/**
 * `graph_status.observability` 数据形状 + JSON / 日志导出（Lane O）。
 *
 * 形状约定（消费方可以只依赖这一层）：
 * ```
 * graph_status = {
 *   ...原有字段（ok/version/ready/counts/graph/journal）,
 *   observability: {
 *     ok, generated_at,
 *     window: {samples, nodes, tools},
 *     health: {status, checks[]},
 *     totals: {calls, ok, failed, rejectionRate, tokens, tokensIn/Out, cost, wallMs, avgWallMs, maxWallMs, retries},
 *     retries: {total, byNode[]},
 *     byNode[], byTool[],
 *     alerts[],
 *     limits{},
 *     source: {blocked[], lease_expired}
 *   }
 * }
 * ```
 * **不改 core/status**：`withObservability()` 返回新对象（浅拷贝 + 新键），原 `graphStatus()` 结果不被修改；
 * service 接线时只要 `withObservability(await core.graphStatus(), obs)` 即可。
 */
import type {
  HealthSnapshot,
  ObservabilityAlert,
  ObservabilityLimits,
  ObservabilityProjection,
} from "./types.ts";
import type { MetricsSnapshot } from "./metrics.ts";
import { healthSnapshot } from "./health.ts";
import { normalizeLimits, severityRank } from "./alerts.ts";

export interface ProjectionInput {
  metrics: MetricsSnapshot;
  limits?: ObservabilityLimits;
  blocked?: string[];
  nodeBudgets?: Record<string, number>;
  at?: string;
}

/** 生成 `graph_status.observability` 投影（纯 JSON 可序列化）。 */
export function observabilityProjection(input: ProjectionInput): ObservabilityProjection {
  const health: HealthSnapshot = healthSnapshot(input);
  const limits = normalizeLimits(input.limits ?? {});
  const metrics = input.metrics;
  return {
    ok: health.ok,
    generated_at: health.at,
    window: {
      samples: metrics.totals.samples,
      nodes: metrics.nodes.length,
      tools: metrics.byTool.length,
    },
    health: { status: health.status, checks: health.checks.map((check) => ({ ...check })) },
    totals: { ...health.totals },
    retries: {
      total: metrics.nodes.reduce((sum, node) => sum + node.retries, 0),
      byNode: metrics.nodes
        .filter((node) => node.retries > 0)
        .map((node) => ({ nodeId: node.nodeId, retries: node.retries }))
        .sort((a, b) => b.retries - a.retries || a.nodeId.localeCompare(b.nodeId)),
    },
    byNode: metrics.nodes.map((node) => ({ ...node })),
    byTool: metrics.byTool.map((tool) => ({ ...tool })),
    alerts: health.alerts.map((item) => ({ ...item })),
    limits,
    source: { blocked: [...(input.blocked ?? [])].sort(), lease_expired: metrics.leaseExpired },
  };
}

/** 把投影挂到 `graph_status` 结果上（返回新对象，不改入参）。 */
export function withObservability(
  graphStatus: Record<string, unknown>,
  projection: ObservabilityProjection,
): Record<string, unknown> {
  return { ...graphStatus, observability: projection };
}

/** 从 `graphStatus()` 结果里读观测所需的最小信息（不改入参、不做推断）。 */
export function readGraphStatus(status: Record<string, unknown> | null | undefined): {
  blocked: string[];
  nodeBudgets: Record<string, number>;
  nodeCount: number;
  done: number;
} {
  const graph = (status?.graph ?? {}) as { nodes?: Array<Record<string, unknown>> };
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const blocked: string[] = [];
  const nodeBudgets: Record<string, number> = {};
  let done = 0;
  for (const node of nodes) {
    const nodeId = String(node.node_id ?? node.nodeId ?? "");
    if (!nodeId) continue;
    if (String(node.status ?? "") === "blocked") blocked.push(nodeId);
    if (String(node.status ?? "") === "done") done += 1;
    const budget = node.budget as { maxTokens?: unknown; max_tokens?: unknown } | undefined;
    const raw = budget?.maxTokens ?? budget?.max_tokens;
    const maxTokens = Number(raw);
    if (Number.isFinite(maxTokens) && maxTokens > 0) nodeBudgets[nodeId] = maxTokens;
  }
  return { blocked: blocked.sort(), nodeBudgets, nodeCount: nodes.length, done };
}

/** 稳定 JSON（键序固定、缩进可配），供落盘与快照对比。 */
export function observabilityToJson(projection: ObservabilityProjection, space = 2): string {
  return JSON.stringify(projection, null, space);
}

/** 日志行：摘要 1 行 + 每条告警 1 行 + 每个节点 1 行（**全 JSON，便于 grep/jq**）。 */
export function observabilityLogLines(projection: ObservabilityProjection): string[] {
  const lines: string[] = [];
  const head = {
    t: "summary",
    at: projection.generated_at,
    health: projection.health.status,
    samples: projection.window.samples,
    calls: projection.totals.calls,
    failed: projection.totals.failed,
    rejectionRate: projection.totals.rejectionRate,
    tokens: projection.totals.tokens,
    cost: projection.totals.cost,
    wallMs: projection.totals.wallMs,
    retries: projection.retries.total,
    alerts: projection.alerts.length,
  };
  lines.push(JSON.stringify(head));
  for (const item of [...projection.alerts].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || a.rule.localeCompare(b.rule),
  )) {
    lines.push(
      JSON.stringify({
        t: "alert",
        severity: item.severity,
        rule: item.rule,
        nodeId: item.nodeId,
        value: item.value,
        limit: item.limit,
        message: item.message,
        at: item.at,
      }),
    );
  }
  for (const node of projection.byNode) {
    lines.push(
      JSON.stringify({
        t: "node",
        nodeId: node.nodeId,
        status: node.lastStatus,
        calls: node.calls,
        failed: node.failed,
        tokens: node.tokens,
        cost: node.cost,
        wallMs: node.wallMs,
        retries: node.retries,
        lastErrorCode: node.lastErrorCode,
      }),
    );
  }
  return lines;
}

/** 供测试/告警通道使用的最小摘要。 */
export function alertDigest(alerts: readonly ObservabilityAlert[]): string {
  if (!alerts.length) return "no-alerts";
  return alerts
    .map((item) => `${item.severity}:${item.rule}${item.nodeId ? `@${item.nodeId}` : ""}`)
    .join(",");
}
