/**
 * 质量度量：**只读聚合已有信号，不改协议、不参与任何判定**。
 *
 * 这是"先能度量质量"那一步的验收。它要证明三件事：
 *
 *   1. **能从已有信号算出可比较的分数**（不新增协议字段就能做）
 *   2. **可解释**：每个维度单独给分 + reasons，不是黑箱
 *   3. **不改变任何行为**：算分数不写 journal、不影响 verify_done
 *
 * 还有一个最容易做错的点，单独成组测：
 *
 *   4. **没有证据 = unknown，不是 0 分**
 *      0 分会被读成"做得很差"，而 unknown 才是"还没法判断"。混同会让人
 *      把"还没开始"当成"干砸了"，进而对没证据的节点做错误处置。
 *
 * 判据（各组）：
 *   - 正常节点：有 verified 证据 + 独立审计 + 无返工 → excellent
 *   - 高返工：attempts 上去后分数显著下降
 *   - 无独立审计：independence 与 audit 维度归零，且 reasons 里明说
 *   - 无证据：score=null、grade=unknown、caveat=no-evidence
 *   - 只读：调用前后 journal 长度不变
 *   - 分组：byStage / byCapability 能聚合，且 unknown 单独计数不混进均值
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (n) => pathToFileURL(path.join(root, 'lib', n)).href;
const core = await import(lib('core/index.js'));

function makeStore(tag) {
  const dir = path.resolve(tempStateDir(`q-${tag}`));
  fs.mkdirSync(dir, { recursive: true });
  const store = new core.Store({});
  return { store, dir };
}

/** 造一张图 + 提交证据，返回 store。 */
function buildGraph(store, nodes) {
  const committed = core.commitGraph(store, {
    wish: 'quality',
    policies: { maxParallel: 8 },
    nodes: nodes.map((n) => ({
      nodeId: n.nodeId,
      title: n.title ?? n.nodeId,
      capability: n.capability ?? 'CODE',
      stage: n.stage ?? 'build',
      deps: [],
      acceptance: { kind: 'exists' },
    })),
  });
  assert.equal(committed.ok, true, JSON.stringify(committed.errors ?? committed).slice(0, 200));
  core.bootstrap(store);
}

/** claim + 提交一条证据。provenance / verdict / auditor 可控。 */
function submit(store, dir, nodeId, { ttlSec = 600, auditor = 'role-audit-01', verdict = 'pass', acceptance = { kind: 'exists' } } = {}) {
  const artifact = path.join(dir, `${nodeId}.md`);
  fs.writeFileSync(artifact, `# ${nodeId}\n`, 'utf8');
  const lease = core.claim(store, nodeId, 'role-code-01', { ttlSec });
  const ev = core.withCoreStore(store, () => core.submitEvidence({
    nodeId,
    artifactPath: artifact,
    fencingToken: lease.fencing_token,
    producerInstance: 'role-code-01',
    ...(auditor ? { auditorInstance: auditor } : {}),
    kind: 'artifact',
    ...(acceptance ? { acceptance } : { verdict }),
  }));
  return { ev, lease };
}

// ── 组 1：健康节点（verified + 独立审计 + 无返工）→ excellent ───────────
{
  const { store, dir } = makeStore('healthy');
  buildGraph(store, [{ nodeId: 'Q1' }]);
  const { ev } = submit(store, dir, 'Q1');
  assert.equal(ev?.ok, true, `提交失败: ${JSON.stringify(ev).slice(0, 200)}`);

  const q = core.scoreNode(store, 'Q1');
  assert.ok(typeof q.score === 'number', '有证据的节点必须能算出分数');
  assert.equal(q.grade, 'excellent', `健康节点应为 excellent，实际 ${q.grade}（score=${q.score}）`);
  assert.equal(q.dimensions.evidence, 1, 'verified 证据 → 证据维度 1');
  assert.equal(q.dimensions.rework, 1, '0 次返工 → 返工维度 1');
  assert.equal(q.dimensions.independence, 1, '有独立审计 → 独立性 1');
  assert.ok(q.reasons.length >= 2, '必须给出可解释的原因');
  console.log(`PASS 健康节点 score=${q.score} grade=${q.grade}（证据/返工/审计/独立性各维度独立给分）`);
}

// ── 组 2：高返工 → 分数显著下降 ────────────────────────────────────────
{
  const { store, dir } = makeStore('rework');
  buildGraph(store, [{ nodeId: 'Q2' }]);
  submit(store, dir, 'Q2');
  const baseline = core.scoreNode(store, 'Q2').score;
  // 制造两次返工
  for (let i = 0; i < 2; i += 1) {
    const node = store.state.nodes.get('Q2');
    node.attempts = Number(node.attempts ?? 0) + 1;
  }
  const after = core.scoreNode(store, 'Q2');
  assert.ok(after.score < baseline, `返工后分数必须下降：${baseline} → ${after.score}`);
  assert.ok(after.dimensions.rework < 1, '返工维度必须 < 1');
  assert.ok(after.reasons.some((r) => /返工/.test(r)), 'reasons 里必须提到返工');
  console.log(`PASS 返工扣分：${baseline} → ${after.score}（${core.scoreNode(store, 'Q2').sample.attempts} 次返工）`);
}

// ── 组 3：没有独立审计 → 审计与独立性维度归零，且明说 ──────────────────
{
  const { store, dir } = makeStore('noaudit');
  buildGraph(store, [{ nodeId: 'Q3' }]);
  submit(store, dir, 'Q3', { auditor: null });
  const q = core.scoreNode(store, 'Q3');
  assert.equal(q.dimensions.independence, 0, '没有独立审计 → 独立性 0');
  assert.equal(q.dimensions.audit, 0, '没有独立审计 → 审计维度 0');
  assert.ok(q.reasons.some((r) => /没有独立审计/.test(r)), 'reasons 必须明说没有独立审计');
  assert.ok(q.score < 70, `没有独立审计不该得高分，实际 ${q.score}`);
  console.log(`PASS 无独立审计 → 审计/独立性归零，score=${q.score}，reasons 明说`);
}

// ── 组 4：无证据 → unknown（**不是 0 分**）──────────────────────────────
{
  const { store } = makeStore('empty');
  buildGraph(store, [{ nodeId: 'Q4' }]);
  const q = core.scoreNode(store, 'Q4');
  assert.equal(q.score, null, '**无证据必须是 null，不是 0**');
  assert.equal(q.grade, 'unknown');
  assert.equal(q.caveat, 'no-evidence');
  assert.ok(q.reasons.some((r) => /无法判断/.test(r)));
  console.log('PASS 无证据节点 → score=null / grade=unknown / caveat=no-evidence（不是 0 分）');
}

// ── 组 5：只读 —— 算分数不写 journal ───────────────────────────────────
{
  const { store, dir } = makeStore('readonly');
  buildGraph(store, [{ nodeId: 'Q5' }]);
  submit(store, dir, 'Q5');
  // `journal.size` 是 getter（属性），不是方法——写成 size() 会 TypeError
  const before = store.journal.size;
  core.qualityReport(store);
  core.scoreNode(store, 'Q5');
  const after = store.journal.size;
  assert.equal(after, before, `质量度量不许写 journal（${before} → ${after}）`);
  console.log(`PASS 只读：调用前后 journal 长度一致（${before}）—— 不改任何状态`);
}

// ── 组 6：分组聚合，unknown 不混进均值 ────────────────────────────────
{
  const { store, dir } = makeStore('group');
  buildGraph(store, [
    { nodeId: 'G1', stage: 'build' },
    { nodeId: 'G2', stage: 'build' },
    { nodeId: 'G3', stage: 'audit' },
    { nodeId: 'G4', stage: 'audit' }, // 故意不给证据 → unknown
  ]);
  submit(store, dir, 'G1');
  submit(store, dir, 'G2', { auditor: null });
  submit(store, dir, 'G3');

  const r = core.qualityReport(store);
  assert.equal(r.ok, true);
  assert.equal(r.totals.nodes, 4);
  assert.equal(r.totals.scored, 3, '3 个有证据');
  assert.equal(r.totals.unknown, 1, '1 个无证据');

  const auditGroup = r.byStage.find((g) => g.key === 'audit');
  assert.ok(auditGroup, 'byStage 必须有 audit 组');
  assert.equal(auditGroup.nodes, 1, 'audit 组只有 1 个可打分');
  assert.equal(auditGroup.unknown, 1, '**unknown 单独计数**');
  assert.ok(auditGroup.avgScore !== null && auditGroup.avgScore > 0, '均值只算有分数的');

  assert.ok(r.measured.includes('过程质量'), '必须说明测的是过程质量');
  assert.ok(r.notMeasured.includes('产出'), '必须说明不测产出的好坏');
  assert.ok(r.note.includes('不参与任何判定'), '必须声明不参与判定');
  console.log(`PASS 分组聚合：3 可测 / 1 unknown，byStage.audit avg=${auditGroup.avgScore} unknown=${auditGroup.unknown}`);
}

// ── 组 7：attention 只列有分数的，且按分数升序 ────────────────────────
{
  const { store, dir } = makeStore('attention');
  buildGraph(store, [{ nodeId: 'A1' }, { nodeId: 'A2' }, { nodeId: 'A3' }]);
  submit(store, dir, 'A1');                       // 高
  submit(store, dir, 'A2', { auditor: null });    // 低
  // A3 无证据 → unknown，不该出现在 attention 里
  const r = core.qualityReport(store);
  assert.ok(r.attention.length > 0);
  assert.ok(r.attention.every((q) => q.score !== null), 'attention 不许混入 unknown');
  for (let i = 1; i < r.attention.length; i += 1) {
    assert.ok((r.attention[i - 1].score) <= (r.attention[i].score), 'attention 必须按分数升序（最低的在前）');
  }
  assert.ok(!r.attention.some((q) => q.nodeId === 'A3'), '无证据的节点不进 attention');
  console.log(`PASS attention：${r.attention.length} 个待关注节点，全部有分数、按升序、不含 unknown`);
}

cleanupTempStateDirs();
