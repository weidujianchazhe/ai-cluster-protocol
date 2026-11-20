/**
 * `dispatchView().active.rows` 的**有界选择**：既要够快，也必须**真的**是最近 50 条。
 *
 * 背景：这一栏原来写的是
 *
 *   const live = [...state.live.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
 *   ... rows: live.slice(0, 50)
 *
 * 也就是「68600 条全量排序，然后只用前 50 条」。实测 68600 条要 26 ms，而
 * `dispatchView()` 每轮派发都会被调一次——这一项就吃掉了整轮预算的一半。
 *
 * 改成环形缓冲 + 单调性探测之后要防的错有两类：
 *
 *   1. **快但错**：环形缓冲的前提是「走过的最后 50 条就是最新的 50 条」，
 *      这个前提只在 `live` 的遍历顺序按 `at` 递增时成立。真实 journal 里
 *      `task_heartbeat_ok` 会**原地刷新**已有记录的 `at`（不改 Map 插入位置），
 *      于是遍历顺序与 `at` 顺序分叉 —— 前提破了。
 *   2. **探测失效后仍给错答案**：探测到逆序必须回退全量排序，而不是「尽力而为」。
 *
 * 所以本文件的核心断言是：**任何形状下，`active.rows` 都必须与全量排序的前 50 条
 * 逐条相同**。快是次要的，快而错是最坏的结果。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempSystemDir, removeTempDir } from './_temp-state.mjs';

const root = process.cwd();
const lib = (name) => pathToFileURL(path.join(root, 'lib', name)).href;
const { L0ControlService } = await import(lib('service.js'));

const mkCtx = () => ({
  get: (name) => {
    if (name === 'workingDirectory') return { defaultDirectory: root };
    if (name === 'subagents') return { list: () => ['spawn'], startActivation: async () => ({ childId: 'c', messageId: 'm' }) };
    return undefined;
  },
});

/** 造一个只有 journal 的 service（不跑 core，视图只依赖 journal）。 */
function makeService(tag) {
  // **必须用绝对路径**。原来这里写的是 `stateDir: path.basename(stateDir)`——
  // service 会拿它按 `workspaceRoot` 重新解释，于是状态落进**插件目录**，
  // 而 finally 里的 `rmSync(stateDir)` 删的是 `os.tmpdir()` 下的那个空路径。
  // 结果：每跑一次 verify 就在插件目录里留 8 个 `l0-bounded-*`，攒到 611 个 / 605 MB。
  // 这是第 28 轮记过的同一形态（「路径被重新解释，清理钩子覆盖不到」）第三次出现。
  const stateDir = tempSystemDir(`l0-bounded-${tag}-`);
  const svc = new L0ControlService(mkCtx(), {
    workspaceRoot: root,
    stateDir, // ← 绝对路径，service 不再重解释
    persistence: 'node',
    maxParallel: 1000,
    // 本文件量的是**有界选择**，不是失联判定。它的 fixture 故意把 20000 条登记
    // 摊在「10 分钟前」这一段里，那是为了造出真实的近似有序序列。
    // 而第 27 轮给未 claim 登记加了 2 分钟宽限期（`enqueueUnclaimedStaleMs`），
    // 会让这批 fixture 全部判过期 → `active.count` 变 0，测的就不是同一件事了。
    // 这里显式关掉该口径（0=沿用 `enqueueStaleMs` 的 30 分钟），
    // 让本文件继续只验证「有界选择在 2 万条活登记上仍正确且够快」。
    enqueueUnclaimedStaleMs: 0,
  }, {});
  return { svc, stateDir };
}

function writeJournal(svc, rows) {
  fs.mkdirSync(path.dirname(svc.journalPath), { recursive: true });
  fs.writeFileSync(svc.journalPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  svc.readJournal(); // 建立游标
}

/** 参考实现：全量排序后取前 `keep`。视图必须与它逐条相同。 */
function expectedTop(rows, keep = 50) {
  const live = new Map();
  for (const row of rows) {
    const kind = String(row.kind ?? '');
    const nodeId = String(row.nodeId ?? '');
    if (!nodeId) continue;
    if (kind === 'node_enqueued') {
      live.set(nodeId, { nodeId, at: String(row.at), claimed: false });
      continue;
    }
    if (kind === 'task_claimed' || kind === 'task_heartbeat_ok') {
      const record = live.get(nodeId);
      if (!record) continue;
      if (String(row.at) >= record.at) record.at = String(row.at);
      if (kind === 'task_claimed') record.claimed = true;
      continue;
    }
    if (kind === 'task_heartbeat_failed' || kind === 'task_claim_rejected' || kind === 'verify_done_requested') {
      live.delete(nodeId);
    }
  }
  const all = [...live.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return {
    count: all.length,
    claimed: all.filter((row) => row.claimed).length,
    top: all.slice(0, keep).map((row) => row.nodeId),
  };
}

// ── 1. 单调递增（最有利形状）：视图与全量排序一致 ─────────────────────────
{
  const { svc, stateDir } = makeService('plain');
  try {
    const rows = [];
    const base = Date.now() - 100_000;
    for (let i = 0; i < 300; i += 1) {
      rows.push({ at: new Date(base + i * 10).toISOString(), kind: 'node_enqueued', nodeId: `P${i}`, sessionId: `s${i}` });
    }
    writeJournal(svc, rows);
    const view = svc.dispatchView();
    const want = expectedTop(rows);
    assert.equal(view.active.count, want.count, `count 应是 ${want.count}`);
    assert.equal(view.active.claimed, want.claimed);
    assert.equal(view.active.unclaimed, view.active.count - view.active.claimed);
    assert.equal(view.queue.queued, view.active.unclaimed, 'queue.queued 与 active.unclaimed 必须是同一个数');
    assert.deepEqual(view.active.rows.map((r) => r.nodeId), want.top, '单调形状下 rows 应是最近 50 条');
    assert.equal(view.active.truncated, true);
    console.log('PASS 1. 单调递增形状：rows 与全量排序前 50 逐条一致，计数口径一致');
  } finally {
    svc.stopDispatch();
    try { removeTempDir(stateDir); } catch {}
  }
}

// ── 2. ★ 心跳打乱顺序：探测到逆序时必须回退，结论仍正确 ──────────────────
// 这是最容易错的一种：`task_heartbeat_ok` 原地刷新 `at`，Map 插入顺序不变。
// 于是「最后写入的 50 条」与「at 最新的 50 条」完全是两批节点。
// 若不做探测，`active.rows` 会安静地显示一批旧节点——页面看起来正常，其实是错的。
{
  const { svc, stateDir } = makeService('heartbeat');
  try {
    const rows = [];
    const base = Date.now() - 100_000;
    // 先派 200 个（N0..N199），再让**最早的 100 个**反复心跳，把它们刷成最新。
    for (let i = 0; i < 200; i += 1) {
      rows.push({ at: new Date(base + i * 10).toISOString(), kind: 'node_enqueued', nodeId: `N${i}`, sessionId: `s${i}` });
    }
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 100; i += 1) {
        rows.push({ at: new Date(base + 10_000 + round * 1000 + i).toISOString(), kind: 'task_heartbeat_ok', nodeId: `N${i}` });
      }
    }
    writeJournal(svc, rows);

    const view = svc.dispatchView();
    const want = expectedTop(rows);
    assert.deepEqual(
      view.active.rows.map((r) => r.nodeId),
      want.top,
      `心跳打乱顺序后 rows 仍必须等于全量排序前 50；实际 ${JSON.stringify(view.active.rows.map((r) => r.nodeId).slice(0, 5))}… 期望 ${JSON.stringify(want.top.slice(0, 5))}…`,
    );
    // 断言这一批确实是「被心跳刷过的早期节点」——否则这个用例根本没测到探测分支。
    assert.ok(
      want.top.every((nodeId) => Number(nodeId.slice(1)) < 100),
      `前提不成立：前 50 应是 N0..N99 里被心跳刷新的那批，实际 ${JSON.stringify(want.top.slice(0, 5))}`,
    );
    console.log('PASS 2. 心跳打乱顺序（遍历序 ≠ at 序）：探测到逆序后回退，rows 仍与全量一致');
  } finally {
    svc.stopDispatch();
    try { removeTempDir(stateDir); } catch {}
  }
}

// ── 3. ★ 数量恰好等于 / 小于 keep 时不能越界或重复 ────────────────────────
// 环形缓冲的经典错法是「未填满时也按已填满展开」，读出来的是 undefined。
{
  for (const n of [0, 1, 49, 50, 51]) {
    const { svc, stateDir } = makeService(`edge${n}`);
    try {
      const rows = [];
      const base = Date.now() - 100_000;
      for (let i = 0; i < n; i += 1) {
        rows.push({ at: new Date(base + i * 10).toISOString(), kind: 'node_enqueued', nodeId: `E${i}`, sessionId: `s${i}` });
      }
      writeJournal(svc, rows);
      const view = svc.dispatchView();
      const want = expectedTop(rows);
      assert.equal(view.active.count, n, `n=${n} 时 count 应是 ${n}`);
      assert.deepEqual(view.active.rows.map((r) => r.nodeId), want.top, `n=${n} 时 rows 不对`);
      assert.ok(view.active.rows.every((r) => typeof r.nodeId === 'string' && r.nodeId.length > 0), `n=${n} 时 rows 里出现空值`);
      assert.equal(view.active.truncated, n > 50, `n=${n} 时 truncated 应是 ${n > 50}`);
    } finally {
      svc.stopDispatch();
      try { removeTempDir(stateDir); } catch {}
    }
  }
  console.log('PASS 3. 边界数量（0/1/49/50/51）不越界、不重复、truncated 标记正确');
}

// ── 4. ★ 有界性：20000 条 live 下这一栏不能随规模线性崩掉 ─────────────────
// 不是精确性能断言（那会 flaky），而是「量级守卫」：旧实现 68600 条要 26 ms，
// 这里给 20000 条留 100 ms 的宽裕上界。若哪天有人改回全量 localeCompare 排序，
// 这条会先红。
{
  const { svc, stateDir } = makeService('scale');
  try {
    const rows = [];
    const base = Date.now() - 600_000;
    for (let i = 0; i < 20_000; i += 1) {
      rows.push({ at: new Date(base + i * 5).toISOString(), kind: 'node_enqueued', nodeId: `S${i}`, sessionId: `s${i}` });
    }
    writeJournal(svc, rows);
    svc.dispatchView(); // 预热
    const rounds = 5;
    const t0 = process.hrtime.bigint();
    let view;
    for (let i = 0; i < rounds; i += 1) view = svc.dispatchView();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / rounds;
    assert.equal(view.active.count, 20_000);
    assert.equal(view.active.rows.length, 50);
    assert.ok(
      ms < 100,
      `20000 条 live 时 dispatchView 应在 100 ms 内（实测 ${ms.toFixed(1)} ms）——超了说明有界选择退化回全量排序`,
    );
    console.log(`PASS 4. 20000 条 live 下 dispatchView ${ms.toFixed(1)} ms（量级守卫，退化成全量排序会先红）`);
  } finally {
    svc.stopDispatch();
    try { removeTempDir(stateDir); } catch {}
  }
}

console.log('\nPASS dispatch view bounded: 单调形状逐条一致 / 心跳打乱仍正确 / 边界数量不越界 / 20000 条有界（量级守卫）');
