/**
 * 探针（**修之前**的行为记录，保留作对照）：worker 崩溃后，节点到底会怎样。
 *
 * 第 27 轮已按这里的三个怀疑改完：`expire()` 接进了 `task_next` / `dispatch()` /
 * 定时 tick；未 claim 登记有了独立宽限期（`enqueueUnclaimedStaleMs`）。
 * 所以本文件现在打出的部分内容**已经不是当前行为**——它留着是为了让「改前是什么样」
 * 可复核，而不是当成活的缺陷清单。当前语义的验收在 `verify-lease-reap.mjs`。
 *
 * 三个怀疑：
 *   1. 租约过期后，`expire()` 没有任何生产调用点 → 节点永久卡在 `claimed`
 *      （不 count 容量、不进 ready、claim 报「存在过期租约，请先 expire 或 takeover」）。
 *   2. `queuedWorkers()` 数的是 `claimed=false` 的登记 → worker 崩在 claim 之前，
 *      那条登记会一直是 `claimed=false` 直到 `enqueueStaleMs`（30 分钟），
 *      30 分钟内积压只增不减 → queue 闸门撞满 → 一个都派不出去。
 *   3. 两条超时共用一个 30 分钟常数，但它们要回答的问题完全不同。
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { removeTempDir } from '../_temp-state.mjs';

const root = process.cwd();
const lib = (name) => pathToFileURL(path.join(root, 'lib', name)).href;
const { Store, commitGraph, bootstrap, claim, currentLease, expire, planDispatchTick } = await import(
  lib('core/index.js')
);
const { applyEnqueueRows, sweepStale, emptyEnqueueState } = await import(lib('dispatch/enqueue-state.js'));

const T0 = Date.parse('2026-11-20T00:00:00.000Z');
const clock = { nowMs: () => T0, nowIso: () => new Date(T0).toISOString() };

function mkStore() {
  const store = new Store({ clock });
  const result = commitGraph(store, {
    wish: '租约回收探针',
    policies: { maxParallel: 6 },
    nodes: ['N1', 'N2', 'N3'].map((id) => ({ nodeId: id, title: id, capability: 'CODE', acceptance: { kind: 'exists' } })),
  });
  if (result.ok !== true) throw new Error(`建图失败：${JSON.stringify(result.errors ?? result)}`);
  // 根节点要进 ready 才能 claim
  bootstrap(store);
  return store;
}

console.log('══ 1. 租约过期后节点卡在 claimed？（生产路径里 expire 有调用点吗）══');
{
  const store = mkStore();
  const lease = claim(store, 'N1', 'worker-1', { ttlSec: 600, now: T0 });
  console.log(`  claim 成功：token=${lease.fencing_token} expires_at=${lease.expires_at} status=${store.state.nodes.get('N1').status}`);
  // worker 崩溃：不发心跳、不释放。时间前进 11 分钟（TTL 600s 已过）。
  const later = T0 + 11 * 60_000;
  const node = store.state.nodes.get('N1');
  console.log(`  11 分钟后：status=${node.status} lease仍在内存在=${store.state.leases.has('N1')}`);
  console.log(`  leaseCapacity 会算它吗：expires_at(${lease.expires_at}) <= now(${later}) → ${lease.expires_at <= later ? '不算（容量已释放）' : '算'}`);
  // 再 claim 一次会怎样？
  try {
    claim(store, 'N1', 'worker-2', { ttlSec: 600, now: later });
    console.log('  再 claim：成功（意外）');
  } catch (error) {
    console.log(`  再 claim：${error.code ?? error.name} — ${String(error.message).slice(0, 80)}`);
  }
  // 节点还是 ready 吗？
  console.log(`  readySet 里有它吗：${store.state.nodes.get('N1').status === 'ready' ? '有' : '没有（永久卡住）'}`);
  // expire 之后
  const reaped = expire(store, { now: later });
  console.log(`  手动 expire：回收 ${JSON.stringify(reaped)}，status=${store.state.nodes.get('N1').status}，attempts=${store.state.nodes.get('N1').attempts}`);
}

console.log('\n══ 2. 崩在 claim 之前的登记：claimed=false 会占积压多久 ══');
{
  const state = emptyEnqueueState();
  const rows = [];
  // 100 个 worker 派出去了、没有一个 claim 成功（全部崩在启动阶段）
  for (let i = 0; i < 100; i += 1) {
    rows.push({ kind: 'node_enqueued', nodeId: `N${i}`, sessionId: `S${i}`, at: new Date(T0).toISOString() });
  }
  applyEnqueueRows(state, rows);
  const queued = () => [...state.live.values()].filter((r) => !r.claimed).length;
  console.log(`  派出 100 个、0 个 claim：live=${state.live.size}，积压=${queued()}`);
  for (const minutes of [1, 5, 29, 31]) {
    const swept = sweepStale(state, { now: T0 + minutes * 60_000, maxAgeMs: 30 * 60_000 });
    const stillQueued = [...swept.live.values()].filter((r) => !r.claimed).length;
    console.log(`  ${String(minutes).padStart(2)} 分钟后（maxAgeMs=30min）：live=${swept.live.size} 积压=${stillQueued}`);
  }
}

console.log('\n══ 3. 两种超时用的是同一个常数，但它们回答的问题不同 ══');
{
  const state = emptyEnqueueState();
  const rows = [
    // A: 派出去了、从未 claim（worker 崩在启动）→ 早该释放
    { kind: 'node_enqueued', nodeId: 'A', sessionId: 'SA', at: new Date(T0).toISOString() },
    // B: 派出去、claim 成功、之后长时间在跑（可能是真在干活）→ 只能慢慢判
    { kind: 'node_enqueued', nodeId: 'B', sessionId: 'SB', at: new Date(T0).toISOString() },
    { kind: 'task_claimed', nodeId: 'B', at: new Date(T0 + 5_000).toISOString() },
  ];
  applyEnqueueRows(state, rows);
  const at5min = sweepStale(state, { now: T0 + 5 * 60_000, maxAgeMs: 30 * 60_000 });
  console.log(`  5 分钟时：live=${[...at5min.live.keys()].join(',')}（A 崩了却还在，B 真在跑）`);
  console.log(`  → 同一个 30 分钟对它俩的含义完全不同：A 是"死了没人收"，B 是"活着别动它"`);
}

console.log('\n══ 4. 积压撞满 queue 闸门会怎样 ══');
{
  const store = mkStore();
  const tick = planDispatchTick(store, {
    mode: 'interval',
    dryRun: false,
    maxPerTick: 32,
    maxActive: 6,
    maxQueuedTasks: 5, // 小上限便于观察
    ratePerSecond: 100,
    currentQueueLength: 5, // = 100 个崩溃登记早把上限撞满
    nowMs: T0,
  });
  console.log(`  ready=${tick.ready.length} willDispatch=${tick.willDispatch.length} gates=${JSON.stringify(tick.gates)}`);
  console.log(`  说明：${tick.summary}`);
}

const tmp = path.join(os.tmpdir(), `.l0-probe-reap-${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
if (!removeTempDir(tmp)) console.log(`临时目录未删净，需手动清: ${tmp}`);
console.log('\n探针结束');
