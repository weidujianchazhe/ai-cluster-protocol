/**
 * 探针：`recoverWithJournal()` 内部的重复计算有多少。
 *
 * 上一轮测出「真实冷启动 open 15.5 s，其中 N4 恢复 11.6 s」，而单看每一步
 * （读 1.1 s + 校验 1.8 s + 折叠 159 ms）只解释得了 6.3 s。差额是**同一件事被反复算**：
 * 一个 34 MB 的 state 被 `canonicalJson` 了 8 次、被 `fold` 了 3 次。
 * 这里逐条量出来，确认哪些是白算。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { removeTempDir } from '../_temp-state.mjs';

const root = process.cwd();
const lib = (name) => pathToFileURL(path.join(root, 'lib', name)).href;
const core = await import(lib('core/index.js'));
const { CorePersistence } = await import(lib('persistence.js'));
const { Journal, statePaths } = await import(lib('state/journal.js'));
const { NodeFsPort } = await import(lib('state/fs-port.js'));
const snapshotMod = await import(lib('state/snapshot.js'));
const reducer = await import(lib('state/reducer.js'));
const canonical = await import(lib('state/canonical.js'));

const NODES = Number(process.argv[2] ?? 100000);
const DIR = path.join(os.tmpdir(), `.l0-probe-recov-${Date.now()}`);
fs.mkdirSync(DIR, { recursive: true });
const rm = (t) => {
  const e = fs.lstatSync(t, { throwIfNoEntry: false });
  if (!e) return;
  if (!e.isDirectory()) return fs.unlinkSync(t);
  for (const n of fs.readdirSync(t)) rm(path.join(t, n));
  if (!removeTempDir(t)) console.log(`临时目录未删净，需手动清: ${t}`);
};
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

// ── 建数据 + 一份新鲜快照 ────────────────────────────────────────────────
{
  const p = await CorePersistence.open({ dir: DIR, mode: 'node', waitMs: 0 });
  core.withCoreStore(p.coreStore, () => {
    core.graphCommit({
      wish: 'recov',
      policies: { maxParallel: NODES + 10, budgetTokens: 0 },
      nodes: Array.from({ length: NODES }, (_, i) => ({
        nodeId: `N${String(i).padStart(6, '0')}`, title: `n${i}`, stage: 'build', status: 'planned',
        deps: [], acceptance: { kind: 'exists' },
      })),
    });
  });
  await p.persist();
  await p.close();
}

const paths = statePaths(DIR);
const fsPort = new NodeFsPort();
const opened = await Journal.open({ dir: DIR, fs: fsPort, owner: 'probe', ttlMs: 1_800_000 });
const journal = opened.journal;
const records = journal.records();
// `rawText()` 是 async 的（曾经是同步，探针后期没跟上 → 传 Promise 给 Buffer.byteLength 崩了）。
// 这个探针不在验收链里，坏了不会有人发现，所以修的时候顺手把这条记进 probes/README。
const raw = await journal.rawText();

// 手动造一份与 journal 同步的快照（模拟"上次正常关闭"）
{
  const t = process.hrtime.bigint();
  const st = reducer.fold(records, reducer.emptyState());
  const f = snapshotMod.buildSnapshot(st, records, raw, new Date().toISOString());
  console.log(`造快照（fold + buildSnapshot）   ${ms(t).toFixed(0)} ms`);
  fs.writeFileSync(paths.snapshot, `${JSON.stringify(f, null, 2)}\n`, 'utf8');
}
await journal.release();

console.log('\n—— 复刻 recoverWithJournal，逐步计时 ——');
const t00 = process.hrtime.bigint();
const j2 = (await Journal.open({ dir: DIR, fs: fsPort, owner: 'probe2', ttlMs: 1_800_000 })).journal;
console.log(`1.  Journal.open（loadAndRepair+verifyChain）      ${ms(t00).toFixed(0)} ms`);

let t = process.hrtime.bigint();
const recs = j2.records();
const rawText = await j2.rawText();
console.log(`2.  records() + rawText()（均命中缓存）            ${ms(t).toFixed(3)} ms（${recs.length} 条 / ${mb(rawText.length)}）`);

t = process.hrtime.bigint();
const authoritative = reducer.fold(recs, reducer.emptyState());
const foldA = ms(t);
console.log(`3.  fold #1 → authoritative                       ${foldA.toFixed(0)} ms`);

t = process.hrtime.bigint();
const loaded = await snapshotMod.readSnapshot(fsPort, paths);
const readSnap = ms(t);
console.log(`4.  readSnapshot（读 ${mb(fs.statSync(paths.snapshot).size)} + JSON.parse）  ${readSnap.toFixed(0)} ms`);

t = process.hrtime.bigint();
snapshotMod.verifySnapshot(loaded.file);
const verify = ms(t);
console.log(`5.  verifySnapshot（canonicalJson(file.state)×1）  ${verify.toFixed(0)} ms`);

t = process.hrtime.bigint();
const anchor = snapshotMod.checkAnchor(loaded.file, recs, rawText);
const anchorMs = ms(t);
console.log(`6.  checkAnchor（前缀 sha256 100 MB）             ${anchorMs.toFixed(0)} ms  ${anchor.status}`);

t = process.hrtime.bigint();
const atAnchor = reducer.foldUntil(recs, loaded.file.meta.seq, reducer.emptyState());
const foldB = ms(t);
console.log(`7.  foldUntil #2 → atAnchor                       ${foldB.toFixed(0)} ms`);

t = process.hrtime.bigint();
const cAtAnchor = canonical.canonicalJson(atAnchor.state);
const cSnap = canonical.canonicalJson(loaded.file.state);
const compareMs = ms(t);
console.log(`8.  canonicalJson(atAnchor) + canonicalJson(snapshot)  ${compareMs.toFixed(0)} ms  （各 ${mb(cAtAnchor.length)}）`);

t = process.hrtime.bigint();
const fast = JSON.parse(JSON.stringify(loaded.file.state));
const cloneMs = ms(t);
console.log(`9.  快路径：深克隆快照 state                       ${cloneMs.toFixed(0)} ms`);

t = process.hrtime.bigint();
for (const record of recs.filter((item) => item.seq > loaded.file.meta.seq)) reducer.applyRecord(fast, record);
const replayMs = ms(t);
console.log(`10. 快路径：增量重放                              ${replayMs.toFixed(3)} ms（0 条，已同步）`);

t = process.hrtime.bigint();
const cFast = canonical.canonicalJson(fast);
const cAuth = canonical.canonicalJson(authoritative);
const compare2 = ms(t);
console.log(`11. 快路径比对：canonicalJson(fast) + canonicalJson(auth)  ${compare2.toFixed(0)} ms`);

t = process.hrtime.bigint();
const finalState = reducer.fold(recs, reducer.emptyState());
const foldC = ms(t);
console.log(`12. fold #3 → finalState（与 #1 输入相同！）        ${foldC.toFixed(0)} ms`);

t = process.hrtime.bigint();
const snapshotFile = snapshotMod.buildSnapshot(finalState, recs, rawText, new Date().toISOString());
const buildMs = ms(t);
console.log(`13. buildSnapshot（再算一次 stateSha256 + 100 MB hash）  ${buildMs.toFixed(0)} ms`);

t = process.hrtime.bigint();
const eqA = canonical.canonicalJson(reducer.fold(recs, reducer.emptyState()));
const eqB = canonical.canonicalJson(finalState);
const replayEqMs = ms(t);
console.log(`14. replayEqualsSnapshot（fold #4 + canonical×2，恒等比较）  ${replayEqMs.toFixed(0)} ms  结果=${eqA === eqB}`);

t = process.hrtime.bigint();
const status = j2.status();
console.log(`15. journal.status()                              ${ms(t).toFixed(0)} ms`);

const total = ms(t00);
console.log(`\n合计 ${total.toFixed(0)} ms`);
const accounted = readSnap + verify + anchorMs + foldB + compareMs + cloneMs + replayMs + compare2 + foldC + buildMs + replayEqMs;
console.log(`其中第 4–14 步（快照相关）  ${accounted.toFixed(0)} ms`);
console.log(`  · 纯重复：#7 与 #1 同输入（foldUntil 到末条 = fold）  ${foldB.toFixed(0)} ms`);
console.log(`  · 纯重复：#12 fold #3 与 #1 同输入                  ${foldC.toFixed(0)} ms`);
console.log(`  · 纯重复：#14 fold #4 + 两次 canonicalJson（恒为 true） ${replayEqMs.toFixed(0)} ms`);
console.log(`  · 可共享：#8/#11 的四次 canonicalJson 只为一个比较    ${(compareMs + compare2).toFixed(0)} ms`);
console.log(`\n结论：快照作为「加速手段」在 10 万节点规模上是负收益——`);
console.log(`      journal 的哈希链校验与全量折叠无论如何都要跑，快照只能省下增量重放，`);
console.log(`      而增量重放本身只要 ${replayMs.toFixed(3)} ms。`);

await j2.release();
// 用 `_temp-state.mjs` 的 `removeTempDir`（内部走 removeTree：先删文件再删目录，
// 每步失败都记下来）。**不要用 fs.rmSync** —— 这个环境里它会静默失败，
// 这个探针曾因此每次跑留 156 MB 残留、连留 3 次共 469 MB，而它自己还打印「临时目录已清理」。
if (removeTempDir(DIR)) {
  console.log('\n临时目录已清理');
} else {
  console.log(`\n⚠ 临时目录未删净，需手动清：${DIR}`);
}
