/**
 * 返工分因：**只把业务原因计入质量分，系统故障单独统计**。
 *
 * 这是用真实数据发现的一个缺陷的修复。真实 journal 里：
 *
 *   attempts_changed 的原因分布：
 *     lease_expired            14  ← 系统（状态机坑人）
 *     rejected:orphan_submitted 7  ← 系统（孤儿清扫，就是那 8 个 M8 节点）
 *     rejected:credential_unavailable 4  ← 业务（提交时凭证不对）
 *
 * 修之前：`M8-01..08` 八个节点全被判 `poor (43)`，但它们的 2 次返工是**租约死锁**
 * 逼出来的，产出本身没问题。质量分把「系统故障受害者」记成了「干得差的 worker」。
 *
 * 本测试验四件事：
 *   1. 业务返工 → 扣分
 *   2. **系统返工 → 不扣分**（这是修复的核心）
 *   3. `isSystemReworkReason` 的分类边界（含 `rejected:` 前缀）
 *   4. 白名单策略：**未知原因算业务**（宁可多扣分，不能免罚）
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
  const dir = path.resolve(tempStateDir(`rw-${tag}`));
  fs.mkdirSync(dir, { recursive: true });
  return { store: new core.Store({}), dir };
}

function graph(store, ids, maxParallel = 16) {
  const c = core.commitGraph(store, {
    wish: 'rework',
    policies: { maxParallel },
    nodes: ids.map((id) => ({
      nodeId: id, title: id, capability: 'CODE', stage: 'build', deps: [], acceptance: { kind: 'exists' },
    })),
  });
  assert.equal(c.ok, true, JSON.stringify(c.errors ?? c).slice(0, 200));
  core.bootstrap(store);
}

function submit(store, dir, nodeId) {
  const a = path.join(dir, `${nodeId}.md`);
  fs.writeFileSync(a, `# ${nodeId}\n`, 'utf8');
  const lease = core.claim(store, nodeId, 'role-code-01', { ttlSec: 600 });
  core.withCoreStore(store, () => core.submitEvidence({
    nodeId, artifactPath: a, fencingToken: lease.fencing_token,
    producerInstance: 'role-code-01', auditorInstance: 'role-audit-01',
    kind: 'artifact', acceptance: { kind: 'exists' },
  }));
  return lease;
}

/**
 * 追加一条 attempts_changed。
 *
 * **同时更新 `node.attempts`** —— 真实运行时两者是一致的（事件是追加日志，
 * node.attempts 是折叠后的投影）。只写事件不更新投影，会造成
 * 「journal 里 3 次但 attempts=0」这种现实中不存在的状态。
 */
function pushAttemptChange(store, nodeId, reason, to = 1) {
  store.journal.append('attempts_changed', nodeId, { at: store.nowIso(), from: 0, to, reason });
  const n = store.state.nodes.get(nodeId);
  if (n) n.attempts = to;
}

// ── 组 1：isSystemReworkReason 的分类边界 ────────────────────────────
{
  assert.equal(core.isSystemReworkReason('lease_expired'), true, 'lease_expired 是系统原因');
  assert.equal(core.isSystemReworkReason('orphan_submitted'), true, 'orphan_submitted 是系统原因');
  assert.equal(core.isSystemReworkReason('rejected:orphan_submitted'), true, '带 rejected: 前缀也识别');
  assert.equal(core.isSystemReworkReason('rejected:lease_expired'), true);
  assert.equal(core.isSystemReworkReason('credential_unavailable'), false, 'credential_unavailable 算业务');
  assert.equal(core.isSystemReworkReason('rejected:credential_unavailable'), false);
  assert.equal(core.isSystemReworkReason('unknown_reason_xyz'), false, '**未知原因算业务（宁可多扣分）**');
  assert.equal(core.isSystemReworkReason(''), false);
  assert.equal(core.isSystemReworkReason(null), false);
  console.log('PASS 分类边界：lease_expired/orphan_submitted=系统；credential_unavailable/未知=业务；空值=false');
}

// ── 组 2：业务返工 → 扣分 ────────────────────────────────────────────
{
  const { store, dir } = makeStore('biz');
  graph(store, ['B1']);
  submit(store, dir, 'B1');
  const before = core.qualityReport(store, {}).nodes.find((q) => q.nodeId === 'B1').score;

  pushAttemptChange(store, 'B1', 'rejected:credential_unavailable', 1);
  const after = core.qualityReport(store, {}).nodes.find((q) => q.nodeId === 'B1');
  assert.ok(after.score < before, `业务返工必须扣分：${before} → ${after.score}`);
  assert.equal(after.sample.businessRework, 1, '业务返工计 1');
  assert.equal(after.sample.systemRetries, 0);
  console.log(`PASS 业务返工扣分：${before} → ${after.score}（businessRework=1）`);
}

// ── 组 3：**系统返工 → 不扣分**（修复的核心）────────────────────────
{
  const { store, dir } = makeStore('sys');
  graph(store, ['S1']);
  submit(store, dir, 'S1');
  const before = core.qualityReport(store, {}).nodes.find((q) => q.nodeId === 'S1').score;

  // 连续 3 次系统重试（模拟租约死锁）
  pushAttemptChange(store, 'S1', 'lease_expired', 1);
  pushAttemptChange(store, 'S1', 'lease_expired', 2);
  pushAttemptChange(store, 'S1', 'rejected:orphan_submitted', 3);

  const after = core.qualityReport(store, {}).nodes.find((q) => q.nodeId === 'S1');
  assert.equal(after.score, before, `**系统返工不该扣分**：${before} → ${after.score}`);
  assert.equal(after.sample.businessRework, 0, '业务返工 0');
  assert.equal(after.sample.systemRetries, 3, '系统重试 3');
  assert.equal(after.sample.attempts, 3, '总 attempts 仍是 3（只是不计入质量）');
  assert.ok(
    after.reasons.some((r) => r.includes('系统重试不计入')),
    `reasons 必须说明系统重试不计入：${JSON.stringify(after.reasons)}`,
  );
  console.log(`PASS 系统返工不扣分：${before} → ${after.score}（3 次 lease_expired/orphan 全部免罚，reasons 明说）`);
}

// ── 组 4：混合情况 —— 业务 + 系统，只扣业务 ─────────────────────────
{
  const { store, dir } = makeStore('mix');
  graph(store, ['M1', 'M2']);
  submit(store, dir, 'M1');
  submit(store, dir, 'M2');
  // M1：1 次业务 + 3 次系统
  pushAttemptChange(store, 'M1', 'lease_expired', 1);
  pushAttemptChange(store, 'M1', 'rejected:credential_unavailable', 2);
  pushAttemptChange(store, 'M1', 'lease_expired', 3);
  // M2：只有 1 次业务（与 M1 的业务次数相同）
  pushAttemptChange(store, 'M2', 'rejected:credential_unavailable', 1);

  const r = core.qualityReport(store, {});
  const m1 = r.nodes.find((q) => q.nodeId === 'M1');
  const m2 = r.nodes.find((q) => q.nodeId === 'M2');
  assert.equal(m1.sample.businessRework, 1, 'M1 业务返工 1');
  assert.equal(m1.sample.systemRetries, 2, 'M1 系统重试 2');
  assert.equal(m2.sample.businessRework, 1, 'M2 业务返工 1');
  assert.equal(m2.sample.systemRetries, 0);
  assert.equal(m1.score, m2.score, `**业务返工次数相同的两个节点，分数应相同**：M1=${m1.score} M2=${m2.score}`);
  console.log(`PASS 混合情况：M1(1业务+2系统)=${m1.score} 与 M2(1业务)=${m2.score} 同分 —— 系统重试不影响质量`);
}

// ── 组 5：真实场景回放 —— M8 那批不再被判 poor ──────────────────────
{
  const { store, dir } = makeStore('m8');
  graph(store, ['M8-FAKE-01']);
  submit(store, dir, 'M8-FAKE-01');
  // 复刻真实 journal 里的情况：orphan_submitted 两次
  pushAttemptChange(store, 'M8-FAKE-01', 'rejected:orphan_submitted', 1);
  pushAttemptChange(store, 'M8-FAKE-01', 'rejected:orphan_submitted', 2);
  store.state.nodes.get('M8-FAKE-01').attempts = 2; // 与现实一致：node.attempts 是 2

  const q = core.qualityReport(store, {}).nodes.find((x) => x.nodeId === 'M8-FAKE-01');
  assert.equal(q.sample.attempts, 2, '总 attempts 2（与现实一致）');
  assert.equal(q.sample.businessRework, 0, '业务返工 0');
  assert.ok(q.score >= 85, `**修复后不该是 poor**：实际 ${q.score} (${q.grade})，修复前是 43/poor`);
  console.log(`PASS M8 场景回放：attempts=2 但全是孤儿清扫 → score=${q.score}/${q.grade}（修复前 43/poor）`);
}

// ── 组 6：没有索引时退化方向 —— 全部算业务（保守，不多给分）──────────
{
  const { store, dir } = makeStore('fallback');
  graph(store, ['F1']);
  submit(store, dir, 'F1');
  store.state.nodes.get('F1').attempts = 2;
  // 不传 index，直接调 scoreNode
  const q = core.scoreNode(store, 'F1');
  assert.equal(q.sample.businessRework, 2, '无索引时全部 attempts 算业务');
  assert.equal(q.sample.systemRetries, 0);
  assert.equal(q.dimensions.rework, Number((1 / 3).toFixed(3)), '2 次业务返工 → 返工维度 1/3');
  assert.ok(q.score < 100, `退化方向是保守的（确实扣分），实际 ${q.score}`);
  console.log(`PASS 无索引退化：attempts=2 全算业务 → rework=${q.dimensions.rework}、score=${q.score}（保守，不给免费分）`);
}

cleanupTempStateDirs();
