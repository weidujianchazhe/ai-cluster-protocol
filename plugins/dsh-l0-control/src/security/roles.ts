/**
 * Lane S · 角色权限矩阵（默认拒绝）。
 *
 * 设计要点：
 *  - **动作白名单**：未登记的动作 = 拒绝（`UnknownAction`），不做前缀/通配放行；
 *  - **默认拒绝**：角色不在某动作的允许集内 = 拒绝（`Forbidden`）；
 *  - 三个「治理动作」只给授权角色：
 *      `verify_done` → AUDIT / HUMAN
 *      `decide`      → ORCH / HUMAN
 *      `reassign`    → ORCH / HUMAN
 *  - `HUMAN` 是操作者（L3 保留口），不应由 Agent 令牌携带（见 `tokens.ts` 的 `allowHuman`）。
 */

import { Forbidden, UnknownAction } from "./errors.ts";
import type { Principal } from "./identity.ts";

/** 职务目录（与 R8 编队一致：可重复、可复合）。 */
export const ROLES = [
  "ORCH", // 编排 / planner
  "RESEARCH",
  "DESIGN",
  "CODE",
  "AUDIT",
  "DELIVER",
  "OBS", // 观测
  "PLUGIN", // 插件自身（服务内部动作）
  "HUMAN", // 人工操作者 / L3
] as const;
export type Role = (typeof ROLES)[number];

/** 动作 → 允许角色。`export` 等只读动作可多角色；写动作收窄。 */
export const PERMISSIONS: Record<string, readonly Role[]> = {
  // 图 / 愿望
  "wish.create": ["ORCH", "HUMAN"],
  "graph.read": ["ORCH", "RESEARCH", "DESIGN", "CODE", "AUDIT", "DELIVER", "OBS", "PLUGIN", "HUMAN"],
  "graph.write": ["ORCH", "HUMAN"],
  // Bootstrap（工程初始化）：人类/编排/插件自身可建目录骨架；不授予执行角色
  "project.init": ["ORCH", "HUMAN", "PLUGIN"],
  // 执行
  "task.next": ["RESEARCH", "DESIGN", "CODE", "DELIVER"],
  "task.claim": ["RESEARCH", "DESIGN", "CODE", "DELIVER"],
  "task.heartbeat": ["RESEARCH", "DESIGN", "CODE", "DELIVER"],
  "task.submit": ["RESEARCH", "DESIGN", "CODE", "DELIVER"],
  "evidence.add": ["RESEARCH", "DESIGN", "CODE", "DELIVER", "PLUGIN"],
  // 治理（只给授权角色）
  "gate.pass": ["ORCH", "AUDIT", "HUMAN"],
  verify_done: ["AUDIT", "HUMAN"],
  decide: ["ORCH", "HUMAN"],
  reassign: ["ORCH", "HUMAN"],
  // 编排面
  "team.spawn": ["ORCH", "HUMAN"],
  "team.message": ["ORCH", "RESEARCH", "DESIGN", "CODE", "AUDIT", "DELIVER", "HUMAN"],
  terminate: ["ORCH", "HUMAN"],
  resume: ["ORCH", "HUMAN"],
  replan: ["ORCH", "HUMAN"],
  // 读面
  "status.read": ["ORCH", "RESEARCH", "DESIGN", "CODE", "AUDIT", "DELIVER", "OBS", "PLUGIN", "HUMAN"],
  "journal.read": ["ORCH", "AUDIT", "OBS", "HUMAN"],
  export: ["ORCH", "AUDIT", "DELIVER", "OBS", "HUMAN"],
};

/** 单独导出：治理动作（供文档/测试断言用，避免被误改）。 */
export const GOVERNANCE_ACTIONS = ["verify_done", "decide", "reassign"] as const;

export const ACTIONS = Object.keys(PERMISSIONS);

export function isKnownAction(action: string): boolean {
  return typeof action === "string" && Object.prototype.hasOwnProperty.call(PERMISSIONS, action);
}

/** 动作允许的角色集（未登记动作 → 空集，调用方按 `UnknownAction` 处理）。 */
export function rolesForAction(action: string): readonly Role[] {
  if (!isKnownAction(action)) return [];
  return PERMISSIONS[action];
}

export function requireKnownAction(action: string): readonly Role[] {
  if (!isKnownAction(action)) {
    throw new UnknownAction(`未登记的动作（默认拒绝）：${action}`, { action });
  }
  return PERMISSIONS[action];
}

/** 角色是否被允许执行该动作（纯判定，不抛；未登记动作返回 false）。 */
export function roleAllows(action: string, role: string): boolean {
  const allowed = rolesForAction(action);
  const normalized = String(role || "").trim().toUpperCase();
  return allowed.includes(normalized as Role);
}

/**
 * 判定 principal 是否可执行 action（默认拒绝）。
 * 抛错语义：未登记动作 → UnknownAction；无角色命中 → Forbidden。
 */
export function assertRoleAllowed(principal: Principal, action: string): readonly Role[] {
  const allowed = requireKnownAction(action);
  const matched = principal.roles.filter((role) => allowed.includes(role as Role));
  if (matched.length === 0) {
    throw new Forbidden(
      `角色不足：${principal.id}（${principal.roles.join(",") || "无"}）不能执行 ${action}`,
      { action, roles: principal.roles, allowed },
    );
  }
  return allowed;
}

/** 治理动作的授权角色（供 service 接线时做二次显式检查）。 */
export function isGovernanceAction(action: string): boolean {
  return (GOVERNANCE_ACTIONS as readonly string[]).includes(action);
}
