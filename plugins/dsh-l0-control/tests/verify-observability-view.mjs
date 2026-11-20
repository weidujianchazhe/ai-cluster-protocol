/**
 * 可观测面：`dispatchView()` / `recoveryView()`。
 *
 * 为什么要有这两个视图：千级运行时真正会问的问题是
 *
 *   - 「现在到底有几个 worker 在跑？」（不是「派过几个」）
 *   - 「上一轮为什么没派它？」（不是「派发失败了」）
 *   - 「崩了之后从哪儿接？有多少要重放？有没有状态退步？」
 *
 * 这些原来只能翻 journal 手工数。视图化之后 UI 与 Lead 都能直接读，而且
 * **视图必须有界**：千级下 `rows` 全量回传会把一次快照变成几 MB 的 JSON。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempStateDir, trackTempStateDir } from './_temp-state.mjs';

const root = process.cwd();
const { L0ControlService } = await import(pathToFileURL(path.join(root, 'lib', 'service.js')).href);

const spawned = [];
const ctx = {
  get: (name) => {
    if (name === 'workingDirectory') return { defaultDirectory: root };
    if (name === 'subagents') {
      return {
        list: () => ['spawn'],
        startActivation: async (request) => {
          spawned.push(request);
          return { childId: `child-${spawned.length}`, messageId: `msg-${spawned.length}` };
        },
      };
    }
    return undefined;
  },
};

const stateDir = tempStateDir('view');
const svc = new L0ControlService(
  ctx,
  // dispatchRatePerSecond 是「每秒最多派几个」，与 maxParallel（同时在跑几个）是两件事。
  // 这里刻意设成 3，好让 rate 的记账能被断言。
  { workspaceRoot: root, stateDir, maxParallel: 3, dispatchRatePerSecond: 3, enqueueStaleMs: 1800000 },
  {},
);

const nodes = Array.from({ length: 6 }, (_, i) => ({
  nodeId: `V${i + 1}`,
  title: `t${i + 1}`,
  capability: 'CODE',
  acceptance: { kind: 'exists' },
}));

try {
  const committed = await svc.graphCommit({ wish: '可观测面', nodes });
  assert.equal(committed.ok, true, JSON.stringify(committed.errors ?? []));

  // ── 1. 空视图结构完整（不崩、字段齐全）──────────────────────────────────
  const empty = svc.dispatchView();
  assert.equal(empty.ok, true);
  assert.equal(empty.active.count, 0);
  assert.equal(empty.active.rows.length, 0);
  assert.equal(typeof empty.rate.perSecond, 'number');
  assert.equal(empty.rate.usedLastSecond, 0);
  console.log('PASS 1. 空视图字段齐全，不崩');

  // ── 2. 派发后 active 反映真实登记，rate 反映真实 spawn ────────────────────
  const dispatched = await svc.dispatch({ mode: 'interval', dryRun: false, enqueue: true, maxPerTick: 2 }, { id: 'lead' });
  assert.equal(dispatched.enqueue.enqueued.length, 2, JSON.stringify(dispatched.enqueue));

  const afterDispatch = svc.dispatchView();
  assert.equal(afterDispatch.active.count, 2, `active 应=2，实际 ${afterDispatch.active.count}`);
  assert.equal(afterDispatch.active.unclaimed, 2, '两节点都还没 claim（worker 自己 claim，插件不代领）');
  assert.equal(afterDispatch.active.claimed, 0);
  assert.equal(afterDispatch.rate.usedLastSecond, 2, `额度应记 2 次真实 spawn，实际 ${afterDispatch.rate.usedLastSecond}`);
  assert.equal(afterDispatch.rate.remaining, 1, '上限 3，用掉 2，应剩 1');
  assert.deepEqual(
    afterDispatch.active.rows.map((r) => r.nodeId).sort(),
    ['V1', 'V2'],
    `active.rows 应是 V1/V2，实际 ${JSON.stringify(afterDispatch.active.rows)}`,
  );
  console.log('PASS 2. active.rows / claimed / rate 全部反映真实状态');

  // ── 3. claim 之后 claimed 计数与 session 可读 ─────────────────────────────
  const claimed = await svc.taskClaim({ nodeId: 'V1', instanceId: 'role-code-01' }, { id: 'lead' });
  assert.equal(claimed.ok, true, JSON.stringify(claimed).slice(0, 200));
  const afterClaim = svc.dispatchView();
  assert.equal(afterClaim.active.claimed, 1, `claim 后 claimed 应=1，实际 ${afterClaim.active.claimed}`);
  assert.equal(afterClaim.active.unclaimed, 1);
  const v1 = afterClaim.active.rows.find((r) => r.nodeId === 'V1');
  assert.equal(v1?.claimed, true, 'V1 应标记 claimed');
  assert.ok(v1?.sessionId, '登记应能追到 session（否则无法判断能否 reap）');
  console.log('PASS 3. claim 之后 claimed 计数与会话可追');

  // ── 4. 释放原因可见（这就是「上轮为什么没派」的答案）─────────────────────
  const loser = await svc.taskClaim({ nodeId: 'V1', instanceId: 'role-code-02' }, { id: 'lead' });
  assert.equal(loser.ok, false, '第二个 claim 应被拒');
  const afterReject = svc.dispatchView();
  const releasedRow = afterReject.released.rows.find((r) => r.nodeId === 'V1');
  assert.equal(releasedRow?.reason, 'claim-rejected', `released 应含 V1 claim-rejected，实际 ${JSON.stringify(afterReject.released.rows)}`);
  assert.ok(String(releasedRow.explain).includes('准入拒绝'));
  console.log('PASS 4. released 带原因与中文解释');

  // ── 5. ★ 视图有界：active.rows / released.rows 都截断并标记 ───────────────
  // 不靠真派 120 个（会被准入/速率挡住，测的就不是视图了），直接写登记行——
  // 视图是否正确截断，与行是怎么来的无关。
  const manySvc = new L0ControlService(ctx, { workspaceRoot: root, stateDir: trackTempStateDir(`${stateDir}-many`), maxParallel: 200 }, {});
  try {
    const many = Array.from({ length: 120 }, (_, i) => ({
      nodeId: `M${String(i + 1).padStart(3, '0')}`,
      title: `m${i}`,
      capability: 'CODE',
      acceptance: { kind: 'exists' },
    }));
    const c = await manySvc.graphCommit({ wish: '大量登记', nodes: many });
    assert.equal(c.ok, true, JSON.stringify(c.errors ?? []).slice(0, 300));
    for (const node of many) {
      manySvc.appendJournal('node_enqueued', { nodeId: node.nodeId, sessionId: `s-${node.nodeId}`, instanceId: 'role-code-01' });
    }
    const view = manySvc.dispatchView();
    assert.equal(view.active.count, 120, `active.count 应是全量 120，实际 ${view.active.count}`);
    assert.equal(view.active.rows.length, 50, `active.rows 应截断到 50，实际 ${view.active.rows.length}`);
    assert.equal(view.active.truncated, true, '截断必须显式标记');
    console.log('PASS 5. 千级登记下视图有界（count 全量 / rows 截断 + truncated 标记）');
  } finally {
    manySvc.stopDispatch();
  }

  // ── 6. recoveryView：检查点 / 重放 / 续做 / drift ────────────────────────
  const recovery = await svc.recoveryView();
  assert.equal(typeof recovery.ok, 'boolean');
  assert.equal(recovery.partitionId, null);
  assert.ok(Array.isArray(recovery.resume), 'resume 应是数组');
  assert.ok(Array.isArray(recovery.drift), 'drift 应是数组');
  assert.equal(recovery.driftDetected, false, '刚提交的图不应有退步');
  assert.ok(String(recovery.hint).includes('driftDetected'));
  console.log('PASS 6. recoveryView 结构完整，无退步时 driftDetected=false');

  // ── 7. recoveryView 带分区：不崩且能报 checkpoint 元数据 ──────────────────
  const withPartition = await svc.recoveryView({ partitionId: 'p-nonexistent' });
  assert.equal(typeof withPartition.ok, 'boolean');
  assert.equal(withPartition.partitionId, 'p-nonexistent');
  console.log('PASS 7. recoveryView 指定不存在分区也不崩');

  // ── 8. uiSnapshot 带上 dispatch（面板不用第二次请求）─────────────────────
  const snap = await svc.uiSnapshot({});
  assert.equal(snap.ok, true);
  assert.equal(snap.dispatch?.ok, true, 'uiSnapshot 应内嵌 dispatch 视图');
  assert.equal(typeof snap.dispatch.active.count, 'number');
  assert.ok(Number(snap.dispatch.rate.perSecond) > 0, 'uiSnapshot.dispatch 应带上速率上限');
  console.log('PASS 8. uiSnapshot.dispatch 内嵌可观测面');

  // ── 9. ★ 恢复面按需：不带 withRecovery 时是 null，带了才是对象 ────────────
  // 这不是"没数据"，是"没问"。千级下每次快照都折叠 journal 重放检查点纯属浪费。
  assert.equal(snap.recovery, null, `不带 withRecovery 时 recovery 应为 null，实际 ${JSON.stringify(snap.recovery)?.slice(0, 120)}`);
  const withRec = await svc.uiSnapshot({ withRecovery: true });
  assert.equal(withRec.ok, true);
  assert.notEqual(withRec.recovery, null, '带 withRecovery=1 时应有恢复面');
  assert.equal(typeof withRec.recovery.ok, 'boolean');
  assert.ok(Array.isArray(withRec.recovery.resume));
  console.log('PASS 9. recovery 按需：默认 null / withRecovery=1 才折叠');

  // ── 10. safeRecoveryView 兜底：内部抛错不能把快照打成错误 ─────────────────
  const broken = new L0ControlService(ctx, { workspaceRoot: root, stateDir: trackTempStateDir(`${stateDir}-broken`) }, {});
  try {
    broken.recoveryView = async () => {
      throw new Error('boom');
    };
    const wrapped = await broken.safeRecoveryView();
    assert.equal(wrapped.ok, false);
    assert.equal(wrapped.error, 'recovery-view-failed');
    assert.ok(String(wrapped.message).includes('boom'));
    console.log('PASS 10. safeRecoveryView 兜底：观测失败不污染快照');
  } finally {
    broken.stopDispatch();
  }

  console.log('\nPASS observability: dispatch/recovery 视图结构完整、有界、可解释（原来只能翻 journal 手工数）');
} finally {
  svc.stopDispatch();
}
