/**
 * 协作图：从 `contextRefs` 声明算出「谁读了谁」，并接上质量分做对比。
 *
 * 这是 ② 因果标注的验收。它要证明四件事：
 *
 *   1. **声明能被记录并回放**（fold 能还原 context_refs）
 *   2. **错误的声明被拒**：引用不存在的节点、引用自己 → 必须在 addEvidence 阶段拒
 *   3. **图算得对**：入度/出度/孤岛/枢纽
 *   4. **结论诚实**：样本不足时 `delta=null` 并明说「不下结论」，不给会被当结论用的数字
 *
 * 第 4 条最重要。这个功能唯一的产出就是一句「协作有没有用」，而这句话在样本不足时
 * **必须说不出来**。给它一个数字，哪怕样本只有 1 个，都会被当成结论引用。
 *
 * 组：
 *   - 正常引用 → 边、入度、出度正确
 *   - 孤岛判定
 *   - 引用不存在节点 → 拒（invalid ref）
 *   - 自引用 → 拒
 *   - 去重（同节点引用两次只算一条）
 *   - 样本不足 → delta=null + verdict 含「样本不足」
 *   - 样本充足 → delta 有值，verdict 含「相关性，不是因果」
 *   - 只读：不写 journal
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
  const dir = path.resolve(tempStateDir(`c-${tag}`));
  fs.mkdirSync(dir, { recursive: true });
  const store = new core.Store({});
  return { store, dir };
}

function graph(store, ids, maxParallel = 8) {
  const committed = core.commitGraph(store, {
    wish: 'collab',
    policies: { maxParallel },
    nodes: ids.map((id) => ({
      nodeId: id,
      title: id,
      capability: 'CODE',
      stage: 'build',
      deps: [], // 无依赖，保证都能 claim
      acceptance: { kind: 'exists' },
    })),
  });
  assert.equal(committed.ok, true, JSON.stringify(committed.errors ?? committed).slice(0, 200));
  core.bootstrap(store);
}

/** 提交证据，可带 contextRefs。返回 { ok, ev }。 */
function submit(store, dir, nodeId, { refs, auditor = 'role-audit-01' } = {}) {
  const artifact = path.join(dir, `${nodeId}-${Math.random().toString(36).slice(2, 8)}.md`);
  fs.writeFileSync(artifact, `# ${nodeId}\n`, 'utf8');
  const lease = core.claim(store, nodeId, 'role-code-01', { ttlSec: 600 });
  return core.withCoreStore(store, () => core.submitEvidence({
    nodeId,
    artifactPath: artifact,
    fencingToken: lease.fencing_token,
    producerInstance: 'role-code-01',
    auditorInstance: auditor,
    kind: 'artifact',
    acceptance: { kind: 'exists' },
    ...(refs ? { contextRefs: refs } : {}),
  }));
}

// ── 组 1：正常引用 → 边/入度/出度 ──────────────────────────────────────
{
  const { store, dir } = makeStore('basic');
  graph(store, ['A', 'B', 'C']);
  submit(store, dir, 'A');
  const r1 = submit(store, dir, 'B', { refs: [{ nodeId: 'A', how: '读了 A 的接口定义，按它实现了调用' }] });
  assert.equal(r1?.ok, true, `带 refs 提交应成功: ${JSON.stringify(r1).slice(0, 200)}`);

  const m = core.collaborationMap(store);
  assert.equal(m.edges.length, 1, '应有 1 条边');
  assert.equal(m.edges[0].from, 'B');
  assert.equal(m.edges[0].to, 'A');
  assert.ok(m.edges[0].how?.includes('接口定义'), 'how 应被保留');

  const b = m.nodes.find((n) => n.nodeId === 'B');
  const a = m.nodes.find((n) => n.nodeId === 'A');
  assert.equal(b.outbound, 1, 'B 出度 1');
  assert.equal(b.inbound, 0, 'B 入度 0');
  assert.equal(a.inbound, 1, 'A 入度 1');
  assert.equal(a.outbound, 0, 'A 出度 0');
  console.log('PASS 正常引用 → 边与入度/出度正确（B→A，how 保留）');
}

// ── 组 2：孤岛判定 ────────────────────────────────────────────────────
{
  const { store, dir } = makeStore('island');
  graph(store, ['A', 'B', 'LONE']);
  submit(store, dir, 'A');
  submit(store, dir, 'B', { refs: [{ nodeId: 'A' }] });
  const m = core.collaborationMap(store);
  assert.equal(m.totals.islands, 1, '只有 LONE 是孤岛');
  assert.ok(m.nodes.find((n) => n.nodeId === 'LONE')?.island, 'LONE 应判为孤岛');
  assert.ok(!m.nodes.find((n) => n.nodeId === 'A')?.island, 'A 被引用，不是孤岛');
  console.log('PASS 孤岛判定：LONE（无人引、不引别人）= 孤岛；A（被引用）不是');
}

// ── 组 3：引用不存在的节点 → 拒 ──────────────────────────────────────
{
  const { store, dir } = makeStore('badref');
  graph(store, ['A']);
  const r = submit(store, dir, 'A', { refs: [{ nodeId: 'GHOST' }] });
  assert.equal(r?.ok, false, '引用不存在的节点必须被拒');
  assert.ok(/不存在的节点/.test(String(r?.message ?? '')), `错误信息应说明原因：${r?.message}`);
  console.log('PASS 引用不存在的节点 → 拒（错误信息含「不存在的节点」）');
}

// ── 组 4：自引用 → 拒 ────────────────────────────────────────────────
{
  const { store, dir } = makeStore('self');
  graph(store, ['A']);
  const r = submit(store, dir, 'A', { refs: [{ nodeId: 'A' }] });
  assert.equal(r?.ok, false, '自引用必须被拒');
  assert.ok(/不能引用自己/.test(String(r?.message ?? '')), `错误信息应说明：${r?.message}`);
  console.log('PASS 自引用 → 拒（自引用会制造假耦合度）');
}

// ── 组 5：去重（同节点引两次只算一条）────────────────────────────────
{
  const { store, dir } = makeStore('dup');
  graph(store, ['A', 'B']);
  submit(store, dir, 'A');
  submit(store, dir, 'B', { refs: [{ nodeId: 'A' }, { nodeId: 'A' }] });
  const m = core.collaborationMap(store);
  assert.equal(m.edges.length, 1, '同一节点引用两次只应算一条边');
  console.log('PASS 去重：同节点引用两次 → 1 条边（避免耦合度虚高）');
}

// ── 组 6：样本不足 → delta=null 且明说「不下结论」────────────────────
{
  const { store, dir } = makeStore('thin');
  graph(store, ['A', 'B']); // 只有 2 个节点，两边样本都不够
  submit(store, dir, 'A');
  submit(store, dir, 'B', { refs: [{ nodeId: 'A' }] });
  const m = core.collaborationMap(store); // 默认 minSample=3
  assert.equal(m.quality.delta, null, '**样本不足时 delta 必须是 null**');
  assert.ok(/样本不足/.test(m.quality.verdict), `verdict 必须说「样本不足」：${m.quality.verdict}`);
  assert.ok(/不下结论/.test(m.quality.verdict), 'verdict 必须明确「不下结论」');
  console.log('PASS 样本不足 → delta=null，verdict 明说「样本不足，不下结论」');
}

// ── 组 7：样本充足 → delta 有值，且声明「相关性不是因果」──────────────
{
  const { store, dir } = makeStore('enough');
  // 4 个耦合（都引用 BASE）+ 4 个孤岛
  // maxParallel 要够：证据提交后租约仍在审计期（不释放），9 个节点需要 9 个名额
  graph(store, ['BASE', 'C1', 'C2', 'C3', 'C4', 'I1', 'I2', 'I3', 'I4'], 16);
  submit(store, dir, 'BASE');
  for (const id of ['C1', 'C2', 'C3', 'C4']) submit(store, dir, id, { refs: [{ nodeId: 'BASE' }] });
  for (const id of ['I1', 'I2', 'I3', 'I4']) submit(store, dir, id);

  const m = core.collaborationMap(store, { minSample: 3 });
  assert.equal(m.quality.coupled.nodes, 5, '耦合侧 5 个有分数（BASE + C1..C4）');
  assert.equal(m.quality.isolated.nodes, 4, '孤岛侧 4 个有分数');
  assert.ok(typeof m.quality.delta === 'number', '样本充足时 delta 应有值');

  // 现在两侧都是满分（都 verified + 独立审计 + 无返工）→ delta=0，verdict 应说「没有可观测差异」
  assert.equal(m.quality.delta, 0, '同质节点两侧应无差异');
  assert.ok(/没有可观测的质量差异|相同/.test(m.quality.verdict),
    `delta=0 时应说「没有差异」：${m.quality.verdict}`);

  // 制造真实差异：给孤岛节点加返工，让它们分数掉下来
  for (const id of ['I1', 'I2', 'I3', 'I4']) {
    store.state.nodes.get(id).attempts = 3;
  }
  const m2 = core.collaborationMap(store, { minSample: 3 });
  assert.ok(typeof m2.quality.delta === 'number' && m2.quality.delta > 0,
    `制造差异后 delta 应为正，实际 ${m2.quality.delta}`);
  assert.ok(
    /相关性/.test(m2.quality.verdict) && /不是因果/.test(m2.quality.verdict),
    `delta≠0 时 verdict 必须声明「相关性不是因果」：${m2.quality.verdict}`,
  );
  console.log(`PASS 样本充足 → delta=${m2.quality.delta}（耦合侧 ${m2.quality.coupled.avgScore} vs 孤岛侧 ${m2.quality.isolated.avgScore}），声明「相关性不是因果」`);
}

// ── 组 8：只读 —— 算协作图不写 journal ──────────────────────────────
{
  const { store, dir } = makeStore('ro');
  graph(store, ['A', 'B']);
  submit(store, dir, 'A');
  submit(store, dir, 'B', { refs: [{ nodeId: 'A' }] });
  const before = store.journal.size;
  core.collaborationMap(store);
  const after = store.journal.size;
  assert.equal(after, before, `协作图不许写 journal（${before} → ${after}）`);
  console.log(`PASS 只读：调用前后 journal 长度一致（${before}）`);
}

cleanupTempStateDirs();
