/**
 * Lane S · security/guard 单测：授权闸门 + 审计行。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  auditRow,
  authorize,
  authorizeWithAudit,
  decide,
  permissionMatrix,
} from "../guard.ts";

const ACME_CODE = { id: "ROLE-CODE-02", kind: "agent", tenant: "acme" };
const ACME_AUDIT = { id: "ROLE-AUDIT-01", kind: "agent", tenant: "acme" };

test("放行：CODE 可以 claim/submit/evidence，decision 带 actor/tenant", () => {
  const decision = authorize(ACME_CODE, "task.claim", { tenant: "acme" });
  assert.equal(decision.allowed, true);
  assert.equal(decision.action, "task.claim");
  assert.equal(decision.tenant, "acme");
  assert.deepEqual(decision.actor, { kind: "agent", id: "ROLE-CODE-02" });
  assert.ok(decision.allowedRoles.includes("CODE"));
  assert.doesNotThrow(() => authorize(ACME_CODE, "task.submit", { tenant: "acme" }));
  assert.doesNotThrow(() => authorize(ACME_CODE, "evidence.add", { tenant: "acme" }));
});

test("默认拒绝：身份缺失 / 动作未登记 / 角色不足", () => {
  assert.throws(() => authorize(null, "graph.read"), (e) => e.code === "unauthenticated");
  assert.throws(
    () => authorize("ROLE-CODE-01", "nuke", {}),
    (e) => e.code === "unknown_action",
  );
  assert.throws(
    () => authorize("ROLE-OBS-01", "task.claim", {}),
    (e) => e.code === "forbidden",
  );
});

test("治理动作需显式 governance 标记", () => {
  assert.throws(
    () => authorize("ROLE-AUDIT-01", "verify_done", {}),
    (e) => e.code === "forbidden",
  );
  const ok = authorize("ROLE-AUDIT-01", "verify_done", { governance: true });
  assert.equal(ok.allowed, true);
  assert.throws(
    () => authorize("ROLE-CODE-01", "verify_done", { governance: true }),
    (e) => e.code === "forbidden",
  );
});

test("tenant 不匹配 fail-closed（调用者 / 作用域 / 资源三级）", () => {
  // 调用者租户 ≠ 作用域
  assert.throws(
    () => authorize({ id: "ROLE-CODE-01", tenant: "acme" }, "graph.read", { tenant: "default" }),
    (e) => e.code === "tenant_mismatch",
  );
  // 资源属于别的租户
  assert.throws(
    () => authorize("ROLE-CODE-01", "graph.read", { resourceTenant: "acme" }),
    (e) => e.code === "tenant_mismatch",
  );
  // 三者一致（大小写归一）放行
  const ok = authorize(ACME_CODE, "graph.read", { tenant: "ACME", resourceTenant: "acme" });
  assert.equal(ok.tenant, "acme");
  // 非 default 作用域缺省即调用者租户
  assert.equal(authorize(ACME_CODE, "graph.read").tenant, "acme");
});

test("审计独立性：requireAuditIndependence 时同实例/同职务拒绝", () => {
  assert.throws(
    () =>
      authorize(ACME_AUDIT, "verify_done", {
        tenant: "acme",
        governance: true,
        requireAuditIndependence: true,
        producerInstance: "ROLE-AUDIT-01",
        auditorInstance: "ROLE-AUDIT-01",
      }),
    (e) => e.code === "forbidden",
  );
  assert.throws(
    () =>
      authorize(ACME_AUDIT, "verify_done", {
        tenant: "acme",
        governance: true,
        requireAuditIndependence: true,
        producerInstance: "ROLE-AUDIT-03",
        auditorInstance: "ROLE-AUDIT-01",
      }),
    (e) => e.code === "forbidden",
  );
  const ok = authorize(ACME_AUDIT, "verify_done", {
    tenant: "acme",
    governance: true,
    requireAuditIndependence: true,
    producerInstance: "ROLE-CODE-01",
    auditorInstance: "ROLE-AUDIT-01",
  });
  assert.equal(ok.allowed, true);
});

test("decide() 不抛：拒绝返回 code（默认拒绝语义不变）", () => {
  const denied = decide("ROLE-OBS-01", "reassign");
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, "forbidden");
  const unauthorized = decide(null, "graph.read");
  assert.equal(unauthorized.code, "unauthenticated");
  const unknown = decide("ROLE-ORCH-01", "not_an_action");
  assert.equal(unknown.code, "unknown_action");
  const allowed = decide("ROLE-ORCH-01", "decide", { governance: true });
  assert.equal(allowed.allowed, true);
  assert.ok(allowed.decision);
  const tenantDenied = decide({ id: "ROLE-CODE-01", tenant: "acme" }, "graph.read", {
    tenant: "default",
  });
  assert.equal(tenantDenied.code, "tenant_mismatch");
});

test("auditRow 必带 actor + tenant；被拒调用同样留痕", () => {
  const decision = authorize(ACME_AUDIT, "gate.pass", { tenant: "acme", governance: true });
  const row = auditRow({ decision, action: "gate.pass", outcome: "allowed" });
  assert.equal(row.kind, "auth");
  assert.equal(row.tenant, "acme");
  assert.deepEqual(row.actor, { kind: "agent", id: "ROLE-AUDIT-01" });
  assert.equal(row.decision, "allowed");
  assert.ok(Array.isArray(row.allowedRoles));

  const deniedRow = auditRow({
    decision: null,
    action: "verify_done",
    outcome: "denied",
    code: "forbidden",
    message: "角色不足",
    tenant: "acme",
  });
  assert.equal(deniedRow.decision, "denied");
  assert.equal(deniedRow.code, "forbidden");
  assert.equal(deniedRow.tenant, "acme");

  const anonymous = auditRow({ decision: null, action: "graph.read", outcome: "error" });
  assert.deepEqual(anonymous.actor, { kind: "unknown", id: "anonymous" });
  assert.equal(anonymous.tenant, "default");
  assert.equal(anonymous.code, "unauthenticated");
});

test("authorizeWithAudit 返回 decision + 行（成功/失败都可直接落 journal）", () => {
  const ok = authorizeWithAudit("ROLE-ORCH-01", "reassign", { governance: true });
  assert.equal(ok.decision?.allowed, true);
  assert.equal(ok.row.decision, "allowed");
  assert.equal(ok.error, null);

  const bad = authorizeWithAudit("ROLE-CODE-01", "reassign", { governance: true });
  assert.equal(bad.decision, null);
  assert.equal(bad.row.decision, "denied");
  assert.equal(bad.row.code, "forbidden");
  // 被拒时仍保留可重抛的原始 SecurityError（service 据此映射 401/403）
  assert.equal(bad.error?.code, "forbidden");

  // 被拒调用也带 actor + tenant（审计可定位）
  const tenantBad = authorizeWithAudit({ id: "ROLE-CODE-01", tenant: "acme" }, "graph.read", {
    tenant: "default",
  });
  assert.equal(tenantBad.row.code, "tenant_mismatch");
  assert.deepEqual(tenantBad.row.actor, { kind: "agent", id: "ROLE-CODE-01" });
  assert.equal(tenantBad.row.tenant, "default");
});

test("permissionMatrix 快照含治理动作", () => {
  const matrix = permissionMatrix();
  assert.deepEqual(matrix.verify_done, ["AUDIT", "HUMAN"]);
  assert.ok(matrix["graph.read"].includes("CODE"));
});
