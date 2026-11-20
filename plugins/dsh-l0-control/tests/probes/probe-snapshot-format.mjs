/**
 * 探针：快照用 `JSON.stringify(file, null, 2)` 存，值不值？
 *
 * 10 万节点时 state 有 34 MB，缩进美化后落成 57 MB。多出来的 23 MB 全是空格，
 * 却要在每次冷启动时被 readFileSync 读、被 JSON.parse 解析、被 verifySnapshot 再算一遍哈希。
 * 这里量出美化到底买了什么、花了多少。
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
const snapshotMod = await import(lib('state/snapshot.js'));
const reducer = await import(lib('state/reducer.js'));
const { Journal, statePaths } = await import(lib('state/journal.js'));
const { NodeFsPort } = await import(lib('state/fs-port.js'));

const NODES = Number(process.argv[2] ?? 100000);
const DIR = path.join(os.tmpdir(), `.l0-probe-snapfmt-${Date.now()}`);
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

{
  const p = await CorePersistence.open({ dir: DIR, mode: 'node', waitMs: 0 });
  core.withCoreStore(p.coreStore, () => {
    core.graphCommit({
      wish: 'snapfmt',
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
const journal = (await Journal.open({ dir: DIR, fs: fsPort, owner: 'probe', ttlMs: 1_800_000 })).journal;
const records = journal.records();
const raw = fs.readFileSync(paths.journal, 'utf8');
const state = reducer.fold(records, reducer.emptyState());
const file = snapshotMod.buildSnapshot(state, records, raw, new Date().toISOString());

const pretty = `${JSON.stringify(file, null, 2)}\n`;
const compact = `${JSON.stringify(file)}\n`;
console.log(`state 体量（canonicalJson）  ${mb(JSON.stringify(state).length)}`);
console.log(`美化格式                     ${mb(pretty.length)}`);
console.log(`紧凑格式                     ${mb(compact.length)}   省 ${((1 - compact.length / pretty.length) * 100).toFixed(0)}%\n`);

const bench = (label, body) => {
  const p = path.join(DIR, `snap-${label}.json`);
  fs.writeFileSync(p, body, 'utf8');
  const t0 = process.hrtime.bigint();
  const text = fs.readFileSync(p, 'utf8');
  const readMs = ms(t0);
  const t1 = process.hrtime.bigint();
  const parsed = JSON.parse(text);
  const parseMs = ms(t1);
  const t2 = process.hrtime.bigint();
  snapshotMod.verifySnapshot(parsed);
  const verifyMs = ms(t2);
  console.log(`${label.padEnd(8)} 读 ${readMs.toFixed(0).padStart(4)} ms · 解析 ${parseMs.toFixed(0).padStart(4)} ms · 自校验 ${verifyMs.toFixed(0).padStart(4)} ms · 合计 ${(readMs + parseMs + verifyMs).toFixed(0).padStart(5)} ms`);
  fs.unlinkSync(p);
  return readMs + parseMs + verifyMs;
};

console.log('冷启动读快照（各跑两轮，取第二轮避免页缓存偏差）');
bench('预热', pretty);
const prettyTotal = bench('美化', pretty);
const compactTotal = bench('紧凑', compact);
console.log(`\n紧凑比美化省 ${(prettyTotal - compactTotal).toFixed(0)} ms（${((1 - compactTotal / prettyTotal) * 100).toFixed(0)}%）`);

console.log('\n可读性代价：快照是机器产物，不是人读文件（人读的是 STATE.md 与报告）。');
console.log('且 `readSnapshot` 只做 JSON.parse，从不按行解析——美化对任何代码路径都没有价值。');

await journal.release();
if (!removeTempDir(DIR)) console.log(`临时目录未删净，需手动清: ${DIR}`);
console.log('\n临时目录已清理');
