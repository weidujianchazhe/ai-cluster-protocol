/**
 * Lane S · tenancy/paths 单测：默认租户兼容 + 子目录落点 + 路径归属校验。
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { assertPathTenant, tenantOfPath, tenantPaths } from "../paths.ts";

const STATE_DIR = path.join("F:", "tmp", "l0-state");

test("default 租户保持原路径（兼容既有数据）", () => {
  const paths = tenantPaths({ stateDir: STATE_DIR, tenant: "default" });
  assert.equal(paths.tenant, "default");
  assert.equal(paths.isDefault, true);
  assert.equal(paths.stateDir, path.resolve(STATE_DIR));
  assert.equal(paths.journalPath, path.join(path.resolve(STATE_DIR), "journal.jsonl"));
  assert.equal(paths.snapshotPath, path.join(path.resolve(STATE_DIR), "snapshot.json"));
  assert.equal(paths.persistenceDir, path.join(path.resolve(STATE_DIR), "core-state"));

  // 不传 tenant 与传 default 等价
  assert.deepEqual(tenantPaths({ stateDir: STATE_DIR }), paths);
  assert.deepEqual(tenantPaths({ stateDir: STATE_DIR, tenant: "DEFAULT" }), paths);
});

test("非 default 租户落到 tenants/<tenant>/ 子目录", () => {
  const paths = tenantPaths({ stateDir: STATE_DIR, tenant: "ACME" });
  assert.equal(paths.tenant, "acme");
  assert.equal(paths.isDefault, false);
  const base = path.join(path.resolve(STATE_DIR), "tenants", "acme");
  assert.equal(paths.stateDir, base);
  assert.equal(paths.journalPath, path.join(base, "journal.jsonl"));
  assert.equal(paths.snapshotPath, path.join(base, "snapshot.json"));
  assert.equal(paths.persistenceDir, path.join(base, "core-state"));
});

test("自定义文件名 / tenantsRoot 生效", () => {
  const paths = tenantPaths({
    stateDir: STATE_DIR,
    tenant: "acme",
    journalFile: "j.jsonl",
    snapshotFile: "s.json",
    persistenceDir: "state-core",
    tenantsRoot: "orgs",
  });
  const base = path.join(path.resolve(STATE_DIR), "orgs", "acme");
  assert.equal(paths.journalPath, path.join(base, "j.jsonl"));
  assert.equal(paths.snapshotPath, path.join(base, "s.json"));
  assert.equal(paths.persistenceDir, path.join(base, "state-core"));
});

test("tenantPaths 缺 stateDir → TypeError", () => {
  assert.throws(() => tenantPaths({ stateDir: "" }), TypeError);
});

test("tenantOfPath：从路径反解租户", () => {
  const base = path.resolve(STATE_DIR);
  assert.equal(tenantOfPath(path.join(base, "journal.jsonl"), { stateDir: STATE_DIR }), "default");
  assert.equal(
    tenantOfPath(path.join(base, "tenants", "acme", "journal.jsonl"), { stateDir: STATE_DIR }),
    "acme",
  );
  // 越界路径按 default 处理（不越权暴露）
  assert.equal(tenantOfPath(path.join("F:", "elsewhere", "x.jsonl"), { stateDir: STATE_DIR }), "default");
});

test("assertPathTenant：路径归属不符 → tenant_mismatch", () => {
  const base = path.resolve(STATE_DIR);
  assert.equal(
    assertPathTenant(path.join(base, "tenants", "acme", "journal.jsonl"), "acme", { stateDir: STATE_DIR }),
    "acme",
  );
  assert.throws(
    () =>
      assertPathTenant(path.join(base, "journal.jsonl"), "acme", { stateDir: STATE_DIR }),
    (error) => error.code === "tenant_mismatch",
  );
  assert.throws(
    () =>
      assertPathTenant(path.join(base, "tenants", "other", "journal.jsonl"), "acme", {
        stateDir: STATE_DIR,
      }),
    (error) => error.code === "tenant_mismatch",
  );
});
