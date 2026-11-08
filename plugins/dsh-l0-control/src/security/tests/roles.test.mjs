/**
 * Lane S · security/roles 单测：角色矩阵 + 默认拒绝。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { resolvePrincipal } from "../identity.ts";
import {
  ACTIONS,
  GOVERNANCE_ACTIONS,
  PERMISSIONS,
  ROLES,
  assertRoleAllowed,
  isGovernanceAction,
  isKnownAction,
  roleAllows,
  rolesForAction,
} from "../roles.ts";

test("默认拒绝：未登记动作一律不授权", () => {
  assert.equal(isKnownAction("verify_done"), true);
  assert.equal(isKnownAction("delete_everything"), false);
  assert.equal(isKnownAction(""), false);
  assert.equal(roleAllows("delete_everything", "ORCH"), false);
  assert.deepEqual(rolesForAction("delete_everything"), []);

  const principal = resolvePrincipal("ROLE-ORCH-01");
  assert.throws(
    () => assertRoleAllowed(principal, "delete_everything"),
    (error) => error.code === "unknown_action",
  );
});

test("治理动作只给授权角色：verify_done / decide / reassign", () => {
  assert.deepEqual([...GOVERNANCE_ACTIONS], ["verify_done", "decide", "reassign"]);
  for (const action of GOVERNANCE_ACTIONS) {
    assert.equal(isGovernanceAction(action), true);
    const allowed = rolesForAction(action).map(String);
    assert.ok(allowed.length > 0, `${action} 必须有授权角色`);
    assert.equal(allowed.includes("CODE"), false, `${action} 不得给 CODE`);
    assert.equal(allowed.includes("RESEARCH"), false, `${action} 不得给 RESEARCH`);
    assert.equal(allowed.includes("HUMAN"), true, `${action} 必须保留 HUMAN`);
  }
  assert.deepEqual([...rolesForAction("verify_done")], ["AUDIT", "HUMAN"]);
  assert.deepEqual([...rolesForAction("decide")], ["ORCH", "HUMAN"]);
  assert.deepEqual([...rolesForAction("reassign")], ["ORCH", "HUMAN"]);
});

test("CODE 不能 verify_done/decide/reassign；AUDIT 不能 decide/reassign", () => {
  const code = resolvePrincipal("ROLE-CODE-01");
  const audit = resolvePrincipal("ROLE-AUDIT-01");
  for (const action of GOVERNANCE_ACTIONS) {
    assert.throws(() => assertRoleAllowed(code, action), (error) => error.code === "forbidden");
  }
  assert.throws(
    () => assertRoleAllowed(audit, "decide"),
    (error) => error.code === "forbidden",
  );
  assert.throws(
    () => assertRoleAllowed(audit, "reassign"),
    (error) => error.code === "forbidden",
  );
  assert.doesNotThrow(() => assertRoleAllowed(audit, "verify_done"));
});

test("矩阵自洽：每个动作至少一个合法角色；矩阵里没有未知角色", () => {
  const catalog = new Set(ROLES);
  for (const action of ACTIONS) {
    const roles = PERMISSIONS[action];
    assert.ok(Array.isArray(roles) && roles.length > 0, `${action} 角色集为空`);
    for (const role of roles) {
      assert.ok(catalog.has(role), `${action} 引用了未知角色 ${role}`);
    }
    assert.equal(roles.map(String).includes("*"), false, `${action} 不得通配`);
  }
});

test("读动作对执行角色开放，写动作收窄", () => {
  for (const role of ["RESEARCH", "DESIGN", "CODE", "DELIVER"]) {
    const principal = resolvePrincipal({ id: `ROLE-${role}-01`, kind: "agent" });
    assert.doesNotThrow(() => assertRoleAllowed(principal, "graph.read"));
    assert.doesNotThrow(() => assertRoleAllowed(principal, "task.claim"));
    assert.doesNotThrow(() => assertRoleAllowed(principal, "evidence.add"));
    assert.doesNotThrow(() => assertRoleAllowed(principal, "status.read"));
    assert.throws(() => assertRoleAllowed(principal, "reassign"), (e) => e.code === "forbidden");
    assert.throws(() => assertRoleAllowed(principal, "journal.read"), (e) => e.code === "forbidden");
  }
  const obs = resolvePrincipal("ROLE-OBS-01");
  assert.doesNotThrow(() => assertRoleAllowed(obs, "status.read"));
  assert.throws(() => assertRoleAllowed(obs, "task.claim"), (e) => e.code === "forbidden");
});
