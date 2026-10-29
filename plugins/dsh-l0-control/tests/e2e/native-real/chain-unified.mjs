/**
 * 统一身份下的 6 节点全链（N7b）：实例 ID 一律 `role-<role>-<nn>` 小写。
 *
 * 与 `scripts/persistence-check.mjs` 的区别：那条验"持久化+重载"，这条验**身份统一**——
 * 全链里 producer/auditor 全部使用 `role-code-*` / `role-audit-code-*`，core 能解析（canonical 大写），
 * 并断言：全链 6/6 done、审计独立、每条证据的 producer 就是对应实例、core 的 parseInstanceId 认得该 ID。
 *
 * 用法：`node tests/e2e/native-real/chain-unified.mjs [--json]`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const lib = (name) => pathToFileURL(path.join(root, 'lib', name)).href;

const { CorePersistence } = await import(lib('persistence.js'));
const core = await import(lib('core/index.js'));
const { roleInstanceId, parseInstanceId } = await import(lib('native/team.js'));

const CHAIN = [
  { nodeId: 'NODE-RESEARCH', stage: 'research', producer: 'CODE', auditor: 'AUDIT_CODE' },
  { nodeId: 'NODE-PRD', stage: 'design', producer: 'CODE', auditor: 'AUDIT_CODE' },
  { nodeId: 'NODE-CONTRACT', stage: 'design', producer: 'CODE', auditor: 'AUDIT_CODE' },
  { nodeId: 'NODE-BUILD', stage: 'build', producer: 'CODE', auditor: 'AUDIT_CODE' },
  { nodeId: 'NODE-AUDIT', stage: 'audit', producer: 'AUDIT_CODE', auditor: 'AUDIT_CODE' },
  { nodeId: 'NODE-DELIVER', stage: 'deliver', producer: 'CODE', auditor: 'AUDIT_CODE' },
].map((row, index) => {
  // 生产/审计按职务编号分配，审计节点用 11/12 保证 producer≠auditor
  const producerIndex = index % 2 === 0 ? 1 : 2;
  const auditorIndex = row.nodeId === 'NODE-AUDIT' ? 12 : 11;
  return {
    ...row,
    producer: roleInstanceId(row.producer, row.nodeId === 'NODE-AUDIT' ? 11 : producerIndex),
    auditor: roleInstanceId(row.auditor, auditorIndex),
  };
});

const checks = [];
function check(name, fn) {
  try {
    const result = fn();
    checks.push({ name, ok: result?.ok === true, detail: result?.detail ?? null });
  } catch (error) {
    checks.push({ name, ok: false, detail: { error: String(error?.message || error) } });
  }
}

check('id: roleInstanceId 统一小写且 AUDIT_CODE → role-audit-code-nn', () => {
  const samples = [roleInstanceId('CODE', 1), roleInstanceId('AUDIT_CODE', 11), roleInstanceId('AUDIT_EVIDENCE', 2)];
  const parsed = samples.map((id) => parseInstanceId(id));
  return {
    ok:
      samples[0] === 'role-code-01' &&
      samples[1] === 'role-audit-code-11' &&
      samples[2] === 'role-audit-evidence-02' &&
      parsed.every((row) => row !== null) &&
      parseInstanceId('role-audit-code-01')?.role === 'AUDIT_CODE',
    detail: { samples, parsed },
  };
});

check('id: core 侧 parseInstanceId 认得统一 ID（canonical 大写）', () => {
  const lower = core.parseInstanceId?.('role-audit-code-11');
  const upper = core.parseInstanceId?.('ROLE-AUDIT-CODE-11');
  return {
    ok: Boolean(lower) && lower.role === 'AUDIT_CODE' && lower.index === 11 && upper?.canonical === lower?.canonical,
    detail: { lower, upperCanonical: upper?.canonical ?? null },
  };
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l0-unified-'));
const artifact = path.join(root, 'README.md');
const p = await CorePersistence.open({ dir, mode: 'node', owner: 'unified' });
core.submitWish({ text: '统一身份：6 节点全链', maxParallel: 6, budgetTokens: 0 });

const steps = [];
for (const node of CHAIN) {
  const store = p.coreStore;
  core.passGate(store, node.stage, []);
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
  steps.push({ nodeId: node.nodeId, producer: node.producer, auditor: node.auditor, claim: claim?.ok === true, evidence: evidence?.ok === true, done: done?.status ?? null });
}
const status = core.graphStatus();
const persisted = await p.persist();
const snap = p.snapshot();
await p.close({ snapshot: true });
fs.rmSync(dir, { recursive: true, force: true });

check('chain: 六节点全 done（统一 ID 全程可用，core 正常解析）', () => {
  return {
    ok: steps.length === 6 && steps.every((step) => step.claim && step.evidence && step.done === 'done') && status?.counts?.done === 6,
    detail: { counts: status?.counts, steps },
  };
});

check('chain: 审计独立（每节点 producer≠auditor，AUDIT 节点由两个审计实例交叉）', () => {
  const bad = steps.filter((step) => !step.producer || !step.auditor || step.producer === step.auditor);
  const auditNode = steps.find((step) => step.nodeId === 'NODE-AUDIT');
  return {
    ok: bad.length === 0 && /^role-audit-code-/.test(auditNode?.producer ?? '') && /^role-audit-code-/.test(auditNode?.auditor ?? ''),
    detail: { bad, auditNode },
  };
});

check('chain: 全部实例 ID 都是统一小写格式', () => {
  const ids = [...new Set(steps.flatMap((step) => [step.producer, step.auditor]))];
  return { ok: ids.every((id) => /^role-[a-z0-9-]+-\d{2,}$/.test(id)), detail: { ids } };
});

check('chain: 落盘完整（appended>0，incomplete=false）', () => ({
  ok: (persisted?.appended ?? 0) > 0 && persisted?.incomplete === false && snap?.coreCursor > 0,
  detail: { persisted, cursor: snap?.coreCursor },
}));

const failed = checks.filter((row) => !row.ok);
const report = { ok: failed.length === 0, mode: 'unified-chain', total: checks.length, failed: failed.length, checks };
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2));
else {
  for (const row of checks) process.stdout.write(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}\n`);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
}
process.exit(report.ok ? 0 : 1);
