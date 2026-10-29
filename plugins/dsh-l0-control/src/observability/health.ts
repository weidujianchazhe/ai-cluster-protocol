/**
 * 健康快照（Lane O）：把「指标聚合 + 图状态 + 租约」收敛成一个可判定的整体。
 *
 * 输出 `HealthSnapshot` 是 `graph_status.observability` 的主体（见 projection.ts）。
 * `checks` 逐条列出规则结论 —— 告警之外还要能看到「规则跑过了、判定为 ok」，
 * 否则「没告警」无法区分「健康」与「规则没跑」。
 */
import type {
  AlertContext,
  HealthSnapshot,
  NodeMetrics,
  ObservabilityAlert,
  ObservabilityLimits,
  Totals,
} from "./types.ts";
import type { MetricsSnapshot } from "./metrics.ts";
import { alertRules, evaluateAlerts, normalizeLimits, severityRank } from "./alerts.ts";
import { finite, isoAt } from "./redact.ts";

export interface HealthInput {
  /** 指标聚合快照（`Metrics.snapshot()`）。 */
  metrics: MetricsSnapshot;
  /** 阈值（缺省用 DEFAULT_LIMITS；0/负数表示不限）。 */
  limits?: ObservabilityLimits;
  /** blocked 节点（来自 graphStatus）。 */
  blocked?: string[];
  /** 节点 token 预算（来自 graphStatus 的 `budget.maxTokens`）。 */
  nodeBudgets?: Record<string, number>;
  /** 时间戳（缺省=当前时刻）。 */
  at?: string;
}

/** 组装规则求值上下文（纯函数，不改输入）。 */
export function buildAlertContext(input: HealthInput): AlertContext {
  const at = isoAt(input.at, new Date().toISOString());
  const limits = normalizeLimits(input.limits ?? {});
  const totals: Totals = { ...input.metrics.totals };
  return {
    at,
    totals,
    nodes: input.metrics.nodes.map((node) => ({ ...node })),
    byTool: input.metrics.byTool.map((tool) => ({ ...tool })),
    limits,
    nodeBudgets: { ...(input.nodeBudgets ?? {}) },
    blocked: [...(input.blocked ?? [])].sort(),
    leaseExpired: finite(input.metrics.leaseExpired, 0),
  };
}

/** 健康快照：状态 + 计数 + 逐规则结论 + 告警。 */
export function healthSnapshot(input: HealthInput): HealthSnapshot {
  const ctx = buildAlertContext(input);
  const alerts = evaluateAlerts(ctx);
  const checks = alertRules.map((rule) => {
    const hits = alerts.filter((item) => item.rule === rule.id);
    return {
      rule: rule.id,
      ok: hits.length === 0,
      detail: hits.length === 0 ? "ok" : hits.map((hit) => hit.message).join("; "),
    };
  });
  const critical = alerts.filter((item) => item.severity === "critical").length;
  const warn = alerts.filter((item) => item.severity === "warn").length;
  const status: HealthSnapshot["status"] =
    critical > 0 ? "critical" : warn > 0 ? "degraded" : "healthy";

  return {
    ok: critical === 0,
    at: ctx.at,
    status,
    totals: ctx.totals,
    counts: {
      blocked: ctx.blocked.length,
      leaseExpired: ctx.leaseExpired,
      alerts: alerts.length,
      critical,
      warn,
    },
    checks,
    alerts,
  };
}

/** 按告警严重度聚合（导出/日志头部摘要用）。 */
export function alertSummary(alerts: readonly ObservabilityAlert[]): {
  critical: number;
  warn: number;
  info: number;
  worst: ObservabilityAlert | null;
} {
  const sorted = [...alerts].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  return {
    critical: alerts.filter((item) => item.severity === "critical").length,
    warn: alerts.filter((item) => item.severity === "warn").length,
    info: alerts.filter((item) => item.severity === "info").length,
    worst: sorted[0] ?? null,
  };
}

/** 单节点健康行（CLI/日志表格化时用；只含可审计字段，不含 spec/title）。 */
export function nodeHealthRows(nodes: readonly NodeMetrics[]): Array<{
  nodeId: string;
  status: string;
  attempts: number;
  calls: number;
  failed: number;
  tokens: number;
  cost: number;
  wallMs: number;
  retries: number;
}> {
  return nodes.map((node) => ({
    nodeId: node.nodeId,
    status: node.lastStatus ?? "unknown",
    attempts: node.retries,
    calls: node.calls,
    failed: node.failed,
    tokens: node.tokens,
    cost: node.cost,
    wallMs: node.wallMs,
    retries: node.retries,
  }));
}
