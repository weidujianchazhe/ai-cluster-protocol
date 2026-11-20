/**
 * 闸门命中的跨轮累积：最近一轮回答不了「这段时间主要卡在哪」。
 *
 * 第 19/20 轮把「这一轮为什么只派了 3 个」做成可归因（`gate` 字段 + `gates` 汇总）。
 * 但面板只报**最近一轮**。排障时真正问的是：
 *
 *   派了半小时，600 轮里 580 轮只派了 1 个 —— 到底卡在哪道闸门？
 *
 * 逐轮看行不通：瞬时原因让相邻两轮完全不同（这一轮 capacity、下一轮 rate），
 * 随便挑一轮得出的结论随取样时刻漂移。累积视图把窗口内所有轮次加起来，
 * 得到与取样时刻无关的分布。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (name) => pathToFileURL(path.join(root, 'lib', name)).href;
const { foldGateHistory } = await import(lib('dispatch/gate-history.js'));

const T0 = Date.parse('2026-11-20T00:00:00.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();

/** 造一行 `dispatch_tick`；`gates` 传 undefined 就是「旧版本写的、没有归因」的行。 */
const tick = (ms, gates) => ({
  kind: 'dispatch_tick',
  at: at(ms),
  ...(gates === undefined ? {} : { gates }),
});

// ── 1. ★ 累积分布：多轮不同闸门求和，dominant 取最多的那个 ─────────────────
{
  const rows = [
    tick(0, { capacity: 3 }),
    tick(1000, { rate: 1 }),
    tick(2000, { capacity: 2 }),
    tick(3000, { queue: 1 }),
    tick(4000, { capacity: 1 }),
  ];
  const history = foldGateHistory(rows, T0 + 5000, { windowMs: 60_000 });
  assert.equal(history.ticks, 5, `应计入 5 轮，实际 ${history.ticks}`);
  assert.equal(history.counts.capacity, 6, `capacity 累计应为 3+2+1=6，实际 ${history.counts.capacity}`);
  assert.equal(history.counts.rate, 1);
  assert.equal(history.counts.queue, 1);
  assert.equal(history.dominant, 'capacity', `dominant 应是 capacity，实际 ${history.dominant}`);
  assert.match(history.explain, /主要卡在 capacity/, `explain 应点名 capacity，实际 "${history.explain}"`);
  assert.match(history.explain, /累计 6 个节点/);
  console.log('PASS 1. 多轮闸门命中求和，dominant 取累计最多的那道并给处置建议');
}

// ── 2. ★ 缺 `gates` 的旧行不能算作「本轮没被挡」─────────────────────────────
// 这是最容易出错的一处：把「没有数据」当成「没有问题」，命中率被系统性低估，
// 而低估的方向正好是「看起来一切正常」。
{
  const rows = [
    tick(0, { capacity: 5 }),
    tick(1000, undefined), // 旧版本写的行
    tick(2000, undefined),
    tick(3000, {}), // 新版本写的「确实没挡」
  ];
  const history = foldGateHistory(rows, T0 + 4000, { windowMs: 60_000 });
  assert.equal(history.ticks, 4);
  assert.equal(history.unknownTicks, 2, `应识别出 2 轮无归因数据，实际 ${history.unknownTicks}`);
  assert.equal(history.cleanTicks, 1, `应识别出 1 轮确实没挡，实际 ${history.cleanTicks}`);
  assert.equal(history.counts.capacity, 5, '无归因的行不得混进命中统计');
  assert.match(history.explain, /2 轮无归因数据/, `explain 必须说明有数据缺口，实际 "${history.explain}"`);
  console.log('PASS 2. 缺 gates 的旧行单列 unknownTicks（不把「没数据」当「没问题」）');
}

// ── 3. ★ 窗口与优先级：并列时按「越难恢复越优先」，与逐轮归因同序 ────────────
// 两个视图对同一批数据给出不同的「主要瓶颈」是最坏的情况：面板说 capacity、
// 逐轮说 queue，看的人只会认为统计坏了。
{
  const rows = [tick(0, { capacity: 2, queue: 2, tick: 2 })];
  const history = foldGateHistory(rows, T0 + 1000, { windowMs: 60_000 });
  assert.equal(history.dominant, 'capacity', `三者并列时报 capacity（最难恢复），实际 ${history.dominant}`);

  // 窗口外的行不计入
  const old = [
    tick(-120_000, { capacity: 100 }),
    tick(0, { rate: 1 }),
  ];
  const windowed = foldGateHistory(old, T0 + 1000, { windowMs: 60_000 });
  assert.equal(windowed.ticks, 1, `窗口内应只有 1 轮，实际 ${windowed.ticks}`);
  assert.equal(windowed.counts.capacity, undefined, '窗口外的行不得计入');
  assert.equal(windowed.dominant, 'rate');
  console.log('PASS 3. 并列时按难恢复优先（与逐轮归因同序）；窗口外的行不计入');
}

// ── 4. ★ 空窗口与「确实没挡」要说不同的话 ────────────────────────────────
{
  const empty = foldGateHistory([], T0, { windowMs: 60_000 });
  assert.equal(empty.ticks, 0);
  assert.equal(empty.dominant, null);
  assert.match(empty.explain, /没有派发轮次/, `空窗口应说「没有轮次」，实际 "${empty.explain}"`);

  const clean = foldGateHistory([tick(0, {}), tick(1000, {})], T0 + 2000, { windowMs: 60_000 });
  assert.equal(clean.ticks, 2);
  assert.equal(clean.dominant, null);
  assert.equal(clean.cleanTicks, 2);
  assert.match(clean.explain, /没有被挡下的节点/, `全没挡应这么说，实际 "${clean.explain}"`);
  console.log('PASS 4. 空窗口与「确实没挡」给出不同说明（不混成一句）');
}

// ── 5. ★ 只认 `dispatch_tick`，别的行一概不看 ─────────────────────────────
// journal 里绝大多数行不是 tick。若不筛 kind，`node_enqueued` 之类会被算进轮次，
// 分母变大 → 命中率被稀释成「看起来不太卡」。
{
  const rows = [
    { kind: 'node_enqueued', at: at(0), gates: { capacity: 99 } },
    { kind: 'task_claim_rejected', at: at(500), gates: { budget: 99 } },
    tick(1000, { rate: 1 }),
  ];
  const history = foldGateHistory(rows, T0 + 2000, { windowMs: 60_000 });
  assert.equal(history.ticks, 1, `只应计入 1 个 tick，实际 ${history.ticks}`);
  assert.equal(history.counts.capacity, undefined, '非 tick 行的 gates 不得计入');
  assert.equal(history.counts.budget, undefined);
  assert.equal(history.dominant, 'rate');
  console.log('PASS 5. 只认 dispatch_tick，其它行的 gates 不污染统计');
}

// ── 6. ★ 前向兼容：不认识的闸门名保留，不崩也不悄悄丢 ────────────────────
// 新版本加了闸门（比如未来的 `host`），旧面板读新 journal 不该崩；但也不能
// 把未知闸门丢掉——那会让命中总数对不上，看起来像「统计漏了」。
{
  const rows = [tick(0, { capacity: 1, host: 5 })];
  const history = foldGateHistory(rows, T0 + 1000, { windowMs: 60_000 });
  assert.equal(history.counts.host, 5, `未知闸门应原样保留，实际 ${JSON.stringify(history.counts)}`);
  assert.equal(history.dominant, 'host', `未知闸门计数最多时应成为 dominant，实际 ${history.dominant}`);
  assert.match(history.explain, /host/, 'explain 应提到它');
  console.log('PASS 6. 未知闸门名保留并可成 dominant（前向兼容不丢数据）');
}

// ── 7. ★ 真实链路：tick 跑出来后，累积视图与 lastTick 一致 ─────────────────
// 单测折叠函数不够——必须确认 `dispatchView().gateHistory` 真的读到了那些 tick。
{
  const { L0ControlService } = await import(lib('service.js'));
  const mkCtx = () => ({
    get: (name) => {
      if (name === 'workingDirectory') return { defaultDirectory: root };
      if (name === 'subagents') return { list: () => ['spawn'], startActivation: async () => ({ childId: 'c', messageId: 'm' }) };
      return undefined;
    },
  });
  const svc = new L0ControlService(mkCtx(), {
    workspaceRoot: root,
    stateDir: tempStateDir('gatehist'),
    persistence: 'node',
    maxQueuedTasks: 2,
    maxParallel: 100,
    dispatchGateWindowMs: 120_000,
  }, {});
  try {
    await svc.graphCommit({
      nodes: ['H1', 'H2', 'H3', 'H4'].map((nodeId) => ({
        nodeId, title: nodeId, capability: 'CODE', acceptance: { kind: 'exists' },
      })),
      policies: { maxParallel: 100 },
    });
    svc.dispatchOverride = { mode: 'interval', dryRun: false, maxPerTick: 10 };
    svc.lastCaller = { id: 'lead' };

    // 三轮：第一轮派 2 个（剩 2 被 queue 挡），第二轮 4 个全被 queue 挡，第三轮同。
    for (let round = 0; round < 3; round += 1) await svc.dispatchTick();

    const view = svc.dispatchView();
    const history = view.gateHistory;
    assert.ok(history, 'dispatchView 必须带 gateHistory');
    assert.equal(history.ticks, 3, `应计入 3 轮 tick，实际 ${history.ticks}`);
    assert.equal(history.counts.queue, 2 + 4 + 4, `queue 累计应是 10，实际 ${history.counts.queue}`);
    assert.equal(history.dominant, 'queue', `dominant 应是 queue，实际 ${history.dominant}`);
    assert.equal(history.unknownTicks, 0, '本轮写的行都带 gates，不该出现无归因');
    assert.match(history.explain, /主要卡在 queue/);

    // 与 lastTick 对齐：最后一轮的 gates 应等于「最近一轮」那一份。
    assert.equal(view.lastTick.gates.queue, 4, `lastTick 应是最后一轮的 4，实际 ${view.lastTick.gates.queue}`);
    console.log('PASS 7. 真实链路：gateHistory 折叠到 3 轮，与 lastTick 各自回答不同问题且不矛盾');
  } finally {
    svc.stopDispatch();
  }
}

console.log('\nPASS gate history: 跨轮累积 / 旧行不冒充「没挡」/ 并列按难恢复优先 / 空窗口与没挡分开说 / 只认 dispatch_tick / 未知闸门前向兼容 / 真实链路贯通 / 增量与全量等价 / 过期真丢 / 硬上限同语义');

// ── 8. ★ 增量折叠必须与全量折叠逐字段等价 ─────────────────────────────────
// 这是增量版唯一的正确性标准。只要两者对同一批行给出不同结果，面板与测试就会
// 各说一套——而「统计视图对不上」是最难查的那类问题（不会崩，只是答案不一致）。
{
  const { GateHistoryFolder } = await import(lib('dispatch/gate-history.js'));
  const rows = [
    tick(0, { capacity: 3 }),
    tick(500, undefined),
    tick(1000, { rate: 1 }),
    tick(1500, {}),
    tick(2000, { queue: 2, capacity: 1 }),
    tick(2500, { host: 4 }),
  ];
  const now = T0 + 3000;
  const options = { windowMs: 60_000 };

  const bulk = foldGateHistory(rows, now, options);

  // 逐行增量：模拟「每轮派发后只看到新增行」
  const folder = new GateHistoryFolder(options);
  let incremental;
  for (let index = 0; index < rows.length; index += 1) {
    incremental = folder.fold(rows.slice(0, index + 1), now);
  }
  assert.deepEqual(incremental, bulk, '增量折叠结果必须与全量折叠逐字段相同');

  // 分块增量（模拟轮询间隔）
  const folder2 = new GateHistoryFolder(options);
  folder2.fold(rows.slice(0, 2), now);
  folder2.fold(rows.slice(0, 4), now);
  const stepped = folder2.fold(rows, now);
  assert.deepEqual(stepped, bulk, '分块增量也必须与全量等价');

  // journal 变短（旋转/截断）：必须整块重来，不能沿用旧 ring
  const rotated = folder.fold([tick(3000, { rate: 2 })], T0 + 4000);
  assert.equal(rotated.ticks, 1, `journal 变短后应只剩新行，实际 ${rotated.ticks} 轮`);
  assert.equal(rotated.counts.capacity, undefined, '旋转后不得残留旧 ring 的计数');
  assert.equal(rotated.dominant, 'rate');
  console.log('PASS 8. 增量折叠与全量折叠逐字段等价；journal 变短时整块重来');
}

// ── 9. ★ 过期条目必须真的被丢掉 ─────────────────────────────────────────
// 这正是「只存累加值」实现不了的那件事：滑动窗口要能删掉过期项。删不掉的话，
// 一小时前的旧原因会永远留在分布里，让人以为问题还在。
{
  const { GateHistoryFolder } = await import(lib('dispatch/gate-history.js'));
  const folder = new GateHistoryFolder({ windowMs: 10_000, maxTicks: 100 });
  folder.fold([tick(0, { capacity: 5 })], T0 + 1000);
  const later = folder.fold([tick(0, { capacity: 5 })], T0 + 20_000);
  assert.equal(later.ticks, 0, `旧条目应已过期，实际还剩 ${later.ticks} 轮`);
  assert.equal(later.counts.capacity, undefined, '过期条目不得继续计入分布');

  const mixed = folder.fold([tick(0, { capacity: 5 }), tick(19_000, { rate: 1 })], T0 + 20_000);
  assert.equal(mixed.ticks, 1, `窗口内应只剩 1 轮，实际 ${mixed.ticks}`);
  assert.equal(mixed.dominant, 'rate');
  console.log('PASS 9. 滑动窗口能真正丢掉过期条目（累加值存法做不到这点）');
}

// ── 10. ★ 硬上限：超过 maxTicks 丢最旧的，与全量折叠同语义 ────────────────
{
  const { GateHistoryFolder } = await import(lib('dispatch/gate-history.js'));
  const rows = Array.from({ length: 10 }, (_, index) => tick(index * 100, { capacity: index + 1 }));
  const now = T0 + 2000;
  const options = { windowMs: 60_000, maxTicks: 3 };
  const bulk = foldGateHistory(rows, now, options);
  const folder = new GateHistoryFolder(options);
  const incremental = folder.fold(rows, now);
  assert.deepEqual(incremental, bulk, '硬上限下增量也要与全量等价');
  assert.equal(incremental.ticks, 3, `应只保留最后 3 轮，实际 ${incremental.ticks}`);
  // 最后三轮是 capacity 8/9/10 → 累计 27（前面的 1..7 必须被丢掉）
  assert.equal(incremental.counts.capacity, 27, `应保留最新的 8+9+10=27，实际 ${incremental.counts.capacity}`);
  console.log('PASS 10. 超过 maxTicks 丢最旧的，增量与全量同语义');
}

// ── 11. ★ 反复调 dispatchView 不得重复计数 ────────────────────────────────
// 增量折叠只有一个坑能坑死人：游标没推进或多推进。表现是「每调一次视图，计数
// 就涨一倍」——面板自动刷新时数字会自己往上爬，看起来像派发越来越卡。
// 这条对同一个 service 连调三次视图，断言计数稳定。
{
  const { L0ControlService } = await import(lib('service.js'));
  const mkCtx = () => ({
    get: (name) => {
      if (name === 'workingDirectory') return { defaultDirectory: root };
      if (name === 'subagents') return { list: () => ['spawn'], startActivation: async () => ({ childId: 'c', messageId: 'm' }) };
      return undefined;
    },
  });
  const svc = new L0ControlService(mkCtx(), {
    workspaceRoot: root,
    stateDir: tempStateDir('gateinc'),
    persistence: 'node',
    maxQueuedTasks: 2,
    maxParallel: 100,
  }, {});
  try {
    await svc.graphCommit({
      nodes: ['K1', 'K2', 'K3', 'K4'].map((nodeId) => ({
        nodeId, title: nodeId, capability: 'CODE', acceptance: { kind: 'exists' },
      })),
      policies: { maxParallel: 100 },
    });
    svc.dispatchOverride = { mode: 'interval', dryRun: false, maxPerTick: 10 };
    svc.lastCaller = { id: 'lead' };
    await svc.dispatchTick();
    await svc.dispatchTick();

    const first = svc.dispatchView().gateHistory;
    const second = svc.dispatchView().gateHistory;
    const third = svc.dispatchView().gateHistory;
    assert.deepEqual(second, first, '第二次调视图不得改变聚合结果（游标没推进或多推进）');
    assert.deepEqual(third, first, '第三次同样');
    assert.equal(first.ticks, 2, `应计入 2 轮，实际 ${first.ticks}`);
    assert.equal(first.counts.queue, 2 + 4, `queue 累计应是 6，实际 ${first.counts.queue}`);

    // 新的一轮之后必须能看见增量（游标要真的推进）
    await svc.dispatchTick();
    const fourth = svc.dispatchView().gateHistory;
    assert.equal(fourth.ticks, 3, `新一轮应计入，实际 ${fourth.ticks}`);
    assert.equal(fourth.counts.queue, 2 + 4 + 4, `queue 应涨到 10，实际 ${fourth.counts.queue}`);
    console.log('PASS 11. 反复调视图计数稳定；新 tick 之后能看见增量（游标真推进）');
  } finally {
    svc.stopDispatch();
  }
}
