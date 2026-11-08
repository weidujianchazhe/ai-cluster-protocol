/**
 * Lane S · tenancy/scope 单测：读过滤 / 写断言 / strict / 分组。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRecordInScope,
  filterInScope,
  groupByTenant,
  isInScope,
} from "../scope.ts";

const NODES = [
  { node_id: "NODE-001", tenant: "acme" },
  { node_id: "NODE-002", tenant: "acme" },
  { node_id: "NODE-003", tenant: "other" },
  { node_id: "NODE-004" }, // 未标注 → default
];

test("读过滤：只返回本租户记录（不泄露别的租户）", () => {
  const acme = filterInScope(NODES, "ACME");
  assert.deepEqual(acme.map((n) => n.node_id), ["NODE-001", "NODE-002"]);
  const def = filterInScope(NODES, "default");
  assert.deepEqual(def.map((n) => n.node_id), ["NODE-004"]);
  assert.deepEqual(filterInScope(null, "acme"), []);
  assert.deepEqual(filterInScope([], "acme"), []);
});

test("isInScope：缺失/非对象一律 false", () => {
  assert.equal(isInScope({ tenant: "acme" }, "acme"), true);
  assert.equal(isInScope({ tenant: "other" }, "acme"), false);
  assert.equal(isInScope(null, "acme"), false);
  assert.equal(isInScope({}, "default"), true);
});

test("strict：非 default 作用域拒绝未标注 tanant 的记录", () => {
  assert.equal(isInScope({ node_id: "NODE-004" }, "acme", { strict: true }), false);
  assert.equal(isInScope({ node_id: "NODE-004" }, "default", { strict: true }), true);
  assert.deepEqual(
    filterInScope(NODES, "acme", { strict: true }).map((n) => n.node_id),
    ["NODE-001", "NODE-002"],
  );
});

test("写断言：同租户通过，跨租户写入 fail-closed", () => {
  assert.equal(assertRecordInScope({ node_id: "NODE-001", tenant: "acme" }, "acme"), "acme");
  assert.throws(
    () => assertRecordInScope({ node_id: "NODE-003", tenant: "other" }, "acme", { action: "graph.write" }),
    (error) => error.code === "tenant_mismatch",
  );
  assert.throws(
    () => assertRecordInScope({ node_id: "NODE-004" }, "acme", { action: "graph.write", strict: true }),
    (error) => error.code === "tenant_mismatch",
  );
  assert.throws(
    () => assertRecordInScope(null, "acme"),
    (error) => error.code === "tenant_mismatch",
  );
});

test("写断言错误信息带 record id 与动作", () => {
  try {
    assertRecordInScope({ evidence_id: "EVD-009", tenant: "other" }, "acme", {
      action: "evidence.add",
    });
    assert.fail("应当抛错");
  } catch (error) {
    assert.equal(error.code, "tenant_mismatch");
    assert.match(error.message, /EVD-009/);
    assert.equal(error.detail.action, "evidence.add");
  }
});

test("groupByTenant：按租户分组，不合并视图", () => {
  const grouped = groupByTenant(NODES);
  assert.deepEqual(Object.keys(grouped).sort(), ["acme", "default", "other"]);
  assert.equal(grouped.acme.length, 2);
  assert.equal(grouped.default.length, 1);
  assert.deepEqual(groupByTenant(undefined), {});
});
