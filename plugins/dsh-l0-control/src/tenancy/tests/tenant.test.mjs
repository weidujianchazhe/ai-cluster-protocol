/**
 * Lane S · tenancy/tenant 单测：规范化 / 兼容默认 / 比对失败即拒。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TENANT,
  assertTenantMatch,
  isDefaultTenant,
  normalizeTenant,
  stampTenant,
  tenantOf,
} from "../tenant.ts";

test("normalizeTenant：缺省/空 → default，大小写归一", () => {
  assert.equal(DEFAULT_TENANT, "default");
  assert.equal(normalizeTenant(undefined), "default");
  assert.equal(normalizeTenant(null), "default");
  assert.equal(normalizeTenant(""), "default");
  assert.equal(normalizeTenant("  ACME  "), "acme");
  assert.equal(normalizeTenant("t-1.acme_ops"), "t-1.acme_ops");
  assert.equal(isDefaultTenant("DEFAULT"), true);
  assert.equal(isDefaultTenant("acme"), false);
});

test("normalizeTenant：非法标识 → tenant_mismatch", () => {
  for (const bad of ["bad tenant", "UPPER!", "x".repeat(64), "-lead", ".dot"]) {
    assert.throws(
      () => normalizeTenant(bad),
      (error) => error.code === "tenant_mismatch",
      `应拒绝 ${bad}`,
    );
  }
});

test("assertTenantMatch：同租户通过，跨租户 fail-closed", () => {
  assert.equal(assertTenantMatch("acme", "ACME"), "acme");
  assert.equal(assertTenantMatch(undefined, "default"), "default");
  assert.throws(
    () => assertTenantMatch("acme", "default", { action: "graph.read", recordId: "NODE-001" }),
    (error) => error.code === "tenant_mismatch",
  );
  // 记录缺 tenant（undefined）在非 default 作用域下被视作 default → 跨租户
  assert.throws(
    () => assertTenantMatch(undefined, "acme"),
    (error) => error.code === "tenant_mismatch",
  );
});

test("tenantOf：记录缺字段视为 default", () => {
  assert.equal(tenantOf({ node_id: "NODE-001" }), "default");
  assert.equal(tenantOf({ tenant: "ACME" }), "acme");
  assert.equal(tenantOf(null), "default");
});

test("stampTenant：打戳 / 冲突拒绝", () => {
  const stamped = stampTenant({ node_id: "NODE-001" }, "acme");
  assert.equal(stamped.tenant, "acme");
  assert.equal(stamped.node_id, "NODE-001");
  assert.throws(
    () => stampTenant({ tenant: "other" }, "acme"),
    (error) => error.code === "tenant_mismatch",
  );
  // 不改入参
  const original = { node_id: "NODE-002" };
  stampTenant(original, "acme");
  assert.equal("tenant" in original, false);
});
