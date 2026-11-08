/**
 * 告警规则（Lane O）。
 *
 * 规则是**纯函数**：给定 `AlertContext`（指标聚合 + graphStatus 的 blocked/预算 + 租约过期数），
 * 返回 `ObservabilityAlert[]`；规则之间不共享可变状态，顺序执行，重复求值幂等。
 *
 * 四条必备规则（计划 §O）：
 *  1. `budget-exceeded`：全局 / 单节点 token 或成本超限；
 *  2. `lease-expired`：窗口内出现租约过期；
 *  3. `node-blocked`：图里有 blocked 节点（阻断无法自愈）；
 *  4. `rejection-rate`：工具调用拒绝率超阈值（小样本不报）。
 * 另加两条可观测性增强：`slow-call`（单节点最慢调用超阈值）、`retry-heavy`（重试超限）。
 */
import type {
  AlertContext,
  AlertSeverity,
  ObservabilityAlert,
  ObservabilityLimits,
} from "./types.ts";
import { DEFAULT_LIMITS, isLimitUnset } from "./types.ts";
import { finite } from "./redact.ts";

export interface AlertRule {
  id: string;
  severity: AlertSeverity;
  description: string;
  evaluate(ctx: AlertContext): ObservabilityAlert[];
}

function alert(
  ctx: AlertContext,
  rule: string,
  severity: AlertSeverity,
  message: string,
  value: number | null,
  limit: number | null,
  nodeId: string | null = null,
): ObservabilityAlert {
  return { rule, severity, message, nodeId, value, limit, at: ctx.at };
}

/** 1) 预算：全局 tokens / 全局成本 / 单节点 tokens。 */
const budgetRule: AlertRule = {
  id: "budget-exceeded",
  severity: "critical",
  description: "全局 token/成本或单节点 token 预算超限",
  evaluate(ctx) {
    const out: ObservabilityAlert[] = [];
    const { limits, totals } = ctx;

    if (!isLimitUnset(limits.maxTokens) && totals.tokens > limits.maxTokens) {
      out.push(
        alert(
          ctx,
          "budget-exceeded",
          "critical",
          `全局 token 预算超限：${totals.tokens} > ${limits.maxTokens}`,
          totals.tokens,
          limits.maxTokens,
        ),
      );
    }
    if (!isLimitUnset(limits.maxCost) && totals.cost > limits.maxCost) {
      out.push(
        alert(
          ctx,
          "budget-exceeded",
          "critical",
          `全局成本预算超限：${round(totals.cost)} > ${limits.maxCost}`,
          round(totals.cost),
          limits.maxCost,
        ),
      );
    }
    for (const node of ctx.nodes) {
      const budget = ctx.nodeBudgets[node.nodeId];
      const cap = budget === undefined ? limits.defaultNodeMaxTokens : budget;
      if (!isLimitUnset(cap) && node.tokens > cap) {
        out.push(
          alert(
            ctx,
            "budget-exceeded",
            "critical",
            `节点 ${node.nodeId} token 超限：${node.tokens} > ${cap}`,
            node.tokens,
            cap,
            node.nodeId,
          ),
        );
      }
    }
    return out;
  },
};

/** 2) 租约过期：出现即 warn，连续多次升级 critical。 */
const leaseRule: AlertRule = {
  id: "lease-expired",
  severity: "warn",
  description: "窗口内出现租约过期（心跳/进程可能已失联）",
  evaluate(ctx) {
    if (ctx.leaseExpired <= 0) return [];
    const severity: AlertSeverity = ctx.leaseExpired >= 3 ? "critical" : "warn";
    return [
      alert(
        ctx,
        "lease-expired",
        severity,
        `租约过期 ${ctx.leaseExpired} 次（阈值 ≥1；≥3 升级 critical）`,
        ctx.leaseExpired,
        1,
      ),
    ];
  },
};

/** 3) blocked：阻断节点无法自愈，必须人工 unblock。 */
const blockedRule: AlertRule = {
  id: "node-blocked",
  severity: "warn",
  description: "图里存在 blocked 节点",
  evaluate(ctx) {
    if (!ctx.blocked.length) return [];
    const severity: AlertSeverity = ctx.blocked.length >= 3 ? "critical" : "warn";
    return [
      alert(
        ctx,
        "node-blocked",
        severity,
        `blocked 节点 ${ctx.blocked.length} 个：${ctx.blocked.join(",")}（≥3 升级 critical）`,
        ctx.blocked.length,
        1,
      ),
    ];
  },
};

/** 4) 拒绝率：小样本不报，避免一次失败就告警。 */
const rejectionRule: AlertRule = {
  id: "rejection-rate",
  severity: "warn",
  description: "工具调用拒绝率超阈值",
  evaluate(ctx) {
    const { limits, totals } = ctx;
    if (totals.calls < limits.minSamplesForRate) return [];
    if (isLimitUnset(limits.maxRejectionRate)) return [];
    if (totals.rejectionRate <= limits.maxRejectionRate) return [];
    const severity: AlertSeverity = totals.rejectionRate >= 0.5 ? "critical" : "warn";
    return [
      alert(
        ctx,
        "rejection-rate",
        severity,
        `拒绝率 ${(totals.rejectionRate * 100).toFixed(1)}% > ${(limits.maxRejectionRate * 100).toFixed(0)}%`
          + `（${totals.failed}/${totals.calls} 次失败）`,
        round(totals.rejectionRate),
        limits.maxRejectionRate,
      ),
    ];
  },
};

/** 5) 慢调用：单节点最慢一次超过阈值。 */
const slowRule: AlertRule = {
  id: "slow-call",
  severity: "warn",
  description: "单节点最慢工具调用超耗时阈值",
  evaluate(ctx) {
    if (isLimitUnset(ctx.limits.maxWallMs)) return [];
    const out: ObservabilityAlert[] = [];
    for (const node of ctx.nodes) {
      if (node.maxWallMs > ctx.limits.maxWallMs) {
        out.push(
          alert(
            ctx,
            "slow-call",
            "warn",
            `节点 ${node.nodeId} 最慢调用 ${node.maxWallMs}ms > ${ctx.limits.maxWallMs}ms`,
            node.maxWallMs,
            ctx.limits.maxWallMs,
            node.nodeId,
          ),
        );
      }
    }
    return out;
  },
};

/** 6) 重试过多：节点重试次数超限（可能死循环）。 */
const retryRule: AlertRule = {
  id: "retry-heavy",
  severity: "warn",
  description: "节点重试次数超限",
  evaluate(ctx) {
    if (isLimitUnset(ctx.limits.maxRetries)) return [];
    const out: ObservabilityAlert[] = [];
    for (const node of ctx.nodes) {
      if (node.retries > ctx.limits.maxRetries) {
        out.push(
          alert(
            ctx,
            "retry-heavy",
            "warn",
            `节点 ${node.nodeId} 重试 ${node.retries} 次 > ${ctx.limits.maxRetries}`,
            node.retries,
            ctx.limits.maxRetries,
            node.nodeId,
          ),
        );
      }
    }
    return out;
  },
};

/** 规则表（顺序即求值顺序；导出给测试与文档核对）。 */
export const alertRules: readonly AlertRule[] = [
  budgetRule,
  leaseRule,
  blockedRule,
  rejectionRule,
  slowRule,
  retryRule,
];

/** 规则 id 列表（测试断言「四条必备规则都在」用）。 */
export function alertRuleIds(): string[] {
  return alertRules.map((rule) => rule.id);
}

/** 求值全部规则（或给定子集），返回扁平告警列表。 */
export function evaluateAlerts(
  ctx: AlertContext,
  rules: readonly AlertRule[] = alertRules,
): ObservabilityAlert[] {
  const out: ObservabilityAlert[] = [];
  for (const rule of rules) {
    out.push(...rule.evaluate(ctx));
  }
  return out.sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      a.rule.localeCompare(b.rule) ||
      (a.nodeId ?? "").localeCompare(b.nodeId ?? ""),
  );
}

export function severityRank(severity: AlertSeverity): number {
  return severity === "critical" ? 2 : severity === "warn" ? 1 : 0;
}

/** 补齐 limits（缺省值来自 `DEFAULT_LIMITS`）。 */
export function normalizeLimits(limits: ObservabilityLimits = {}): Required<ObservabilityLimits> {
  const merged = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof ObservabilityLimits>) {
    const value = limits[key];
    if (value !== undefined && value !== null && Number.isFinite(Number(value))) {
      merged[key] = Number(value);
    }
  }
  return merged;
}

function round(value: number): number {
  return Math.round(finite(value, 0) * 1_000_000) / 1_000_000;
}
