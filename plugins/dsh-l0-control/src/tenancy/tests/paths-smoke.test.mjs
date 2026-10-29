/**
 * Lane S · 双租户真实路径冒烟（真临时 stateDir + 真文件，不用 mock）。
 *
 * 证明三件事：
 *  1. default 租户路径与现状**逐字节一致**（既有 journal 无需迁移即可继续读）；
 *  2. 非 default 租户真实落到 `<stateDir>/tenants/<tenant>/`，两个租户的文件互不覆盖；
 *  3. 跨租户读 / 导出 / 写一律拒绝（fail-closed）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { tenantPaths, tenantOfPath, assertPathTenant } from "../paths.ts";
import { filterInScope, assertRecordInScope } from "../scope.ts";
import { filterExport } from "../export.ts";
import { normalizeTenant } from "../tenant.ts";

function makeStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l0-tenant-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeJournal(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

function readJournal(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("真实 stateDir：default 逐字节兼容，acme 落 tenants/acme/", () => {
  const { dir, cleanup } = makeStateDir();
  try {
    // 模拟「既有部署」：老版本已经把 journal 写在 stateDir 根上
    const legacyPath = path.join(dir, "journal.jsonl");
    writeJournal(legacyPath, [{ kind: "node_added", node_id: "NODE-001" }]);

    const def = tenantPaths({ stateDir: dir, tenant: "default" });
    assert.equal(def.journalPath, path.resolve(legacyPath), "default 路径必须与老版本完全一致");
    assert.equal(def.stateDir, path.resolve(dir));
    assert.equal(def.isDefault, true);
    assert.equal(readJournal(def.journalPath).length, 1, "既有数据不需要迁移即可读");

    const acme = tenantPaths({ stateDir: dir, tenant: "ACME" });
    assert.equal(acme.tenant, "acme");
    assert.equal(
      acme.journalPath,
      path.join(path.resolve(dir), "tenants", "acme", "journal.jsonl"),
    );
    writeJournal(acme.journalPath, [{ kind: "node_added", node_id: "NODE-A1", tenant: "acme" }]);

    // 两个租户的文件真实存在且互不覆盖
    assert.ok(fs.existsSync(path.resolve(legacyPath)));
    assert.ok(fs.existsSync(acme.journalPath));
    assert.equal(readJournal(path.resolve(legacyPath))[0].node_id, "NODE-001");
    assert.equal(readJournal(acme.journalPath)[0].node_id, "NODE-A1");

    // 路径反解 + 归属断言
    assert.equal(tenantOfPath(def.journalPath, { stateDir: dir }), "default");
    assert.equal(tenantOfPath(acme.journalPath, { stateDir: dir }), "acme");
    assert.throws(
      () => assertPathTenant(def.journalPath, "acme", { stateDir: dir }),
      (error) => error.code === "tenant_mismatch",
    );
    assert.throws(
      () => assertPathTenant(acme.journalPath, "other", { stateDir: dir }),
      (error) => error.code === "tenant_mismatch",
    );
  } finally {
    cleanup();
  }
});

test("跨租户读：acme 作用域读不到 default/other 的行", () => {
  const { dir, cleanup } = makeStateDir();
  try {
    const rows = [
      { kind: "node_added", node_id: "NODE-001", tenant: "acme" },
      { kind: "node_added", node_id: "NODE-002", tenant: "other" },
      { kind: "node_added", node_id: "NODE-003" }, // 老数据无 tenant → default
    ];
    writeJournal(tenantPaths({ stateDir: dir, tenant: "acme" }).journalPath, rows);
    const acmeRows = readJournal(tenantPaths({ stateDir: dir, tenant: "acme" }).journalPath);

    assert.deepEqual(
      filterInScope(acmeRows, "acme").map((row) => row.node_id),
      ["NODE-001"],
    );
    assert.deepEqual(
      filterInScope(acmeRows, "default").map((row) => row.node_id),
      ["NODE-003"],
    );
    assert.deepEqual(filterInScope(acmeRows, "other").map((row) => row.node_id), ["NODE-002"]);
    // strict：非 default 下未标注行（NODE-003）在 acme 视角被剔除
    assert.deepEqual(
      filterInScope(acmeRows, "acme", { strict: true }).map((row) => row.node_id),
      ["NODE-001"],
    );
  } finally {
    cleanup();
  }
});

test("跨租户写 / 导出：越界一律拒绝", () => {
  const { dir, cleanup } = makeStateDir();
  try {
    const acmeJournal = tenantPaths({ stateDir: dir, tenant: "acme" }).journalPath;
    const payload = {
      nodes: [{ node_id: "NODE-001", tenant: "acme" }],
      evidence: [{ evidence_id: "EVD-1", tenant: "other" }],
      journal: [{ kind: "node_added", node_id: "NODE-002", tenant: "other" }],
    };

    // 写：把 other 的行写进 acme 作用域 → 拒绝，且不产生文件副作用
    assert.throws(
      () =>
        assertRecordInScope(
          { kind: "node_added", node_id: "NODE-002", tenant: "other" },
          normalizeTenant("acme"),
          { action: "journal.append" },
        ),
      (error) => error.code === "tenant_mismatch",
    );
    assert.equal(fs.existsSync(acmeJournal), false, "被拒写入不得落地");

    // 导出：acme 视角拿不到 other 的 evidence/journal
    const exported = filterExport(payload, { tenant: "acme" });
    assert.deepEqual(exported.nodes.map((n) => n.node_id), ["NODE-001"]);
    assert.deepEqual(exported.evidence, []);
    assert.deepEqual(exported.journal, []);
    assert.equal(exported.tenant, "acme");
  } finally {
    cleanup();
  }
});
