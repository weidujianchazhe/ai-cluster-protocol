/**
 * 指标聚合（Lane O）。
 *
 * 输入是**采样**，不是全局状态：
 *  - `recordToolCall()`：每工具调用一条（服务层包一层就能产生，见 `instrumentTool`）；
 *  - `recordNode()`：节点级采样（adapter usage / 进度），用于补 token、成本、耗时、attempts；
 *  - `recordLeaseExpired()`：租约过期计数（也可由 journal 派生后一次性灌入）。
 *
 * 输出是纯 JSON 可序列化的聚合：总量、按节点、按工具。原始样本只保留最近 N 条（有界内存），
 * 聚合值单调累加，不因环形缓冲淘汰而回退。
 */
import type {
  NodeMetrics,
  NodeSample,
  ToolCallSample,
  ToolMetrics,
  Totals,
} from "./types.ts";
import { finite, integer, isoAt, ratio, safeMeta } from "./redact.ts";

export interface MetricsOptions {
  /** 原始样本环形缓冲上限（聚合不受影响）。 */
  maxSamples?: number;
  /** 注入时钟（测试可固定时间）。 */
  clock?: () => string;
}

export interface MetricsSnapshot {
  totals: Totals;
  nodes: NodeMetrics[];
  byTool: ToolMetrics[];
  /** 窗口内租约过期次数（显式采样 + journal 派生之和）。 */
  leaseExpired: number;
}

interface NodeAcc {
  nodeId: string;
  calls: number;
  ok: number;
  failed: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  wallMs: number;
  maxWallMs: number;
  /** 工具采样里出现过的最大 attempt（1 起）→ 重试 = maxAttempt - 1。 */
  maxAttempt: number;
  /** 节点采样上报的 attempts（journal `attempts_changed` 的累计值）。 */
  nodeAttempts: number;
  lastStatus: string | null;
  lastErrorCode: string | null;
  lastAt: string | null;
}

interface ToolAcc {
  tool: string;
  calls: number;
  ok: number;
  failed: number;
  wallMs: number;
  tokens: number;
  cost: number;
}

const DEFAULT_MAX_SAMPLES = 500;

export class Metrics {
  private readonly maxSamples: number;
  private readonly clock: () => string;
  private readonly nodeAcc = new Map<string, NodeAcc>();
  private readonly toolAcc = new Map<string, ToolAcc>();
  private readonly samples: ToolCallSample[] = [];
  private leaseExpiredCount = 0;
  private totals: Totals = emptyTotals();

  constructor(options: MetricsOptions = {}) {
    this.maxSamples = Math.max(1, integer(options.maxSamples, DEFAULT_MAX_SAMPLES));
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  /** 每工具调用一条采样；`ok:false` 计入拒绝率。 */
  recordToolCall(input: ToolCallSample): ToolCallSample {
    const at = isoAt(input.at, this.clock());
    const wallMs = finite(input.wallMs, 0);
    const tokensIn = finite(input.tokensIn, 0);
    const tokensOut = finite(input.tokensOut, 0);
    const cost = finite(input.cost, 0);
    const attempt =
      input.attempt === null || input.attempt === undefined ? null : integer(input.attempt);
    const sample: ToolCallSample = {
      tool: String(input.tool || "unknown"),
      nodeId: input.nodeId ? String(input.nodeId) : null,
      instanceId: input.instanceId ? String(input.instanceId) : null,
      ok: Boolean(input.ok),
      errorCode: input.errorCode ? String(input.errorCode) : null,
      wallMs,
      tokensIn,
      tokensOut,
      cost,
      attempt,
      at,
      meta: safeMeta(input.meta),
    };

    // 总量
    this.totals.samples += 1;
    this.totals.calls += 1;
    this.totals.ok += sample.ok ? 1 : 0;
    this.totals.failed += sample.ok ? 0 : 1;
    this.totals.tokensIn += tokensIn;
    this.totals.tokensOut += tokensOut;
    this.totals.tokens = this.totals.tokensIn + this.totals.tokensOut;
    this.totals.cost += cost;
    this.totals.wallMs += wallMs;
    this.totals.maxWallMs = Math.max(this.totals.maxWallMs, wallMs);
    this.totals.avgWallMs = this.totals.calls ? round(this.totals.wallMs / this.totals.calls) : 0;
    this.totals.rejectionRate = ratio(
      this.totals.calls ? this.totals.failed / this.totals.calls : 0,
    );

    // 按工具
    const tool = this.toolAccOf(sample.tool);
    tool.calls += 1;
    tool.ok += sample.ok ? 1 : 0;
    tool.failed += sample.ok ? 0 : 1;
    tool.wallMs += wallMs;
    tool.tokens += tokensIn + tokensOut;
    tool.cost += cost;

    // 按节点
    if (sample.nodeId) {
      const node = this.nodeAccOf(sample.nodeId);
      node.calls += 1;
      node.ok += sample.ok ? 1 : 0;
      node.failed += sample.ok ? 0 : 1;
      node.tokensIn += tokensIn;
      node.tokensOut += tokensOut;
      node.cost += cost;
      node.wallMs += wallMs;
      node.maxWallMs = Math.max(node.maxWallMs, wallMs);
      if (attempt !== null) node.maxAttempt = Math.max(node.maxAttempt, attempt);
      if (!sample.ok) node.lastErrorCode = sample.errorCode ?? "unknown";
      node.lastAt = at;
    }

    // 有界样本缓冲（聚合不回退）
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
    this.totals.nodes = this.nodeAcc.size;
    this.totals.tools = this.toolAcc.size;
    return sample;
  }

  /** 节点级采样：补 token/成本/耗时/状态（无工具调用的节点也能可见）。 */
  recordNode(input: NodeSample): NodeMetrics | null {
    const nodeId = String(input.nodeId ?? "");
    if (!nodeId) return null;
    const at = isoAt(input.at, this.clock());
    const node = this.nodeAccOf(nodeId);
    const tokensIn = finite(input.tokensIn, 0);
    const tokensOut = finite(input.tokensOut, 0);
    const attempts = input === undefined || input.attempts === undefined
      ? null
      : integer(input.attempts);
    node.tokensIn += tokensIn;
    node.tokensOut += tokensOut;
    node.cost += finite(input.cost, 0);
    const wallMs = finite(input.wallMs, 0);
    node.wallMs += wallMs;
    node.maxWallMs = Math.max(node.maxWallMs, wallMs);
    if (attempts !== null) {
      node.maxAttempt = Math.max(node.maxAttempt, attempts);
      node.nodeAttempts = Math.max(node.nodeAttempts, attempts);
    }
    if (input.status) node.lastStatus = String(input.status);
    node.lastAt = at;

    // 节点采样同样计入 token/成本总量（否则「只有节点级 usage」的场景统计不全）
    this.totals.tokensIn += tokensIn;
    this.totals.tokensOut += tokensOut;
    this.totals.tokens = this.totals.tokensIn + this.totals.tokensOut;
    this.totals.cost += finite(input.cost, 0);
    this.totals.samples += 1;
    this.totals.nodes = this.nodeAcc.size;
    return this.nodeView(node);
  }

  /** 记录一次租约过期（累加；journal 派生也走这里）。 */
  recordLeaseExpired(count = 1): number {
    this.leaseExpiredCount += integer(count, 0);
    return this.leaseExpiredCount;
  }

  get leaseExpired(): number {
    return this.leaseExpiredCount;
  }

  /** 原始样本快照（有界；调用方不得修改内部数组）。 */
  recentSamples(limit = 20): ToolCallSample[] {
    const n = Math.max(0, integer(limit, 0));
    return n > 0 ? this.samples.slice(-n) : [...this.samples];
  }

  /** 聚合快照（纯 JSON）。 */
  snapshot(): MetricsSnapshot {
    const nodes = [...this.nodeAcc.values()]
      .map((acc) => this.nodeView(acc))
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    const byTool = [...this.toolAcc.values()]
      .map((acc) => ({
        tool: acc.tool,
        calls: acc.calls,
        ok: acc.ok,
        failed: acc.failed,
        rejectionRate: ratio(acc.calls ? acc.failed / acc.calls : 0),
        wallMs: acc.wallMs,
        avgWallMs: acc.calls ? round(acc.wallMs / acc.calls) : 0,
        tokens: acc.tokens,
        cost: round(acc.cost),
      }))
      .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
    const totals: Totals = {
      ...this.totals,
      rejectionRate: ratio(this.totals.calls ? this.totals.failed / this.totals.calls : 0),
      cost: round(this.totals.cost),
      retries: nodes.reduce((sum, node) => sum + node.retries, 0),
      nodes: nodes.length,
      tools: byTool.length,
    };
    return { totals, nodes, byTool, leaseExpired: this.leaseExpiredCount };
  }

  reset(): void {
    this.nodeAcc.clear();
    this.toolAcc.clear();
    this.samples.length = 0;
    this.leaseExpiredCount = 0;
    this.totals = emptyTotals();
  }

  private nodeAccOf(nodeId: string): NodeAcc {
    let acc = this.nodeAcc.get(nodeId);
    if (!acc) {
      acc = {
        nodeId,
        calls: 0,
        ok: 0,
        failed: 0,
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        wallMs: 0,
        maxWallMs: 0,
        maxAttempt: 0,
        nodeAttempts: 0,
        lastStatus: null,
        lastErrorCode: null,
        lastAt: null,
      };
      this.nodeAcc.set(nodeId, acc);
    }
    return acc;
  }

  private toolAccOf(tool: string): ToolAcc {
    let acc = this.toolAcc.get(tool);
    if (!acc) {
      acc = { tool, calls: 0, ok: 0, failed: 0, wallMs: 0, tokens: 0, cost: 0 };
      this.toolAcc.set(tool, acc);
    }
    return acc;
  }

  private nodeView(acc: NodeAcc): NodeMetrics {
    // 重试口径：工具采样里「第 n 次尝试」→ n-1 次重试；节点采样/journal 直接给 attempts。
    // 两个来源取 max（同一件事不重复计数）。
    const fromCalls = acc.maxAttempt > 1 ? acc.maxAttempt - 1 : 0;
    const retries = Math.max(fromCalls, acc.nodeAttempts);
    return {
      nodeId: acc.nodeId,
      calls: acc.calls,
      ok: acc.ok,
      failed: acc.failed,
      tokensIn: acc.tokensIn,
      tokensOut: acc.tokensOut,
      tokens: acc.tokensIn + acc.tokensOut,
      cost: round(acc.cost),
      wallMs: acc.wallMs,
      avgWallMs: acc.calls ? round(acc.wallMs / acc.calls) : 0,
      maxWallMs: acc.maxWallMs,
      retries,
      lastStatus: acc.lastStatus,
      lastErrorCode: acc.lastErrorCode,
      lastAt: acc.lastAt,
    };
  }
}

export function createMetrics(options: MetricsOptions = {}): Metrics {
  return new Metrics(options);
}

function round(value: number): number {
  return Math.round(finite(value, 0) * 1_000_000) / 1_000_000;
}

function emptyTotals(): Totals {
  return {
    samples: 0,
    calls: 0,
    ok: 0,
    failed: 0,
    rejectionRate: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokens: 0,
    cost: 0,
    wallMs: 0,
    avgWallMs: 0,
    maxWallMs: 0,
    retries: 0,
    nodes: 0,
    tools: 0,
  };
}
