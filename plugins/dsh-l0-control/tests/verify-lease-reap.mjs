/**
 * 崩溃 worker 的早回收：**过期的租约必须有人收，否则节点永久卡死**。
 *
 * 第 26 轮之前的三个缺陷（每个都单独能卡住整张图）：
 *
 *   1. `core/leases.ts` 的 `expire()` 是**死代码**——只有 selfcheck 与一个观测测试调它。
 *      生产路径里没有任何人回收过期租约。后果不是「晚一点」而是**永久**：
 *         worker 崩 → 租约到期 → `leaseCapacity` 已跳过它（容量看着是空的）
 *         → 但节点状态仍是 `claimed`、`readySet` 不含它 → 调度器永远看不到它
 *         → 新 worker 来 claim 得到 `lease_expired`「请先 expire 或 takeover」
 *         → 四条路全堵死，只能靠人手动接管。
 *
 *   2. 派发登记只有**一个** 30 分钟的失联阈值，而它要回答两个不同的问题：
 *         - 「派了但从没 claim」（worker 崩在启动）——没有任何存活信号，该早放；
 *         - 「claim 过、之后安静」（可能在长跑）——沉默可疑但可能还活着，要等久。
 *      共用一个数 ⇒ 100 个崩在启动的 worker 会把 `queuedWorkers()` 顶满 30 分钟，
 *      期间 `maxQueuedTasks` 被幽灵登记吃光，queue 闸门把新节点全挡住（实测 100% 卡死）。
 *
 *   3. 租约回收与派发登记是两本账（core 哈希链 journal / flat service journal），
 *      回收了租约却不写扁平事件 ⇒ 节点回到 ready，但登记仍是 `live`，
 *      `enqueuePlan` 以 `already-enqueued` 跳过它 —— 重新可就绪却再也不会被派出去。
 *
 * 本测试只断言**语义**，不把性能数字写进来（数字归 `_probe-*.mjs`）。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (name) => pathToFileURL(path.join(root, 'lib', name)).href;

const {
  Store, withCoreStore, commitGraph, bootstrap, claim, currentLease,
  reapExpiredLeases, readySet, foldEvents, graphStatus,
} = await import(lib('core/index.js'));
const { applyEnqueueRows, sweepStale, emptyEnqueueState, explainRelease } = await import(
  lib('dispatch/enqueue-state.js')
);
const { L0ControlService } = await import(lib('service.js'));

/**
 * `svc.graphStatus()` 把 core 结果嵌在 `graph` 里，而 `withCore` 又包了一层
 * `{ok, action, result, persistence}`。这里只取真正的 core 结果。
 */
const unwrap = (wrapped) => {
  const inner = wrapped && typeof wrapped === 'object' && 'graph' in wrapped ? wrapped.graph : wrapped;
  return inner && typeof inner === 'object' && 'result' in inner ? inner.result : inner;
};

let now = 1_800_000_000_000;
const clock = { nowMs: () => now, nowIso: () => new Date(now).toISOString() };

function makeStore(nodeIds = ['N1', 'N2']) {
  const store = new Store({ clock });
  const result = commitGraph(store, {
    wish: '租约回收',
    policies: { maxParallel: 8 },
    nodes: nodeIds.map((nodeId) => ({ nodeId, title: nodeId, capability: 'CODE', acceptance: { kind: 'exists' } })),
  });
  assert.equal(result.ok, true, `建图失败：${JSON.stringify(result.errors ?? result)}`);
  bootstrap(store);
  return store;
}

try {
  // ══════════════════════════════════════════════════════════════════════════
  // 1. 过期租约必须回收：节点回到 ready、attempts+1、journal 留痕
  // ══════════════════════════════════════════════════════════════════════════
  {
    const store = makeStore();
    const lease = claim(store, 'N1', 'worker-1', { ttlSec: 600, now });
    assert.equal(store.state.nodes.get('N1').status, 'claimed');

    // worker 崩溃：不发心跳、不释放。TTL 600s 已过。
    const later = now + 601_000;
    const beforeJournal = store.journal.count();
    withCoreStore(store, () => {
      const report = reapExpiredLeases({ now: later });
      assert.deepEqual(report.reaped, ['N1'], '应回收 N1');
      assert.equal(report.count, 1);
      assert.equal(report.leases.expired, 0, '回收后不应再有过期租约');
      assert.equal(report.leases.live, 0);
      assert.equal(report.nodes[0].status, 'ready', `节点应回到 ready，实际 ${report.nodes[0].status}`);
      assert.equal(report.nodes[0].attempts, 1, '一次崩溃算一次 attempt');
      assert.ok(report.ready.includes('N1'), `readySet 应含 N1：${JSON.stringify(report.ready)}`);
    });
    assert.equal(store.state.nodes.get('N1').status, 'ready');
    assert.equal(store.state.leases.has('N1'), false, '内存里不得留下幽灵租约');
    assert.ok(store.journal.count() > beforeJournal, '回收必须写 journal（否则重启后租约复活）');

    const kinds = store.journal.raw().map((ev) => ev.kind);
    assert.ok(kinds.includes('lease_expired'), 'journal 里应有 lease_expired');
    assert.ok(kinds.includes('status_changed'), 'journal 里应有 status_changed');
    assert.ok(kinds.includes('attempts_changed'), 'journal 里应有 attempts_changed');

    // 跨重启：fold 重放后租约不得复活、节点仍是 ready
    const replayed = foldEvents(store.journal.raw());
    assert.equal(replayed.leases.has('N1'), false, '重放后租约不得复活');
    assert.equal(replayed.nodes.get('N1').status, 'ready', '重放后节点应仍为 ready');
    assert.equal(replayed.nodes.get('N1').attempts, 1);

    // 幂等：再收一次什么都不该发生
    const beforeIdempotent = store.journal.count();
    withCoreStore(store, () => {
      const again = reapExpiredLeases({ now: later + 10_000 });
      assert.deepEqual(again.reaped, [], '没有过期租约时不得重复回收');
      assert.equal(again.count, 0);
    });
    assert.equal(store.journal.count(), beforeIdempotent, '幂等调用不得写 journal');

    // 回收后可以被下一个 worker claim，且 fencing token 单调 +1
    const next = claim(store, 'N1', 'worker-2', { ttlSec: 600, now: later });
    assert.equal(next.fencing_token, lease.fencing_token + 1, 'token 必须单调递增（旧 holder 被 fenced out）');
    assert.equal(store.state.nodes.get('N1').status, 'claimed');

    console.log('PASS 1. 过期租约回收：ready / attempts+1 / journal 留痕 / 重放不复活 / 幂等 / token 单调');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 2. 未过期的租约绝不动它（回收是对契约的执行，不是猜测）
  // ══════════════════════════════════════════════════════════════════════════
  {
    const store = makeStore(['L1']);
    claim(store, 'L1', 'alive-worker', { ttlSec: 600, now });
    const before = store.journal.count();
    withCoreStore(store, () => {
      const report = reapExpiredLeases({ now: now + 599_000 });
      assert.deepEqual(report.reaped, [], '未到期的租约不得被回收');
      assert.equal(report.leases.live, 1);
      assert.equal(report.leases.expired, 0);
      assert.ok(!report.ready.includes('L1'), '持租约中的节点不得出现在 ready');
    });
    assert.equal(store.journal.count(), before, '未到期时不得写 journal');
    assert.equal(currentLease(store, 'L1').owner, 'alive-worker');

    console.log('PASS 2. 未到期租约不动：零写入、不进 ready、owner 不变');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3. 自愈入口是 `task_next`，不是让 claim 偷偷回收
  //    （`claim` 保留「请先 expire 或 takeover」这条有意契约：禁止 token 静默轮转）
  // ══════════════════════════════════════════════════════════════════════════
  {
    const store = makeStore(['C1']);
    const dead = claim(store, 'C1', 'dead-worker', { ttlSec: 600, now });
    now += 601_000;
    const { claimTask, nextTask } = await import(lib('core/index.js'));

    // 契约仍然成立：过期租约不能直接覆盖
    withCoreStore(store, () => {
      assert.throws(() => claimTask({ nodeId: 'C1', instanceId: 'fresh-worker' }), { code: 'lease_expired' });
    });

    // 但 `task_next` 一次就把节点救回来了（这就是「问一次就自愈」）
    let next;
    withCoreStore(store, () => {
      next = nextTask({});
    });
    assert.deepEqual(next.reaped, ['C1'], 'task_next 应回收过期租约');
    assert.ok(next.ready.includes('C1'), `回收后 C1 应就绪：${JSON.stringify(next.ready)}`);

    let claimed;
    withCoreStore(store, () => {
      claimed = claimTask({ nodeId: 'C1', instanceId: 'fresh-worker' });
    });
    assert.equal(claimed.ok, true, `回收后应可正常 claim：${JSON.stringify(claimed).slice(0, 200)}`);
    assert.equal(claimed.lease.owner, 'fresh-worker');
    assert.equal(claimed.lease.fencing_token, dead.fencing_token + 1, '新 token 必须单调 +1（旧 holder 被 fenced out）');
    assert.equal(claimed.node.attempts, 1, '崩溃的那次应计一次 attempt');

    console.log('PASS 3. task_next 自愈：过期租约回收 → 就绪 → 可 claim；claim 的“先 expire”契约不变');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 4. 两个失联阈值：未 claim 的早放（never-claimed），已 claim 的等久（stale）
  // ══════════════════════════════════════════════════════════════════════════
  {
    const T0 = Date.parse('2026-11-20T00:00:00.000Z');
    const iso = (ms) => new Date(ms).toISOString();
    const build = () => {
      const state = emptyEnqueueState();
      applyEnqueueRows(state, [
        // A：派出去了，从没 claim（worker 崩在启动）
        { kind: 'node_enqueued', nodeId: 'A', sessionId: 'SA', at: iso(T0) },
        // B：claim 过，之后安静（可能在长跑）
        { kind: 'node_enqueued', nodeId: 'B', sessionId: 'SB', at: iso(T0) },
        { kind: 'task_claimed', nodeId: 'B', at: iso(T0 + 5_000) },
      ]);
      return state;
    };
    const at5min = sweepStale(build(), {
      now: T0 + 5 * 60_000,
      maxAgeMs: 30 * 60_000,
      unclaimedMaxAgeMs: 2 * 60_000,
    });
    assert.equal(at5min.live.has('A'), false, 'A 从没 claim，5 分钟时早该释放');
    assert.equal(at5min.released.get('A').reason, 'never-claimed');
    assert.ok(at5min.live.has('B'), 'B 在长跑，5 分钟时必须留着');
    assert.ok(String(explainRelease(at5min.released.get('A'))).includes('一直没 claim'));

    // 到 31 分钟，B 才被判 stale
    const at31 = sweepStale(at5min, { now: T0 + 31 * 60_000, maxAgeMs: 30 * 60_000, unclaimedMaxAgeMs: 120_000 });
    assert.equal(at31.live.has('B'), false, '31 分钟时 B 应判失联');
    assert.equal(at31.released.get('B').reason, 'stale');
    assert.ok(String(explainRelease(at31.released.get('B'))).includes('长时间无心跳'));

    // 旧口径向后兼容：不给 unclaimedMaxAgeMs 时，未 claim 的登记按 maxAgeMs 判
    const compat = sweepStale(build(), { now: T0 + 5 * 60_000, maxAgeMs: 30 * 60_000 });
    assert.ok(compat.live.has('A'), '不给新阈值时行为必须与旧版逐字节一致');
    assert.ok(compat.live.has('B'));

    console.log('PASS 4. 双阈值：never-claimed（2 分钟）与 stale（30 分钟）各管各的；旧口径不变');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 5. queue 闸门不再被幽灵登记堵死（这才是那个 30 分钟常数的真实代价）
  // ══════════════════════════════════════════════════════════════════════════
  {
    const T0 = Date.parse('2026-11-20T00:00:00.000Z');
    const iso = (ms) => new Date(ms).toISOString();
    const state = emptyEnqueueState();
    const rows = [];
    for (let i = 0; i < 100; i += 1) {
      rows.push({ kind: 'node_enqueued', nodeId: `Q${i}`, sessionId: `SQ${i}`, at: iso(T0) });
    }
    applyEnqueueRows(state, rows);
    const queued = (s) => [...s.live.values()].filter((r) => !r.claimed).length;

    const oldWay = sweepStale(state, { now: T0 + 5 * 60_000, maxAgeMs: 30 * 60_000 });
    assert.equal(queued(oldWay), 100, '旧口径：5 分钟时 100 个幽灵登记仍占着积压');

    const newWay = sweepStale(state, {
      now: T0 + 5 * 60_000,
      maxAgeMs: 30 * 60_000,
      unclaimedMaxAgeMs: 2 * 60_000,
    });
    assert.equal(queued(newWay), 0, '新口径：5 分钟时幽灵登记已全部释放');

    console.log('PASS 5. queue 闸门：100 个崩在启动的 worker 不再吃掉 30 分钟积压额度');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 6. 租约回收必须同时释放派发登记（两本账）
  // ══════════════════════════════════════════════════════════════════════════
  {
    const T0 = Date.parse('2026-11-20T00:00:00.000Z');
    const iso = (ms) => new Date(ms).toISOString();
    const state = emptyEnqueueState();
    applyEnqueueRows(state, [
      { kind: 'node_enqueued', nodeId: 'R1', sessionId: 'SR1', at: iso(T0) },
      { kind: 'task_claimed', nodeId: 'R1', at: iso(T0 + 1_000) },
    ]);
    assert.ok(state.live.has('R1'), '前置：R1 应有一条已被 claim 的活登记');

    // 回收事件到达后，登记立刻释放（不必等 30 分钟 stale）
    applyEnqueueRows(state, [{ kind: 'lease_reaped', nodeId: 'R1', at: iso(T0 + 2_000) }]);
    assert.equal(state.live.has('R1'), false, 'lease_reaped 必须释放登记');
    assert.equal(state.released.get('R1').reason, 'lease-expired');
    assert.ok(String(explainRelease(state.released.get('R1'))).includes('租约到期被回收'));

    console.log('PASS 6. 两本账对齐：lease_reaped → 登记释放（reason=lease-expired）');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 7. 端到端（真实 service）：崩溃 worker → 下一轮 tick 自动回收 → 可再派
  // ══════════════════════════════════════════════════════════════════════════
  {
    const stateDir = tempStateDir('reap');
    const CONFIG = { workspaceRoot: root, stateDir, persistence: 'node' };
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

    let svc = new L0ControlService(makeCtx(), CONFIG, {});
    try {
      const committed = await svc.graphCommit({
        wish: '崩溃回收 e2e',
        nodes: [{ nodeId: 'K1', title: '崩溃回收', capability: 'CODE', acceptance: { kind: 'exists' } }],
      });
      assert.equal(committed.ok, true, JSON.stringify(committed.errors ?? []));

      // 造一个**真的**过期租约：直接用 core 的 claim，把 now 设到过去。
      // 走的是真租约表（不是 mock），所以回收逻辑面对的是真实结构。
      const core = await svc.core();
      const persistence = await svc.persistence();
      assert.ok(persistence?.coreStore, '前置：node 持久化应已打开');
      const store = persistence.coreStore;
      const past = Date.now() - 700_000;
      const deadLease = core.claim(store, 'K1', 'crashed-worker', { ttlSec: 600, now: past });
      assert.ok(deadLease.expires_at < Date.now(), '前置：租约应已过期');

      const statusBefore = unwrap(await svc.graphStatus());
      assert.equal(statusBefore.counts.done, 0);
      const k1Before = (statusBefore.nodes ?? []).find((n) => (n.nodeId ?? n.node_id) === 'K1');
      assert.equal(k1Before?.status, 'claimed', '前置：节点应卡在 claimed');

      // 一轮 dispatch（mode 保持 off 也要回收：回收不是派发）
      const tick = await svc.dispatch({}, { id: 'lead' });
      assert.equal(tick.ok, true, `dispatch 应成功：${JSON.stringify(tick).slice(0, 200)}`);
      assert.ok(Array.isArray(tick.reaped) && tick.reaped.includes('K1'), `本轮应回收 K1：reaped=${JSON.stringify(tick.reaped)}`);

      const reapedRows = svc.readJournal().filter((r) => r.kind === 'lease_reaped' && r.nodeId === 'K1');
      assert.equal(reapedRows.length, 1, '扁平 journal 必须留一条 lease_reaped（否则登记不释放）');

      const statusAfter = unwrap(await svc.graphStatus());
      const k1After = (statusAfter.nodes ?? []).find((n) => (n.nodeId ?? n.node_id) === 'K1');
      assert.equal(k1After?.status, 'ready', `回收后节点应回到 ready，实际 ${k1After?.status}`);
      assert.ok((statusAfter.ready ?? []).includes('K1'), 'readySet 应含 K1');

      // 幂等：再跑一轮不应重复回收
      const tick2 = await svc.dispatch({}, { id: 'lead' });
      assert.deepEqual(tick2.reaped ?? [], [], '没有过期租约时不得重复回收');

      // 回收后能被正常 claim（token 递增）
      const reclaimed = await svc.taskClaim({ nodeId: 'K1', instanceId: 'role-code-77' }, { id: 'lead' });
      assert.equal(reclaimed.ok, true, `回收后应可 claim：${JSON.stringify(reclaimed).slice(0, 300)}`);
      assert.equal(reclaimed.result.lease.fencing_token, deadLease.fencing_token + 1);

      console.log('PASS 7. 端到端：崩溃租约 → tick 自动回收 → ready → 可再 claim（token+1）');
    } finally {
      svc.stopDispatch();
      await svc.dispose();
    }
  }

  console.log('\n全部通过');
} finally {
  cleanupTempStateDirs();
}
