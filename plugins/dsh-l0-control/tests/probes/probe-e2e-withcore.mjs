/**
 * 探针：服务层每步 ~1.7–1.8 ms 里，`withCore` 外壳占多少。
 *
 * 上一轮把 core 内部的热点修完之后，剩下的问题是「core 直调往往 < 0.5 ms，
 * 而 service 同动作约 1.7–1.8 ms」。差值只能在 `withCore` 里：
 *   persist()  →  sanitizeForHost()  →  包装对象
 * 本探针对同一份状态分别量「core 直调」与「service 全链」，并把外壳拆开。
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
const { L0ControlService, sanitizeForHost } = await import(lib('service.js'));

const N = Number(process.argv[2] ?? 1000);
const ROUNDS = Number(process.argv[3] ?? 20);
const makeCtx = () => ({ get: (n) => (n === 'workingDirectory' ? { defaultDirectory: workspaceRoot } : undefined) });
const unwrap = (w) => { const i = w && typeof w === 'object' && 'graph' in w ? w.graph : w; return i && typeof i === 'object' && 'result' in i ? i.result : i; };

const stateDir = path.resolve(tempStateDir('withcore'));
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
  { workspaceRoot, stateDir, persistence: 'node', maxParallel: 40 },
  {},
);

const time = async (label, fn, rounds = ROUNDS) => {
  await fn();
  const t0 = performance.now();
  for (let i = 0; i < rounds; i += 1) await fn();
  const ms = (performance.now() - t0) / rounds;
  console.log(`  ${label.padEnd(34)} ${ms.toFixed(3)} ms`);
  return ms;
};

try {
  const nodes = Array.from({ length: N }, (_, i) => ({
    nodeId: `W${String(i + 1).padStart(4, '0')}`,
    title: `n${i}`,
    capability: 'CODE',
    stage: i === 0 ? 'research' : 'build',
    deps: i === 0 ? [] : ['W0001'],
    evidenceRequired: ['artifact'],
    acceptance: { kind: 'exists' },
  }));
  unwrap(await svc.graphCommit({ wish: 'withcore-probe', policies: { maxParallel: 40 }, nodes }));
  for (const stage of ['research', 'build']) await svc.passGate({ stage, evidence_refs: [] });

  const caller = { id: 's1' };
  const auditor = { id: 's2' };
  let doneCount = 0;
  for (let i = 1; i <= N; i += 1) {
    const nodeId = `W${String(i).padStart(4, '0')}`;
    const claimed = unwrap(await svc.taskClaim({ nodeId, instanceId: 'role-code-01' }, caller));
    if (!claimed?.ok) continue;
    const token = claimed.lease.fencing_token;
    const artifact = path.join(artDir, `a-${nodeId}.md`);
    fs.writeFileSync(artifact, `# ${nodeId}\n`, 'utf8');
    const ev = unwrap(await svc.evidenceSubmit({ nodeId, artifactPath: artifact, fencingToken: token, producer_instance: 'role-code-01', auditor_instance: 'role-audit-code-01', kind: 'artifact', acceptance: { kind: 'exists' } }, caller));
    if (!ev?.ok) continue;
    const v = unwrap(await svc.verifyDone({ nodeId, fencingToken: token, producer_instance: 'role-code-01', auditor_instance: 'role-audit-code-01' }, auditor));
    if (v?.ok) doneCount += 1;
  }

  const persistence = await svc.persistence();
  const store = persistence.coreStore;
  console.log(`\nN=${N} done=${doneCount} core 事件=${store.journal.count()} evidence=${store.state.evidence.size}\n`);

  console.log('— 同一动作：core 直调 vs service 全链 —');
  const coreNext = await time('core.nextTask（直调）', () => core.withCoreStore(store, () => core.nextTask({})));
  const svcNext = await time('svc.taskNext（全链）', () => svc.taskNext({}));
  const coreStatus = await time('core.graphStatus(limit=1)（直调）', () => core.withCoreStore(store, () => core.graphStatus({ limit: 1 })));
  const svcStatus = await time('svc.graphStatus(limit=1)（全链）', () => svc.graphStatus({ limit: 1 }));

  console.log('\n— withCore 外壳的三段 —');
  const persistMs = await time('persistence.persist()（无待落）', () => persistence.persist());
  const smallPayload = { ok: true, nodeId: 'W0002', status: 'ready', lease: { fencing_token: 3 } };
  const smallSanitize = await time('sanitizeForHost(小载荷)', async () => sanitizeForHost(smallPayload));
  const statusResult = unwrap(await svc.graphStatus({ limit: 1 }));
  const bigSanitize = await time('sanitizeForHost(graphStatus 载荷)', async () => sanitizeForHost(statusResult), 10);
  const nextResult = unwrap(await svc.taskNext({}));
  const nextSanitize = await time('sanitizeForHost(taskNext 载荷)', async () => sanitizeForHost(nextResult));

  console.log(`\n  外壳差值：taskNext ${(svcNext - coreNext).toFixed(3)} ms，graphStatus ${(svcStatus - coreStatus).toFixed(3)} ms`);
  console.log(`  可归因：persist ${persistMs.toFixed(3)} + sanitize(taskNext ${nextSanitize.toFixed(3)} / status ${bigSanitize.toFixed(3)})`);
} finally {
  try { svc.stopDispatch(); } catch {}
  try { await svc.dispose(); } catch {}
  cleanupTempStateDirs();
}
