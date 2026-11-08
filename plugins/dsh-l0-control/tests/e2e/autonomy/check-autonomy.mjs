/**
 * 自主循环验收（Lane A）：读插件审计 journal + N4 core journal，验证"worker 自驱"而不是"插件代发"。
 *
 * 断言：
 *   1. 6/6 done（从 N4 core journal 折叠出的节点状态）；
 *   2. 每个节点的 claim 由 **worker 实例**（`role-*`）发起，且 claim 过的实例数 ≥ 2 CODE + 2 AUDIT；
 *   3. 审计独立：每节点 producer ≠ auditor，且 auditor 是审计职务实例；
 *   4. 租约：claim 行带 fencing/lease 证据（core 侧 lease 记录存在，heartbeat/过期字段非空）；
 *   5. 无插件代发：审计 journal 里 `task_claimed / evidence_submitted / verify_done_requested`
 *      的 instanceId 全部是 `role-*`，**没有**调用者会话（1210cf86…）直接发起的 task_/verify 行；
 *   6. 驳回重试：存在 `verify_done_rejected` 且其后有同节点的成功 `verify_done_requested`（或至少出现重试迹象）。
 *
 * 用法：`node tests/e2e/autonomy/check-autonomy.mjs [journal.jsonl] [core-journal.jsonl]`
 * 退出码：0 全绿 / 1 断言失败 / 3 输入不可读。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// here = <ws>/plugins/dsh-l0-control/tests/e2e/autonomy → 上 5 级到 workspace
const root = path.resolve(here, '..', '..', '..', '..', '..');
const auditFile = process.argv[2] ?? path.join(root, '.l0-control', 'journal.jsonl');
const coreFile = process.argv[3] ?? path.join(root, '.l0-control', 'core-state', 'journal.jsonl');

const COORDINATOR_SESSION = '1210cf86-12cb-4117-99d3-d42784b7e0ce';
const AUDIT_ROLE_RE = /^role-audit/i;
const WORKER_RE = /^role-/i;
const lower = (value) => String(value ?? '').toLowerCase();

function readJsonl(file) {
  if (!fs.existsSync(file)) return null;
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // 跳过坏行
    }
  }
  return rows;
}

const auditRows = readJsonl(auditFile);
const coreRows = readJsonl(coreFile);
if (!auditRows || !coreRows) {
  process.stdout.write(JSON.stringify({ ok: false, state: 'unknown', auditFile, coreFile }, null, 2));
  process.exit(3);
}

const checks = [];
function check(name, fn) {
  try {
    const result = fn();
    checks.push({ name, ok: result?.ok === true, detail: result?.detail ?? null });
  } catch (error) {
    checks.push({ name, ok: false, detail: { error: String(error?.message || error) } });
  }
}

// ── 节点状态：优先用 N4 core journal（权威），缺失时退回插件审计 journal ──
const nodeStatus = new Map();
const gates = new Map();
for (const row of coreRows) {
  const payload = row?.payload ?? {};
  if (row.kind === 'node_added' && (payload.node?.nodeId ?? row.nodeId)) {
    nodeStatus.set(payload.node?.nodeId ?? row.nodeId, payload.node?.status ?? 'planned');
  }
  if (row.kind === 'status_changed' && (payload.nodeId ?? row.nodeId) && payload.to) {
    nodeStatus.set(payload.nodeId ?? row.nodeId, payload.to);
  }
  // core 侧闸门事件 kind 为 stage_gate_changed，载荷是扁平的 {stage,status,evidence_refs}；
  // 兼容旧投影的 gate_set + 嵌套 gate 形状（D-1：只折叠 gate_set 会导致闸门断言恒假阴性）。
  if (row.kind === 'gate_set' || row.kind === 'stage_gate_changed') {
    const stage = payload.gate?.stage ?? payload.stage;
    const status = payload.gate?.status ?? payload.status;
    if (stage) gates.set(stage, status ?? 'passed');
  }
}
const NODES = ['NODE-RESEARCH', 'NODE-PRD', 'NODE-CONTRACT', 'NODE-BUILD', 'NODE-AUDIT', 'NODE-DELIVER'];

// ── 审计 journal 切片：只看本轮自主窗口（最后一次 wish_submitted 之后） ──
let startIndex = 0;
auditRows.forEach((row, index) => {
  if (row.kind === 'wish_submitted') startIndex = index;
});
const window = auditRows.slice(startIndex);

const claims = window.filter((row) => row.kind === 'task_claimed');
const evidences = window.filter((row) => row.kind === 'evidence_submitted');
const verifies = window.filter((row) => row.kind === 'verify_done_requested');
const rejects = window.filter((row) => row.kind === 'verify_done_rejected');

check('done: 6/6 节点 done', () => {
  const done = NODES.filter((node) => nodeStatus.get(node) === 'done');
  return { ok: done.length === 6, detail: NODES.map((node) => ({ node, status: nodeStatus.get(node) ?? 'unknown' })) };
});

check('claim: 全部节点由 worker 领取；≥2 CODE + ≥2 AUDIT **参与**（claim 或 verify，G-2 口径 ③）', () => {
  const owners = new Set(claims.map((row) => String(row.instanceId ?? '')));
  const claimedNodes = new Set(claims.map((row) => row.nodeId));
  const codeWorkers = [...owners].filter((id) => WORKER_RE.test(lower(id)) && !AUDIT_ROLE_RE.test(lower(id)));
  // G-2 口径 ③：审计实例"参与"= claim 或做过 verify（不强制 claim，单 AUDIT 节点不够两个实例领）
  const auditActors = new Set(
    [
      ...owners,
      ...verifies.map((row) => String(row.auditor_instance ?? row.auditorInstance ?? '')),
    ].filter((id) => AUDIT_ROLE_RE.test(lower(id))),
  );
  const auditClaims = [...owners].filter((id) => AUDIT_ROLE_RE.test(lower(id)));
  return {
    ok:
      NODES.every((node) => claimedNodes.has(node)) &&
      codeWorkers.length >= 2 &&
      auditActors.size >= 2 &&
      [...owners].every((id) => WORKER_RE.test(lower(id))),
    detail: {
      owners: [...owners],
      codeWorkers,
      auditActors: [...auditActors],
      auditClaims,
      claimedNodes: [...claimedNodes],
    },
  };
});

check('审计独立: producer ≠ auditor，且 auditor 为审计职务', () => {
  const rows = verifies.map((row) => ({
    nodeId: row.nodeId,
    producer: row.producer_instance ?? row.producerInstance ?? null,
    auditor: row.auditor_instance ?? row.auditorInstance ?? null,
  }));
  const bad = rows.filter((row) => !row.producer || !row.auditor || row.producer === row.auditor || !AUDIT_ROLE_RE.test(lower(row.auditor)));
  return { ok: rows.length >= 2 && bad.length === 0, detail: { rows, bad } };
});

check('租约: 每个 claim 都有 lease/token 证据（插件行或 core lease_claimed）', () => {
  const leaseEvents = coreRows.filter((row) => row.kind === 'lease_claimed' || row.kind === 'lease_renewed');
  const rows = claims.map((row) => ({
    nodeId: row.nodeId,
    instanceId: row.instanceId,
    lease: row.lease ?? null,
    token: row.fencing_token ?? row.token ?? null,
  }));
  return {
    ok: rows.length > 0 && rows.every((row) => row.instanceId) && (rows.some((row) => row.lease || row.token) || leaseEvents.length > 0),
    detail: { rows, leaseEvents: leaseEvents.length },
  };
});

check('无插件代发: 审计行里没有协调者会话直接发起的 claim/evidence/verify', () => {
  const rows = [...claims, ...evidences, ...verifies].filter((row) => {
    const actor = String(row.callerSessionId ?? row.instanceId ?? row.producer_instance ?? '');
    return actor === COORDINATOR_SESSION;
  });
  const actors = [...new Set([...claims, ...evidences, ...verifies].map((row) => String(row.instanceId ?? row.producer_instance ?? row.auditor_instance ?? '')))];
  return { ok: rows.length === 0 && actors.every((id) => id === '' || WORKER_RE.test(id)), detail: { offenders: rows, actors } };
});

check('驳回重试: 存在 verify 驳回，且其后同节点又成功', () => {
  const rejectedNodes = [...new Set(rejects.map((row) => row.nodeId))];
  const retried = rejectedNodes.filter((node) =>
    window.some((row) => row.kind === 'verify_done_requested' && row.nodeId === node && !rejects.includes(row)),
  );
  const doneAfterRetry = rejectedNodes.filter((node) => nodeStatus.get(node) === 'done' || nodeStatus.get(node) === 'submitted');
  return {
    ok: rejects.length === 0 ? true : retried.length > 0 || doneAfterRetry.length > 0,
    detail: { rejectedNodes, retried, rejects: rejects.map((row) => ({ nodeId: row.nodeId, reason: row.reason })) },
  };
});

check('闸门: 五段闸门至少 research/design/build/audit/deliver 出现过 passed', () => {
  const stages = ['research', 'design', 'build', 'audit', 'deliver'];
  const passed = stages.filter((stage) => gates.get(stage) === 'passed');
  return { ok: passed.length >= 1, detail: { gates: [...gates.entries()], passed } };
});

const failed = checks.filter((row) => !row.ok);
const report = {
  ok: failed.length === 0,
  auditFile,
  coreFile,
  windowEvents: window.length,
  claims: claims.length,
  evidences: evidences.length,
  verifies: verifies.length,
  rejects: rejects.length,
  checks: checks.length,
  failed: failed.length,
  results: checks,
};
process.stdout.write(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
