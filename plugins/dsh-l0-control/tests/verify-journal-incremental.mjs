/**
 * journal 增量读：**别让「读日志」变成吞吐上限**。
 *
 * 为什么：70000 行 / 13 MB 时全量读 + 逐行 JSON.parse 是 **86 ms**。而一份 journal
 * 一个 tick 里会被读好几遍（派发登记推导、UI 快照、实例回放）。千级规模下这不是
 * 「慢一点」，是直接把吞吐钉死不动的上限。
 *
 * 增量读的正确性比性能难得多，本测试钉住五个容易写错的点：
 *
 *   1. **撕裂尾行不能被消费**：末行没换行 = 正在写，读了会把半条 JSON 留在缓存里，
 *      之后所有读取都少一行、且永远不会补上。
 *   2. **文件变短必须整块失效**：截断/旋转后按旧偏移续读会读到错位内容。
 *   3. **返回值是副本**：调用方改 `rows` 不能污染缓存（否则下一次读到的就是被改过的历史）。
 *   4. **坏行跳过但要能继续**：中间一条坏 JSON 不能卡住后续所有行。
 *   5. **增量与全量结果一致**：连读三次 == 一次性全量读。
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

let seq = 0;
function newService() {
  const stateDir = tempSystemDir('l0-jr-');
  const svc = new L0ControlService(ctx, { workspaceRoot: root, stateDir }, {});
  return { svc, stateDir, journalPath: path.join(stateDir, 'journal.jsonl') };
}

process.stdout.write('\njournal 增量读\n' + '─'.repeat(70) + '\n');

// ═══ 1. 空文件 / 文件不存在 ═════════════════════════════════════════════════
{
  const { svc, journalPath } = newService();
  check('文件不存在 → 空数组', svc.readJournal().length === 0);
  fs.writeFileSync(journalPath, '', 'utf8');
  check('空文件 → 空数组', svc.readJournal().length === 0);
}

// ═══ 2. 增量：连读三次结果与全量一致 ═══════════════════════════════════════
{
  const { svc, journalPath } = newService();
  for (let i = 0; i < 5; i += 1) svc.appendJournal('node_enqueued', { nodeId: `N${i}` });
  const a = svc.readJournal();
  check('首次读 5 行', a.length === 5, `len=${a.length}`);

  for (let i = 5; i < 8; i += 1) svc.appendJournal('node_enqueued', { nodeId: `N${i}` });
  const b = svc.readJournal();
  check('追加后增量读到 8 行', b.length === 8, `len=${b.length}`);

  const c = svc.readJournal();
  check('无新增时重复读仍是 8 行', c.length === 8, `len=${c.length}`);

  const full = fs
    .readFileSync(journalPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  check('增量结果与全量逐行一致', JSON.stringify(b) === JSON.stringify(full), `incr=${b.length} full=${full.length}`);
}

// ═══ 3. ★ 撕裂尾行不能被消费 ═══════════════════════════════════════════════
// 模拟「正在写」：文件末尾有半条 JSON、没换行。读完不能把它算进去。
{
  const { svc, journalPath } = newService();
  for (let i = 0; i < 3; i += 1) svc.appendJournal('node_enqueued', { nodeId: `N${i}` });
  const good = fs.readFileSync(journalPath, 'utf8');
  // 追加半条（无换行）
  fs.writeFileSync(journalPath, good + '{"at":"2026-01-01T00:00:00Z","kind":"node_enq', 'utf8');

  const during = svc.readJournal();
  check('撕裂尾行不被消费', during.length === 3, `len=${during.length}`);

  // 写完了：补上剩下半条 + 换行
  fs.appendFileSync(journalPath, 'ueued","nodeId":"N3"}\n', 'utf8');
  const after = svc.readJournal();
  check('尾行写完后被正确补上', after.length === 4, `len=${after.length}`);
  check('补上的那行内容正确', after[3]?.nodeId === 'N3', `nodeId=${after[3]?.nodeId}`);
}

// ═══ 4. ★ 文件变短必须整块失效 ═════════════════════════════════════════════
{
  const { svc, journalPath } = newService();
  for (let i = 0; i < 5; i += 1) svc.appendJournal('node_enqueued', { nodeId: `N${i}` });
  check('截断前 5 行', svc.readJournal().length === 5);

  // 截断成前 2 行（模拟 journal 旋转 / 人工修复）
  const lines = fs.readFileSync(journalPath, 'utf8').split('\n').filter((l) => l.trim());
  fs.writeFileSync(journalPath, lines.slice(0, 2).join('\n') + '\n', 'utf8');
  const afterTruncate = svc.readJournal();
  check('文件变短 → 整块失效重读', afterTruncate.length === 2, `len=${afterTruncate.length}`);
  check('重读后内容对得上', afterTruncate[1]?.nodeId === 'N1', `nodeId=${afterTruncate[1]?.nodeId}`);
}

// ═══ 5. ★ 返回值不能被就地改坏缓存 ═════════════════════════════════════════
// `slice()` 只浅拷贝：数组是新数组，**元素对象与缓存共用**。所以要么每次深拷贝
// （贵两个量级），要么把元素冻结（解析时一次性成本）。这里选冻结，并验证：
// 改元素会抛错（而不是偷偷把缓存里的历史改掉）。
{
  const { svc } = newService();
  for (let i = 0; i < 3; i += 1) svc.appendJournal('node_enqueued', { nodeId: `N${i}` });
  const first = svc.readJournal();

  // 改数组本身（push/splice）安全：返回的是新数组
  first.push({ kind: 'injected' });
  const afterPush = svc.readJournal();
  check('调用方 push 不污染缓存', afterPush.length === 3, `len=${afterPush.length}`);

  // 改元素：冻结后必须抛 TypeError，而不是静默改掉缓存
  let threw = false;
  try {
    first[0].nodeId = 'TAMPERED';
  } catch {
    threw = true;
  }
  check('改元素被冻结拦住（抛 TypeError，而不是静默污染）', threw);
  const afterMutation = svc.readJournal();
  check('缓存里的历史没被改坏', afterMutation[0]?.nodeId === 'N0', `nodeId=${afterMutation[0]?.nodeId}`);

  // 严格模式外也不会静默改：非严格赋值失败但值不变（Node ESM 恒为严格模式，故走上面的分支）
  check('元素确实被 Object.isFrozen', Object.isFrozen(afterMutation[0]));
}

// ═══ 6. 中间坏行：跳过但继续 ═══════════════════════════════════════════════
{
  const { svc, journalPath } = newService();
  fs.writeFileSync(
    journalPath,
    ['{"kind":"a","nodeId":"A"}', '{ broken json', '{"kind":"c","nodeId":"C"}', ''].join('\n'),
    'utf8',
  );
  const rows = svc.readJournal();
  check('中间坏行被跳过', rows.length === 2, `len=${rows.length}`);
  check('坏行之后的行仍被读到', rows[1]?.nodeId === 'C', `nodeId=${rows[1]?.nodeId}`);
}

// ═══ 7. 增量跨「坏行 + 追加」组合 ═══════════════════════════════════════════
{
  const { svc, journalPath } = newService();
  fs.writeFileSync(journalPath, '{"kind":"a","nodeId":"A"}\n{bad\n', 'utf8');
  const first = svc.readJournal();
  check('初次读到 1 行（坏行跳过）', first.length === 1, `len=${first.length}`);
  fs.appendFileSync(journalPath, '{"kind":"c","nodeId":"C"}\n', 'utf8');
  const second = svc.readJournal();
  check('追加后读到 2 行', second.length === 2, `len=${second.length}`);
  check('追加的行正确', second[1]?.nodeId === 'C', `nodeId=${second[1]?.nodeId}`);
}

// ═══ 8. 性能：增量读应显著快于全量 ═════════════════════════════════════════
{
  const { svc, journalPath } = newService();
  const N = 20000;
  const lines = [];
  for (let i = 0; i < N; i += 1) {
    lines.push(JSON.stringify({ at: '2026-01-01T00:00:00Z', kind: 'task_heartbeat_ok', nodeId: `N${i % 500}`, pad: 'x'.repeat(60) }));
  }
  fs.writeFileSync(journalPath, lines.join('\n') + '\n', 'utf8');

  // 冷读（首次必须全量）
  const cold0 = process.hrtime.bigint();
  const cold = svc.readJournal();
  const cold1 = process.hrtime.bigint();
  const coldMs = Number(cold1 - cold0) / 1e6;

  // 热读（无新增 → 直接返回缓存副本）
  const warm0 = process.hrtime.bigint();
  const warm = svc.readJournal();
  const warm1 = process.hrtime.bigint();
  const warmMs = Number(warm1 - warm0) / 1e6;

  check('冷读读到全部行', cold.length === N, `len=${cold.length}`);
  check('热读结果一致', warm.length === N, `len=${warm.length}`);
  check(
    `热读显著快于冷读（cold=${coldMs.toFixed(1)}ms warm=${warmMs.toFixed(2)}ms）`,
    warmMs < coldMs / 5,
    `cold=${coldMs.toFixed(2)}ms warm=${warmMs.toFixed(2)}ms`,
  );

  // 追加 1 行后：应只解析 1 行，不是 20001 行
  svc.appendJournal('task_heartbeat_ok', { nodeId: 'N0' });
  const inc0 = process.hrtime.bigint();
  const inc = svc.readJournal();
  const inc1 = process.hrtime.bigint();
  const incMs = Number(inc1 - inc0) / 1e6;
  check('追加 1 行增量读到 N+1 行', inc.length === N + 1, `len=${inc.length}`);
  check(
    `追加后增量读远快于冷读（inc=${incMs.toFixed(2)}ms vs cold=${coldMs.toFixed(1)}ms）`,
    incMs < coldMs / 5,
    `inc=${incMs.toFixed(2)}ms cold=${coldMs.toFixed(2)}ms`,
  );
  process.stdout.write(`      实测：冷读 ${coldMs.toFixed(1)}ms / 热读 ${warmMs.toFixed(3)}ms / 增量 ${incMs.toFixed(2)}ms（${N} 行）\n`);
}

// ═══ 9. 与其它消费者兼容：journalSummary 仍看全量 ══════════════════════════
{
  const { svc } = newService();
  for (let i = 0; i < 4; i += 1) svc.appendJournal('node_enqueued', { nodeId: `N${i}` });
  const summary = svc.journalSummary();
  check('journalSummary.events 正确', summary.events === 4, `events=${summary.events}`);
  check('journalSummary.lastKind 正确', summary.lastKind === 'node_enqueued', `lastKind=${summary.lastKind}`);
}

const failed = results.filter((r) => !r.ok);
process.stdout.write('─'.repeat(70) + '\n');
process.stdout.write(
  `${failed.length === 0 ? 'PASS' : 'FAIL'} journal incremental: ${results.length - failed.length}/${results.length} 项通过\n`,
);
if (failed.length) {
  for (const f of failed) process.stdout.write(`  FAILED: ${f.name} — ${f.detail}\n`);
  process.exit(1);
}
