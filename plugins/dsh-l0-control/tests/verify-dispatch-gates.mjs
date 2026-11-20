/**
 * 四道闸门同 tick 归因：**这一轮只派了 3 个，到底是谁挡的**。
 *
 * 四道限流闸门各有各的处置方式：
 *
 * | 闸门 | 恢复方式 | 该调哪个参数 |
 * |---|---|---|
 * | `tick` | 下一轮自动 | `dispatchMaxPerTick` |
 * | `capacity` | 等 worker 完成 / 租约释放 | `maxParallel` |
 * | `partition` | 等域内 worker 完成 | 分区 `maxActive` |
 * | `rate` | 下一窗口自动 | `dispatchRatePerSecond` |
 * | `queue` | 等 claim 或释放 | `maxQueuedTasks` |
 *
 * 四者同时逼近时真正的原因只有一个——`effectiveLimit` 取的是四者的最小值。
 * 旧实现把四个数字一起塞进一句话：
 *
 *   `本轮额度已用尽（tick=32, active=0, rate=100, queue=2）`
 *
 * 读的人要自己比大小，而且 `active=0`、`rate=100` 都在暗示「还有余量」，
 * 真正见底的 `queue=2` 混在里面看不出来；机器判读更没法用——字符串里括不出
 * 「该去调哪个参数」，于是面板只能显示一句「额度已用尽」，运维只能挨个试。
 *
 * 本测试钉住三件事：**单道闸门各自归因正确**、**四者同时见底时报最该处理的那道**、
 * **分区满员优先于全局限流**（局部原因去调全局参数，永远调不好）。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (name) => pathToFileURL(path.join(root, 'lib', name)).href;
const core = await import(lib('core/index.js'));

const NODES = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'];

/** 建一张 6 节点全就绪的图，返回作用域内可用的 store。 */
function freshStore(withPartition = false) {
  const store = new core.Store();
  core.withCoreStore(store, () => {
    const spec = {
      nodes: NODES.map((nodeId) => ({
        nodeId, title: nodeId, stage: 'build', status: 'planned', deps: [], acceptance: { kind: 'exists' },
      })),
      policies: { maxParallel: 100 },
    };
    if (withPartition) {
      spec.coordination = {
        enabled: true,
        maxActive: 100,
        partitions: [
          // 分区只装 G1..G3 且 maxActive=1：G2/G3 会被分区闸门挡，G4..G6 不受影响。
          { id: 'p-tight', nodeRefs: ['G1', 'G2', 'G3'], maxActive: 1 },
          { id: 'p-loose', nodeRefs: ['G4', 'G5', 'G6'], maxActive: 100 },
        ],
      };
    }
    assert.equal(core.graphCommit(spec).ok, true, JSON.stringify(core.graphCommit(spec).errors ?? []));
  });
  return store;
}

const base = {
  mode: 'interval',
  maxPerTick: 10,
  maxActive: 100,
  maxQueuedTasks: 100,
  ratePerSecond: 100,
  currentQueueLength: 0,
  dispatchedThisSecond: 0,
};

const planned = (store, overrides) =>
  core.withCoreStore(store, () => {
    const plan = core.dispatchPlan({ ...base, ...overrides });
    // 前置条件：就绪数必须 > 0，否则「没候选」会被误读成「闸门生效」。
    assert.ok(plan.readyCount > 0, `前置条件失败：就绪数为 ${plan.readyCount}（作用域不对？）`);
    return plan;
  });

const skips = (plan) => plan.plan.filter((item) => item.action === 'skip');

// ── 1. ★ 单道闸门逐一道归因 ───────────────────────────────────────────────
{
  const store = freshStore();
  const cases = [
    ['tick', { maxPerTick: 1 }],
    ['capacity', { maxActive: 2 }],
    // rate 用小数会让 Math.floor 把余量算成 0：上限 0.5 → 余量 floor(-0)=0。
    ['rate', { ratePerSecond: 1, dispatchedThisSecond: 1 }],
    ['queue', { maxQueuedTasks: 2, currentQueueLength: 2 }],
  ];
  for (const [expected, overrides] of cases) {
    const plan = planned(store, overrides);
    const skip = skips(plan);
    assert.ok(skip.length > 0, `${expected}: 应至少有一个跳过项`);
    assert.equal(skip[0].gate, expected, `${expected}: 归因错了，实际 ${skip[0].gate}（reason=${skip[0].reason}）`);
    assert.match(skip[0].reason, new RegExp(`（${expected}）`), `${expected}: reason 里应写明闸门名`);
    // 人话建议必须能指导行动：每道闸门都要说「现在该做什么」。
    assert.ok(skip[0].reason.length > 20, `${expected}: reason 太短，看不出该做什么`);
    assert.ok(
      /下一轮|等|调/.test(skip[0].reason),
      `${expected}: reason 缺少可操作建议（实际 "${skip[0].reason}"）`,
    );
  }
}
console.log('PASS 1. 四道限流闸门各自归因正确，reason 带闸门名与可操作建议');

// ── 2. ★ 四者同时见底：报最该处理的那道（不是 tick）────────────────────────
// 这是旧实现最误导的场景：四道全见底时它报「本轮额度已用尽」并列四个数字，
// 而 `tick` 是四者里**最容易恢复**的一个。报 tick 会让人以为等下一轮就好。
{
  const store = freshStore();
  const plan = planned(store, {
    maxPerTick: 2, maxActive: 1, maxQueuedTasks: 1, ratePerSecond: 1, currentQueueLength: 1, dispatchedThisSecond: 1,
  });
  const skip = skips(plan);
  assert.ok(skip.length > 0);
  // queue 的额度是 1-1=0，是四者最小值 → 报 queue。
  assert.equal(skip[0].gate, 'queue', `四者同时见底时应报额度最小的 queue，实际 ${skip[0].gate}（${skip[0].reason}）`);
  assert.equal(plan.willDispatch.length, 0);
}
console.log('PASS 2. 四者同时见底报额度真正最小的那道（queue=0），不误报 tick');

// ── 3. ★ 额度为 0 必须被报出来，不能被跳过 ─────────────────────────────────
// 第一版写法是 `if (!(gap > 0)) continue`，于是「额度 0」被当成「这道没限制」
// 跳过，永远报出第二小的那个 —— 反向建议，不崩不报错。这条钉住它。
{
  const store = freshStore();
  const plan = planned(store, { ratePerSecond: 1, dispatchedThisSecond: 1, maxPerTick: 10 });
  const skip = skips(plan);
  assert.equal(skip[0].gate, 'rate', `rate 额度为 0 时应报 rate，实际 ${skip[0].gate}`);
  assert.match(skip[0].reason, /额度 tick=10 active=100 rate=0 queue=100/, 'reason 应附原始额度供核对');
}
console.log('PASS 3. 额度为 0 的闸门被正确报出（不被当成「没限制」跳过）');

// ── 4. ★ 分区满员优先于全局限流：局部原因不能给全局建议 ────────────────────
// 分区 maxActive 满时，去调 dispatchMaxPerTick / maxParallel 毫无作用。
{
  const store = freshStore(true);
  const plan = planned(store, { maxPerTick: 10, maxActive: 100 });
  const skip = skips(plan);
  const partitionSkip = skip.find((item) => item.gate === 'partition');
  assert.ok(partitionSkip, `应有分区闸门拦截，实际 gates=${JSON.stringify(skip.map((s) => s.gate))}`);
  assert.match(partitionSkip.reason, /协调域 p-tight/);
  // 同图另一个域不受影响：G4..G6 应被派出去。
  assert.ok(plan.willDispatch.length > 0, '宽分区应照常派活，分区隔离不能被全局限流掩盖');
  assert.ok(
    plan.willDispatch.some((nodeId) => nodeId.startsWith('G4') || nodeId.startsWith('G5') || nodeId.startsWith('G6')),
    `宽分区节点应被派，实际 ${JSON.stringify(plan.willDispatch)}`,
  );
}
console.log('PASS 4. 分区满员单独归因为 partition，且不影响其它分区（局部原因不给全局建议）');

// ── 5. gates 汇总：一眼看出「为什么只派了 3 个」────────────────────────────
{
  const store = freshStore(true);
  const plan = planned(store, { maxPerTick: 10, maxActive: 100 });
  assert.ok(plan.gates, '结果必须带 gates 汇总');
  assert.ok((plan.gates.partition ?? 0) > 0, `gates 应含 partition 计数，实际 ${JSON.stringify(plan.gates)}`);
  // summary 里也要能读到，因为面板/日志主要看这一行。
  assert.match(plan.summary, /partition×\d+/, `summary 应含闸门计数，实际 "${plan.summary}"`);
  // 计数字段之和应等于带 gate 的跳过数
  const withGate = skips(plan).filter((item) => item.gate).length;
  const summed = Object.values(plan.gates).reduce((sum, n) => sum + n, 0);
  assert.equal(summed, withGate, `gates 之和 ${summed} 应等于带 gate 的跳过数 ${withGate}`);
}
console.log('PASS 5. gates 汇总与 summary 都报出闸门分布（之和等于带 gate 的跳过数）');

// ── 6. 预算 / 巡检 / 防重放也各归各的 gate，不混进限流 ──────────────────────
{
  const store = new core.Store();
  core.withCoreStore(store, () => {
    assert.equal(core.graphCommit({
      nodes: [
        { nodeId: 'B1', title: 'B1', stage: 'build', status: 'planned', deps: [], acceptance: { kind: 'exists' }, budget: { maxTokens: 10 } },
        { nodeId: 'B2', title: 'B2', stage: 'build', status: 'planned', deps: [], acceptance: { kind: 'exists' } },
      ],
      policies: { maxParallel: 100 },
    }).ok, true);
  });
  // 把 B1 的预算烧完，让它进 budget 闸门。
  store.journal.append('evidence_added', 'B1', { usageTokens: 10 });
  const plan = planned(store, {});
  const b1 = plan.plan.find((item) => item.nodeId === 'B1');
  assert.equal(b1?.gate, 'budget', `B1 应归因为 budget，实际 ${b1?.gate}（${b1?.reason}）`);
  assert.match(b1.reason, /预算拦截/);
  // B2 没有预算上限，应照常派。
  assert.ok(plan.willDispatch.includes('B2'), `B2 应被派，实际 ${JSON.stringify(plan.willDispatch)}`);
}
console.log('PASS 6. 预算拦截归因为 budget，不影响无预算上限的节点');

// ── 7. 未触发任何限流时 gates 为空，不制造噪声 ─────────────────────────────
{
  const store = freshStore();
  const plan = planned(store, { maxPerTick: 100, maxActive: 100, maxQueuedTasks: 100, ratePerSecond: 1000 });
  assert.equal(plan.willDispatch.length, NODES.length, `全部节点应被派，实际 ${plan.willDispatch.length}`);
  assert.deepEqual(plan.gates, {}, `无限流时 gates 应为空对象，实际 ${JSON.stringify(plan.gates)}`);
  assert.ok(!plan.summary.includes('（'), `无限流时 summary 不该带括号计数，实际 "${plan.summary}"`);
}
console.log('PASS 7. 无限流时 gates 为空、summary 不带计数（不制造噪声）');

// ── 8. ★ 闸门分布要贯通到 journal 与面板：事后查得到、面板读得对 ──────────
// `gates` 只留在 dispatchPlan 的返回值里是没用的——那个对象一返回就丢了。
// 必须钻进 journal（跨重启仍在的权威记录）与 dispatchView（面板读的那一份）。
{
  const { L0ControlService } = await import(lib('service.js'));
  const mkCtx = () => ({
    get: (name) => {
      if (name === 'workingDirectory') return { defaultDirectory: root };
      if (name === 'subagents') {
        return { list: () => ['spawn'], startActivation: async () => ({ childId: 'c', messageId: 'm' }) };
      }
      return undefined;
    },
  });
  const svc = new L0ControlService(mkCtx(), {
    workspaceRoot: root,
    stateDir: tempStateDir('gates'),
    persistence: 'node',
    maxQueuedTasks: 2,
    maxParallel: 100,
  }, {});
  try {
    await svc.graphCommit({
      nodes: ['Y1', 'Y2', 'Y3', 'Y4'].map((nodeId) => ({
        nodeId, title: nodeId, capability: 'CODE', acceptance: { kind: 'exists' },
      })),
      policies: { maxParallel: 100 },
    });
    svc.dispatchOverride = { mode: 'interval', dryRun: false, maxPerTick: 10 };
    svc.lastCaller = { id: 'lead' };

    await svc.dispatchTick();
    const tickRow = svc.readJournal().filter((row) => row.kind === 'dispatch_tick').at(-1);
    assert.ok(tickRow.gates, `dispatch_tick 必须落 gates，实际 ${JSON.stringify(tickRow.gates)}`);
    assert.equal(tickRow.gates.queue, 2, `首轮 4 个就绪派 2 个、剩 2 个被排队挡，实际 ${JSON.stringify(tickRow.gates)}`);

    // dispatchView 必须**折叠 journal** 得出，而不是自己再算一遍：
    // 两次计算之间状态会变（worker claim 了、租约过期了），重算的原因与日志、
    // 与 worker 实际收到的指示都会不一致。
    const view = svc.dispatchView();
    assert.ok(view.lastTick, 'dispatchView 必须带 lastTick');
    assert.equal(view.lastTick.gates.queue, 2, `lastTick.gates 应从 journal 折叠，实际 ${JSON.stringify(view.lastTick.gates)}`);
    assert.equal(view.lastTick.ready, 4);
    assert.equal(view.lastTick.spawned, 2);

    // 第二轮的闸门分布应更新，而不是留着旧值。
    await svc.dispatchTick();
    const view2 = svc.dispatchView();
    assert.equal(view2.lastTick.gates.queue, 4, `第二轮 4 个全被排队挡，实际 ${JSON.stringify(view2.lastTick.gates)}`);
    console.log('PASS 8. gates 贯通 journal → dispatchView.lastTick（面板读的是折叠值，不是重算值）');
  } finally {
    svc.stopDispatch();
  }
}

console.log('\nPASS dispatch gates: 四道闸门同 tick 各自归因 / 同时见底报最该处理的那道 / 分区局部优先 / gates 汇总可读 / 贯通到 journal 与面板');
