/**
 * 状态机常量（Python `graph.py` R9/R10 的等价物）。
 *
 * 三条硬约束：
 *  1. `done` 是终态：只能由凭证进入，不能再出；
 *  2. 跨状态迁移必须在 TRANSITIONS 白名单内（同状态幂等路径不受限）；
 *  3. `blocked → ready` 必须带 `unblocked:<原因>`。
 */
import { NODE_STATUSES } from "./types.ts";
import type { NodeStatus } from "./types.ts";

/** 跨状态白名单（16 条，与 Python `graph.TRANSITIONS` 完全一致）。 */
export const TRANSITIONS: ReadonlySet<string> = new Set([
  edgeKey("planned", "ready"),
  edgeKey("ready", "planned"),
  edgeKey("ready", "claimed"),
  edgeKey("claimed", "ready"),
  edgeKey("claimed", "claimed"),
  edgeKey("running", "ready"),
  edgeKey("claimed", "submitted"),
  edgeKey("running", "submitted"),
  edgeKey("submitted", "verifying"),
  edgeKey("submitted", "ready"),
  edgeKey("verifying", "ready"),
  edgeKey("verifying", "done"),
  edgeKey("ready", "blocked"),
  edgeKey("claimed", "blocked"),
  edgeKey("running", "blocked"),
  edgeKey("blocked", "ready"),
]);

/** 终态集合：不可退出。 */
export const TERMINAL_STATUSES: ReadonlySet<NodeStatus> = new Set<NodeStatus>(["done"]);

/** 需要证据凭证才能进入的状态。 */
export const GATED_STATUSES: ReadonlySet<NodeStatus> = new Set<NodeStatus>(["done"]);

export const UNBLOCK_REASON_PREFIX = "unblocked:";

export function edgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

export function isNodeStatus(value: string): value is NodeStatus {
  return (NODE_STATUSES as readonly string[]).includes(value);
}

export function isTerminal(status: NodeStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isGated(status: NodeStatus): boolean {
  return GATED_STATUSES.has(status);
}

/**
 * 白名单强制开关。默认开；可用环境变量 `CP_TRANSITIONS_ENFORCE=0`
 * 或运行期 `setTransitionEnforcement(false)` 关闭（回滚点，与 Python 对齐）。
 */
let enforceTransitions = process.env.CP_TRANSITIONS_ENFORCE !== "0";

export function setTransitionEnforcement(enabled: boolean): void {
  enforceTransitions = Boolean(enabled);
}

export function transitionEnforcement(): boolean {
  return enforceTransitions;
}

export interface TransitionCheck {
  ok: boolean;
  reason?: "terminal" | "not_whitelisted" | "same_status";
}

/** 判定一次迁移是否被允许（不做凭证校验——凭证由 graph.setStatus 负责）。 */
export function checkTransition(from: NodeStatus, to: NodeStatus): TransitionCheck {
  if (from === to) return { ok: true, reason: "same_status" };
  if (isTerminal(from)) return { ok: false, reason: "terminal" };
  if (!enforceTransitions) return { ok: true };
  if (!TRANSITIONS.has(edgeKey(from, to))) return { ok: false, reason: "not_whitelisted" };
  return { ok: true };
}

/** 白名单的邻接表形式（只读视图，供测试/工具/文档复用）。 */
export function allowedTransitions(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of TRANSITIONS) {
    const [from, to] = key.split("->");
    (out[from] ??= []).push(to);
  }
  for (const from of Object.keys(out)) out[from].sort();
  return out;
}
