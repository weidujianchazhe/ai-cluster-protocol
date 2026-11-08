/**
 * 派活循环（dispatcher）。
 *
 * 模式由用户选择，默认**不激活**：
 *   off        —— 完全不跑（默认），图只能靠人手动 task_next / task_claim
 *   interval   —— 定时跑：每隔 intervalMs 跑一次 tick
 *   resident   —— 常驻跑：跑完立刻排下一次（仍受 maxPerTick 与冷却约束）
 *
 * 本文件只做**纯逻辑**：给定 store 与选项，算出一轮该派谁、为什么跳过谁。
 * 定时器、配置读取、与宿主生命周期的绑定都在上层（service/index），
 * 这样 tick 可以在测试里被完整驱动，不需要真的等待时间。
 */
import type { Store } from "./store.ts";
import type { NodeRecord } from "./types.ts";
import { readySet } from "./ready.ts";
import { runFactorGuards, type GuardFinding } from "./guards.ts";

export type DispatchMode = "off" | "interval" | "resident";

export interface DispatchOptions {
  mode: DispatchMode;
  /** interval 模式的间隔（毫秒）；resident 模式下作为最小冷却 */
  intervalMs: number;
  /** 单轮最多派几个节点，防止一次把并行度打满 */
  maxPerTick: number;
  /** true 时只出计划不实际派活（默认 true，安全） */
  dryRun: boolean;
  /** 派活时使用的实例 ID */
  dispatcherInstance: string;
  /** 注入时钟，便于测试 */
  nowMs: number;
}

export const DEFAULT_DISPATCH_OPTIONS: Omit<DispatchOptions, "nowMs"> = {
  mode: "off",
  intervalMs: 5 * 60 * 1000,
  maxPerTick: 3,
  dryRun: true,
  dispatcherInstance: "ROLE-DISPATCH-01",
};

export interface DispatchPlanItem {
  nodeId: string;
  capability: string | null;
  /** dispatch=会派；skip=本轮跳过（含原因）；would-dispatch=dryRun 下的会派 */
  action: "dispatch" | "would-dispatch" | "skip";
  reason: string;
}

export interface DispatchTickResult {
  mode: DispatchMode;
  /** 本轮看到就绪的节点 */
  ready: string[];
  /** ready 数量（冗余计数，方便调用方只读计数不遍历列表） */
  readyCount: number;
  plan: DispatchPlanItem[];
  /** critical 级巡检发现（会阻塞对应节点的派活） */
  blocking: GuardFinding[];
  /** 实际会派（或 dryRun 下本会派）的节点 ID */
  willDispatch: string[];
  /** 人类可读的一行摘要 */
  summary: string;
  /** 给调用方/人的提示：off 模式下为何没派、该怎么做 */
  hint?: string;
}

/** 同一节点被这些 critical finding 命中时，本轮不派——先让人看一眼。 */
const BLOCKING_CHECKS = new Set([
  "stalled",
  "unsatisfied-while-active",
  "gate-not-passed",
]);

function nodeCapability(node: NodeRecord): string | null {
  return node.capability ?? null;
}

/**
 * 跑一轮派活计划。
 *
 * 只读 store；不会调用 claim。是否真的派活由调用方根据 `willDispatch` 决定，
 * 因此这个函数在 off 模式、dryRun 模式、正式模式下都是安全的。
 */
export function planDispatchTick(store: Store, options: DispatchOptions): DispatchTickResult {
  if (options.mode === "off") {
    // P1-10：off 也不派活，但返回 ready 计数与 hint（只读统计，不 claim、不写 journal）。
    // dryRun/would-dispatch 语义不变：off 下 plan 为空、willDispatch 为空。
    const ready = readySet(store);
    return {
      mode: "off",
      ready,
      readyCount: ready.length,
      plan: [],
      blocking: [],
      willDispatch: [],
      summary: `派活循环未激活（mode=off）；就绪 ${ready.length}，未派活`,
      hint: ready.length
        ? `mode=off 下不派活；${ready.length} 个节点就绪，可手动 task_next/task_claim，或用 dispatch 工具切换为 interval/resident`
        : "mode=off 下不派活；当前无就绪节点，需要时用 dispatch 工具切换为 interval/resident",
    };
  }

  const guardReport = runFactorGuards({ store, nowMs: options.nowMs });
  const blocking = guardReport.findings.filter(
    (f) => f.severity === "critical" && BLOCKING_CHECKS.has(f.check),
  );
  const blockedNodes = new Set(blocking.map((f) => f.nodeId));

  const ready = readySet(store);
  const plan: DispatchPlanItem[] = [];
  const candidates: string[] = [];

  for (const nodeId of ready) {
    const node = store.state.nodes.get(nodeId);
    if (!node) continue;
    if (blockedNodes.has(nodeId)) {
      const why = blocking.find((f) => f.nodeId === nodeId);
      plan.push({
        nodeId,
        capability: nodeCapability(node),
        action: "skip",
        reason: `巡检拦截：${why?.check ?? "critical"} — ${why?.message ?? ""}`.trim(),
      });
      continue;
    }
    if (candidates.length >= options.maxPerTick) {
      plan.push({
        nodeId,
        capability: nodeCapability(node),
        action: "skip",
        reason: `本轮已达上限 maxPerTick=${options.maxPerTick}`,
      });
      continue;
    }
    candidates.push(nodeId);
    plan.push({
      nodeId,
      capability: nodeCapability(node),
      action: options.dryRun ? "would-dispatch" : "dispatch",
      reason: options.dryRun ? "dryRun：只出计划，不实际派活" : "就绪且无阻塞",
    });
  }

  const willDispatch = candidates;
  const summary = options.dryRun
    ? `[dryRun] 就绪 ${ready.length}，本轮可派 ${willDispatch.length}，拦截 ${blockedNodes.size}`
    : `就绪 ${ready.length}，本轮派 ${willDispatch.length}，拦截 ${blockedNodes.size}`;

  return { mode: options.mode, ready, readyCount: ready.length, plan, blocking, willDispatch, summary };
}

/** 从宿主配置里读派活选项，做取值收敛（非法值一律回落到默认）。 */
export function normalizeDispatchOptions(raw: Partial<DispatchOptions> | undefined, nowMs: number): DispatchOptions {
  const mode = raw?.mode;
  const safeMode: DispatchMode = mode === "interval" || mode === "resident" ? mode : "off";
  const intervalMs = Number(raw?.intervalMs);
  const maxPerTick = Number(raw?.maxPerTick);
  return {
    mode: safeMode,
    intervalMs: Number.isFinite(intervalMs) && intervalMs >= 30_000 ? intervalMs : DEFAULT_DISPATCH_OPTIONS.intervalMs,
    maxPerTick: Number.isFinite(maxPerTick) && maxPerTick >= 1 ? Math.min(maxPerTick, 32) : DEFAULT_DISPATCH_OPTIONS.maxPerTick,
    // 默认按 dryRun 处理：只有显式 false 才真的派活
    dryRun: raw?.dryRun !== false,
    dispatcherInstance: raw?.dispatcherInstance || DEFAULT_DISPATCH_OPTIONS.dispatcherInstance,
    nowMs,
  };
}
