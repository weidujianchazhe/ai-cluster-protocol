/**
 * 探针：`graphStatus(limit=1)` 在 1000 节点上那 24 ms 花在哪。
 *
 * 上一轮把 worker 每步的热路径修完之后，`graphStatus` 成了剩下最大的一笔。
 * 它一次调用里做了四件事，本探针逐个计时（不猜）：
 *   validateStream / runFactorGuards / budgetView / readySet+listNodes
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
const { L0ControlService } = await import(lib('service.js'));

const N = Number(process.argv[2] ?? 1000);
const DRIVEN = Number(process.argv[3] ?? 300);
const ROUNDS = Number(process.argv[4] ?? 10);

const makeCtx = () => ({ get: (n) => (n === 'workingDirectory' ? { defaultDirectory: workspaceRoot } : undefined) });
const unwrap = (w) => { const i = w && typeof w === 'object' && 'graph' in w ? w.graph : w; return i && typeof i === 'object' && 'result' in i ? i.result : i; };

const stateDir = path.resolve(tempStateDir('graphstatus'));
const artDir = path.join(stateDir, 'art');
fs.mkdirSync(artDir, { recursive: true });
const bindings = new Map([['role-code-01', 's1'], ['role-audit-code-01', 's2']]);
const svc = new L0ControlService(
  {
    get: (name) => {
      if (name === 'workingDirectory') return { defaultDirectory: workspaceRoot };
      if (name === 'l0adapter') return { report: () => ({ instances: [...bindings].map(([instanceId, sessionId]) => ({ instanceId, sessionId })) }) };
      return undefined;
    },
  },
  { workspaceRoot, stateDir, persistence: 'node', maxParallel: 200 },
  {},
);

const time = async (label, fn, rounds = ROUNDS) => {
  await fn();
  const start = performance.now();
  for (let i = 0; i < rounds; i += 1) await fn();
  const ms = (performance.now() - start) / rounds;
  console.log(`  ${label.padEnd(30)} ${ms.toFixed(2)} ms`);
  return ms;
};

try {
  const nodes = Array.from({ length: N }, (_, i) => ({
    nodeId: `Q${String(i + 1).padStart(4, '0')}`,
    title: `n${i}`,
    capability: 'CODE',
    stage: i === 0 ? 'research' : 'build',
    deps: i === 0 ? [] : ['Q0001'],
    evidenceRequired: ['artifact'],
    acceptance: { kind: 'exists' },
  }));
  unwrap(await svc.graphCommit({ wish: 'graphstatus-probe', policies: { maxParallel: 200 }, nodes }));
  for (const stage of ['research', 'build']) await svc.passGate({ stage, evidence_refs: [] });

  // 驱动 DRIVEN 个节点，让 evidence / artifact 表与 journal 真的长起来
  const caller = { id: 's1' };
  const auditor = { id: 's2' };
  for (let i = 1; i <= DRIVEN; i += 1) {
    const nodeId = `Q${String(i).padStart(4, '0')}`;
    const claimed = unwrap(await svc.taskClaim({ nodeId, instanceId: 'role-code-01' }, caller));
    if (!claimed?.ok) continue;
    const token = claimed.lease.fencing_token;
    const artifact = path.join(artDir, `role-code-01-${nodeId}.md`);
    fs.writeFileSync(artifact, `# ${nodeId}\n`, 'utf8');
    await svc.evidenceSubmit(
      { nodeId, artifactPath: artifact, fencingToken: token, producer_instance: 'role-code-01', auditor_instance: 'role-audit-code-01', kind: 'artifact', acceptance: { kind: 'exists' } },
      caller,
    );
    await svc.verifyDone(
      { nodeId, fencingToken: token, producer_instance: 'role-code-01', auditor_instance: 'role-audit-code-01' },
      auditor,
    );
  }

  const persistence = await svc.persistence();
  const store = persistence.coreStore;
  const events = store.journal.count();
  console.log(`\nN=${N} driven=${DRIVEN} core 事件=${events} evidence=${store.state.evidence.size} artifacts=${store.state.artifacts.size}\n`);

  const total = await time('svc.graphStatus(limit=1)', () => svc.graphStatus({ limit: 1 }));
  const js = await time('svc.journalSummary()', () => svc.journalSummary(), 20);
  const dv = await time('svc.dispatchView()', () => svc.dispatchView(), 20);
  const snap = await time('persistence.snapshot()', () => persistence.snapshot(), 20);
  const coreOnly = await time('core.graphStatus(limit=1) 直调', () => core.withCoreStore(persistence.coreStore, () => core.graphStatus({ limit: 1 })), 20);
  const vs = await time('journal.validateStream()', () => store.journal.validateStream(), 20);
  const guards = await time('runFactorGuards()', () => core.runFactorGuards({ store, nowMs: store.nowMs() }), 20);
  const budget = await time('budgetView()', () => core.budgetView(store), 20);
  const ready = await time('readySet() + listNodes()', () => { core.readySet(store); core.listNodes(store); }, 20);
  console.log(`\n  分项合计 = ${(vs + guards + budget + ready).toFixed(2)} ms（core 内部），core 整调用 ${coreOnly.toFixed(2)} ms，service 整调用 ${total.toFixed(2)} ms`);
  console.log(`  service 外壳 = journalSummary ${js.toFixed(2)} + dispatchView ${dv.toFixed(2)} + snapshot ${snap.toFixed(2)} = ${(js + dv + snap).toFixed(2)} ms`);
} finally {
  try { svc.stopDispatch(); } catch {}
  try { await svc.dispose(); } catch {}
  cleanupTempStateDirs();
}
