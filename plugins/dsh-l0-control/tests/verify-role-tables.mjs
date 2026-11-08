// 角色表一致性：四张白名单必须互相对得上。
//
// 背景：Bug 6 —— `ROLES` 只列了粗粒度 `AUDIT`，而 `verify_done` 的前置检查
// (`AUDITOR_ROLES`) 只认 `AUDIT_CODE/EVIDENCE/DESIGN`。两张表不相交，
// 于是 `verify_done` 对任何调用者都不可能成功，报错还只说 `forbidden`。
//
// 这个测试把「一致性」变成一条可执行断言，而不是一次人工审查。
import {
  validateRoleTables,
  ROLES,
  AUDITOR_ROLES,
  PERMISSIONS,
} from "../lib/security/roles.js";

const cases = [];
const check = (name, cond, detail) => cases.push({ name, pass: Boolean(cond), detail });

// 1. 官方自检函数必须返回空
{
  const issues = validateRoleTables();
  check("validateRoleTables() 无问题", issues.length === 0, issues.join(" | "));
}

// 2. 审计职务必须都在 ROLES 里声明过
{
  const declared = new Set(ROLES);
  const missing = AUDITOR_ROLES.filter((r) => !declared.has(r));
  check("AUDITOR_ROLES 全部已声明", missing.length === 0, `缺：${missing.join(",")}`);
}

// 3. 审计职务必须都出现在 verify_done 白名单里（Bug 6 的核心断言）
{
  const allowed = new Set(PERMISSIONS.verify_done ?? []);
  const missing = AUDITOR_ROLES.filter((r) => !allowed.has(r));
  check("verify_done 白名单覆盖全部审计职务", missing.length === 0, `缺：${missing.join(",")}`);
}

// 4. PERMISSIONS 里引用的角色全部已声明
{
  const declared = new Set(ROLES);
  const bad = [];
  for (const [action, roles] of Object.entries(PERMISSIONS)) {
    for (const role of roles) if (!declared.has(role)) bad.push(`${action}:${role}`);
  }
  check("PERMISSIONS 未引用未声明角色", bad.length === 0, bad.join(","));
}

// 5. 双向导出一致：capabilities 的 AUDITOR_ROLES 与 roles 的是同一个集合
{
  const caps = await import("../lib/capabilities.js");
  const a = [...caps.AUDITOR_ROLES].sort().join(",");
  const b = [...AUDITOR_ROLES].sort().join(",");
  check("capabilities.AUDITOR_ROLES === roles.AUDITOR_ROLES", a === b, `${a} != ${b}`);
}

const failed = cases.filter((c) => !c.pass);
for (const c of cases) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : "  (" + c.detail + ")"}`);
console.log(failed.length === 0 ? "\nALL PASS" : `\nFAILED: ${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);
