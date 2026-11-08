/**
 * 持久化恢复验收（node 模式）：**6 节点全链**跑完 → 关闭 → 重开一个代次。
 *
 * 断言（Lead 口径）：
 *   1. 重开后 `counts` = {nodes:6, edges:5, done:6, blocked:0}（state 回折正确，不只是"非 0"）；
 *   2. `journalFingerprint` 与关闭前一致（journal 未被改写）；
 *   3. `replay == snapshot`（`core.replayMismatches` 为空，且重放节点数 == 6）；
 *   4. 五段闸门随 journal 恢复；`coreCursor` 与 N4 游标一致（N4-R6 的 `persistCoreEvents(..., {baseSeq})` 口径）。
 *
 * 用法：`node scripts/persistence-check.mjs [--json]`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const lib = (name) => pathToFileURL(path.join(root, 'lib', name)).href;

const { CorePersistence } = await import(lib('persistence.js'));
const core = await import(lib('core/index.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l0-persist-'));
const artifact = path.join(root, 'README.md');

const CHAIN = [
  { nodeId: 'NODE-RESEARCH', stage: 'research', producer: 'ROLE-CODE-01', auditor: 'ROLE-AUDIT_CODE-01' },
  { nodeId: 'NODE-PRD', stage: 'design', producer: 'ROLE-CODE-02', auditor: 'ROLE-AUDIT_CODE-01' },
  { nodeId: 'NODE-CONTRACT', stage: 'design', producer: 'ROLE-CODE-01', auditor: 'ROLE-AUDIT_CODE-01' },
  { nodeId: 'NODE-BUILD', stage: 'build', producer: 'ROLE-CODE-02', auditor: 'ROLE-AUDIT_CODE-01' },
  { nodeId: 'NODE-AUDIT', stage: 'audit', producer: 'ROLE-AUDIT_CODE-01', auditor: 'ROLE-AUDIT_CODE-02' },
  { nodeId: 'NODE-DELIVER', stage: 'deliver', producer: 'ROLE-CODE-01', auditor: 'ROLE-AUDIT_CODE-01' },
];

/** 本测试自己的 6 节点 spec（生产路径不再自动生成固定流水线）。 */
const CHAIN_SPEC = {
  wish: '持久化验收：6 节点全链',
  nodes: CHAIN.map((node, index) => ({
    nodeId: node.nodeId,
    title: node.nodeId,
    stage: node.stage,
    deps: index === 0 ? [] : [CHAIN[index - 1].nodeId],
    acceptance: { kind: 'exists' },
  })),
};

const checks = [];
function check(name, fn) {
  try {
    const result = fn();
    checks.push({ name, ok: result?.ok === true, detail: result?.detail ?? null });
  } catch (error) {
    checks.push({ name, ok: false, detail: { error: String(error?.message || error) } });
  }
}

// ── 代次 1：建图 + 6 节点全链 + 逐节点落盘 ──────────────────
const p1 = await CorePersistence.open({ dir, mode: 'node', owner: 'gen-1' });
core.submitWish({ text: '持久化验收：6 节点全链', maxParallel: 6, budgetTokens: 0 });
core.graphCommit(CHAIN_SPEC);

const steps = [];
for (const node of CHAIN) {
  const store = p1.coreStore;
  const gate = core.passGate(store, node.stage, []);
  const claim = core.claimTask({ nodeId: node.nodeId, role: 'ANY', instanceId: node.producer });
  const evidence = core.submitEvidence({
    nodeId: node.nodeId,
    artifactPath: artifact,
    producer_instance: node.producer,
    producerInstance: node.producer,
    acceptance: { kind: 'exists' },
  });
  const done = core.verifyDone({
    nodeId: node.nodeId,
    producer_instance: node.producer,
    producerInstance: node.producer,
    auditor_instance: node.auditor,
    auditorInstance: node.auditor,
    acceptance: { kind: 'exists' },
  });
  const persisted = await p1.persist();
  steps.push({
    nodeId: node.nodeId,
    gate: gate?.status,
    claim: claim?.ok === true,
    evidence: evidence?.ok === true,
    done: done?.status,
    persisted,
  });
}
const snap1 = p1.snapshot();
const status1 = core.graphStatus();
await p1.close({ snapshot: true });

// ── 代次 2：只读重开 ────────────────────────────────────────
const p2 = await CorePersistence.open({ dir, mode: 'node', owner: 'gen-2' });
const snap2 = p2.snapshot();
const status2 = core.graphStatus();
let mismatches = null;
try {
  mismatches = core.replayMismatches(p2.coreStore);
} catch (error) {
  mismatches = { error: String(error?.message || error) };
}
const gates = core.listGates(p2.coreStore);

check('gen1: 六节点全链跑完（每步 gate→claim→evidence→done）', () => ({
  ok:
    steps.length === 6 &&
    steps.every((step) => step.gate === 'passed' && step.claim && step.evidence && step.done === 'done'),
  detail: steps.map((step) => ({ nodeId: step.nodeId, gate: step.gate, done: step.done })),
}));

check('gen1: 每一步都真落盘（appended>0 且 revision 单调）', () => {
  const rows = steps.map((step, index) => ({
    nodeId: step.nodeId,
    appended: step.persisted?.appended ?? 0,
    revision: step.persisted?.revision ?? 0,
    cursor: step.persisted?.cursor ?? null,
    monotonic: index === 0 || (step.persisted?.revision ?? 0) >= (steps[index - 1].persisted?.revision ?? 0),
  }));
  return { ok: rows.every((row) => row.monotonic && row.cursor !== null && row.appended > 0), detail: rows };
});

check('gen1: counts = {6,5,6,0}', () => ({
  ok:
    status1?.counts?.nodes === 6 &&
    status1?.counts?.edges === 5 &&
    status1?.counts?.done === 6 &&
    status1?.counts?.blocked === 0,
  detail: status1?.counts,
}));

check('gen2: journalFingerprint 与关闭前一致', () => ({
  ok: snap2.fingerprint === snap1.fingerprint && snap2.records === snap1.records,
  detail: { before: snap1.fingerprint.slice(0, 16), after: snap2.fingerprint.slice(0, 16), records: snap2.records },
}));

check('gen2: 重开后 counts = {6,5,6,0}（state 回折正确）', () => ({
  ok:
    status2?.counts?.nodes === 6 &&
    status2?.counts?.edges === 5 &&
    status2?.counts?.done === 6 &&
    status2?.counts?.blocked === 0,
  detail: status2?.counts,
}));

check('gen2: replay == snapshot（无 mismatch）', () => {
  const graph = core.replaySnapshot(p2.coreStore);
  return {
    ok: Array.isArray(mismatches) && mismatches.length === 0 && Object.keys(graph.nodes).length === 6,
    detail: { mismatches, replayed: Object.keys(graph.nodes).length },
  };
});

check('gen2: 五段闸门随 journal 恢复', () => {
  const stages = ['research', 'design', 'build', 'audit', 'deliver'];
  const byStage = new Map((gates ?? []).map((gate) => [gate.stage, gate.status]));
  return { ok: stages.every((stage) => byStage.get(stage) === 'passed'), detail: [...byStage.entries()] };
});

check('gen2: coreCursor 与 N4 游标一致（appendFromSeq 口径）', () => {
  const cursor = typeof p2.stateStore.cursorOf === 'function' ? p2.stateStore.cursorOf('core') : null;
  return {
    ok: Number(cursor?.coreSeq) === Number(snap2.coreCursor) && Number(snap2.coreCursor) > 0,
    detail: { snapshotCursor: snap2.coreCursor, storeCursor: cursor?.coreSeq ?? null, adopted: snap2.adopted },
  };
});

await p2.close();

// ── 代次 3：关闭后**立即**重开（锁释放验证，STATE_LOCKED 回归） ──────
const p3 = await CorePersistence.open({ dir, mode: 'node', owner: 'gen-3' });
const reopened = await p3.persist();
const snap3 = p3.snapshot();
const status3 = core.graphStatus();
await p3.close();

check('lock: close() 后立即重开，无 STATE_LOCKED', () => {
  const code = String(reopened?.error?.code ?? '');
  return {
    ok: reopened?.error === null && !/LOCK/i.test(code) && !/LOCK/i.test(String(reopened?.error?.message ?? '')),
    detail: { error: reopened?.error ?? null, incomplete: reopened?.incomplete ?? null },
  };
});

check('lock: 三代次后指纹稳定、counts 仍 6/6', () => ({
  ok:
    snap3.fingerprint === snap1.fingerprint &&
    status3?.counts?.nodes === 6 &&
    status3?.counts?.done === 6 &&
    status3?.counts?.blocked === 0 &&
    snap3.error === null,
  detail: { fingerprint: snap3.fingerprint.slice(0, 16), counts: status3?.counts, error: snap3.error },
}));

fs.rmSync(dir, { recursive: true, force: true });

const failed = checks.filter((row) => !row.ok);
const report = { ok: failed.length === 0, dir, total: checks.length, failed: failed.length, checks };
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2));
else {
  for (const row of checks) process.stdout.write(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}\n`);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
}
process.exit(report.ok ? 0 : 1);
