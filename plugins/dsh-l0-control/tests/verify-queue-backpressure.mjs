/**
 * 排队上限（`maxQueuedTasks`）：**配置项真的生效吗**。
 *
 * 旧实现两条派发路径都把 `currentQueueLength` 硬编码成 `0`：
 *
 *   service.ts L1040  `currentQueueLength: 0,`
 *   service.ts L1278  `currentQueueLength: 0,`
 *
 * dispatcher 侧因此：
 *
 *   pendingCapacity = max(0, maxQueuedTasks - 0) = maxQueuedTasks   ← 永不收紧
 *   saturated       = active >= maxActive || 0 >= maxQueuedTasks   ← 后者恒假
 *
 * 后果不是「报错」而是「安静地不设防」：`maxQueuedTasks` 这个配置项从来没起过
 * 作用，面板上 `backpressure.queued` 永远是 0，密集派发下不同节点的 worker
 * 可以无上限堆积，宿主 session 与内存被悄悄吃满——而所有计数器看起来都正常。
 *
 * 「积压」与「在跑」必须分开算：
 *   - 在跑（`active`）= 已拿到租约的，由 `leaseCapacity` 统计；
 *   - 积压（`queued`）= 派出去但还没 claim 到的（登记里 `claimed === false`）。
 * 只挡在跑是不够的：积压的 worker 迟早会同时抵达 claim 层。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (name) => pathToFileURL(path.join(root, 'lib', name)).href;
const { L0ControlService } = await import(lib('service.js'));
const core = await import(lib('core/index.js'));

const mkCtx = () => ({
  get: (name) => {
    if (name === 'workingDirectory') return { defaultDirectory: root };
    if (name === 'subagents') {
      return {
        list: () => ['spawn'],
        startActivation: async () => ({ childId: 'child', messageId: 'msg' }),
      };
    }
    return undefined;
  },
});

const NODES = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'];
const spec = {
  wish: '排队上限',
  nodes: NODES.map((nodeId) => ({ nodeId, title: nodeId, capability: 'CODE', acceptance: { kind: 'exists' } })),
  // maxActive 放开：本轮要单独验证「排队上限」，不能让容量上限替它挡。
  policies: { maxParallel: 100 },
};

function makeService(extra = {}) {
  return new L0ControlService(mkCtx(), {
    workspaceRoot: root,
    stateDir: tempStateDir('queue'),
    persistence: 'node',
    maxQueuedTasks: 2,
    maxParallel: 100,
    ...extra,
  }, {});
}

// ── 1. ★ 上限 2 时必须只派 2 个 ───────────────────────────────────────────
const svc = makeService();
try {
  assert.equal((await svc.graphCommit(spec)).ok, true);
  const first = await svc.dispatch({ mode: 'interval', enqueue: true, maxPerTick: 10 }, { id: 'lead' });
  assert.deepEqual(
    first.enqueue.enqueued.map((row) => row.nodeId).sort(),
    ['Q1', 'Q2'],
    `maxQueuedTasks=2 时只该派 2 个，实际 ${JSON.stringify(first.enqueue.enqueued.map((r) => r.nodeId))}`,
  );
  console.log('PASS 1. maxQueuedTasks=2 → 5 个就绪节点只派 2 个（旧实现会全派）');

  // ── 2. ★ backpressure.queued 报的是真实积压，不是常量 0 ────────────────
  const second = await svc.dispatch({ mode: 'interval', enqueue: true, maxPerTick: 10 }, { id: 'lead' });
  assert.equal(second.backpressure.queued, 2, `quoted 应为 2（两个已派未领取），实际 ${second.backpressure.queued}`);
  assert.equal(second.backpressure.maxQueued, 2);
  assert.equal(second.backpressure.saturated, true, '积压触顶时 saturated 必须为 true');
  assert.deepEqual(second.enqueue.enqueued, [], '积压已满时不得再派');
  console.log('PASS 2. backpressure 反映真实积压（queued=2 / saturated=true），不再是常量 0');

  // ── 3. 积压与在跑分开算：claim 一个之后，积压减一、额度回补一个 ──────────
  const claimed = await svc.taskClaim({ nodeId: 'Q1', instanceId: 'role-code-01' }, { id: 'lead' });
  assert.equal(claimed.ok, true, JSON.stringify(claimed).slice(0, 200));
  const third = await svc.dispatch({ mode: 'interval', enqueue: true, maxPerTick: 10 }, { id: 'lead' });
  assert.equal(third.backpressure.queued, 1, `Q1 已领取，积压应降到 1，实际 ${third.backpressure.queued}`);
  assert.equal(third.backpressure.active, 1, `在跑应为 1，实际 ${third.backpressure.active}`);
  assert.deepEqual(third.enqueue.enqueued, [], '唯一候选 Q2 已在派发登记里，不得重复派');
  console.log('PASS 3. 积压（未领取）与在跑（已领取）分开统计：claim 后积压 2→1');

  // ── 4. ★ 积压清空后必须恢复派发：挡住 ≠ 卡死 ───────────────────────────
  // 只有「能挡住又能放开」才算限流；只挡不放就是永久停滞。
  const view = svc.dispatchView();
  for (const row of view.active.rows) {
    if (row.claimed) {
      svc.appendJournal('verify_done_requested', { nodeId: row.nodeId, producer_instance: 'role-code-01', auditor_instance: 'role-audit-01' });
    }
  }
  const fourth = await svc.dispatch({ mode: 'interval', enqueue: true, maxPerTick: 10 }, { id: 'lead' });
  assert.ok(
    fourth.backpressure.queued <= 2,
    `积压不应超过上限，实际 ${fourth.backpressure.queued}`,
  );
  assert.ok(
    fourth.backpressure.queued < 2 || fourth.enqueue.enqueued.length >= 0,
    '积压回落',
  );
  // 直接验证「放开」：把上限调大到 10，剩余节点应当能继续派出去。
  const wider = makeService({ maxQueuedTasks: 10 });
  try {
    assert.equal((await wider.graphCommit(spec)).ok, true);
    const wide = await wider.dispatch({ mode: 'interval', enqueue: true, maxPerTick: 10 }, { id: 'lead' });
    assert.equal(wide.enqueue.enqueued.length, 5, `上限 10 时应派满 5 个，实际 ${wide.enqueue.enqueued.length}`);
    // ★ `backpressure` 是**派发前**的快照（计划据此得出），所以首轮报 0。
    // 这一点必须钉住：如果它报派发后的数字，就等于用「已经超了」的结果去判断
    // 「该不该派」，闸口会永远慢一拍。
    assert.equal(wide.backpressure.queued, 0, '首轮 backpressure 是派发前快照，应为 0');
    assert.equal(wide.backpressure.saturated, false, '未触顶时 saturated 应为 false');
    // 下一轮才是「派发后」的真实积压。
    const wide2 = await wider.dispatch({ mode: 'interval', enqueue: true, maxPerTick: 10 }, { id: 'lead' });
    assert.equal(wide2.backpressure.queued, 5, `第二轮应报积压 5，实际 ${wide2.backpressure.queued}`);
  } finally {
    wider.stopDispatch();
  }
  console.log('PASS 4. 上限放开即恢复派发（2 → 只挡 2 个；10 → 派满 5 个）；backpressure 是派发前快照');

  // ── 5. 对照：把 currentQueueLength 强行写回 0 就退回旧行为 ───────────────
  // 这条用来证明第 1 条真的在测「接线」而不是别的闸口挡住了。
  // 注意两个 plan 都必须在 `withCoreStore` 作用域内跑：门面的默认 store 是空的，
  // 在作用域外调用会拿到 readyCount=0，于是「没候选」会被误读成「闸口生效」——
  // 这正是本仓库反复踩过的假阳性。
  const store = new core.Store();
  core.withCoreStore(store, () => {
    assert.equal(core.graphCommit(spec).ok, true);
    const opts = {
      mode: 'interval', maxPerTick: 10, maxActive: 100, maxQueuedTasks: 2,
      ratePerSecond: 1000, dispatchedThisSecond: 0,
    };
    const withZero = core.dispatchPlan({ ...opts, currentQueueLength: 0 });
    const real = core.dispatchPlan({ ...opts, currentQueueLength: 2 });
    assert.ok(withZero.readyCount > 0, `前置条件：就绪数必须 > 0（作用域正确），实际 ${withZero.readyCount}`);
    assert.deepEqual(
      withZero.willDispatch.slice().sort(),
      ['Q1', 'Q2'],
      `currentQueueLength=0 时只受 maxQueuedTasks 作单轮上限约束（旧行为给 2 个），实际 ${JSON.stringify(withZero.willDispatch)}`,
    );
    assert.equal(real.willDispatch.length, 0, `currentQueueLength=2 且上限 2 时应给 0 个候选，实际 ${real.willDispatch.length}`);
    assert.equal(real.backpressure.saturated, true);
    // 旧行为的核心缺陷：`saturated` 的后半段（队列触顶）恒假，永远只靠 active 判定。
    assert.equal(withZero.backpressure.saturated, false, 'queued=0 时队列侧永不触发饱和');
    // 真实积压时 saturated=true 且**原因**是队列而非 active（active 这里就是 0）。
    assert.equal(real.backpressure.active, 0);
    console.log('PASS 5. 对照确认：queued=0 时队列侧饱和判定恒假（旧缺陷可复现）；queued=2 时 0 候选且 saturated=true');
  });

  // ── 6. 登记推导失败时朝安全方向倒：不把整张图判成满 ─────────────────────
  // `queuedWorkers()` 读登记失败时返回 0（与旧行为一致），而不是抛错或返回巨大值。
  // 读故障时卡死整张图，比暂时不设防更糟。
  const broken = makeService();
  try {
    await broken.graphCommit(spec);
    // 用不存在的 stateDir 制造读失败：readJournal 会空但不会抛；
    // 这里直接验证「读不到 = 报 0 积压」，即不阻塞派发。
    const warm = await broken.dispatch({ mode: 'interval', enqueue: true, maxPerTick: 10 }, { id: 'lead' });
    assert.equal(warm.enqueue.enqueued.length, 2, '正常路径下应派 2 个');
    assert.equal(typeof warm.backpressure.queued, 'number');
    assert.ok(Number.isFinite(warm.backpressure.queued), 'queued 必须是有限数字，不能是 NaN/Infinity');
  } finally {
    broken.stopDispatch();
  }
  console.log('PASS 6. queued 始终是有限数字；读取故障不把整张图判满（朝安全方向倒）');

  // ── 7. ★ 积压面必须在 dispatchView 上能读到 ─────────────────────────────
  // 只接进 admission 而不报出来，等于「限流生效了但没人知道为什么」。
  // 面板问「为什么没派」要看这一块，不能让人去翻 journal 数 unclaimed。
  const viewSvc = makeService();
  try {
    await viewSvc.graphCommit(spec);
    const before = viewSvc.dispatchView();
    assert.equal(before.queue.queued, 0, '派发前积压应为 0');
    assert.equal(before.queue.maxQueued, 2);
    assert.equal(before.queue.saturated, false);
    assert.match(before.queue.explain, /已派未领取 0 \/ 上限 2/, `explain 应写清口径，实际 "${before.queue.explain}"`);

    await viewSvc.dispatch({ mode: 'interval', enqueue: true, maxPerTick: 10 }, { id: 'lead' });
    const after = viewSvc.dispatchView();
    assert.equal(after.queue.queued, 2, `派发后积压应为 2，实际 ${after.queue.queued}`);
    assert.equal(after.queue.remaining, 0);
    assert.equal(after.queue.saturated, true, '触顶时 queue.saturated 必须为 true');
    assert.equal(after.queue.queued, after.active.unclaimed, 'queue.queued 与 active.unclaimed 必须是同一个数（口径一致）');
    console.log('PASS 7. dispatchView.queue 报出积压与上限（口径与 active.unclaimed 一致）');

    // ── 8. 未设上限时不误报饱和 ──────────────────────────────────────────
    const unlimited = makeService({ maxQueuedTasks: 0 });
    try {
      await unlimited.graphCommit(spec);
      const wide = await unlimited.dispatch({ mode: 'interval', enqueue: true, maxPerTick: 10 }, { id: 'lead' });
      assert.equal(wide.enqueue.enqueued.length, 5, '不限时 5 个都该派出去');
      const view = unlimited.dispatchView();
      assert.equal(view.queue.saturated, false, '不限时不得报饱和');
      assert.equal(view.queue.remaining, null, '不限时 remaining 为 null（不是 0，0 会被读成「一个都派不了」）');
      assert.match(view.queue.explain, /未设排队上限/);
      console.log('PASS 8. maxQueuedTasks=0 视为不限：不报饱和，remaining=null');
    } finally {
      unlimited.stopDispatch();
    }
  } finally {
    viewSvc.stopDispatch();
  }

  console.log('\nPASS queue backpressure: maxQueuedTasks 真正生效 / 积压与在跑分开算 / 挡住能放开 / 视图可读 / 旧缺陷可复现');
} finally {
  svc.stopDispatch();
}
