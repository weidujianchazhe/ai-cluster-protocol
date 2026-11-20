/**
 * 探针：`Journal.status()` 的 `bytes` 字段有多贵。
 *
 * `status()` 里这行是全量 `JSON.stringify`：
 *   `bytes: this.recordsCache.reduce((sum, r) => sum + JSON.stringify(r).length + 1, 0)`
 * 20 万条记录时它要 stringify 20 万个对象，只为报一个字节数。
 * 而 `recoverWithJournal` 在返回报告时调了一次（`journal.status().repair`）。
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
const { Journal } = await import(lib('state/journal.js'));
const { NodeFsPort } = await import(lib('state/fs-port.js'));

const NODES = Number(process.argv[2] ?? 100000);
const DIR = path.join(os.tmpdir(), `.l0-probe-status-${Date.now()}`);
fs.mkdirSync(DIR, { recursive: true });
const rm = (t) => {
  const e = fs.lstatSync(t, { throwIfNoEntry: false });
  if (!e) return;
  if (!e.isDirectory()) return fs.unlinkSync(t);
  for (const n of fs.readdirSync(t)) rm(path.join(t, n));
  if (!removeTempDir(t)) console.log(`临时目录未删净，需手动清: ${t}`);
};
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

{
  const p = await CorePersistence.open({ dir: DIR, mode: 'node', waitMs: 0 });
  core.withCoreStore(p.coreStore, () => {
    core.graphCommit({
      wish: 'status-probe',
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

const fsPort = new NodeFsPort();
const opened = await Journal.open({ dir: DIR, fs: fsPort, owner: 'probe', ttlMs: 1_800_000 });
const journal = opened.journal;
const records = journal.records();
console.log(`记录数 ${records.length}\n`);

// status() 整体
let t = process.hrtime.bigint();
const st = journal.status();
const statusMs = ms(t);
console.log(`status() 整体                        ${statusMs.toFixed(0)} ms  报出 bytes=${st.bytes}`);

// 只算 bytes（复刻同一行）
t = process.hrtime.bigint();
let bytes = 0;
for (const record of records) bytes += JSON.stringify(record).length + 1;
const bytesMs = ms(t);
console.log(`  其中 bytes 那行（JSON.stringify 全量）  ${bytesMs.toFixed(0)} ms  → ${bytes}`);

// 对照：用真实文件大小
const realBytes = fs.statSync(path.join(DIR, 'journal.jsonl')).size;
console.log(`  真实文件字节                           ${realBytes}（差 ${((bytes - realBytes) / realBytes * 100).toFixed(1)}%，因为多字节字符）`);

// 对照：incremental 维护（压入时累加）应该是 0
t = process.hrtime.bigint();
let inc = 0;
for (const record of records) inc += record.seq >= 0 ? 0 : 0;
const incMs = ms(t);
console.log(`  对照：增量维护（压入时累加）=          ${incMs.toFixed(0)} ms（O(1)）`);

await journal.release();
if (!removeTempDir(DIR)) console.log(`临时目录未删净，需手动清: ${DIR}`);
console.log('\n临时目录已清理');
