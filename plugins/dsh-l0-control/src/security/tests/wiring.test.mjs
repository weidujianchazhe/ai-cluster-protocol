/**
 * Lane S · 接线契约冒烟（不依赖 service.ts）：用一个最小假 service 证明
 *  - 每个动作都经授权闸门，拒绝路径只写 auth 审计行；
 *  - verify_done/decide/reassign 只有授权角色能过；
 *  - tenant 不匹配 fail-closed（调用者 / 资源 / 导出）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { isGovernanceAction } from "../roles.ts";
import { authorizeWithAudit } from "../guard.ts";
import { httpStatusFor, isSecurityError } from "../errors.ts";
import { filterExport, filterInScope } from "../../tenancy/index.ts";

/** 最小假 service：Journal + 节点表 + 动作入口（模拟主窗口接线方式）。 */
class FakeService {
  constructor(tenant = "default") {
    this.tenant = tenant;
    this.journal = [];
    this.nodes = { "NODE-001": { node_id: "NODE-001", tenant, status: "submitted" } };
    this.writes = 0;
  }

  appendJournal(kind, row) {
    this.journal.push({ kind, ...row });
  }

  invoke(actor, action, options = {}) {
    const { decision, row, error } = authorizeWithAudit(actor, action, {
      tenant: this.tenant,
      resourceTenant: options.resourceTenant,
      governance: isGovernanceAction(action),
      requireAuditIndependence: action === "verify_done",
      producerInstance: options.producerInstance,
      auditorInstance: actor?.id,
    });
    this.appendJournal("auth", row);
    if (!decision) {
      if (error) throw error;
      const mapped = new Error(row.message);
      mapped.code = row.code;
      throw mapped;
    }
    if (options.write) this.writes += 1;
    return decision;
  }

  exportNodes() {
    return filterExport({ nodes: Object.values(this.nodes), graph_version: 1 }, { tenant: this.tenant });
  }
}

test("正常放行：AUDIT 在 acme 租户 verify_done（治理动作 + 审计独立）", () => {
  const service = new FakeService("acme");
  const decision = service.invoke(
    { id: "ROLE-AUDIT-01", kind: "agent", tenant: "acme" },
    "verify_done",
    { producerInstance: "ROLE-CODE-01", write: true },
  );
  assert.equal(decision.allowed, true);
  assert.equal(service.writes, 1);
  assert.equal(service.journal.at(-1).decision, "allowed");
  assert.equal(service.journal.at(-1).tenant, "acme");
  assert.deepEqual(service.journal.at(-1).actor, { kind: "agent", id: "ROLE-AUDIT-01" });
});

test("拒绝：CODE 不能 verify_done，且拒绝路径不写业务状态、仍留审计", () => {
  const service = new FakeService("acme");
  assert.throws(
    () =>
      service.invoke({ id: "ROLE-CODE-01", kind: "agent", tenant: "acme" }, "verify_done", {
        producerInstance: "ROLE-DESIGN-01",
        write: true,
      }),
    (error) => error.code === "forbidden" && httpStatusFor(error.code) === 403,
  );
  assert.equal(service.writes, 0);
  const last = service.journal.at(-1);
  assert.equal(last.decision, "denied");
  assert.equal(last.code, "forbidden");
  assert.equal(last.tenant, "acme");
  assert.deepEqual(last.actor, { kind: "agent", id: "ROLE-CODE-01" });
});

test("拒绝：跨租户（actor/资源/导出）", () => {
  const service = new FakeService("acme");
  // actor 属于 default 却打 acme 作用域
  assert.throws(
    () => service.invoke("ROLE-ORCH-01", "decide", { write: true }),
    (error) => error.code === "tenant_mismatch",
  );
  // 资源在别的租户
  assert.throws(
    () =>
      service.invoke({ id: "ROLE-ORCH-01", tenant: "acme" }, "graph.write", {
        resourceTenant: "other",
        write: true,
      }),
    (error) => error.code === "tenant_mismatch",
  );
  assert.equal(service.writes, 0);

  const exported = service.exportNodes();
  assert.equal(exported.tenant, "acme");
  assert.equal(exported.nodes.length, 1);
  // 别的租户节点不会出现在 acme 导出里
  assert.deepEqual(filterInScope([{ node_id: "NODE-999", tenant: "other" }], "acme"), []);
});

test("未认证 / 未登记动作：401 / 400 映射", () => {
  const service = new FakeService("default");
  assert.throws(
    () => service.invoke(null, "graph.read"),
    (error) => isSecurityError(error) && error.code === "unauthenticated" && httpStatusFor(error.code) === 401,
  );
  assert.throws(
    () => service.invoke("ROLE-ORCH-01", "delete_everything"),
    (error) => error.code === "unknown_action" && httpStatusFor(error.code) === 400,
  );
  assert.equal(service.journal.at(-1).actor.id, "ROLE-ORCH-01");
});

test("审计独立性：生产与审计同实例 → 拒绝", () => {
  const service = new FakeService("acme");
  assert.throws(
    () =>
      service.invoke({ id: "ROLE-AUDIT-01", tenant: "acme" }, "verify_done", {
        producerInstance: "ROLE-AUDIT-01",
      }),
    (error) => error.code === "forbidden",
  );
});
