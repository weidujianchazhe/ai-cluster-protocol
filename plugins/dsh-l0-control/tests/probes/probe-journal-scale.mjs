/**
 * 探针：journal 在 10 万节点量级的真实代价（先测再改）。
 *
 * 只回答可测的数字：
 *   1. 10 万节点规模下 journal 行数、字节数、单行均值、放大倍数；
 *   2. **冷启动全量读**的耗时拆解（readFileSync / split / JSON.parse / 哈希链校验）；
 *   3. 真实 `CorePersistence.open()`（含恢复）的耗时可与内存占用。
 *
 * 不测「分段后能快多少」——那是改完之后才有的数。
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

function stateDir(tag) {
  const dir = path.join(os.tmpdir(), `.l0-probe-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function removeTree(target) {
  const entry = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!entry) return;
  if (!entry.isDirectory()) return fs.unlinkSync(target);
  for (const name of fs.readdirSync(target)) removeTree(path.join(target, name));
  if (!removeTempDir(target)) console.log(`临时目录未删净，需手动清: ${target}`);
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const NODES = Number(process.argv[2] ?? 100000);
const DIR = stateDir('journal-scale');

console.log(`规模：${NODES} 节点 · Node ${process.version}\n`);

// ── 建图并落盘 ─────────────────────────────────────────────────────────────
const tBuild = process.hrtime.bigint();
const heapBefore = process.memoryUsage().heapUsed;
const persistence = await CorePersistence.open({ dir: DIR, mode: 'node', waitMs: 0 });
const store = persistence.coreStore;

core.withCoreStore(store, () => {
  core.submitWish({ text: `${NODES} 节点 journal 规模探针`, maxParallel: NODES + 10, budgetTokens: 0 });
  const committed = core.graphCommit({
    wish: `${NODES} 节点 journal 规模探针`,
    policies: { maxParallel: NODES + 10, budgetTokens: 0 },
    nodes: Array.from({ length: NODES }, (_, i) => ({
      nodeId: `N${String(i).padStart(6, '0')}`,
      title: `节点 ${i}`,
      stage: 'build',
      status: 'planned',
      deps: [],
      acceptance: { kind: 'exists' },
    })),
  });
  if (!committed.ok) throw new Error(JSON.stringify(committed.errors ?? []).slice(0, 400));
});
const flushed = await persistence.persist();
console.log(`persist: 落盘 ${flushed.appended} 条，revision=${flushed.revision}，incomplete=${flushed.incomplete}`);
const buildMs = Number(process.hrtime.bigint() - tBuild) / 1e6;
const heapAfterBuild = process.memoryUsage().heapUsed;

const journalPath = path.join(DIR, 'journal.jsonl');
const bytes = fs.statSync(journalPath).size;
const rawForCount = fs.readFileSync(journalPath, 'utf8');
const lineCount = rawForCount.split('\n').filter(Boolean).length;

console.log(`建图 + 落盘              ${buildMs.toFixed(0)} ms`);
console.log(`journal 行数             ${lineCount}`);
console.log(`journal 字节             ${mb(bytes)}（单行均值 ${(bytes / lineCount).toFixed(0)} B）`);
console.log(`放大倍数                 ${(lineCount / NODES).toFixed(2)} 行/节点`);
console.log(`堆增量                   ${mb(heapAfterBuild - heapBefore)}`);

await persistence.close();

// ── 冷读拆解（同一份文本，分别计时）──────────────────────────────────────
const tRead = process.hrtime.bigint();
const raw = fs.readFileSync(journalPath, 'utf8');
const readMs = Number(process.hrtime.bigint() - tRead) / 1e6;

const tSplit = process.hrtime.bigint();
const lines = raw.split('\n');
const splitMs = Number(process.hrtime.bigint() - tSplit) / 1e6;

const tJson = process.hrtime.bigint();
const parsed = [];
for (const line of lines) if (line) parsed.push(JSON.parse(line));
const jsonMs = Number(process.hrtime.bigint() - tJson) / 1e6;

console.log(`\n冷读拆解（${parsed.length} 行）`);
console.log(`  readFileSync           ${readMs.toFixed(1)} ms`);
console.log(`  split('\\n')            ${splitMs.toFixed(1)} ms`);
console.log(`  JSON.parse             ${jsonMs.toFixed(1)} ms`);
console.log(`  合计                   ${(readMs + splitMs + jsonMs).toFixed(0)} ms`);

// ── 哈希链校验单独计时（这是冷启动绕不开的那一段）───────────────────────
const { recordHashOk } = await import(lib('state/canonical.js'));
const tHash = process.hrtime.bigint();
let chainOk = 0;
let prev = null;
for (const record of parsed) {
  if (!recordHashOk(record)) break;
  if (prev && (record.seq !== prev.seq + 1 || record.prevHash !== prev.hash)) break;
  prev = record;
  chainOk += 1;
}
const hashMs = Number(process.hrtime.bigint() - tHash) / 1e6;
console.log(`  哈希链校验（${chainOk} 条）  ${hashMs.toFixed(0)} ms`);

// ── 真实冷启动 ─────────────────────────────────────────────────────────────
global.gc?.();
const heapBeforeOpen = process.memoryUsage().heapUsed;
const tOpen = process.hrtime.bigint();
const reopened = await CorePersistence.open({ dir: DIR, mode: 'node', waitMs: 0 });
const openMs = Number(process.hrtime.bigint() - tOpen) / 1e6;
const heapAfterOpen = process.memoryUsage().heapUsed;
const snap = reopened.snapshot();

console.log(`\n真实冷启动 open()        ${openMs.toFixed(0)} ms`);
console.log(`  恢复记录数             ${snap.records}`);
console.log(`  恢复节点数             ${snap.restoredCounts?.nodes ?? 0}`);
console.log(`  冷启动堆增量           ${mb(heapAfterOpen - heapBeforeOpen)}`);
console.log(`  单节点冷启动成本       ${(openMs / NODES).toFixed(3)} ms/节点`);

await reopened.close();

// ── 二次冷启动：快照在，看省了多少 ────────────────────────────────────────
const tOpen2 = process.hrtime.bigint();
const again = await CorePersistence.open({ dir: DIR, mode: 'node', waitMs: 0 });
const open2Ms = Number(process.hrtime.bigint() - tOpen2) / 1e6;
console.log(`\n二次冷启动               ${open2Ms.toFixed(0)} ms（降幅 ${(100 - (open2Ms / openMs) * 100).toFixed(0)}%）`);
console.log('  说明：快照只是缓存，哈希链仍逐条校验，所以降幅有限——这正是下面要处理的地方。');

await again.close();
removeTree(DIR);
console.log('\n临时目录已清理');
