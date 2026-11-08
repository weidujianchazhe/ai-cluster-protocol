/**
 * Lane S · tenancy/export 单测：导出按 tenant 过滤，未知集合默认剔除。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { assertExportTenant, filterExport } from "../export.ts";

function payload() {
  return {
    graph_version: 3,
    config: { toolPrefix: "l0_" },
    tenant: "acme",
    nodes: [
      { node_id: "NODE-001", tenant: "acme" },
      { node_id: "NODE-002", tenant: "other" },
    ],
    evidence: [
      { evidence_id: "EVD-001", tenant: "acme" },
      { evidence_id: "EVD-002" }, // 未标注 → default
    ],
    edges: [
      { from: "NODE-001", to: "NODE-002", kind: "blocks", tenant: "acme" },
      { from: "NODE-009", to: "NODE-010", kind: "blocks", tenant: "other" },
    ],
    mystery: [{ id: "x", tenant: "other" }],
  };
}

test("导出只含本租户数据，且显式写入 tenant", () => {
  const out = filterExport(payload(), { tenant: "acme" });
  assert.equal(out.tenant, "acme");
  assert.deepEqual(out.nodes.map((n) => n.node_id), ["NODE-001"]);
  assert.deepEqual(out.evidence.map((e) => e.evidence_id), ["EVD-001"]);
  assert.deepEqual(out.edges.map((e) => e.from), ["NODE-001"]);
  assert.equal(out.graph_version, 3);
  assert.deepEqual(out.config, { toolPrefix: "l0_" }, "无 tenant 的共享元数据保留");
});

test("default 租户导出拿到未标注记录，不拿别的租户", () => {
  const out = filterExport(payload(), { tenant: "default" });
  assert.equal(out.tenant, "default");
  assert.deepEqual(out.nodes, []);
  assert.deepEqual(out.evidence.map((e) => e.evidence_id), ["EVD-002"]);
  assert.deepEqual(out.edges, []);
});

test("未知数组集合默认剔除（宁缺勿泄），显式开启才保留", () => {
  const strictOut = filterExport(payload(), { tenant: "acme" });
  assert.equal("mystery" in strictOut, false);

  const loose = filterExport(payload(), { tenant: "acme", keepUnknownCollections: true });
  assert.ok(Array.isArray(loose.mystery), "显式开启后未知集合保留原样");
});

test("strict：非 default 作用域剔除未标注记录", () => {
  const out = filterExport(payload(), { tenant: "acme", strict: true });
  // EVD-002 未标注 → 非 default strict 下剔除；EVD-001 标注 acme → 保留
  assert.deepEqual(out.evidence.map((e) => e.evidence_id), ["EVD-001"]);
  assert.deepEqual(out.nodes.map((n) => n.node_id), ["NODE-001"]);
});

test("单对象带 tenant：不符则整键剔除", () => {
  const out = filterExport(
    { snapshot: { tenant: "other", revision: 7 }, meta: { revision: 1 } },
    { tenant: "acme" },
  );
  assert.equal("snapshot" in out, false);
  assert.deepEqual(out.meta, { revision: 1 });
});

test("不修改入参", () => {
  const input = payload();
  const before = JSON.stringify(input);
  filterExport(input, { tenant: "acme" });
  assert.equal(JSON.stringify(input), before);
});

test("assertExportTenant：声明不符拒绝，未声明则打戳", () => {
  assert.equal(assertExportTenant({ tenant: "ACME" }, "acme"), "acme");
  assert.equal(assertExportTenant({ revision: 1 }, "acme"), "acme");
  assert.throws(
    () => assertExportTenant({ tenant: "other" }, "acme"),
    (error) => error.code === "tenant_mismatch",
  );
  assert.throws(() => assertExportTenant(null, "acme"), TypeError);
});
