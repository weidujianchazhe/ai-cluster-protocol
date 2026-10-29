/**
 * 真实团队执行（native-real）一致性检查：吃一份 run 记录，断言五组事。
 *
 *   1. 不串号：实例 ID / sessionId 全唯一，ID 形如 ROLE-<职务>-<NN>；
 *   2. 等回执：至少一个实例的 awaitOutput 收敛（settled + turn/end completed + 有文本）；
 *   3. 审计独立：每节点 producer ≠ auditor，auditor 职务属审计职务；
 *   4. 状态链：每节点 claimed → submitted → done，且证据只带 producer；
 *   5. 投影同源：每节点有对应 TeamTask，nodeId 对得上、终态与图一致；reassign 若被拒必须显式记录。
 *
 * 用法：`node tests/e2e/native-real/check.mjs [run.json]`（缺省取最新 run-*.json）
 * 退出码：0 全绿 / 1 断言失败 / 3 记录不可读（fail-closed）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AUDITOR_ROLES = ['AUDIT_CODE', 'AUDIT_EVIDENCE', 'AUDIT_DESIGN'];
const INSTANCE_RE = /^ROLE-([A-Z][A-Z0-9_]*)-(\d{2,})$/;

const here = path.dirname(fileURLToPath(import.meta.url));

function latestRun() {
  const files = fs
    .readdirSync(here)
    .filter((name) => /^run-.*\.json$/.test(name))
    .sort();
  return files.length ? path.join(here, files[files.length - 1]) : null;
}

const file = process.argv[2] ?? latestRun();
let run;
try {
  run = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, state: 'unknown', error: String(error?.message || error) }, null, 2));
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

const instances = Array.isArray(run.instances) ? run.instances : [];
const nodes = Array.isArray(run?.graph?.nodes) ? run.graph.nodes : [];
const tasks = Array.isArray(run?.projection?.tasks) ? run.projection.tasks : [];

// ── 身份模式（N7b 统一身份记录）：只断言身份层，不掺 6 节点链 ──
if (run?.kind === 'identity') {
  const UNIFIED_RE = /^role-[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\d{2,}$/;

  check('identity: 全部实例 ID 为统一小写格式 role-<role>-<nn>', () => {
    const ids = instances.map((row) => row.instanceId);
    return { ok: ids.length >= 4 && ids.every((id) => UNIFIED_RE.test(id)), detail: { ids } };
  });

  check('identity: ≥2 CODE + ≥2 AUDIT（role-audit-code-*）', () => {
    const code = instances.filter((row) => /^role-code-/.test(row.instanceId)).length;
    const audit = instances.filter((row) => /^role-audit-code-/.test(row.instanceId)).length;
    const auditRoles = instances.filter((row) => row.role === 'AUDIT_CODE').length;
    return { ok: code >= 2 && audit >= 2 && audit === auditRoles, detail: { code, audit, auditRoles } };
  });

  check('identity: sessionId 互不相同（不串号）', () => {
    const sessions = instances.map((row) => row.sessionId);
    return { ok: sessions.length === instances.length && new Set(sessions).size === sessions.length, detail: { sessions } };
  });

  check('identity: spawn 路径与 owner 能力显式标注', () => {
    const rows = instances.map((row) => ({ id: row.instanceId, via: row.via, ownerCapable: row.ownerCapable }));
    const validVia = rows.every((row) => row.via === 'spawnTeammate' || row.via === 'startActivation');
    const marked = rows.every((row) => typeof row.ownerCapable === 'boolean');
    const leadMembers = rows.filter((row) => row.via === 'spawnTeammate');
    return {
      ok: validVia && marked && leadMembers.every((row) => row.ownerCapable === true),
      detail: rows,
    };
  });

  check('identity: spawnTeammate 时 memberName === instanceId', () => {
    const leadMembers = instances.filter((row) => row.via === 'spawnTeammate');
    return {
      ok: leadMembers.every((row) => !row.memberName || row.memberName === row.instanceId),
      detail: leadMembers.map((row) => ({ instanceId: row.instanceId, memberName: row.memberName ?? null })),
    };
  });

  check('identity: 至少一个真实回执（awaitOutput 收敛）', () => {
    const withReceipt = instances.filter((row) => row.awaitOutput?.settled === true);
    return {
      ok: withReceipt.length >= 1 && withReceipt.every((row) => String(row.reply ?? '').length > 0),
      detail: withReceipt.map((row) => ({ id: row.instanceId, reply: row.reply, turnEnd: row.awaitOutput.turnEnd })),
    };
  });

  check('identity: board owner 用 memberName（Lead 侧已打通 / 本侧标注限制）', () => {
    const board = run?.ledger?.board ?? {};
    return {
      ok: board.ownerSameAsMemberName === true && typeof board.note === 'string' && board.note.length > 0,
      detail: board,
    };
  });

  const failed = checks.filter((row) => !row.ok);
  const report = { ok: failed.length === 0, mode: 'identity', file, checks: checks.length, failed: failed.length, results: checks };
  process.stdout.write(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

// ── 1. 不串号 ──────────────────────────────────────────────
check('instances: 实例 ID 合法且 sessionId 互不相同', () => {
  const ids = instances.map((row) => row.instanceId);
  const sessions = instances.map((row) => row.sessionId);
  return {
    ok:
      instances.length >= 3 &&
      ids.every((id) => INSTANCE_RE.test(id)) &&
      new Set(ids).size === ids.length &&
      new Set(sessions).size === sessions.length,
    detail: { ids, sessions },
  };
});

check('instances: ≥2 个 CODE + 审计节点需要 ≥2 个审计实例', () => {
  const roles = instances.map((row) => INSTANCE_RE.exec(row.instanceId)?.[1] ?? null);
  const code = roles.filter((role) => role === 'CODE').length;
  const audit = roles.filter((role) => String(role ?? '').startsWith('AUDIT')).length;
  const hasAuditNode = nodes.some((node) => String(node?.nodeId ?? '').includes('AUDIT'));
  // 审计节点自身要交叉复核 → producer/auditor 必须是两个不同审计实例
  return { ok: code >= 2 && audit >= 1 && (!hasAuditNode || audit >= 2), detail: { roles, code, audit, hasAuditNode } };
});

// ── 2. 等回执（awaitOutput） ───────────────────────────────
check('awaitOutput: 至少一个实例收敛到 turn/end 且有文本', () => {
  const withOutput = instances.filter((row) => row.awaitOutput);
  const settled = withOutput.filter(
    (row) => row.awaitOutput.settled === true && row.awaitOutput.turnEnd?.reason === 'completed' && row.awaitOutput.timedOut === false,
  );
  return {
    ok: withOutput.length >= 1 && settled.length === withOutput.length && withOutput.every((row) => String(row.reply ?? '').length > 0),
    detail: withOutput.map((row) => ({ instanceId: row.instanceId, baselineSeq: row.awaitOutput.baselineSeq, turnEnd: row.awaitOutput.turnEnd, reply: row.reply })),
  };
});

check('awaitOutput: 回执文本与记录一致（无串号）', () => {
  const withOutput = instances.filter((row) => row.awaitOutput);
  return {
    ok: withOutput.length >= 1 && withOutput.every((row) => row.reply && row.replyMatches === 'followup'),
    detail: withOutput.map((row) => ({ instanceId: row.instanceId, reply: row.reply, matches: row.replyMatches })),
  };
});

// ── 3. 审计独立 ───────────────────────────────────────────
check('审计独立: 每节点 producer ≠ auditor', () => {
  const bad = nodes.filter((node) => !node?.done?.producer || !node?.done?.auditor || node.done.producer === node.done.auditor);
  return {
    ok: nodes.length >= 2 && bad.length === 0,
    detail: nodes.map((node) => ({ nodeId: node.nodeId, producer: node?.done?.producer, auditor: node?.done?.auditor })),
  };
});

check('审计独立: auditor 职务属审计职务', () => {
  const roles = nodes.map((node) => INSTANCE_RE.exec(node?.done?.auditor ?? '')?.[1] ?? null);
  return { ok: roles.length >= 2 && roles.every((role) => role && AUDITOR_ROLES.includes(role)), detail: { roles } };
});

// ── 4. 状态链 + 证据归属 ──────────────────────────────────
check('状态链: 每节点 claimed → submitted → done', () => {
  const ok = nodes.every(
    (node) =>
      node?.claim?.statusAfter === 'claimed' &&
      node?.evidence?.nodeStatus === 'submitted' &&
      node?.evidence?.advancedFrom === 'claimed' &&
      node?.done?.status === 'done',
  );
  return {
    ok: nodes.length >= 2 && ok,
    detail: nodes.map((node) => ({ nodeId: node.nodeId, claim: node?.claim?.statusAfter, evidence: node?.evidence?.nodeStatus, done: node?.done?.status })),
  };
});

check('证据归属: 证据 producer 与 claim owner 一致，且审计发生在 verify', () => {
  const ok = nodes.every(
    (node) =>
      node?.evidence?.producerInstance === node?.claim?.owner &&
      (node?.evidence?.auditorInstance ?? null) === null &&
      node?.done?.producer === node?.claim?.owner,
  );
  return {
    ok: nodes.length >= 2 && ok,
    detail: nodes.map((node) => ({ nodeId: node.nodeId, claimOwner: node?.claim?.owner, evidenceProducer: node?.evidence?.producerInstance })),
  };
});

check('分工: CODE 节点由两个不同 CODE 实例分担', () => {
  const codeProducers = nodes
    .filter((node) => INSTANCE_RE.exec(node?.done?.producer ?? '')?.[1] === 'CODE')
    .map((node) => node.done.producer);
  const distinct = new Set(codeProducers);
  return { ok: codeProducers.length >= 2 && distinct.size >= 2, detail: { codeProducers, distinct: [...distinct] } };
});

// ── 5. 投影同源 ───────────────────────────────────────────
check('投影同源: 每节点都有 TeamTask，nodeId 对得上且终态一致', () => {
  const byNode = new Map(tasks.map((task) => [task.nodeId, task]));
  const missing = nodes.filter((node) => !byNode.has(node.nodeId));
  const mismatched = nodes.filter((node) => {
    const task = byNode.get(node.nodeId);
    return !task || task.status !== 'completed' || node?.done?.status !== 'done';
  });
  return {
    ok: tasks.length >= 2 && missing.length === 0 && mismatched.length === 0,
    detail: { tasks: tasks.map((task) => ({ taskId: task.taskId, nodeId: task.nodeId, status: task.status })), missing, mismatched: mismatched.map((n) => n.nodeId) },
  };
});

check('投影 owner: reassign 被拒时必须显式记录（Lead-only 限制）', () => {
  const attempted = tasks.filter((task) => task.ownerInstanceRequested);
  const documented = attempted.every((task) => task.reassigned && task.reassigned.ok === false && /Lead/.test(String(task.reassigned.error)));
  return {
    ok: attempted.length >= 1 && documented,
    detail: attempted.map((task) => ({ taskId: task.taskId, requested: task.ownerInstanceRequested, reassigned: task.reassigned })),
  };
});

check('全链: 六个节点全部 done 且 ready 为空', () => {
  const counts = run?.graph?.counts ?? {};
  const ready = Array.isArray(run?.graph?.ready) ? run.graph.ready : null;
  return {
    ok: nodes.length === 6 && counts.done === 6 && counts.blocked === 0 && ready !== null && ready.length === 0,
    detail: { nodes: nodes.length, counts, ready },
  };
});

check('全链: 五个阶段闸门都 passed', () => {
  const gates = run?.graph?.gates ?? {};
  const stages = ['research', 'design', 'build', 'audit', 'deliver'];
  return { ok: stages.every((stage) => gates[stage] === 'passed'), detail: gates };
});

const failed = checks.filter((row) => !row.ok);
const report = { ok: failed.length === 0, file, checks: checks.length, failed: failed.length, results: checks };
process.stdout.write(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
