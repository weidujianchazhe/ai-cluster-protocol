/**
 * 观测层类型（Lane O）。
 *
 * 设计约束：
 *  - **纯数据模块**：不 import `core/*`（避免与 core/state 的单向依赖倒灌），
 *    只在类型层面借用 `EventRecord` 的形状；core 侧需要时由 service 把 journal 事件喂进来。
 *  - 只使用「Node 类型剥离可直接执行」的语法（无 enum / 无 namespace / 无参数属性）。
 *  - 所有对外数字必须是有限值（`NaN` / `Infinity` 不得进导出），见 `redact.finite()`。
 */

/** 一次工具调用的采样（服务层每调一次工具就应产生一条）。 */
export interface ToolCallSample {
  /** 工具名，如 `graph_status` / `verify_done`。 */
  tool: string;
  /** 关联节点（可选；编排类工具可能没有）。 */
  nodeId?: string | null;
  /** 调用者实例（ROLE-CODE-01 之类），用于按实例归集。 */
  instanceId?: string | null;
  /** 调用是否成功（失败 = 拒绝的一种）。 */
  ok: boolean;
  /** 失败错误码（如 `invalid-state` / `credential-unavailable`）。 */
  errorCode?: string | null;
  /** 墙钟耗时（毫秒）。 */
  wallMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** 折算成本（价目表口径，币种无关）。 */
  cost?: number;
  /** 本次调用是第几次尝试（重试可见性）。 */
  attempt?: number | null;
  /** 采样时间（ISO）；缺省用注入的时钟。 */
  at?: string;
  /** 附加元数据：**会被脱敏**（见 redact.ts），不要放 prompt/密钥/绝对路径。 */
  meta?: Record<string, unknown>;
}

/** 一次节点级采样（拿到 adapter usage 或无工具调用的节点进度时用）。 */
export interface NodeSample {
  nodeId: string;
  instanceId?: string | null;
  status?: string | null;
  attempts?: number;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  wallMs?: number;
  at?: string;
  meta?: Record<string, unknown>;
}

/** 单节点聚合。 */
export interface NodeMetrics {
  nodeId: string;
  calls: number;
  ok: number;
  failed: number;
  tokensIn: number;
  tokensOut: number;
  tokens: number;
  cost: number;
  wallMs: number;
  avgWallMs: number;
  maxWallMs: number;
  retries: number;
  lastStatus: string | null;
  lastErrorCode: string | null;
  lastAt: string | null;
}

/** 单工具聚合。 */
export interface ToolMetrics {
  tool: string;
  calls: number;
  ok: number;
  failed: number;
  rejectionRate: number;
  wallMs: number;
  avgWallMs: number;
  tokens: number;
  cost: number;
}

/** 全局汇总。 */
export interface Totals {
  samples: number;
  calls: number;
  ok: number;
  failed: number;
  rejectionRate: number;
  tokensIn: number;
  tokensOut: number;
  tokens: number;
  cost: number;
  wallMs: number;
  avgWallMs: number;
  maxWallMs: number;
  retries: number;
  nodes: number;
  tools: number;
}

/** 阈值（全部可选；缺省用 `DEFAULT_LIMITS`）。 */
export interface ObservabilityLimits {
  /** 全局 token 预算；超限 → critical 告警。 */
  maxTokens?: number;
  /** 全局成本预算。 */
  maxCost?: number;
  /** 单次调用耗时上限（毫秒）；超过 → warn（`slow-call`）。 */
  maxWallMs?: number;
  /** 拒绝率阈值（0..1）；超过 → warn/critical。 */
  maxRejectionRate?: number;
  /** 拒绝率判定的最小样本数（避免 1 次失败就报警）。 */
  minSamplesForRate?: number;
  /** 单节点重试次数上限。 */
  maxRetries?: number;
  /** 节点预算缺省值（节点自带 `budget.maxTokens` 优先）。 */
  defaultNodeMaxTokens?: number;
}

export type AlertSeverity = "info" | "warn" | "critical";

/** 告警（JSON 可序列化；`rule` 与 `alertRules[].id` 一一对应）。 */
export interface ObservabilityAlert {
  rule: string;
  severity: AlertSeverity;
  message: string;
  nodeId: string | null;
  value: number | null;
  limit: number | null;
  at: string;
}

/** 规则求值上下文（由 metrics + graphStatus 投影组装，规则本身不读全局状态）。 */
export interface AlertContext {
  at: string;
  totals: Totals;
  nodes: NodeMetrics[];
  byTool: ToolMetrics[];
  limits: Required<ObservabilityLimits>;
  /** 节点预算（来自 graphStatus 的 `graph.nodes[].budget.maxTokens`）。 */
  nodeBudgets: Record<string, number>;
  /** 来自 graphStatus 的 blocked 节点。 */
  blocked: string[];
  /** 窗口内 lease_expired 次数（journal 派生或显式采样）。 */
  leaseExpired: number;
}

/** 健康快照（`graph_status.observability` 的主体）。 */
export interface HealthSnapshot {
  ok: boolean;
  at: string;
  status: "healthy" | "degraded" | "critical";
  totals: Totals;
  counts: {
    blocked: number;
    leaseExpired: number;
    alerts: number;
    critical: number;
    warn: number;
  };
  checks: Array<{ rule: string; ok: boolean; detail: string }>;
  alerts: ObservabilityAlert[];
}

/** `graph_status.observability` 的完整数据形状。 */
export interface ObservabilityProjection {
  ok: boolean;
  generated_at: string;
  window: { samples: number; nodes: number; tools: number };
  health: { status: HealthSnapshot["status"]; checks: HealthSnapshot["checks"] };
  totals: Totals;
  retries: { total: number; byNode: Array<{ nodeId: string; retries: number }> };
  byNode: NodeMetrics[];
  byTool: ToolMetrics[];
  alerts: ObservabilityAlert[];
  limits: Required<ObservabilityLimits>;
  source: { blocked: string[]; lease_expired: number };
}

export const DEFAULT_LIMITS: Required<ObservabilityLimits> = {
  maxTokens: 0,
  maxCost: 0,
  maxWallMs: 120_000,
  maxRejectionRate: 0.3,
  minSamplesForRate: 5,
  maxRetries: 3,
  defaultNodeMaxTokens: 0,
};

/** `0` 表示「不限」，统一收敛在这里，避免各规则各写一遍。 */
export function isLimitUnset(value: number): boolean {
  return !Number.isFinite(value) || value <= 0;
}
