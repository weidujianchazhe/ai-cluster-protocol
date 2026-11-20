/**
 * 探针：10 万节点冷启动 15.5 秒，倒底花在哪一段。
 *
 * 已测出的部分：读 1.09 s + 哈希链校验 1.76 s ≈ 2.9 s，**剩下 12.6 s 没有归属**。
 * 不定位就动手会改错地方，所以先把恢复流程逐段捏开单独计时。
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
const DIR = path.join(os.tmpdir(), `.l0-probe-breakdown-${Date.now()}`);
fs.mkdirSync(DIR, { recursive: true });

const rm = (t) => {
  const e = fs.lstatSync(t, { throwIfNoEntry: false });
  if (!e) return;
  if (!e.isDirectory()) return fs.unlinkSync(t);
  for (const n of fs.readdirSync(t)) rm(path.join(t, n));
  if (!removeTempDir(t)) console.log(`临时目录未删净，需手动清: ${t}`);
};
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const mb = (b) => `${(b / 1024 / 1024).toFixed(0)} MB`;

// ── 准备数据（复用真实流程，保证 journal 形状真实）──────────────────────
const p1 = await CorePersistence.open({ dir: DIR, mode: 'node', waitMs: 0 });
core.withCoreStore(p1.coreStore, () => {
  core.graphCommit({
    wish: 'breakdown',
    policies: { maxParallel: NODES + 10, budgetTokens: 0 },
    nodes: Array.from({ length: NODES }, (_, i) => ({
      nodeId: `N${String(i).padStart(6, '0')}`, title: `n${i}`, stage: 'build', status: 'planned',
      deps: [], acceptance: { kind: 'exists' },
    })),
  });
});
await p1.persist();
await p1.close();
console.log(`已建 ${NODES} 节点 journal\n`);

// ── 逐段计时（不走 CorePersistence，直接操 N4 状态层）──────────────────
const paths = statePaths(DIR);
const fsPort = new NodeFsPort();

let t = process.hrtime.bigint();
const opened = await Journal.open({ dir: DIR, fs: fsPort, owner: 'probe', ttlMs: 1_800_000 });
const journalOpenMs = ms(t);
const journal = opened.journal;
console.log(`1. Journal.open（含 loadAndRepair + verifyChain）  ${journalOpenMs.toFixed(0)} ms`);

t = process.hrtime.bigint();
const records = journal.records();
const recordsMs = ms(t);
console.log(`2. records() 取缓存                                ${recordsMs.toFixed(3)} ms（${records.length} 条）`);

t = process.hrtime.bigint();
const folded = reducer.fold(records, reducer.emptyState());
const foldMs = ms(t);
console.log(`3. fold（全量折叠）                                ${foldMs.toFixed(0)} ms`);

t = process.hrtime.bigint();
const sha = snapshotMod.stateSha256(folded);
const shaMs = ms(t);
console.log(`4. stateSha256(canonicalJson(全量状态))            ${shaMs.toFixed(0)} ms  sha=${sha.slice(0, 8)}`);

const raw = fs.readFileSync(paths.journal, 'utf8');
t = process.hrtime.bigint();
const snap = snapshotMod.buildSnapshot(folded, records, raw, new Date().toISOString());
const buildSnapMs = ms(t);
console.log(`5. buildSnapshot（含再算一次 journalBytes/hash）    ${buildSnapMs.toFixed(0)} ms  字节=${mb(JSON.stringify(snap).length)}`);

// 读回快照（模拟二次启动）
const snapBody = `${JSON.stringify(snap, null, 2)}\n`;
fs.writeFileSync(paths.snapshot, snapBody, 'utf8');
t = process.hrtime.bigint();
const loaded = await snapshotMod.readSnapshot(fsPort, paths);
const readSnapMs = ms(t);
console.log(`6. readSnapshot（JSON.parse 快照）                 ${readSnapMs.toFixed(0)} ms  文件=${mb(snapBody.length)}`);

t = process.hrtime.bigint();
snapshotMod.verifySnapshot(loaded.file);
const verifySnapMs = ms(t);
console.log(`7. verifySnapshot（再算一次 stateSha256）           ${verifySnapMs.toFixed(0)} ms`);

t = process.hrtime.bigint();
const anchor = snapshotMod.checkAnchor(loaded.file, records, raw);
const anchorMs = ms(t);
console.log(`8. checkAnchor（前缀 sha256 + 全量字节）            ${anchorMs.toFixed(0)} ms  状态=${anchor.status}`);

t = process.hrtime.bigint();
const atAnchor = reducer.foldUntil(records, loaded.file.meta.seq, reducer.emptyState());
const foldUntilMs = ms(t);
console.log(`9. foldUntil（折到快照 seq，**第二遍全量折叠**）     ${foldUntilMs.toFixed(0)} ms`);

t = process.hrtime.bigint();
const cmp = canonical.canonicalJson(atAnchor.state);
const cmpMs = ms(t);
console.log(`10. canonicalJson(折到 seq 的状态) 用于比对        ${cmpMs.toFixed(0)} ms  长度=${mb(cmp.length)}`);

console.log(`\n合计已归属：${(journalOpenMs + recordsMs + foldMs + shaMs + buildSnapMs + readSnapMs + verifySnapMs + anchorMs + foldUntilMs + cmpMs).toFixed(0)} ms`);
console.log('（真实 open 还含 rehydrate(core)、restoreCoreJournal、adoptCursor 等）');

await journal.release();
if (!removeTempDir(DIR)) console.log(`临时目录未删净，需手动清: ${DIR}`);
console.log('\n临时目录已清理');
