/**
 * 分区级恢复演练：**进程被杀**后按检查点恢复，验证「已完成 activity 不重放」。
 *
 * 这不是单元测试，是故障演练：
 *   代次 1 —— 建图（4 节点 / 1 个分区）→ 跑完前 2 个节点 → 落检查点 → 再跑 1 个节点
 *             → **不 close、不 snapshot，直接丢弃句柄**（模拟 kill -9 后的进程消失）
 *   代次 2 —— takeover 重开 → 折回 state → `graphResumePlan` 必须给出：
 *             · skipCompleted 含「检查点前就 done」的 2 个节点（**绝不能再执行一次**）
 *             · resume 含「检查点前没完成」的节点（接着做）
 *             · drift 为空（没有 done 退回，说明 journal 没被改写）
 *
 * 反证：如果 skipCompleted 漏了任何一个已 done 节点，恢复后 worker 会重新领活、
 * 重复产出证据 —— 这正是「重放已完成 activity」的危害，本演练专门盯这点。
 *
 * 用法：`node tests/verify-partition-recovery-drill.mjs`
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempSystemDir, removeTempDir } from './_temp-state.mjs';

const root = process.cwd();
const lib = (name) => pathToFileURL(path.join(root, 'lib', name)).href;
const { CorePersistence } = await import(lib('persistence.js'));
const core = await import(lib('core/index.js'));

const dir = tempSystemDir('l0-recovery-drill-');
const artifact = path.join(root, 'README.md');

const NODES = ['D1', 'D2', 'D3', 'D4'];
const SPEC = {
  wish: '分区恢复演练',
  coordination: {
    enabled: true,
    maxActive: 8,
    maxQueuedTasks: 100,
    ratePerSecond: 25,
    partitions: [{ id: 'drill', nodeRefs: NODES, maxActive: 4 }],
  },
  nodes: NODES.map((nodeId, index) => ({
    nodeId,
    title: nodeId,
    stage: 'build',
    status: index === 0 ? 'ready' : 'planned',
    deps: index === 0 ? [] : [NODES[index - 1]],
    acceptance: { kind: 'exists' },
  })),
};

/** 跑完一个节点：过阶段闸门 → claim → evidence → verify_done。 */
async function runNode(persistence, nodeId, role, auditor) {
  const run = (fn) => core.withCoreStore(persistence.coreStore, fn);
  // 阶段闸门必须先过，否则 verify_done 会以「闸门未通过」驳回
  run(() => core.passGate(persistence.coreStore, 'build', []));
  const claim = run(() => core.claimTask({ nodeId, role: 'ANY', instanceId: role }));
  assert.equal(claim.ok, true, `${nodeId} claim 失败：${JSON.stringify(claim)}`);
  const fencingToken = Number(claim.lease.fencing_token);
  const evidence = run(() =>
    core.submitEvidence({
      fencingToken,
      nodeId,
      artifactPath: artifact,
      producer_instance: role,
      producerInstance: role,
      acceptance: { kind: 'exists' },
    }),
  );
  assert.equal(evidence.ok, true, `${nodeId} evidence 失败：${JSON.stringify(evidence)}`);
  const done = run(() =>
    core.verifyDone({
      nodeId,
      producer_instance: role,
      producerInstance: role,
      fencingToken,
      auditor_instance: auditor,
      auditorInstance: auditor,
      acceptance: { kind: 'exists' },
    }),
  );
  assert.equal(done.status, 'done', `${nodeId} verify_done 失败：${JSON.stringify(done)}`);
  return done;
}

// ── 代次 1：建图 → 跑 D1 D2 → 检查点 → 再跑 D3 → 模拟进程消失 ──────────────
// ttlMs 故意压到 800ms：kill -9 后没有 close()，锁只能靠 TTL 过期变 stale，
// 二代次才能用 takeover 接管。默认 30min 的话演练要真等半小时，不现实。
const p1 = await CorePersistence.open({ dir, mode: 'node', owner: 'drill-gen-1', ttlMs: 800 });
const run1 = (fn) => core.withCoreStore(p1.coreStore, fn);
run1(() => core.submitWish({ text: '分区恢复演练', maxParallel: 4, budgetTokens: 0 }));
run1(() => core.graphCommit(SPEC));
run1(() => core.bootstrap(p1.coreStore));

await runNode(p1, 'D1', 'ROLE-CODE-01', 'ROLE-AUDIT_CODE-01');
await runNode(p1, 'D2', 'ROLE-CODE-01', 'ROLE-AUDIT_CODE-01');
await p1.persist();

const ckpt = run1(() => core.graphCheckpoint({ partitionId: 'drill' }));
assert.equal(ckpt.ok, true, `checkpoint 失败：${JSON.stringify(ckpt)}`);
assert.equal(ckpt.checkpoint.nodeStates.filter((n) => n.status === 'done').length, 2);

// 检查点之后才完成的 D3 —— 它「不在检查点里」，恢复时算「检查点后做完」，既不 resume 也不 skip
await runNode(p1, 'D3', 'ROLE-CODE-02', 'ROLE-AUDIT_CODE-01');
await p1.persist();
const journalBeforeCrash = run1(() => core.graphStatus()).counts;

// **模拟 kill -9**：不 close、不 snapshot、不释放锁 —— 直接把句柄丢掉。
//
// 但必须先 `suspendHeartbeat()`：`CorePersistence` 默认按 TTL/3 自动续租，
// 而 kill -9 的语义是「进程消失，不再续租」。在同一个进程里复现这个语义，
// 只能显式停掉续租；否则定时器还在跑、锁永远 fresh，二代次的 takeover
// 会永远等不到 stale —— 那不是被测逻辑的问题，是演练失真。
const abandoned = p1;
abandoned.suspendHeartbeat();

// 等 TTL 过期让锁变 stale（真实崩溃场景里进程已消失，锁只能靠 TTL 判定）
await new Promise((resolve) => setTimeout(resolve, 900));

// ── 代次 2：takeover 重开（锁被上一代次占着，必须显式接管） ─────────────────
const p2 = await CorePersistence.open({ dir, mode: 'node', owner: 'drill-gen-2', takeover: true, ttlMs: 800 });const run2 = (fn) => core.withCoreStore(p2.coreStore, fn);

const plan = run2(() => core.graphResumePlan({ partitionId: 'drill' }));
const status = run2(() => core.graphStatus());

// ── 断言 1：重开后 state 折回正确（D1 D2 D3 done，D4 未做） ────────────────
assert.equal(status.counts.nodes, 4, `重开后节点数应为 4，实际 ${status.counts.nodes}`);
assert.equal(status.counts.done, 3, `重开后 done 应为 3，实际 ${status.counts.done}`);

// ── 断言 2：drift 为空 —— 没有 done 节点退回（journal 没被改写） ────────────
assert.deepEqual(plan.drift, [], `不应有 drift，实际：${JSON.stringify(plan.drift)}`);
assert.equal(plan.ok, true);

// ── 断言 3：检查点前已完成的 D1 D2 **必须在 skipCompleted 里**（核心诉求） ──
assert.deepEqual(
  [...plan.skipCompleted].sort(),
  ['D1', 'D2'],
  `skipCompleted 应恰为检查点前已完成的节点，实际：${JSON.stringify(plan.skipCompleted)}`,
);

// ── 断言 4：resume 只含检查点时未完成、现在仍未完成的 D4 ────────────────────
assert.deepEqual(
  plan.resume.map((row) => row.nodeId),
  ['D4'],
  `resume 应只含 D4，实际：${JSON.stringify(plan.resume)}`,
);

// ── 断言 5：检查点之后才做完的 D3 既不在 resume 也不在 skip（不误判） ───────
assert.ok(!plan.skipCompleted.includes('D3'), 'D3 是检查点后完成的，不应进 skipCompleted');
assert.ok(!plan.resume.some((row) => row.nodeId === 'D3'), 'D3 已 done，不应进 resume');

// ── 断言 6：baseSeq 是检查点事件自身 seq，重放数 = 检查点之后的事件数 ──────
assert.equal(plan.baseSeq, ckpt.checkpoint.baseSeq);
assert.ok(plan.replayed > 0, `检查点之后应有待重放事件，实际 ${plan.replayed}`);

// ── 断言 7：重放等价性 —— 全新 store 从头折 journal，必须与当前状态一致 ────
const fresh = new core.Store();
core.withCoreStore(fresh, () => {
  const events = p2.coreStore.journal.raw();
  const folded = core.foldEvents(events);
  assert.equal(folded.nodes.size, status.counts.nodes, '重放节点数应与当前一致');
  const completed = NODES.filter((nodeId) => nodeId !== 'D4');
  for (const nodeId of completed) {
    assert.equal(
      folded.nodes.get(nodeId)?.status,
      'done',
      `${nodeId} 重放后状态应为 done`,
    );
  }
  assert.notEqual(folded.nodes.get('D4')?.status, 'done', 'D4 未做过，重放后不应是 done');
});

// ── 断言 8：**不会重复执行** —— skipCompleted 里的节点再次 claim 必被拒 ──────
// 注意：拒绝有两种形态 —— 结构化 `{ok:false}` 或 lease 层直接抛错（节点不在 ready）。
// 两者都算「被拒」；只要有任何一个 claim 成功了，就是重放已完成 activity。
for (const nodeId of plan.skipCompleted) {
  let outcome;
  try {
    outcome = run2(() => core.claimTask({ nodeId, role: 'ANY', instanceId: 'ROLE-CODE-09' }));
  } catch (error) {
    outcome = { ok: false, thrown: String(error?.message || error) };
  }
  assert.notEqual(
    outcome.ok,
    true,
    `${nodeId} 已完成却被重新 claim 成功 —— 这就是「重放已完成 activity」：${JSON.stringify(outcome)}`,
  );
}

// ── 断言 9：D4 仍可正常领活（恢复后真能接着做） ────────────────────────────
const d4 = run2(() => core.claimTask({ nodeId: 'D4', role: 'ANY', instanceId: 'ROLE-CODE-03' }));
assert.equal(d4.ok, true, `恢复后 D4 应可领活：${JSON.stringify(d4)}`);

// 清理：先让被"杀掉"的句柄释放锁，再关二代次
try {
  await abandoned.close({ snapshot: false });
} catch {
  // 已被 takeover，释放失败属预期
}
try {
  await p2.close({ snapshot: true });
} catch {
  // 忽略
}
removeTempDir(dir);

console.log('PASS partition recovery drill: checkpoint → crash → takeover reopen → skip completed, resume pending, no drift, no duplicate claim');
