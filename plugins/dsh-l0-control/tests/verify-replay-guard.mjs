/**
 * 恢复防重放闸口：`done` 退回 `ready` 时，派活必须拒绝而不是重做。
 *
 * 攻击面/故障面：journal 被截断、检查点写在状态回滚之后、或有人手工改
 * 状态表 —— 都会让「检查点说已完成」的节点重新出现在 `ready` 里。
 * 此时派活层若不拦，worker 会重新领活、重复产出证据、重复消耗预算，
 * 即「重放已完成 activity」。
 *
 * 本测试直接构造这个矛盾态（改内存状态，模拟 journal 被改写后的折叠结果），
 * 断言：
 *   1. `graphResumePlan` 报出 drift 且 `ok=false`；
 *   2. 该节点仍在 ready 里（矛盾态确认没被别的机制顺手修掉）；
 *   3. `dispatch` 把它标 `skip`，`willDispatch` 不含它 —— **真的不派**；
 *   4. 同分区里未完成且 ready 的节点仍能派 —— 闸口不会把整图锁死。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const lib = (name) => pathToFileURL(path.join(root, 'lib', name)).href;
const core = await import(lib('core/index.js'));

const store = new core.Store();
const run = (fn) => core.withCoreStore(store, fn);

run(() => core.submitWish({ text: '防重放闸口验收', maxParallel: 4, budgetTokens: 0 }));
run(() =>
  core.graphCommit({
    wish: '防重放闸口验收',
    coordination: {
      enabled: true,
      maxActive: 8,
      maxQueuedTasks: 100,
      ratePerSecond: 50,
      partitions: [{ id: 'replay', nodeRefs: ['P1', 'P2'], maxActive: 4 }],
    },
    nodes: [
      { nodeId: 'P1', title: 'P1', acceptance: { kind: 'exists' } },
      { nodeId: 'P2', title: 'P2', acceptance: { kind: 'exists' } },
    ],
  }),
);
run(() => core.bootstrap(store));

// P1 标记为已完成后落检查点（此时检查点记录 P1=done）
run(() => {
  const node = store.state.nodes.get('P1');
  node.status = 'done';
});
const ckpt = run(() => core.graphCheckpoint({ partitionId: 'replay' }));
assert.equal(ckpt.ok, true, `checkpoint 失败：${JSON.stringify(ckpt)}`);
assert.equal(
  ckpt.checkpoint.nodeStates.find((row) => row.nodeId === 'P1')?.status,
  'done',
  '检查点应记录 P1=done',
);

// 构造矛盾态：P1 从 done 退回 ready（模拟 journal 被截断/状态被改）
run(() => {
  const node = store.state.nodes.get('P1');
  node.status = 'ready';
});

// ── 断言 1：resume plan 必须报 drift 且 ok=false ──────────────────────────
const plan = run(() => core.graphResumePlan({ partitionId: 'replay' }));
assert.equal(plan.ok, false, `drift 时 ok 应为 false：${JSON.stringify(plan)}`);
assert.equal(plan.drift.length, 1, `应恰有 1 条 drift：${JSON.stringify(plan.drift)}`);
assert.equal(plan.drift[0].nodeId, 'P1');
assert.equal(plan.drift[0].checkpointStatus, 'done');
assert.equal(plan.drift[0].currentStatus, 'ready');
assert.equal(plan.drift[0].reason, 'done-regressed');
assert.ok(
  !plan.skipCompleted.includes('P1'),
  'P1 现在不是 done，不能进 skipCompleted（那是给真正完成的节点用的）',
);

// ── 断言 2：P1 确实回到 ready 了（矛盾态成立，没被别的机制顺手修掉） ──────
const ready = run(() => core.readySet(store));
assert.ok(ready.includes('P1'), `P1 应在 ready 里，实际：${JSON.stringify(ready)}`);
assert.ok(ready.includes('P2'), `P2 应在 ready 里，实际：${JSON.stringify(ready)}`);

// ── 断言 3：dispatch 必须把 P1 标 skip，且不派它 ──────────────────────────
const dispatch = run(() =>
  core.dispatchPlan({ mode: 'resident', dryRun: false, maxPerTick: 10, intervalMs: 60000 }),
);
assert.equal(dispatch.ok, true);
assert.ok(
  !dispatch.willDispatch.includes('P1'),
  `P1 已完成却进了 willDispatch —— 这就是重放已完成 activity：${JSON.stringify(dispatch.willDispatch)}`,
);
const p1Item = dispatch.plan.find((item) => item.nodeId === 'P1');
assert.ok(p1Item, `P1 应出现在 plan 里：${JSON.stringify(dispatch.plan)}`);
assert.equal(p1Item.action, 'skip', `P1 应被 skip，实际 ${p1Item.action}`);
assert.ok(
  String(p1Item.reason).includes('恢复防重放'),
  `skip 理由应指出恢复防重放，实际：${p1Item.reason}`,
);
assert.ok(
  String(p1Item.reason).includes('done'),
  `skip 理由应带上检查点里的完成态，实际：${p1Item.reason}`,
);

// ── 断言 4：闸口不锁死整图 —— P2 未完成且 ready，仍应被派出 ────────────────
assert.ok(
  dispatch.willDispatch.includes('P2'),
  `P2 未完成，闸口不应牵连它：${JSON.stringify(dispatch.willDispatch)}`,
);

console.log(
  'PASS replay guard: checkpoint done→ready drift is reported, dispatch skips it with reason, sibling pending node still dispatches',
);
