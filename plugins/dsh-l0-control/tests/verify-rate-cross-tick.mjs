/**
 * 跨 tick / 跨重启的**全局**速率控制。
 *
 * 旧实现的缺陷（实测复现）：速率窗口是 `private dispatchTimes: number[] = []`，
 * 纯进程内数组。于是 `dispatchRatePerSecond` 实际只是「单个进程生命周期内的速率」：
 *
 *   第 1 轮派出 Z1 Z2            →  进程窗口 = 2
 *   重启（同一 stateDir）        →  进程窗口 = 0      ← 归零
 *   释放 Z1 Z2 的登记后再派      →  又派出 Z1 Z2
 *   journal 里 1 秒内 node_enqueued = 4，而上限是 2
 *
 * 也就是说「全局速率控制」被一次重启绕过，而且不报错不告警——它恰好在你最需要
 * 限速的时刻失效（崩溃重启后立刻抢跑）。
 *
 * 判据改为与 claim 层一致：速率额度 = 最近 windowMs 内**实际发生过**的派发，
 * 而实际派发在 journal 里有唯一权威记录（`node_enqueued`）。窗口随 journal
 * 一起持久化，于是跨重启、跨 tick、跨实例都成立。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const { L0ControlService } = await import(pathToFileURL(path.join(root, 'lib', 'service.js')).href);
const { dispatchedInWindow, effectiveDispatched } = await import(
  pathToFileURL(path.join(root, 'lib', 'dispatch', 'rate-window.js')).href
);

let spawnCount = 0;
const mkCtx = () => ({
  get: (name) => {
    if (name === 'workingDirectory') return { defaultDirectory: root };
    if (name === 'subagents') {
      return {
        list: () => ['spawn'],
        startActivation: async () => {
          spawnCount += 1;
          return { childId: `child-${spawnCount}`, messageId: `msg-${spawnCount}` };
        },
      };
    }
    return undefined;
  },
});

// ── 1. 纯函数：窗口推导的边界 ───────────────────────────────────────────────
{
  const now = 1_800_000_000_000;
  const rows = [
    { kind: 'node_enqueued', at: new Date(now - 5000).toISOString() },
    { kind: 'node_enqueue_failed', at: new Date(now - 900).toISOString() },
    { kind: 'node_enqueued', at: new Date(now - 800).toISOString() },
    { kind: 'graph_committed', at: new Date(now - 700).toISOString() },
    { kind: 'node_enqueued', at: new Date(now - 600).toISOString() },
    { kind: 'node_enqueued', at: new Date(now - 100).toISOString() },
  ];
  assert.equal(dispatchedInWindow(rows, now, 1000), 3, '只数窗口内的 node_enqueued，失败与其它事件不算');
  assert.equal(dispatchedInWindow(rows, now, 6000), 4);
  assert.equal(dispatchedInWindow([], now, 1000), 0);

  // 缺时间戳的行跳过而不是当成「很久以前」——宁可少算也不误挡
  const messy = [{ kind: 'node_enqueued' }, { kind: 'node_enqueued', at: 'not-a-date' }];
  assert.equal(dispatchedInWindow(messy, now, 1000), 0);

  // 取较大者：journal 可能少算刚写进去的那几次
  assert.equal(effectiveDispatched(3, 0), 3);
  assert.equal(effectiveDispatched(0, 5), 5);
  assert.equal(effectiveDispatched(2, 4), 4);
  assert.equal(effectiveDispatched(0, 0), 0);
  assert.equal(effectiveDispatched(-1, Number.NaN), 0);
  console.log('PASS 1. 窗口推导：只数 node_enqueued / 缺时间戳跳过 / 进程值与推导值取大');
}

// ── 2. 尾扫早停：窗口外就停，不退化成全量 ───────────────────────────────────
{
  const now = 1_800_000_000_000;
  const rows = [];
  for (let i = 0; i < 200_000; i += 1) rows.push({ kind: 'graph_committed', at: new Date(now - 60_000 - i).toISOString() });
  rows.push({ kind: 'node_enqueued', at: new Date(now - 10).toISOString() });
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i += 1) dispatchedInWindow(rows, now, 1000);
  const perCallMs = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
  assert.ok(perCallMs < 0.5, `20 万行 journal 也必须尾扫早停，实测 ${perCallMs.toFixed(3)} ms/次`);
  console.log(`PASS 2. 20 万行 journal 下 ${perCallMs.toFixed(4)} ms/次（从尾部倒扫，超窗口即停）`);
}

// ── 3. 端到端：重启不能绕过速率上限 ─────────────────────────────────────────
{
  // 用 `tempStateDir()` 而不是自己拼 `.l0-test-rate-...`：后者被 .gitignore 挡住，
  // 于是 82 个残留目录在 `git status` 里完全看不见（第 26 轮清点时才发现）。
  const stateDir = tempStateDir('rate');
  const config = { workspaceRoot: root, stateDir, persistence: 'node', dispatchRatePerSecond: 2 };
  const nodes = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6'];

  const first = new L0ControlService(mkCtx(), config, {});
  try {
    const c = await first.graphCommit({
      wish: '跨重启速率',
      nodes: nodes.map((nodeId) => ({ nodeId, title: nodeId, capability: 'CODE', acceptance: { kind: 'exists' } })),
      policies: { maxParallel: 16 },
    });
    assert.equal(c.ok, true, JSON.stringify(c.errors ?? []));

    const r1 = await first.dispatch({ mode: 'interval', dryRun: false, enqueue: true, maxPerTick: 16 }, { id: 'lead' });
    const sent1 = r1.enqueue.enqueued.map((row) => row.nodeId);
    assert.equal(sent1.length, 2, `速率上限 2，第一轮应只派 2 个，实际 ${JSON.stringify(sent1)}`);
    await first.close?.();
  } finally {
    first.stopDispatch();
  }

  const second = new L0ControlService(mkCtx(), config, {});
  try {
    const st = await second.graphStatus({});
    assert.equal(st.graph.result.counts.nodes, nodes.length, '图状态必须跨重启存活，否则测不到速率');
    assert.equal(second.dispatchTimes.length, 0, '进程内窗口天然为空——这正是缺陷所在');

    // 释放前两个 worker 的登记（等价于它们 claim 被拒后按契约停手），
    // 否则 already-enqueued 会挡住重派，测出来的是别的原因。
    for (const nodeId of ['Z1', 'Z2']) {
      second.appendJournal('task_claim_rejected', { nodeId, at: new Date().toISOString() });
    }

    const r2 = await second.dispatch({ mode: 'interval', dryRun: false, enqueue: true, maxPerTick: 16 }, { id: 'lead' });
    const sent2 = r2.enqueue.enqueued.map((row) => row.nodeId);
    assert.deepEqual(sent2, [], `同一秒内已派 2 个（上限 2），重启后不该再派，实际派了 ${JSON.stringify(sent2)}`);

    const recent = second.readJournal()
      .filter((row) => row.kind === 'node_enqueued')
      .filter((row) => Date.now() - Date.parse(String(row.at)) < 1000);
    assert.equal(recent.length, 2, `journal 里 1 秒内应恰好 2 条 node_enqueued，实际 ${recent.length}`);

    // 视图里的速率面也必须用同一口径，否则面板显示「额度还剩 2」而实际派不出去
    const view = second.dispatchView();
    assert.equal(view.rate.usedLastSecond, 2, `dispatchView 应报 2，实际 ${view.rate.usedLastSecond}`);
    assert.equal(view.rate.remaining, 0);
    assert.equal(view.rate.saturated, true);
  } finally {
    second.stopDispatch();
  }
  console.log('PASS 3. 重启不能绕过速率上限：同秒内已派 2 个，重启后一个都派不出去');
}

console.log('\nPASS rate cross-tick: 窗口从 journal 推导（旧实现用进程内数组，重启即归零）');
cleanupTempStateDirs();
