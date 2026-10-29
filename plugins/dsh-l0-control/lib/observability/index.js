/**
 * Lane O · 观测层门面。
 *
 * 面向 service / e2e 的最小接入口（**不改 core / state / entry**）：
 *
 * ```ts
 * import { createObservability, instrumentTool, withObservability } from "../observability/index.js";
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
             
                 
              
             
                      
                          
                 
                    
import { Metrics, createMetrics } from "./metrics.js";
                                                                    
import { healthSnapshot } from "./health.js";
                                               
import { observabilityProjection } from "./projection.js";
import { writeObservabilityExport } from "./export.js";
                                                               

export * from "./types.js";
export { Metrics, createMetrics } from "./metrics.js";
                                                                    
export { alertRules, alertRuleIds, evaluateAlerts, normalizeLimits, severityRank } from "./alerts.js";
                                             
export { buildAlertContext, healthSnapshot, alertSummary, nodeHealthRows } from "./health.js";
                                               
export {
  observabilityProjection,
  withObservability,
  readGraphStatus,
  observabilityToJson,
  observabilityLogLines,
  alertDigest,
} from "./projection.js";
                                                       
export { writeObservabilityExport, renderExport, findSensitive } from "./export.js";
                                                               
export { metricsFromEvents, applyJournal, journalRejectionRate } from "./from-events.js";
                                                                         
export { redactValue, safeMeta, finite, integer, ratio, isoAt, SENSITIVE_VALUE_PATTERNS } from "./redact.js";

                                                              
                               
                               
 

                              
                     
                                       
              
                          
                               
 

/** 观测门面：持有一个 `Metrics` 实例 + 阈值。 */
export class Observability {
           metrics         ;
                   limits                     ;
                   clock              ;

  constructor(options                       = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.metrics = createMetrics({ maxSamples: options.maxSamples, clock: this.clock });
    this.limits = { ...(options.limits ?? {}) };
  }

  /** 每工具调用调用一次（服务层包一层即可）。 */
  sampleToolCall(input                )                 {
    return this.metrics.recordToolCall(input);
  }

  /** 节点级采样（adapter usage / 进度）。 */
  sampleNode(input            )                     {
    return this.metrics.recordNode(input);
  }

  /** 租约过期计数（可来自 watchdog 或 journal 派生）。 */
  recordLeaseExpired(count = 1)         {
    return this.metrics.recordLeaseExpired(count);
  }

  /** 当前阈值（只读副本）。 */
  get limitsSnapshot()                      {
    return { ...this.limits };
  }

  snapshot()                  {
    return this.metrics.snapshot();
  }

  /** 健康快照（含告警与逐规则结论）。 */
  health(hints              = {})                 {
    const input              = {
      metrics: this.metrics.snapshot(),
      limits: { ...this.limits, ...(hints.limits ?? {}) },
      blocked: hints.blocked,
      nodeBudgets: hints.nodeBudgets,
      at: hints.at ?? this.clock(),
    };
    return healthSnapshot(input);
  }

  /** `graph_status.observability` 投影。 */
  projection(hints              = {})                          {
    return observabilityProjection({
      metrics: this.metrics.snapshot(),
      limits: { ...this.limits, ...(hints.limits ?? {}) },
      blocked: hints.blocked,
      nodeBudgets: hints.nodeBudgets,
      at: hints.at ?? this.clock(),
    });
  }

  /** 导出 JSON + JSONL（fail-closed 脱敏）。 */
  exportTo(dir        , options                = {})               {
    return writeObservabilityExport(dir, this.projection(), options);
  }

  reset()       {
    this.metrics.reset();
  }
}

export function createObservability(options                       = {})                {
  return new Observability(options);
}

/* ────────────────────────── 函数式快捷口（无需实例） ────────────────────────── */

/** `sampleNode(obs | metrics, sample)`：计划里点名的入口。 */
export function sampleNode(
  target                         ,
  input            ,
)                     {
  return target instanceof Observability
    ? target.sampleNode(input)
    : target.recordNode(input);
}

/** `sampleToolCall(obs | metrics, sample)`。 */
export function sampleToolCall(
  target                         ,
  input                ,
)                 {
  return target instanceof Observability
    ? target.sampleToolCall(input)
    : target.recordToolCall(input);
}

/** 对任意 metrics 快照求健康（不绑定实例）。 */
export function healthSnapshotOf(snapshot                 , hints              = {})                 {
  return healthSnapshot({
    metrics: snapshot,
    limits: hints.limits,
    blocked: hints.blocked,
    nodeBudgets: hints.nodeBudgets,
    at: hints.at,
  });
}

/* ────────────────────────── 工具包装（service 接线用） ────────────────────────── */

                                    
                                                   
                    
                                                       
                                                 
                                      
                                                                                                   
                                               
                                                    
                      
                     
 

function defaultNodeId(input         )                {
  if (!input || typeof input !== "object") return null;
  const raw = input                           ;
  const value = raw.nodeId ?? raw.node_id ?? raw.id;
  return typeof value === "string" && value.length ? value : null;
}

function defaultUsage(result         )                                                                  {
  if (!result || typeof result !== "object") return null;
  const usage = (result                           ).usage;
  if (!usage || typeof usage !== "object") return null;
  const row = usage                           ;
  return {
    tokensIn: Number(row.tokensIn ?? row.tokens_in ?? row.prompt ?? 0),
    tokensOut: Number(row.tokensOut ?? row.tokens_out ?? row.completion ?? 0),
    cost: Number(row.cost ?? 0),
  };
}

function defaultErrorCode(error         )                {
  if (!error || typeof error !== "object") return null;
  const row = error                           ;
  const direct = row.code ?? row.error;
  return typeof direct === "string" ? direct : null;
}

/**
 * 包一层工具定义：`execute` 前后计时 + 记录成功/失败 + 采集 usage。
 * **不改变行为**：返回值原样、异常原样抛出（先记录再抛）。
 */
export function instrumentTool                               (
  tool   ,
  target                         ,
  options                    = {},
)    {
  const original = tool.execute;
  if (typeof original !== "function") return tool;
  const now = options.now ?? (() => Date.now());
  const toolName =
    options.toolName ?? (typeof tool.name === "string" ? tool.name : "tool");
  const pickNode = options.nodeIdFrom ?? defaultNodeId;
  const pickUsage = options.usageFrom ?? defaultUsage;
  const pickError = options.errorCodeFrom ?? defaultErrorCode;

  const wrapped = async (...args           )                   => {
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


//# sourceURL=observability\index.js