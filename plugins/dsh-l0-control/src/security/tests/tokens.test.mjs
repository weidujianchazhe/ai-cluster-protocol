/**
 * Lane S · security/tokens 单测：签发/验签/篡改/过期/租户/动作白名单。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  TOKEN_VERSION,
  decodeCapabilityToken,
  issueCapabilityToken,
  verifyCapabilityToken,
} from "../tokens.ts";

const SECRET = "test-secret-0123456789";
const NOW = 1_700_000_000;

function issue(overrides = {}) {
  return issueCapabilityToken({
    subject: "ROLE-AUDIT-01",
    tenant: "acme",
    secret: SECRET,
    nowSec: NOW,
    ttlSec: 600,
    ...overrides,
  });
}

test("签发 → 验签：principal 带 roles/tenant/slot", () => {
  const token = issue();
  assert.ok(token.startsWith(`${TOKEN_VERSION}.`));
  const principal = verifyCapabilityToken(token, { secret: SECRET, nowSec: NOW + 10 });
  assert.equal(principal.id, "ROLE-AUDIT-01");
  assert.equal(principal.kind, "agent");
  assert.equal(principal.tenant, "acme");
  assert.deepEqual(principal.roles, ["AUDIT"]);
  assert.equal(principal.slot, "01");
  assert.equal(principal.claims.exp, NOW + 600);
  assert.ok(principal.claims.jti);
});

test("匿名/缺角色/短密钥/非法 ttl 一律拒绝签发", () => {
  assert.throws(() => issue({ subject: "" }), (e) => e.code === "token_invalid");
  assert.throws(
    () => issue({ subject: "verifier-ci", roles: [] }),
    (e) => e.code === "token_invalid",
  );
  assert.throws(
    () => issue({ secret: "short" }),
    (e) => e.code === "token_invalid",
  );
  assert.throws(() => issue({ ttlSec: 0 }), (e) => e.code === "token_invalid");
});

test("HUMAN 角色不得由令牌携带（除非显式 allowHuman）", () => {
  assert.throws(
    () => issue({ subject: "ROLE-HUMAN-01", roles: ["HUMAN"] }),
    (e) => e.code === "token_invalid",
  );
  const token = issue({ subject: "ROLE-HUMAN-01", roles: ["HUMAN"], allowHuman: true });
  const principal = verifyCapabilityToken(token, { secret: SECRET, nowSec: NOW });
  assert.deepEqual(principal.roles, ["HUMAN"]);
});

test("签发时动作必须已登记", () => {
  assert.throws(
    () => issue({ actions: ["delete_everything"] }),
    (e) => e.code === "token_invalid",
  );
});

test("篡改 payload / 篡改签名 / 换密钥 → token_invalid", () => {
  const token = issue();
  const [version, payload, sig] = token.split(".");

  const tamperedClaims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  tamperedClaims.roles = ["ORCH", "AUDIT"];
  const forgedPayload = Buffer.from(JSON.stringify(tamperedClaims)).toString("base64url");
  assert.throws(
    () => verifyCapabilityToken(`${version}.${forgedPayload}.${sig}`, { secret: SECRET, nowSec: NOW }),
    (e) => e.code === "token_invalid",
  );

  const flipped = sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA");
  assert.throws(
    () => verifyCapabilityToken(`${version}.${payload}.${flipped}`, { secret: SECRET, nowSec: NOW }),
    (e) => e.code === "token_invalid",
  );

  assert.throws(
    () => verifyCapabilityToken(token, { secret: "another-secret-0001", nowSec: NOW }),
    (e) => e.code === "token_invalid",
  );

  assert.throws(
    () => verifyCapabilityToken("garbage", { secret: SECRET, nowSec: NOW }),
    (e) => e.code === "token_invalid",
  );
});

test("过期 → token_expired（skew 可放宽但仍 fail-closed）", () => {
  const token = issue({ ttlSec: 60 });
  assert.throws(
    () => verifyCapabilityToken(token, { secret: SECRET, nowSec: NOW + 61 }),
    (e) => e.code === "token_expired",
  );
  assert.doesNotThrow(() =>
    verifyCapabilityToken(token, { secret: SECRET, nowSec: NOW + 61, skewSec: 5 }),
  );
});

test("租户不符 → tenant_mismatch", () => {
  const token = issue({ tenant: "acme" });
  assert.throws(
    () => verifyCapabilityToken(token, { secret: SECRET, nowSec: NOW, tenant: "default" }),
    (e) => e.code === "tenant_mismatch",
  );
  assert.doesNotThrow(() =>
    verifyCapabilityToken(token, { secret: SECRET, nowSec: NOW, tenant: "ACME" }),
  );
});

test("动作白名单收窄 → forbidden", () => {
  const token = issue({ actions: ["graph.read"] });
  assert.doesNotThrow(() =>
    verifyCapabilityToken(token, { secret: SECRET, nowSec: NOW, action: "graph.read" }),
  );
  assert.throws(
    () => verifyCapabilityToken(token, { secret: SECRET, nowSec: NOW, action: "verify_done" }),
    (e) => e.code === "forbidden",
  );
});

test("decode 不验签（仅调试用）：结构非法仍抛", () => {
  const token = issue();
  const claims = decodeCapabilityToken(token);
  assert.equal(claims.sub, "ROLE-AUDIT-01");
  assert.throws(() => decodeCapabilityToken("not-a-token"), (e) => e.code === "token_invalid");
  assert.throws(
    () => decodeCapabilityToken("v0.abc.def"),
    (e) => e.code === "token_invalid",
  );
});
