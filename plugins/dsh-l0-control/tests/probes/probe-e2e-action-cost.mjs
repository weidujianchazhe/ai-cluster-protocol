/**
 * 探针：2000 节点为什么比 1000 节点贵（7.90 → 10.66 ms/节点）。
 *
 * `taskNext` 稳态已到 0.2 ms，所以增量不在它身上。逐个量另外三个动作的
 * **core 直调**成本，并单独量怀疑对象 `listEvidence`（它每次都把全部 evidence
 * 展开 + 过滤 + 排序——单个节点的证据却要用全表来筛）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempStateDir, cleanupTempStateDirs } from '../_temp-state.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..', '..');
const workspaceRoot = path.resolve(pluginRoot, '..', '..');
const lib = (n) => pathToFileURL(path.join(pluginRoot, 'lib', n)).href;
const core = await import(lib('core/index.js'));

const N = Number(process.argv[2] ?? 1000);
const DRIVE = Number(process.argv[3] ?? N);
const ROUNDS = Number(process.argv[4] ?? 30);

const dir = path.resolve(tempStateDir(`scale-${N}`));
const store = new core.Store({});
const nodes = Array.from({ length: N }, (_, i) => ({
  nodeId: `X${String(i + 1).padStart(5, '0')}`,
  title: `n${i}`,
  capability: 'CODE',
  acceptance: { kind: 'exists' },
}));
const committed = core.commitGraph(store, { wish: 'probe', policies: { maxParallel: 64 }, nodes });
if (!committed.ok) throw new Error(JSON.stringify(committed.errors));
core.bootstrap(store);
fs.mkdirSync(path.join(dir, 'art'), { recursive: true });
const artifact = path.join(dir, 'art', 'a.md');
fs.writeFileSync(artifact, '# a\n', 'utf8');

const time = (label, fn, rounds = ROUNDS) => {
  fn();
  const t0 = performance.now();
  for (let i = 0; i < rounds; i += 1) fn();
  const ms = (performance.now() - t0) / rounds;
  console.log(`  ${label.padEnd(30)} ${ms.toFixed(3)} ms`);
  return ms;
};

// 驱动 DRIVE 个节点（claim → evidence → verify），让 evidence 表长大
let done = 0;
for (let i = 1; i <= DRIVE; i += 1) {
  const nodeId = `X${String(i).padStart(5, '0')}`;
  const lease = core.claim(store, nodeId, 'role-code-01', { ttlSec: 600 });
  const ev = core.withCoreStore(store, () => core.submitEvidence({
    nodeId,
    artifactPath: artifact,
    fencingToken: lease.fencing_token,
    producerInstance: 'role-code-01',
    auditorInstance: 'role-audit-code-01',
    kind: 'artifact',
    acceptance: { kind: 'exists' },
  }));
  if (!ev.ok) continue;
  const v = core.withCoreStore(store, () => core.verifyDone({
    nodeId,
    fencingToken: lease.fencing_token,
    producer_instance: 'role-code-01',
    auditor_instance: 'role-audit-code-01',
  }));
  if (v.ok) done += 1;
}

console.log(`\nN=${N} driven=${done} evidence=${store.state.evidence.size} artifacts=${store.state.artifacts.size} 事件=${store.journal.count()}\n`);

const nodeId = `X${String(DRIVE).padStart(5, '0')}`; // 已 done，用来量只读路径
const pending = `X${String(DRIVE + 1).padStart(5, '0')}`;

const lv = time('listEvidence(单节点)', () => core.listEvidence(store, nodeId), 50);
const pv = time('passEvidence(单节点)', () => core.passEvidence(store, nodeId), 50);
const cred = time('doneCredential', () => core.doneCredential(store, nodeId), 50);
const claimMs = time(`claim(新节点 ${pending})`, () => { try { core.claim(store, pending, 'role-code-99', { ttlSec: 1 }); } catch { /* 已有租约等 */ } }, 20);
const evMs = (() => {
  // 反复对同一个已 done 节点提证据会失败，但入口开销仍要付
  const t0 = performance.now();
  for (let i = 0; i < 20; i += 1) {
    core.withCoreStore(store, () => core.submitEvidence({ nodeId, artifactPath: artifact, fencingToken: 1, producerInstance: 'role-code-01', acceptance: { kind: 'exists' } }));
  }
  const ms = (performance.now() - t0) / 20;
  console.log(`  ${'submitEvidence(入口开销)'.padEnd(30)} ${ms.toFixed(3)} ms`);
  return ms;
})();
console.log(`\n  归因：listEvidence ${lv.toFixed(3)} / passEvidence ${pv.toFixed(3)} / 凭证 ${cred.toFixed(3)} / claim ${claimMs.toFixed(3)} / evidence 入口 ${evMs.toFixed(3)}`);
cleanupTempStateDirs();
