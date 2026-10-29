/**
 * Lane S · 授权闸门（service 接线的唯一入口）。
 *
 * 调用形态（主窗口/N2 接线时）：
 *   const decision = guard.authorize(actorInput, "verify_done", { tenant, resourceTenant });
 *   journal.append({ ...guard.auditRow(decision), ... });
 *
 * 语义（全部 fail-closed）：
 *  1. 身份解析失败 → `Unauthenticated`（401）
 *  2. 动作未登记 → `UnknownAction`（400，默认拒绝，不做通配）
 *  3. 角色不在矩阵 → `Forbidden`（403）
 *  4. principal.tenant ≠ 请求 tenant → `TenantMismatch`（403）
 *  5. resourceTenant 给了且 ≠ 请求 tenant → `TenantMismatch`（403，跨租户读写拒绝）
 *  6. 治理动作要求显式 `governance: true` 标记（防止被普通写路径顺手带过）
 *  7. `requireAudit` 时校验生产者/审计者独立（同实例/同职务 → `Forbidden`）
 */

import { Forbidden, SecurityError, TenantMismatch } from "./errors.ts";
import {
  actorRef,
  auditIndependenceConflict,
  resolvePrincipal,
  DEFAULT_TENANT,
  type Principal,
  type PrincipalInput,
} from "./identity.ts";
import { PERMISSIONS, assertRoleAllowed, isGovernanceAction } from "./roles.ts";
import { normalizeTenant } from "../tenancy/tenant.ts";

export interface AuthorizeContext {
  /** 请求作用域 tenant（缺省取 principal.tenant）。 */
  tenant?: string;
  /** 目标资源所属 tenant（节点/journal 行/产物）；给了就强制比对。 */
  resourceTenant?: string;
  /** 治理动作的显式标记（verify_done / decide / reassign 必须为 true）。 */
  governance?: boolean;
  /** 审计独立性判定输入。 */
  producerInstance?: string;
  auditorInstance?: string;
  requireAuditIndependence?: boolean;
  /** 缺省租户（默认 `default`）。 */
  defaultTenant?: string;
}

export interface AuthorizationDecision {
  allowed: true;
  action: string;
  tenant: string;
  principal: Principal;
  actor: { kind: Principal["kind"]; id: string };
  allowedRoles: readonly string[];
  at: string;
}

/** 判定并返回 decision；任何不满足都抛 SecurityError 子类。 */
export function authorize(
  actor: PrincipalInput | string | null | undefined,
  action: string,
  context: AuthorizeContext = {},
): AuthorizationDecision {
  const principal = resolvePrincipal(actor, { defaultTenant: context.defaultTenant ?? DEFAULT_TENANT });
  const roles = assertRoleAllowed(principal, action);
  const scopeTenant = normalizeTenant(context.tenant ?? principal.tenant);

  if (principal.tenant !== scopeTenant) {
    throw new TenantMismatch(
      `调用者租户与请求作用域不一致：actor=${principal.tenant} scope=${scopeTenant}`,
      { actorTenant: principal.tenant, scopeTenant, action },
    );
  }
  if (context.resourceTenant !== undefined) {
    const resourceTenant = normalizeTenant(context.resourceTenant);
    if (resourceTenant !== scopeTenant) {
      throw new TenantMismatch(
        `跨租户访问被拒绝：resource=${resourceTenant} scope=${scopeTenant}（${action}）`,
        { resourceTenant, scopeTenant, action, resource: "resource" },
      );
    }
  }

  if (isGovernanceAction(action) && context.governance !== true) {
    throw new Forbidden(`治理动作需显式 governance 标记：${action}`, { action });
  }

  if (context.requireAuditIndependence) {
    const conflict = auditIndependenceConflict(
      String(context.producerInstance ?? ""),
      String(context.auditorInstance ?? principal.id),
    );
    if (conflict) {
      throw new Forbidden(conflict.message, { action, code: conflict.code });
    }
  }

  return {
    allowed: true,
    action,
    tenant: scopeTenant,
    principal,
    actor: actorRef(principal),
    allowedRoles: roles,
    at: new Date().toISOString(),
  };
}

/** 不抛版本（读路径/可观测用）：返回 {allowed:false, code, message}。 */
export function decide(
  actor: PrincipalInput | string | null | undefined,
  action: string,
  context: AuthorizeContext = {},
): { allowed: boolean; action: string; code: string | null; message: string | null; decision: AuthorizationDecision | null } {
  try {
    const decision = authorize(actor, action, context);
    return { allowed: true, action, code: null, message: null, decision };
  } catch (error) {
    const code = (error as { code?: string })?.code ?? "forbidden";
    const message = String((error as { message?: string })?.message || error);
    if (!["unauthenticated", "forbidden", "unknown_action", "tenant_mismatch"].includes(code)) {
      throw error;
    }
    return { allowed: false, action, code, message, decision: null };
  }
}

export interface AuditRowInput {
  decision: AuthorizationDecision | null;
  action: string;
  outcome: "allowed" | "denied" | "error";
  code?: string | null;
  message?: string | null;
  tenant?: string;
  actor?: { kind: string; id: string } | null;
  at?: string;
  detail?: Record<string, unknown>;
}

/**
 * 审计行（journal 追加用）：**必须**带 `actor` 与 `tenant`。
 * 拒绝路径也走这里，保证「被拒调用」同样留痕（actor + tenant + code）。
 */
export function auditRow(input: AuditRowInput): Record<string, unknown> {
  const tenant = normalizeTenant(input.tenant ?? input.decision?.tenant ?? DEFAULT_TENANT);
  const actor = input.actor ?? input.decision?.actor ?? null;
  if (!actor) {
    // 连身份都解析不出时，用匿名占位，仍要留 tenant + 拒绝码
    return {
      kind: "auth",
      at: input.at ?? new Date().toISOString(),
      action: input.action,
      actor: { kind: "unknown", id: "anonymous" },
      tenant,
      decision: input.outcome,
      code: input.code ?? "unauthenticated",
      message: input.message ?? null,
      detail: input.detail ?? {},
    };
  }
  return {
    kind: "auth",
    at: input.at ?? new Date().toISOString(),
    action: input.action,
    actor,
    tenant,
    decision: input.outcome,
    code: input.code ?? null,
    allowedRoles: input.decision?.allowedRoles ? [...input.decision.allowedRoles] : [],
    detail: input.detail ?? {},
  };
}

/** 便捷包装：执行动作并在失败时产出审计行（调用方决定是否落 journal）。 */
export function authorizeWithAudit(
  actor: PrincipalInput | string | null | undefined,
  action: string,
  context: AuthorizeContext = {},
): {
  decision: AuthorizationDecision | null;
  row: Record<string, unknown>;
  error: SecurityError | null;
} {
  try {
    const decision = authorize(actor, action, context);
    return { decision, row: auditRow({ decision, action, outcome: "allowed" }), error: null };
  } catch (error) {
    const code = (error as { code?: string })?.code ?? "forbidden";
    const message = String((error as { message?: string })?.message || error);
    // 被拒调用也要能定位到 actor：尽力解析（解析不出才是 anonymous）
    let actorOnDeny: { kind: Principal["kind"]; id: string } | null = null;
    try {
      actorOnDeny = actorRef(
        resolvePrincipal(actor, { defaultTenant: context.defaultTenant ?? DEFAULT_TENANT }),
      );
    } catch {
      actorOnDeny = null;
    }
    return {
      decision: null,
      row: auditRow({
        decision: null,
        action,
        outcome: "denied",
        code,
        message,
        tenant: context.tenant,
        actor: actorOnDeny,
      }),
      error: error instanceof SecurityError ? error : null,
    };
  }
}

/** 供 health/观测读：矩阵快照。 */
export function permissionMatrix(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [action, roles] of Object.entries(PERMISSIONS)) {
    out[action] = roles.map(String);
  }
  return out;
}
