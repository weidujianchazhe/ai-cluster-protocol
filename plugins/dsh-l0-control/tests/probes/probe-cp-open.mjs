/**
 * 探针：`CorePersistence.open()` 里 N4 之外的那部分花了多少。
 *
 * 已知 N4 恢复流程自身约 6.3 s，而真实 open 是 15.5 s。差值 9 s 落在
 * `restoreCoreJournal` / `rehydrate(core)` / `adoptCursor` 这几步上。
 * 不测清楚就优化会改错地方。
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
const { Store: StateStore } = await import(lib('state/store.js'));
const { NodeFsPort } = await import(lib('state/fs-port.js'));
const bridge = await import(lib('state/bridge.js'));

const NODES = Number(process.argv[2] ?? 100000);
const DIR = path.join(os.tmpdir(), `.l0-probe-cp-${Date.now()}`);
fs.mkdirSync(DIR, { recursive: true });

const rm = (t) => {
  const e = fs.lstatSync(t, { throwIfNoEntry: false });
  if (!e) return;
  if (!e.isDirectory()) return fs.unlinkSync(t);
  for (const n of fs.readdirSync(t)) rm(path.join(t, n));
  if (!removeTempDir(t)) console.log(`临时目录未删净，需手动清: ${t}`);
};
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

// ── 建数据 ────────────────────────────────────────────────────────────────
{
  const p = await CorePersistence.open({ dir: DIR, mode: 'node', waitMs: 0 });
  core.withCoreStore(p.coreStore, () => {
    core.graphCommit({
      wish: 'cp-breakdown',
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
console.log(`已建 ${NODES} 节点\n`);

global.gc?.();

// ── 复刻 CorePersistence.open 的每一步 ───────────────────────────────────
let t = process.hrtime.bigint();
const opened = await StateStore.open({ dir: DIR, fs: new NodeFsPort(), waitMs: 5000, retryBaseMs: 25, retryMaxMs: 500 });
const tStateOpen = ms(t);
console.log(`1. StateStore.open（N4 恢复全流程）        ${tStateOpen.toFixed(0)} ms`);

const coreStore = new core.Store({});

t = process.hrtime.bigint();
const all = opened.journal.records();
const tRecords = ms(t);
console.log(`2. journal.records()                       ${tRecords.toFixed(3)} ms（${all.length} 条）`);

t = process.hrtime.bigint();
const business = bridge.businessRecords(all);
const tBusiness = ms(t);
console.log(`3. businessRecords（过滤诊断事件）          ${tBusiness.toFixed(0)} ms（${business.length} 条）`);

t = process.hrtime.bigint();
const rawEvents = bridge.toEventRecords(business);
const tToEvents = ms(t);
console.log(`4. toEventRecords（camelCase → snake_case） ${tToEvents.toFixed(0)} ms`);

t = process.hrtime.bigint();
const renumbered = rawEvents.map((event, index) => ({ ...event, seq: index + 1, event_id: `EVT-${String(index + 1).padStart(6, '0')}` }));
const tRenumber = ms(t);
console.log(`5. 重编号（每条新建对象）                   ${tRenumber.toFixed(0)} ms`);

t = process.hrtime.bigint();
coreStore.journal.restore(renumbered);
const tRestore = ms(t);
console.log(`6. core.journal.restore（灌进 core 内存日志） ${tRestore.toFixed(0)} ms`);

t = process.hrtime.bigint();
const rehydrated = core.rehydrate(coreStore);
const tRehydrate = ms(t);
console.log(`7. rehydrate(core)（core 全量折叠）         ${tRehydrate.toFixed(0)} ms  节点=${rehydrated?.nodes?.size ?? 0}`);

t = process.hrtime.bigint();
await opened.adoptCursor(coreStore.journal.count(), 'core');
const tCursor = ms(t);
console.log(`8. adoptCursor（通常幂等，不写盘）          ${tCursor.toFixed(0)} ms`);

const total = tStateOpen + tRecords + tBusiness + tToEvents + tRenumber + tRestore + tRehydrate + tCursor;
console.log(`\n合计 ${total.toFixed(0)} ms`);
console.log(`其中 N4 恢复      ${tStateOpen.toFixed(0)} ms  (${((tStateOpen / total) * 100).toFixed(0)}%)`);
console.log(`其中桥接 + core   ${(total - tStateOpen).toFixed(0)} ms  (${(((total - tStateOpen) / total) * 100).toFixed(0)}%)`);

await opened.close({ snapshot: false });
if (!removeTempDir(DIR)) console.log(`临时目录未删净，需手动清: ${DIR}`);
console.log('\n临时目录已清理');
