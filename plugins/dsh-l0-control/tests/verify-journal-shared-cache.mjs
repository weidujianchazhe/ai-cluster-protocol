/**
 * journal 读路径：**一份缓存，三种取用方式**（别让"读日志"变成每轮恒定税）。
 *
 * 背景（第 23 轮遗留 + 第 24 轮实测）：
 *   - `readJournal()` 一直返回 `cursor.rows.slice()` —— 71400 行时单次 0.35 ms；
 *   - `dispatchView()` 一次调用里它被调 **4 次**（`enqueueState` / `usedDispatchQuota` /
 *     `lastTick` / `gateHistory`），合计拷贝 **285600** 个元素引用；
 *   - 而这 4 处**没有任何一处需要全量副本**：两处只要尾部增量，两处只从尾部倒扫。
 *   - `journalSummary()` 更狠：`readFileSync().split().filter()` 三个全量拷贝，70000 行 **22.5 ms**，
 *     而它在每次 UI 快照与 hint 里都被调。
 *
 * 本测试钉住四件事：
 *   1. 三种取用方式（`journalRows` / `journalTail` / `readJournal`）**语义各自正确**；
 *   2. 只有 `journalRows()` 不拷贝，另外两个必须给副本（不能污染缓存）；
 *   3. `journalSummary()` 与文件真值逐字段一致 —— **含坏行**（坏行必须计入 events，
 *      且末行坏掉要报 `unparsable`，否则"少了一行"永远查不出来）；
 *   4. `enqueueState()` 的成本**与历史长度脱钩**，且失联结果写回折叠态
 *      （否则 60000 条过期登记每轮重判一次，恒定 26 ms 且永不衰减）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempSystemDir } from './_temp-state.mjs';

const root = process.cwd();
const { L0ControlService } = await import(pathToFileURL(path.join(root, 'lib', 'service.js')).href);

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: Boolean(cond), detail: detail ?? '' });
  process.stdout.write(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` — ${detail ?? ''}`}\n`);
};

const ctx = { get: (name) => (name === 'workingDirectory' ? { defaultDirectory: root } : undefined) };

function newService() {
  const stateDir = tempSystemDir('l0-jcache-');
  const svc = new L0ControlService(ctx, { workspaceRoot: root, stateDir, persistence: 'node', maxParallel: 100 }, {});
  return { svc, stateDir, journalPath: path.join(stateDir, 'journal.jsonl') };
}

process.stdout.write('\njournal 共享缓存与摘要\n' + '─'.repeat(70) + '\n');

// ═══ 1. 三种取用方式语义 ════════════════════════════════════════════════════
{
  const { svc } = newService();
  for (let i = 0; i < 6; i += 1) svc.appendJournal('node_enqueued', { nodeId: `N${i}` });

  const all = svc.journalRows();
  check('journalRows() 拿到全部行', all.length === 6, `len=${all.length}`);
  check('journalLength() 与 journalRows().length 一致', svc.journalLength() === 6, `len=${svc.journalLength()}`);

  check('journalTail(0) 等价于全量', svc.journalTail(0).length === 6, `len=${svc.journalTail(0).length}`);
  const tail2 = svc.journalTail(4);
  check('journalTail(4) 只给尾部 2 条', tail2.length === 2, `len=${tail2.length}`);
  check('journalTail(4) 内容对得上', String(tail2[0]?.nodeId) === 'N4', `nodeId=${tail2[0]?.nodeId}`);
  check('journalTail(未来值) 给空数组而不是抛错', svc.journalTail(999).length === 0);
  check('journalTail(负数) 退化为全量', svc.journalTail(-5).length === 6);

  // 空 journal
  const empty = newService();
  check('文件不存在 → journalRows() 为空且不抛', empty.svc.journalRows().length === 0);
  check('文件不存在 → journalTail(10) 为空', empty.svc.journalTail(10).length === 0);
  check('文件不存在 → journalSummary 全零', empty.svc.journalSummary().events === 0
    && empty.svc.journalSummary().lastKind === null);
}

// ═══ 2. ★ 只有 journalRows() 不拷贝；副本必须真的隔离 ═══════════════════════
{
  const { svc } = newService();
  for (let i = 0; i < 3; i += 1) svc.appendJournal('node_enqueued', { nodeId: `N${i}` });

  // 同一性：两次 journalRows() 必须是**同一个数组**（缓存本体，零拷贝）
  const a = svc.journalRows();
  const b = svc.journalRows();
  check('★ journalRows() 两次返回同一数组（零拷贝）', a === b);
  check('★ journalRows() 与 append 后的缓存仍是同一数组（原地追加）',
    (svc.appendJournal('node_enqueued', { nodeId: 'N9' }), svc.journalRows() === a));

  // 副本隔离：readJournal() 必须给新数组
  const c = svc.readJournal();
  check('readJournal() 返回新数组（不是缓存本体）', c !== svc.journalRows());
  c.push({ kind: 'injected' });
  check('readJournal() 的 push 不污染缓存', svc.journalLength() === 4, `len=${svc.journalLength()}`);

  // journalTail 也必须给副本
  const d = svc.journalTail(0);
  check('journalTail() 返回新数组', d !== svc.journalRows());
  d.length = 0;
  check('journalTail() 被清空也不影响缓存', svc.journalLength() === 4, `len=${svc.journalLength()}`);

  // 元素冻结：无论从哪条路拿到的行，都不能就地改
  let threw = 0;
  for (const getter of [() => svc.journalRows()[0], () => svc.readJournal()[0], () => svc.journalTail(0)[0]]) {
    try {
      getter().nodeId = 'TAMPERED';
    } catch {
      threw += 1;
    }
  }
  check('三条取用路径的行对象都被冻结（改不动缓存里的历史）', threw === 3, `threw=${threw}`);
  check('缓存里的历史确实没变', String(svc.journalRows()[0]?.nodeId) === 'N0', `nodeId=${svc.journalRows()[0]?.nodeId}`);
}

// ═══ 3. ★ journalSummary() 与文件真值一致（含坏行） ═════════════════════════
{
  const { svc, journalPath } = newService();
  const lines = [
    '{"kind":"wish_submitted","at":"2026-01-01T00:00:00.000Z"}',
    '{ broken json',
    '{"kind":"node_enqueued","at":"2026-01-01T00:00:01.000Z"}',
    '',
    '{"kind":"dispatch_tick","at":"2026-01-01T00:00:02.000Z"}',
  ];
  fs.writeFileSync(journalPath, lines.join('\n') + '\n', 'utf8');
  const summary = svc.journalSummary();
  // 非空行 4 条（含 1 条坏行）：events 必须报 4，不是 3
  check('★ 坏行计入 events（4 条非空行）', summary.events === 4, `events=${summary.events}`);
  check('末行可解析 → lastKind 取真实 kind', summary.lastKind === 'dispatch_tick', `lastKind=${summary.lastKind}`);
  check('readJournal() 只给能解析的行（3 条）', svc.readJournal().length === 3, `len=${svc.readJournal().length}`);
  check('events > 可解析行数 ⇒ 坏行确实被计数', summary.events === svc.readJournal().length + 1);

  // 末行坏掉 → unparsable
  fs.appendFileSync(journalPath, '{ tail broken', 'utf8');
  const tailBadSummary = svc.journalSummary();
  check('★ 末行坏掉 → lastKind = unparsable', tailBadSummary.lastKind === 'unparsable', `lastKind=${tailBadSummary.lastKind}`);

  // 末行坏掉后补上换行 + 好行 → 恢复正常
  fs.appendFileSync(journalPath, '\n{"kind":"evidence_submitted"}\n', 'utf8');
  const recovered = svc.journalSummary();
  check('坏行之后继续追加 → lastKind 恢复成真实 kind',
    recovered.lastKind === 'evidence_submitted', `lastKind=${recovered.lastKind}`);
  check('坏行仍被计入 events', recovered.events === 6, `events=${recovered.events}`);
}

// ═══ 4. journalSummary() 不再全量重读：70000 行下必须显著快于冷读 ═══════════
{
  const { svc, journalPath } = newService();
  const N = 70000;
  const lines = [];
  for (let i = 0; i < N; i += 1) {
    lines.push(JSON.stringify({ at: '2026-01-01T00:00:00.000Z', kind: i % 7 === 0 ? 'dispatch_tick' : 'node_enqueued', nodeId: `N${i}` }));
  }
  fs.writeFileSync(journalPath, lines.join('\n') + '\n', 'utf8');

  const cold0 = process.hrtime.bigint();
  svc.readJournal(); // 冷读：必须全量解析
  const coldMs = Number(process.hrtime.bigint() - cold0) / 1e6;

  const warm = [];
  for (let i = 0; i < 20; i += 1) {
    const t0 = process.hrtime.bigint();
    svc.journalSummary();
    warm.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  warm.sort((x, y) => x - y);
  const p50 = warm[10];
  process.stdout.write(`      实测：冷读 ${coldMs.toFixed(1)}ms / journalSummary p50 ${p50.toFixed(3)}ms（${N} 行）\n`);
  check('journalSummary() 在 70000 行下 < 5ms（旧实现 22.5ms）', p50 < 5, `p50=${p50.toFixed(2)}ms`);
  check('journalSummary().events 精确等于行数', svc.journalSummary().events === N, `events=${svc.journalSummary().events}`);
  check('journalSummary().lastKind 与末行一致', svc.journalSummary().lastKind === 'node_enqueued', `lastKind=${svc.journalSummary().lastKind}`);
}

// ═══ 5. ★ enqueueState() 成本与历史长度脱钩 + 失联写回折叠态 ════════════════
// 旧行为：`sweepStale()` 的结果只作用在**返回值**上，折叠态仍是 live=60000，
// 于是下一轮又从 60000 条出发重判一次 —— 每轮恒定 26 ms，与是否真有活 worker 无关。
{
  const { svc, journalPath } = newService();
  const N = 60000;
  // 全部登记的时间都在 30 分钟之前（enqueueStaleMs 默认 1800000）：一条都该判失联。
  const base = Date.now() - 3600 * 1000;
  const lines = [];
  for (let i = 0; i < N; i += 1) {
    lines.push(JSON.stringify({ at: new Date(base + i).toISOString(), kind: 'node_enqueued', nodeId: `N${i}`, sessionId: `s${i}` }));
  }
  fs.writeFileSync(journalPath, lines.join('\n') + '\n', 'utf8');

  const rounds = [];
  let firstState = null;
  for (let i = 0; i < 5; i += 1) {
    const t0 = process.hrtime.bigint();
    const st = svc.enqueueState();
    rounds.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (i === 0) firstState = st;
  }
  process.stdout.write(`      5 轮：${rounds.map((ms) => ms.toFixed(2)).join(' / ')} ms\n`);

  check('★ 首轮确实折叠了全部 60000 条（live 已判失联 → 0）', firstState.live.size === 0, `live=${firstState.live.size}`);
  check('失联记录进 released（带 stale 原因）', firstState.released.size > 0, `released=${firstState.released.size}`);
  // **不用绝对毫秒阈值**。
  //
  // 原来断言的是 `rounds.slice(2).every(ms => ms < 3)`——这在负载高的机器上会随机红：
  // 实测出现过 `408.74/74.53/0.79/15.04/0.58`，第 4 轮抖到 15 ms 就被判失败。
  // 而它要证明的其实是「**缓存生效了**」，不是「这台机器有多快」。
  //
  // 改成两条与机器快慢无关的判据：
  //   ① 稳态轮的中位数必须**显著小于**首轮（缓存确实起作用，否则每轮都在全量折叠）；
  //   ② 稳态轮不得出现量级退化（最大值不超过首轮），防止「偶尔走缓存、偶尔全量」。
  const first = rounds[0];
  const steady = rounds.slice(2).slice().sort((a, b) => a - b);
  const steadyMedian = steady[Math.floor(steady.length / 2)];
  const steadyMax = steady[steady.length - 1];
  check('★ 稳态轮显著快于首轮：缓存确实生效（中位数 < 首轮 / 5）',
    steadyMedian * 5 < first,
    `首轮 ${first.toFixed(2)} ms，稳态中位 ${steadyMedian.toFixed(2)} ms，全部：${rounds.map((ms) => ms.toFixed(2)).join(' / ')}`);
  check('★ 稳态轮无量级退化（最大 < 首轮）：没有「偶尔走缓存、偶尔全量」',
    steadyMax < first,
    `稳态最大 ${steadyMax.toFixed(2)} ms vs 首轮 ${first.toFixed(2)} ms`);
  check('★ 折叠态与返回态是同一对象（不再有两个相反答案）',
    svc.enqueueFolded?.state === svc.enqueueState());
  check('★ 折叠态里的 live 也是 0（不留幽灵 worker）',
    svc.enqueueFolded.state.live.size === 0, `foldedLive=${svc.enqueueFolded.state.live.size}`);

  // 新增一条**新鲜**登记：必须能重新变成 live，且不受历史失联影响
  svc.appendJournal('node_enqueued', { nodeId: 'FRESH', sessionId: 'sf' });
  const after = svc.enqueueState();
  check('新增新鲜登记能正常进入 live', after.live.has('FRESH'), `live=${[...after.live.keys()]}`);
  check('队列积压计数随之变 1', svc.queuedWorkers() === 1, `queued=${svc.queuedWorkers()}`);
}

// ═══ 6. dispatchView() 不再为拿长度/尾巴拷全量 ══════════════════════════════
{
  const { svc, journalPath } = newService();
  const lines = [];
  const base = Date.now() - 120 * 1000;
  for (let i = 0; i < 40000; i += 1) {
    lines.push(JSON.stringify({
      at: new Date(base + i).toISOString(),
      kind: i % 50 === 0 ? 'dispatch_tick' : 'node_enqueued',
      ...(i % 50 === 0 ? { ready: 30, willDispatch: 1, spawned: 1, gates: { queue: 1 } } : { nodeId: `N${i}`, sessionId: `s${i}` }),
    }));
  }
  fs.writeFileSync(journalPath, lines.join('\n') + '\n', 'utf8');
  svc.dispatchView(); // 预热

  const original = svc.readJournal.bind(svc);
  let copies = 0;
  svc.readJournal = function patched() {
    const out = original();
    copies += out.length;
    return out;
  };
  copies = 0;
  svc.dispatchView();
  check('★ dispatchView() 里 readJournal() 拷贝量为 0', copies === 0, `copied=${copies}`);
  svc.readJournal = original;

  const view = svc.dispatchView();
  check('视图仍能给出 lastTick', view.lastTick !== null && Number(view.lastTick.spawned) === 1,
    `lastTick=${JSON.stringify(view.lastTick && { spawned: view.lastTick.spawned })}`);
  check('视图仍能给出 gateHistory（窗口内 tick 计数 > 0）', Number(view.gateHistory?.ticks) > 0,
    `ticks=${view.gateHistory?.ticks}`);
}

const failed = results.filter((r) => !r.ok);
process.stdout.write('─'.repeat(70) + '\n');
process.stdout.write(
  `${failed.length === 0 ? 'PASS' : 'FAIL'} journal shared cache: ${results.length - failed.length}/${results.length} 项通过\n`,
);
if (failed.length) {
  for (const f of failed) process.stdout.write(`  FAILED: ${f.name} — ${f.detail}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
