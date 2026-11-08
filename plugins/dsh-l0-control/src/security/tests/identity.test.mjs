/**
 * Lane S · security/identity 单测（node --test）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTOR_KINDS,
  actorRef,
  auditIndependenceConflict,
  hasRole,
  parseInstanceId,
  resolvePrincipal,
} from "../identity.ts";

test("parseInstanceId 解析 ROLE-<ROLE>-<NN>（大小写不敏感）", () => {
  assert.deepEqual(parseInstanceId("ROLE-CODE-03"), { role: "CODE", slot: "03" });
  assert.deepEqual(parseInstanceId("role-audit-02"), { role: "AUDIT", slot: "02" });
  assert.equal(parseInstanceId("NODE-001"), null);
  assert.equal(parseInstanceId("ROLE-CODE-3"), null, "序号必须是两位");
  assert.equal(parseInstanceId(""), null);
  assert.equal(parseInstanceId(null), null);
});

test("resolvePrincipal：字符串输入按 agent 实例 ID 解析", () => {
  const principal = resolvePrincipal("ROLE-RESEARCH-01");
  assert.equal(principal.id, "ROLE-RESEARCH-01");
  assert.equal(principal.kind, "agent");
  assert.equal(principal.tenant, "default");
  assert.deepEqual(principal.roles, ["RESEARCH"]);
  assert.equal(principal.slot, "01");
});

test("resolvePrincipal：缺 id / 非法 kind / 无角色 → Unauthenticated", () => {
  assert.throws(() => resolvePrincipal(null), (error) => error.code === "unauthenticated");
  assert.throws(() => resolvePrincipal({ id: "   " }), (error) => error.code === "unauthenticated");
  assert.throws(
    () => resolvePrincipal({ id: "ROLE-CODE-01", kind: "robot" }),
    (error) => error.code === "unauthenticated",
  );
  assert.throws(
    () => resolvePrincipal({ id: "verifier-ci", kind: "plugin" }),
    (error) => error.code === "unauthenticated",
  );
});

test("resolvePrincipal：复合职务与显式 roles 合并去重", () => {
  const principal = resolvePrincipal({
    id: "ROLE-CODE-01",
    kind: "agent",
    roles: ["audit", "CODE", "OBS"],
  });
  assert.deepEqual(principal.roles, ["CODE", "AUDIT", "OBS"]);
  assert.equal(hasRole(principal, "audit"), true);
  assert.equal(hasRole(principal, "deliver"), false);
});

test("resolvePrincipal：tenant 归一与非法 tenant 拒绝", () => {
  assert.equal(resolvePrincipal({ id: "ROLE-CODE-01", tenant: "ACME" }).tenant, "acme");
  assert.equal(resolvePrincipal({ id: "ROLE-CODE-01", tenant: "" }).tenant, "default");
  assert.equal(
    resolvePrincipal({ id: "ROLE-CODE-01" }, { defaultTenant: "acme" }).tenant,
    "acme",
  );
  assert.throws(
    () => resolvePrincipal({ id: "ROLE-CODE-01", tenant: "bad tenant!" }),
    (error) => error.code === "tenant_mismatch",
  );
});

test("actorRef 只暴露 kind/id（tenant 单独字段）", () => {
  const principal = resolvePrincipal({ id: "ROLE-AUDIT-02", tenant: "acme" });
  assert.deepEqual(actorRef(principal), { kind: "agent", id: "ROLE-AUDIT-02" });
  assert.equal(ACTOR_KINDS.includes("human"), true);
});

test("审计独立性：同实例 / 同职务 / 缺身份", () => {
  assert.equal(
    auditIndependenceConflict("ROLE-CODE-01", "ROLE-AUDIT-01"),
    null,
  );
  const same = auditIndependenceConflict("ROLE-CODE-01", "role-code-01");
  assert.equal(same?.code, "audit_not_independent");
  const sameRole = auditIndependenceConflict("ROLE-CODE-01", "ROLE-CODE-02");
  assert.equal(sameRole?.code, "audit_same_role");
  const missing = auditIndependenceConflict("", "ROLE-AUDIT-01");
  assert.equal(missing?.code, "audit_identity_missing");
});
