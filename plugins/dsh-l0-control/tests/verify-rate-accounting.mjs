/**
 * 速率额度语义：**只有真派出去才烧额度**。
 *
 * 旧实现无条件把 `willDispatch.length` 塞进速率窗口，于是：
 *
 *   - dryRun 的 tick 也烧额度（"计划过"被当成"派过"）；
 *   - 候选被 already-enqueued 挡下也烧额度；
 *   - 连跑几轮之后真实派活被自己判成 `rate_limited` —— 窗口里全是没发生过的派发。
 *
 * 这类 bug 的特征是「不报错、只是越跑越慢，最后卡住不动」，所以必须有机检。
 * 本测试直接驱动 service 的 dispatch 入口，观察窗口内的记账。
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

const stateDir = tempStateDir('rate');
const svc = new L0ControlService(ctx, { workspaceRoot: root, stateDir, dispatchRatePerSecond: 4 }, {});

// 直接读私有窗口（测试专用；生产路径只经 noteDispatched 写）
const windowSize = () => {
  const now = Date.now();
  return svc.dispatchTimes.filter((at) => at > now - 1000).length;
};

const spec = {
  wish: '速率额度语义',
  nodes: [
    { nodeId: 'R1', title: 'a', capability: 'CODE', acceptance: { kind: 'exists' } },
    { nodeId: 'R2', title: 'b', capability: 'CODE', acceptance: { kind: 'exists' } },
    { nodeId: 'R3', title: 'c', capability: 'CODE', acceptance: { kind: 'exists' } },
  ],
};

try {
  const committed = await svc.graphCommit(spec);
  assert.equal(committed.ok, true, JSON.stringify(committed.errors ?? []));

  // ── 1. dryRun 的计划不烧额度 ───────────────────────────────────────────────
  // 注意：mode=off 时 `willDispatch` 恒为空（off 就是"不派"），要观察候选必须用 interval。
  const dry = await svc.dispatch({ mode: 'interval', dryRun: true, maxPerTick: 4 }, { id: 'lead' });
  assert.equal(dry.ok, true, JSON.stringify(dry).slice(0, 200));
  assert.equal(dry.dryRun, true);
  assert.ok(Array.isArray(dry.willDispatch) && dry.willDispatch.length === 3, `dryRun 应给出 3 个候选，实际 ${JSON.stringify(dry.willDispatch)}`);
  assert.equal(windowSize(), 0, `dryRun 不得消耗速率额度（窗口=${windowSize()}）`);
  console.log('PASS 1. dryRun 出候选但不烧额度（旧实现会把"计划过"记成"派过"）');

  // ── 2. 只出候选（不开 enqueue）也不烧额度 ─────────────────────────────────
  const planOnly = await svc.dispatch({ mode: 'interval', dryRun: true, maxPerTick: 4 }, { id: 'lead' });
  assert.equal(planOnly.enqueue, undefined, '未传 enqueue 不应返回 enqueue 字段');
  assert.equal(windowSize(), 0, '只出计划不烧额度');
  console.log('PASS 2. 只出候选不烧额度');

  // ── 3. 真派出去才烧额度，且按实际 spawn 数记 ──────────────────────────────
  const real = await svc.dispatch({ mode: 'interval', dryRun: false, enqueue: true, maxPerTick: 4 }, { id: 'lead' });
  assert.equal(real.enqueue.ok, true, JSON.stringify(real.enqueue));
  assert.equal(real.enqueue.enqueued.length, 3, '应真派 3 个');
  assert.equal(spawned.length, 3);
  assert.equal(windowSize(), 3, `实际派 3 个应记 3（窗口=${windowSize()}）`);
  console.log('PASS 3. 真派 3 个 → 窗口记 3');

  // ── 4. 被 already-enqueued 挡住的候选不烧额度 ─────────────────────────────
  // 等一秒让窗口自然过期，再跑一次全被挡的派发。
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(windowSize(), 0, '一秒后窗口应自然清空');
  const blocked = await svc.dispatch({ mode: 'interval', dryRun: false, enqueue: true, maxPerTick: 4 }, { id: 'lead' });
  assert.deepEqual(blocked.enqueue.enqueued, [], '全部应被 already-enqueued 挡下');
  assert.equal(windowSize(), 0, `被挡下的派发不得烧额度（窗口=${windowSize()}）`);
  console.log('PASS 4. 全被 already-enqueued 挡下 → 不烧额度');

  // ── 5. 窗口里只留一秒内的记录 ─────────────────────────────────────────────
  svc.noteDispatched(2, Date.now());
  assert.equal(windowSize(), 2);
  svc.noteDispatched(5, Date.now() - 2000); // 两秒前 → 应被清掉
  assert.equal(windowSize(), 2, `过期记录不得留在窗口里（窗口=${windowSize()}）`);
  console.log('PASS 5. 窗口只保留一秒内记录');

  // ── 6. noteDispatched(0) 是 no-op，负值不会被当成负额度 ───────────────────
  svc.noteDispatched(0, Date.now());
  assert.equal(windowSize(), 2);
  svc.noteDispatched(-5, Date.now());
  assert.equal(windowSize(), 2, '负值不得减少额度');
  console.log('PASS 6. noteDispatched(0) / 负值 都是 no-op');

  // ── 7. ★ 定时器 tick：出候选 → 真派 → 才记额度；无 caller 时显式留痕 ──────
  // `dispatchTick` 以前只跑 dispatchPlan（纯计划）就写日志收工：`willDispatch: N`
  // 看着像派了 N 个，**实际没有任何 worker 被派出去**。这类"看起来在干活其实没干"
  // 比崩溃难发现得多，所以要同时钉住三件事：真派 / 按真实数记账 / 无 caller 时留痕。
  const freshStateDir = trackTempStateDir(`${stateDir}-tick`);
  const fresh = new L0ControlService(
    ctx,
    { workspaceRoot: root, stateDir: freshStateDir, dispatchRatePerSecond: 4 },
    {},
  );
  try {
    const c2 = await fresh.graphCommit({
      wish: 'tick 记账',
      nodes: [
        { nodeId: 'T1', title: 't1', capability: 'CODE', acceptance: { kind: 'exists' } },
        { nodeId: 'T2', title: 't2', capability: 'CODE', acceptance: { kind: 'exists' } },
      ],
    });
    assert.equal(c2.ok, true, JSON.stringify(c2.errors ?? []));

    // 先看「没有 caller」时：不假装成功，要留一条可检索的事件
    await fresh.dispatch({ mode: 'interval', dryRun: false, maxPerTick: 4 }, { id: 'lead' });
    // 清掉 dispatch() 自己绑的 lastCaller，模拟"重启后定时器先醒、还没有任何调用"
    fresh.lastCaller = null;
    await fresh.dispatchTick();
    const noCallerTick = fresh.readJournal().filter((r) => r.kind === 'dispatch_tick').at(-1);
    assert.equal(Number(noCallerTick.spawned), 0, '无 caller 时不该派');
    assert.equal(noCallerTick.error, 'tick-no-caller', `应显式标注原因，实际 ${noCallerTick.error}`);
    assert.ok(
      fresh.readJournal().some((r) => r.kind === 'dispatch_tick_no_caller'),
      '无 caller 必须留一条可检索事件（静默空转是定时器最坏的失败方式）',
    );
    console.log('PASS 7a. tick 无 caller → 不派、显式记 tick-no-caller');

    // 再让 caller 就绪：tick 应真的 spawn，并按真实数记额度
    fresh.lastCaller = { id: 'lead' };
    const beforeTick = spawned.length;
    await fresh.dispatchTick();
    const tickRow = fresh.readJournal().filter((r) => r.kind === 'dispatch_tick').at(-1);
    assert.ok(Number(tickRow.willDispatch) > 0, `tick 应产出候选，实际 ${tickRow.willDispatch}`);
    assert.equal(Number(tickRow.spawned), 2, `tick 应真派 2 个，实际 ${tickRow.spawned}`);
    assert.equal(Number(tickRow.rateRecorded), 2, '额度按真实 spawn 数记');
    assert.equal(spawned.length - beforeTick, 2, '真的发出了 2 次 startActivation');
    assert.equal(
      fresh.dispatchTimes.filter((at) => at > Date.now() - 1000).length,
      2,
      '窗口里应是 2 条真实派发记录',
    );
    console.log('PASS 7b. tick 有 caller → 真派 2 个，额度记 2（旧实现只写计划、假记额度）');

    // 再跑一轮：两个节点都已登记 → 不该重复派，也不该再记额度
    const beforeSecond = spawned.length;
    await fresh.dispatchTick();
    const secondRow = fresh.readJournal().filter((r) => r.kind === 'dispatch_tick').at(-1);
    assert.equal(Number(secondRow.spawned), 0, '已登记节点不得重复派');
    assert.equal(spawned.length, beforeSecond, '没有新的 startActivation');
    console.log('PASS 7c. tick 第二轮不重复派（already-enqueued 生效）');

    // ── 7d. ★ tick 必须把闸门分布记进 journal ──────────────────────────────
    // 事后查「那天为什么只派了 3 个」时，journal 是唯一跨重启仍在的证据。
    // 只记 `ready`/`willDispatch` 反推不出来：ready 20 派 3 既可能是 tick 到量，
    // 也可能是容量/速率/排队——三者处置方式完全不同（调哪个参数都不一样）。
    // 上一轮把 `gates` 加进 dispatchPlan 返回值，但 dispatchTick 的日志漏了它；
    // 这条断言就是那次遗漏的守卫。
    const gateRows = fresh.readJournal().filter((r) => r.kind === 'dispatch_tick' && r.gates);
    assert.ok(gateRows.length > 0, 'dispatch_tick 必须带 gates 字段');
    const lastGates = gateRows.at(-1).gates;
    assert.equal(typeof lastGates, 'object', `gates 应是对象，实际 ${JSON.stringify(lastGates)}`);
    console.log('PASS 7d. tick 的 journal 行带 gates（跨重启仍能查出被哪道闸门挡）');
  } finally {
    fresh.stopDispatch();
  }

  console.log('\nPASS rate accounting: dryRun/候选/被挡都不烧额度，只有真实 spawn 才记（旧实现无条件记账）');
} finally {
  svc.stopDispatch();
}
