/**
 * 探针：为什么 1000 节点时每步 ~25 ms 而 60 节点时 ~4 ms？
 *
 * 服务层每个动作都要 `withCore` → 动作 → `persist()`。若每步成本随**状态规模**增长，
 * 那它就是个 O(state) 的固定税，与动作本身无关。本探针对同规模的图，分别用
 * `persistence: node` 与 `memory` 量同一批动作，从而把「持久化」与「图规模」分开。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempStateDir, cleanupTempStateDirs } from '../_temp-state.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..', '..');
const workspaceRoot = path.resolve(pluginRoot, '..', '..');
const lib = (name) => pathToFileURL(path.join(pluginRoot, 'lib', name)).href;
const { L0ControlService } = await import(lib('service.js'));

const N = Number(process.argv[2] ?? 1000);
const ROUNDS = Number(process.argv[3] ?? 30);
const makeCtx = () => ({ get: (n) => (n === 'workingDirectory' ? { defaultDirectory: workspaceRoot } : undefined) });
const unwrap = (w) => { const i = w && typeof w === 'object' && 'graph' in w ? w.graph : w; return i && typeof i === 'object' && 'result' in i ? i.result : i; };
const time = async (label, fn, rounds = ROUNDS) => {
  await fn(); // 预热
  const start = performance.now();
  for (let i = 0; i < rounds; i += 1) await fn();
  const ms = (performance.now() - start) / rounds;
  console.log(`  ${label.padEnd(22)} ${ms.toFixed(2)} ms/次`);
  return ms;
};

for (const mode of ['memory', 'node']) {
  const stateDir = path.resolve(tempStateDir(`probe-${mode}`));
  const svc = new L0ControlService(makeCtx(), { workspaceRoot, stateDir, persistence: mode, maxParallel: 64 }, {});
  try {
    const nodes = Array.from({ length: N }, (_, i) => ({
      nodeId: `P${String(i + 1).padStart(4, '0')}`,
      title: `n${i}`,
      capability: 'CODE',
      evidenceRequired: ['artifact'],
      acceptance: { kind: 'exists' },
    }));
    unwrap(await svc.graphCommit({ wish: 'op-cost', policies: { maxParallel: 64 }, nodes }));
    console.log(`\npersistence=${mode}  N=${N}`);
    await time('graphStatus(limit=1)', () => svc.graphStatus({ limit: 1 }), 10);
    await time('taskNext', () => svc.taskNext({}));
    await time('dispatch({})', () => svc.dispatch({}), 5);
    const persistence = await svc.persistence();
    console.log(`  core journal 行数        ${persistence.core.journal.count()}`);
    console.log(`  persist() 本体           ${(await time('persist()', () => svc.persist(), 10)).toFixed(2)} ms/次`);
  } finally {
    try { svc.stopDispatch(); } catch {}
    try { await svc.dispose(); } catch {}
    cleanupTempStateDirs();
  }
}
