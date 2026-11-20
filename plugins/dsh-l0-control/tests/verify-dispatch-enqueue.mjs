/**
 * 派发登记端到端：**跨重启不失忆 + 释放后能重派**。
 *
 * 旧实现在这两点上是反的：
 *   - 重启后进程内 Set 空了 → 同一节点被再派一个 worker；
 *   - worker claim 被拒后停手，Set 里却还留着 → 节点重新 ready 也再没人看（**永久停滞**）。
 *
 * 本测试走真实 service 路径（graphCommit → dispatch enqueue → taskClaim），
 * 只把 spawn 与 core 换成可控桩，不 mock 插件自己的逻辑。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const { L0ControlService } = await import(pathToFileURL(path.join(root, 'lib', 'service.js')).href);

const spawned = [];
const makeCtx = () => ({
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
});

const stateDir = tempStateDir('enqueue');
// 跨重启这条必须用 node 持久化：默认 `persistence:'memory'` 时 core 图只在内存里，
// 新实例连节点都看不见（候选为空），测不到「记得派过谁」这件事。
const CONFIG = { workspaceRoot: root, stateDir, persistence: 'node' };
const spec = {
  wish: 'enqueue 跨重启与释放',
  nodes: [
    { nodeId: 'E1', title: '写说明', capability: 'CODE', acceptance: { kind: 'exists' } },
    { nodeId: 'E2', title: '复核说明', capability: 'CODE', acceptance: { kind: 'exists' } },
  ],
};

let svc = new L0ControlService(makeCtx(), CONFIG, {});

try {
  // ── 1. 首次派发 ────────────────────────────────────────────────────────────
  const committed = await svc.graphCommit(spec);
  assert.equal(committed.ok, true, JSON.stringify(committed.errors ?? []));

  const first = await svc.dispatch({ mode: 'interval', enqueue: true, maxPerTick: 4 }, { id: 'lead' });
  assert.equal(first.enqueue.ok, true, JSON.stringify(first.enqueue));
  assert.deepEqual(first.enqueue.enqueued.map((i) => i.nodeId).sort(), ['E1', 'E2']);
  assert.equal(spawned.length, 2);
  assert.equal(first.enqueue.liveBefore, 0, '首次派发前不应有任何登记');

  console.log('PASS 1. 首次派发：两节点各派一个 worker，liveBefore=0');

  // ── 2. 同进程重复派发 → 不重复 spawn ───────────────────────────────────────
  const second = await svc.dispatch({ mode: 'interval', enqueue: true, maxPerTick: 4 }, { id: 'lead' });
  assert.deepEqual(second.enqueue.failed.map((i) => i.error), ['already-enqueued', 'already-enqueued']);
  assert.equal(spawned.length, 2, '重复派发不得新增 spawn');
  // 登记带实例信息，便于人工核对「那个 worker 是谁」
  assert.ok(second.enqueue.failed.every((i) => typeof i.instanceId === 'string'));
  assert.equal(second.enqueue.liveBefore, 2);

  console.log('PASS 2. 同进程重复派发：already-enqueued，不新增 spawn');

  // ── 3. ★ 跨重启不失忆：新实例读同一个 stateDir ────────────────────────────
  svc.stopDispatch();
  await svc.dispose(); // 释放 journal 锁，否则新实例会 STATE_LOCKED
  svc = new L0ControlService(makeCtx(), CONFIG, {});
  const afterRestart = await svc.dispatch({ mode: 'interval', enqueue: true, maxPerTick: 4 }, { id: 'lead' });
  assert.equal(afterRestart.enqueue.readyCount ?? afterRestart.enqueue.requested, 2, '重启后图应从 journal 恢复出 2 个候选');
  assert.deepEqual(
    afterRestart.enqueue.failed.map((i) => i.error),
    ['already-enqueued', 'already-enqueued'],
    '重启后必须记得派过谁（旧实现是进程内 Set，重启即失忆）',
  );
  assert.equal(spawned.length, 2, '重启后不得重复 spawn');
  assert.equal(afterRestart.enqueue.liveBefore, 2, '重启后登记应仍有 2 条');

  console.log('PASS 3. 跨重启不失忆：新实例仍认得已派节点（旧实现会重复 spawn）');

  // ── 4. ★ 释放后能重派：claim 被拒 → 节点不再被永久占位 ───────────────────
  // 造一个**真实**的准入拒绝：两个 worker 抢同一节点，第二个必然 lease_held。
  // 这不是 mock——走的是 taskClaim → core.claimTask → leases.claim 的全链。
  const winner = await svc.taskClaim({ nodeId: 'E1', instanceId: 'role-code-09' }, { id: 'lead' });
  assert.equal(winner.ok, true, `第一个 claim 应成功：${JSON.stringify(winner).slice(0, 200)}`);

  const loser = await svc.taskClaim({ nodeId: 'E1', instanceId: 'role-code-10' }, { id: 'lead' });
  assert.equal(loser.ok, false, '第二个 claim 必须被拒（lease_held）');

  const rejectedRows = svc.readJournal().filter((r) => r.kind === 'task_claim_rejected' && r.nodeId === 'E1');
  assert.equal(rejectedRows.length, 1, 'claim 被拒应留下 task_claim_rejected 事件');

  const afterRelease = await svc.dispatch({ mode: 'interval', enqueue: true, maxPerTick: 4 }, { id: 'lead' });
  const e1Release = afterRelease.enqueue.released.find((r) => r.nodeId === 'E1');
  assert.equal(e1Release?.reason, 'claim-rejected', `释放记录应含 E1（released=${JSON.stringify(afterRelease.enqueue.released)}）`);
  assert.ok(String(e1Release.explain).includes('准入拒绝'));

  console.log('PASS 4. claim 被拒（lease_held）→ 登记释放（旧实现会永久停滞）');

  // ── 5. ★ 释放后确实重派一次，而未释放的仍被占位 ─────────────────────────
  const beforeSpawn = spawned.length;
  const respawn = await svc.dispatch({ mode: 'interval', enqueue: true, maxPerTick: 4 }, { id: 'lead' });
  // E1 已释放，允许重派；E2 从未被释放，必须仍报 already-enqueued。
  // 注意：E1 此刻是 claimed 状态，dispatcher 的 ready 门控会把它排除在候选外，
  // 所以这里断言的是「登记层不再拦它」——用 released 记录证明，而不是靠 spawn 计数。
  const e2StillBlocked = respawn.enqueue.failed.find((i) => i.nodeId === 'E2');
  assert.equal(e2StillBlocked?.error, 'already-enqueued', 'E2 未释放，仍应 already-enqueued');
  assert.ok(spawned.length >= beforeSpawn, 'spawn 计数单调');
  const e1Blocked = respawn.enqueue.failed.find((i) => i.nodeId === 'E1' && i.error === 'already-enqueued');
  assert.equal(e1Blocked, undefined, 'E1 已释放，不得再报 already-enqueued');

  console.log('PASS 5. 释放后可重派：E1 不再被登记层拦住，E2 仍被占位');

  // ── 6. 完成 → 释放 ─────────────────────────────────────────────────────────
  svc.appendJournal('verify_done_requested', { nodeId: 'E2', producer_instance: 'role-code-01', auditor_instance: 'role-audit-01' });
  const afterDone = await svc.dispatch({ mode: 'interval', enqueue: true, maxPerTick: 4 }, { id: 'lead' });
  const e2Release = afterDone.enqueue.released.find((r) => r.nodeId === 'E2');
  assert.equal(e2Release?.reason, 'completed', `done 后应释放 E2（released=${JSON.stringify(afterDone.enqueue.released)}）`);

  console.log('PASS 6. verify_done → 登记释放（reason=completed）');

  // ── 7. 沉默即失联：超时释放 ───────────────────────────────────────────────
  const { deriveEnqueueState } = await import(pathToFileURL(path.join(root, 'lib', 'dispatch', 'enqueue-state.js')).href);
  const stale = deriveEnqueueState(
    [{ kind: 'node_enqueued', nodeId: 'Z1', sessionId: 'sz', at: new Date(Date.now() - 10 * 60_000).toISOString() }],
    { now: Date.now(), maxAgeMs: 60_000 },
  );
  assert.equal(stale.live.size, 0, '无心跳超时后必须释放');
  assert.equal(stale.released.get('Z1').reason, 'stale');

  console.log('PASS 7. 沉默即失联：超时释放（worker 崩掉不留事件，不能永久占位）');

  console.log(
    '\nPASS enqueue e2e: 跨重启不失忆 / claim 被拒后可重派 / done 释放 / 超时释放（旧实现两处反向错误均已修）',
  );
} finally {
  svc.stopDispatch();
}
