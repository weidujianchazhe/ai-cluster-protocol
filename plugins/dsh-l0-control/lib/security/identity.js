/**
 * Lane S · 调用者身份（Principal）。
 *
 * 事实来源：
 *  - 统一实例 ID 形态 `role-<role>-<nn>` / `ROLE-<ROLE>-<NN>`（见计划 §1 与真实链 6 节点）；
 *  - 审计需 `actor`（kind/id）与 `tenant`（见 e2e/port.ts Actor 与 plan §3-S）。
 *
 * 规则：
 *  - **默认拒绝**：kind 不认识、id 为空、角色解析不出 → `Unauthenticated`；
 *  - tenant 缺省 = `default`（兼容既有单团队数据，plan §5）；
 *  - 只做「解析 + 校验」，不做授权判定（授权在 `roles.ts` / `guard.ts`）。
 */

import { DEFAULT_TENANT, normalizeTenant } from "../tenancy/tenant.js";
import { Unauthenticated } from "./errors.js";

export const ACTOR_KINDS = ["agent", "plugin", "human"]         ;
                                                     

export { DEFAULT_TENANT };

/** 实例 ID：`ROLE-<ROLE>-<NN>`（大小写不敏感，统一解析为大写）。 */
const INSTANCE_ID_RE = /^role-([a-z][a-z0-9]*)-(\d{2})$/i;

                            
                                                   
             
                  
                         
                 
                                  
                  
                                         
                      
 

                                 
                
              
                  
                   
                                  
                
 

/** 解析实例 ID → {role, slot}；不是实例 ID 形态则返回 null（不抛）。 */
export function parseInstanceId(id        )                                        {
  if (typeof id !== "string") return null;
  const matched = INSTANCE_ID_RE.exec(id.trim());
  if (!matched) return null;
  return { role: matched[1].toUpperCase(), slot: matched[2] };
}

function normalizeKind(kind         )            {
  if (typeof kind === "string") {
    const lowered = kind.trim().toLowerCase();
    for (const candidate of ACTOR_KINDS) {
      if (candidate === lowered) return candidate;
    }
  }
  throw new Unauthenticated("actor kind 缺失或非法（expected agent|plugin|human）", { kind });
}

function normalizeRoles(input                , parsedRole               )           {
  const roles           = [];
  const push = (value         )       => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const upper = trimmed.toUpperCase();
    if (!roles.includes(upper)) roles.push(upper);
  };
  if (parsedRole) push(parsedRole);
  if (Array.isArray(input.roles)) for (const role of input.roles) push(role);
  push(input.role);
  return roles;
}

/**
 * 解析调用者身份（fail-closed）。
 *
 * @param input 对象或字符串（字符串按 agent 实例 ID 处理）
 * @param options.defaultTenant 缺省租户（默认 `default`）
 */
export function resolvePrincipal(
  input                                            ,
  options                             = {},
)            {
  if (input === null || input === undefined) {
    throw new Unauthenticated("缺少调用者身份（actor）");
  }
  const raw                 = typeof input === "string" ? { id: input, kind: "agent" } : input;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) throw new Unauthenticated("actor.id 不能为空");

  const kind = normalizeKind(raw.kind ?? "agent");
  const parsed = parseInstanceId(id);
  const roles = normalizeRoles(raw, parsed ? parsed.role : null);
  if (roles.length === 0) {
    throw new Unauthenticated("调用者没有任何可判定角色（roles 为空）", { id });
  }

  const tenantRaw = typeof raw.tenant === "string" ? raw.tenant.trim().toLowerCase() : "";
  const tenant = tenantRaw ? normalizeTenant(tenantRaw) : (options.defaultTenant ?? DEFAULT_TENANT);

  return { id, kind, tenant, roles, slot: parsed ? parsed.slot : null };
}

/** 审计行里的 actor 字段（不含 tenant，tenant 单独字段）。 */
export function actorRef(principal           )                                  {
  return { kind: principal.kind, id: principal.id };
}

export function hasRole(principal           , role        )          {
  return principal.roles.includes(role.trim().toUpperCase());
}

/**
 * 审计独立性：生产者与审计者不得同实例、也不得同职务。
 * 返回 null 表示独立；否则返回冲突原因（供 guard 抛 Forbidden）。
 */
export function auditIndependenceConflict(
  producerInstance        ,
  auditorInstance        ,
)                                           {
  const producer = typeof producerInstance === "string" ? producerInstance.trim() : "";
  const auditor = typeof auditorInstance === "string" ? auditorInstance.trim() : "";
  if (!producer || !auditor) {
    return { code: "audit_identity_missing", message: "生产者/审计者实例缺失，无法判定审计独立" };
  }
  if (producer.toLowerCase() === auditor.toLowerCase()) {
    return { code: "audit_not_independent", message: `审计者与生产者是同一实例：${producer}` };
  }
  const producerRole = parseInstanceId(producer)?.role ?? null;
  const auditorRole = parseInstanceId(auditor)?.role ?? null;
  if (producerRole && auditorRole && producerRole === auditorRole) {
    return { code: "audit_same_role", message: `审计者与生产者同职务：${producerRole}` };
  }
  return null;
}


//# sourceURL=security\identity.js