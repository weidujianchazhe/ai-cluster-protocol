/**
 * Lane O · 观测层门面。
 *
 * 面向 service / e2e 的最小接入口（**不改 core / state / entry**）：
 *
 * ```ts
 * import { createObservability, instrumentTool, withObservability } from "../observability/index.ts";
 *
 * const obs = createObservability({ limits: { maxTokens: 200_000, maxCost: 5 } });
 * const tools = ALL_TOOLS.map((tool) => instrumentTool(tool, obs));   // 每调用一条指标
 * // graph_status:
 * const status = withObservability(await core.graphStatus(), obs.projection({ ...statusHints }));
 * obs.exportTo("out/observability");        // observability.json + observability.log
 * ```
 *
 * 三条不变式：
 *  1. **不抛业务错**：采样/聚合失败只会降级为空指标，绝不阻断工具调用（`instrumentTool` 里 catch 后 rethrow 原错）；
 *  2. **不改入参**：`withObservability` 返回新对象；
 *  3. **可离线**：所有输入都是普通 JS 值，无全局单例依赖（`createObservability()` 各自独立）。
 */
import type {
  HealthSnapshot,
  NodeMetrics,
  NodeSample,
  ObservabilityLimits,
  ObservabilityProjection,
  ToolCallSample,
} from "./types.ts";
import { Metrics, createMetrics } from "./metrics.ts";
import type { MetricsOptions, MetricsSnapshot } from "./metrics.ts";
import { healthSnapshot } from "./health.ts";
import type { HealthInput } from "./health.ts";
import { observabilityProjection } from "./projection.ts";
import { writeObservabilityExport } from "./export.ts";
import type { ExportOptions, ExportResult } from "./export.ts";

export * from "./types.ts";
export { Metrics, createMetrics } from "./metrics.ts";
export type { MetricsOptions, MetricsSnapshot } from "./metrics.ts";
export { alertRules, alertRuleIds, evaluateAlerts, normalizeLimits, severityRank } from "./alerts.ts";
export type { AlertRule } from "./alerts.ts";
export { buildAlertContext, healthSnapshot, alertSummary, nodeHealthRows } from "./health.ts";
export type { HealthInput } from "./health.ts";
export {
  observabilityProjection,
  withObservability,
  readGraphStatus,
  observabilityToJson,
  observabilityLogLines,
  alertDigest,
} from "./projection.ts";
export type { ProjectionInput } from "./projection.ts";
export { writeObservabilityExport, renderExport, findSensitive } from "./export.ts";
export type { ExportOptions, ExportResult } from "./export.ts";
export { metricsFromEvents, applyJournal, journalRejectionRate } from "./from-events.ts";
export type { JournalDerived, JournalEventLike } from "./from-events.ts";
export { redactValue, safeMeta, finite, integer, ratio, isoAt, SENSITIVE_VALUE_PATTERNS } from "./redact.ts";

export interface ObservabilityOptions extends MetricsOptions {
  /** 阈值；缺省用 DEFAULT_LIMITS。 */
  limits?: ObservabilityLimits;
}

export interface HealthHints {
  blocked?: string[];
  nodeBudgets?: Record<string, number>;
  at?: string;
  /** 单次求值的阈值覆盖（不写入实例）。 */
  limits?: ObservabilityLimits;
}

/** 观测门面：持有一个 `Metrics` 实例 + 阈值。 */
export class Observability {
  readonly metrics: Metrics;
  private readonly limits: ObservabilityLimits;
  private readonly clock: () => string;

  constructor(options: ObservabilityOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.metrics = createMetrics({ maxSamples: options.maxSamples, clock: this.clock });
    this.limits = { ...(options.limits ?? {}) };
  }

  /** 每工具调用调用一次（服务层包一层即可）。 */
  sampleToolCall(input: ToolCallSample): ToolCallSample {
    return this.metrics.recordToolCall(input);
  }

  /** 节点级采样（adapter usage / 进度）。 */
  sampleNode(input: NodeSample): NodeMetrics | null {
    return this.metrics.recordNode(input);
  }

  /** 租约过期计数（可来自 watchdog 或 journal 派生）。 */
  recordLeaseExpired(count = 1): number {
    return this.metrics.recordLeaseExpired(count);
  }

  /** 当前阈值（只读副本）。 */
  get limitsSnapshot(): ObservabilityLimits {
    return { ...this.limits };
  }

  snapshot(): MetricsSnapshot {
    return this.metrics.snapshot();
  }

  /** 健康快照（含告警与逐规则结论）。 */
  health(hints: HealthHints = {}): HealthSnapshot {
    const input: HealthInput = {
      metrics: this.metrics.snapshot(),
      limits: { ...this.limits, ...(hints.limits ?? {}) },
      blocked: hints.blocked,
      nodeBudgets: hints.nodeBudgets,
      at: hints.at ?? this.clock(),
    };
    return healthSnapshot(input);
  }

  /** `graph_status.observability` 投影。 */
  projection(hints: HealthHints = {}): ObservabilityProjection {
    return observabilityProjection({
      metrics: this.metrics.snapshot(),
      limits: { ...this.limits, ...(hints.limits ?? {}) },
      blocked: hints.blocked,
      nodeBudgets: hints.nodeBudgets,
      at: hints.at ?? this.clock(),
    });
  }

  /** 导出 JSON + JSONL（fail-closed 脱敏）。 */
  exportTo(dir: string, options: ExportOptions = {}): ExportResult {
    return writeObservabilityExport(dir, this.projection(), options);
  }

  reset(): void {
    this.metrics.reset();
  }
}

export function createObservability(options: ObservabilityOptions = {}): Observability {
  return new Observability(options);
}

/* ────────────────────────── 函数式快捷口（无需实例） ────────────────────────── */

/** `sampleNode(obs | metrics, sample)`：计划里点名的入口。 */
export function sampleNode(
  target: Observability | Metrics,
  input: NodeSample,
): NodeMetrics | null {
  return target instanceof Observability
    ? target.sampleNode(input)
    : target.recordNode(input);
}

/** `sampleToolCall(obs | metrics, sample)`。 */
export function sampleToolCall(
  target: Observability | Metrics,
  input: ToolCallSample,
): ToolCallSample {
  return target instanceof Observability
    ? target.sampleToolCall(input)
    : target.recordToolCall(input);
}

/** 对任意 metrics 快照求健康（不绑定实例）。 */
export function healthSnapshotOf(snapshot: MetricsSnapshot, hints: HealthHints = {}): HealthSnapshot {
  return healthSnapshot({
    metrics: snapshot,
    limits: hints.limits,
    blocked: hints.blocked,
    nodeBudgets: hints.nodeBudgets,
    at: hints.at,
  });
}

/* ────────────────────────── 工具包装（service 接线用） ────────────────────────── */

export interface InstrumentOptions {
  /** 覆盖工具名（工具名可能是函数，如 `named('graph_status')`）。 */
  toolName?: string;
  /** 从调用入参里取节点 id（默认读 `nodeId` / `node_id` / `id`）。 */
  nodeIdFrom?: (input: unknown) => string | null;
  /** 从返回值里取 token/成本（默认读 `usage`）。 */
  usageFrom?: (result: unknown) => { tokensIn?: number; tokensOut?: number; cost?: number } | null;
  /** 取失败错误码（默认读 `error` 字段 / `error.code`）。 */
  errorCodeFrom?: (error: unknown) => string | null;
  /** 注入时钟（毫秒），测试用。 */
  now?: () => number;
}

function defaultNodeId(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const value = raw.nodeId ?? raw.node_id ?? raw.id;
  return typeof value === "string" && value.length ? value : null;
}

function defaultUsage(result: unknown): { tokensIn?: number; tokensOut?: number; cost?: number } | null {
  if (!result || typeof result !== "object") return null;
  const usage = (result as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return null;
  const row = usage as Record<string, unknown>;
  return {
    tokensIn: Number(row.tokensIn ?? row.tokens_in ?? row.prompt ?? 0),
    tokensOut: Number(row.tokensOut ?? row.tokens_out ?? row.completion ?? 0),
    cost: Number(row.cost ?? 0),
  };
}

function defaultErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const row = error as Record<string, unknown>;
  const direct = row.code ?? row.error;
  return typeof direct === "string" ? direct : null;
}

/**
 * 包一层工具定义：`execute` 前后计时 + 记录成功/失败 + 采集 usage。
 * **不改变行为**：返回值原样、异常原样抛出（先记录再抛）。
 */
export function instrumentTool<T extends Record<string, any>>(
  tool: T,
  target: Observability | Metrics,
  options: InstrumentOptions = {},
): T {
  const original = tool.execute;
  if (typeof original !== "function") return tool;
  const now = options.now ?? (() => Date.now());
  const toolName =
    options.toolName ?? (typeof tool.name === "string" ? tool.name : "tool");
  const pickNode = options.nodeIdFrom ?? defaultNodeId;
  const pickUsage = options.usageFrom ?? defaultUsage;
  const pickError = options.errorCodeFrom ?? defaultErrorCode;

  const wrapped = async (...args: unknown[]): Promise<unknown> => {
    const started = now();
    try {
      const result = await original.apply(tool, args);
      const usage = pickUsage(result);
      sampleToolCall(target, {
        tool: toolName,
        nodeId: pickNode(args[0]),
        ok: true,
        wallMs: now() - started,
        tokensIn: usage?.tokensIn,
        tokensOut: usage?.tokensOut,
        cost: usage?.cost,
      });
      return result;
    } catch (error) {
      sampleToolCall(target, {
        tool: toolName,
        nodeId: pickNode(args[0]),
        ok: false,
        errorCode: pickError(error),
        wallMs: now() - started,
      });
      throw error;
    }
  };

  return { ...tool, execute: wrapped };
}
