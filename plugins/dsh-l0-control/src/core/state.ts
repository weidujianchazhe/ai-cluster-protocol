/**
 * 集群状态（ClusterState）——集群醒来时读的那一份东西。
 *
 * 定位：**服务集群，不是服务人。**
 * 它不是报告，是"新分支进入时能直接吃进去的状态"。
 * 判断标准：短到能塞进上下文，密到不用追问。
 *
 * 核心约束：**每条断言必须带来源引用与证据等级。**
 * cluster state 本身是「relation through a stale span」——某个时刻的理解，不是恒真的事实。
 * 没有 source 的断言一律不生成，否则下一个分支会把它当成事实。
 *
 * 更新策略：**标记便宜、生成按需。**
 * 状态变更时只推进 journal seq（免费），真正生成时比对 seq 判断是否过期。
 */
import type { Store } from "./store.ts";
import type { NodeRecord } from "./types.ts";
import { digestAll } from "./digest.ts";
import { runFacets, type FacetDigest } from "./facets.ts";
import { detectConflicts, routeConflicts, type Conflict, type RouteContext } from "./conflict.ts";
import { readySet } from "./ready.ts";

export type ClaimEvidence = "verified" | "inferred" | "assumed";

export interface StateClaim {
  text: string;
  evidence: ClaimEvidence;
  /** 指向原始记录：journal 事件 / 节点 / 冲突 / 视角 */
  source: { kind: "journal" | "node" | "conflict" | "facet" | "meta"; ref: string };
}

export interface NextAction {
  action: string;
  reason: string;
  source: string;
}

export interface ClusterState {
  goal: string;
  phase: string;
  asOf: string;
  /** 基于哪个 journal 序号生成——用于判断是否过期 */
  basedOnSeq: number;
  claims: StateClaim[];
  facets: FacetDigest[];
  conflicts: Conflict[];
  next: NextAction[];
  cost: { journalEvents: number; nodes: number };
  /** 本状态的字符量（进入成本） */
  chars: number;
  /** 是否已落后于 journal（调用方决定是否重生成） */
  stale: boolean;
}

const META_KEY = "cluster_state_seq";

/** 上次生成时基于的 journal 序号；没生成过返回 0。 */
export function lastStateSeq(store: Store): number {
  const raw = store.state.meta.get(META_KEY);
  const n = Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** 标记一次生成（便宜：只是写一个序号）。 */
export function markStateBuilt(store: Store, seq: number): void {
  store.state.meta.set(META_KEY, String(seq));
}

/** 是否过期：journal 向前走了，状态就该重生成。 */
export function isStateStale(store: Store): boolean {
  return store.journal.count() > lastStateSeq(store);
}

function pickGoal(store: Store): string {
  const candidates = [
    store.state.meta.get("wish"),
    store.state.meta.get("goal"),
  ];
  for (const c of candidates) {
    const s = String(c ?? "").trim();
    if (s) return s;
  }
  // 退化到最近一次 wish_submitted 事件
  // 注：Journal 实际没有 `read()`（只有 `all()`），所以这里运行时恒等于 `[]`，
  // 目标只会来自 meta。类型按现状写实：用断言描述「可能存在的 read」，不改运行时。
  try {
    const journal = store.journal as unknown as { read?: () => unknown[] };
    const events = journal.read?.() ?? [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i] as { kind?: string; wish?: string };
      if (e?.kind === "wish_submitted" && e.wish) return String(e.wish);
    }
  } catch {
    /* journal 不可读时保持空 */
  }
  return "(未声明目标)";
}

function computePhase(nodes: readonly NodeRecord[]): string {
  if (nodes.length === 0) return "空图";
  const total = nodes.length;
  const done = nodes.filter((n) => n.status === "done" || n.status === "accepted").length;
  const active = nodes.filter((n) => ["claimed", "running", "submitted", "verifying"].includes(n.status)).length;
  const blocked = nodes.filter((n) => n.status === "blocked").length;
  const stages = new Map<string, number>();
  for (const n of nodes) {
    if (!n.stage) continue;
    stages.set(n.stage, (stages.get(n.stage) ?? 0) + 1);
  }
  const stageDesc = [...stages.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "无阶段";
  const pct = Math.round((done / total) * 100);
  const bits = [`${done}/${total} 完成（${pct}%）`];
  if (active) bits.push(`${active} 在跑`);
  if (blocked) bits.push(`${blocked} 阻塞`);
  return `${stageDesc}｜${bits.join("，")}`;
}

/**
 * 生成集群状态。
 *
 * routeCtx 由调用方提供（图内已有能力 + 目录可拉能力）；
 * 缺省时冲突一律标为 unresolved，不做猜测。
 */
export function buildClusterState(
  store: Store,
  options: { routeCtx?: RouteContext } = {},
): ClusterState {
  const nodes = [...store.state.nodes.values()];
  const digests = digestAll(nodes);
  const goal = pickGoal(store);
  const facetRun = runFacets(digests, goal);

  const conflicts = detectConflicts([...facetRun.static, ...facetRun.dynamic], digests);
  const routed = routeConflicts(
    conflicts,
    options.routeCtx ?? { availableCapabilities: new Map(), catalogCapabilities: [] },
  );

  // ── 断言池：每条都必须能指回原始记录 ──
  const claims: StateClaim[] = [];

  claims.push({
    text: `目标：${goal}`,
    evidence: goal === "(未声明目标)" ? "assumed" : "verified",
    source: { kind: "meta", ref: "wish" },
  });

  claims.push({
    text: `规模：${nodes.length} 个节点，${store.journal.count()} 条事件`,
    evidence: "verified",
    source: { kind: "journal", ref: `seq:${store.journal.count()}` },
  });

  // 视角里值得进状态的只有"有问题"的那些，正常的不占字符
  for (const f of [...facetRun.static, ...facetRun.dynamic]) {
    if (f.notes.length === 0) continue;
    claims.push({
      text: `${f.facetId}：${f.notes.join("；")}`,
      evidence: "inferred",
      source: { kind: "facet", ref: f.facetId },
    });
  }

  // 未解决冲突单独成条，带路由结果
  for (const c of routed.slice(0, 5)) {
    claims.push({
      text: `冲突 ${c.id}（${c.type}）：${c.subject} → ${c.route}${c.routedTo ? `(${c.routedTo})` : ""}`,
      evidence: "inferred",
      source: { kind: "conflict", ref: c.id },
    });
  }

  // ── 下一步：从 ready + 冲突派生，每条带理由 ──
  const next: NextAction[] = [];
  const ready = readySet(store);
  const readyNodes = ready
    .map((id) => store.state.nodes.get(id))
    .filter((n): n is NodeRecord => Boolean(n))
    .slice(0, 3);
  for (const n of readyNodes) {
    next.push({
      action: `推进 ${n.node_id}（${n.capability ?? "无标签"}）`,
      reason: "依赖已完成且无阻塞",
      source: `node:${n.node_id}`,
    });
  }
  for (const c of routed.filter((x) => x.route === "human").slice(0, 2)) {
    next.push({
      action: `需要人：${c.subject}`,
      reason: c.reason,
      source: `conflict:${c.id}`,
    });
  }
  if (next.length === 0) {
    next.push({ action: "无待办", reason: "没有 ready 节点，也没有需要人的冲突", source: "readySet" });
  }

  const state: ClusterState = {
    goal,
    phase: computePhase(nodes),
    asOf: new Date().toISOString(),
    basedOnSeq: store.journal.count(),
    claims,
    facets: [...facetRun.static, ...facetRun.dynamic],
    conflicts: routed,
    next,
    cost: { journalEvents: store.journal.count(), nodes: nodes.length },
    chars: 0,
    stale: false,
  };

  // 进入成本：整份状态的字符量（不含 facets 明细，那是按需才展开的）
  state.chars =
    state.goal.length +
    state.phase.length +
    state.claims.reduce((s, c) => s + c.text.length + 20, 0) +
    state.next.reduce((s, n) => s + n.action.length + n.reason.length + 20, 0) +
    120;
  return state;
}

/** 供上下文注入用的紧凑文本（不含 facets 明细，只留结论）。 */
export function renderStateForContext(state: ClusterState): string {
  const lines = [
    `【集群状态 ${state.asOf}】基于事件 ${state.basedOnSeq}`,
    `目标：${state.goal}`,
    `进度：${state.phase}`,
    "",
    "正在发生的问题：",
    ...(state.claims.length > 2 ? state.claims.slice(2).map((c) => `- ${c.text} [${c.evidence}]`) : ["- （无）"]),
    "",
    "下一步：",
    ...state.next.map((n) => `- ${n.action}｜${n.reason}`),
    "",
    `成本：${state.cost.nodes} 节点 / ${state.cost.journalEvents} 事件｜本状态 ${state.chars} 字符`,
  ];
  return lines.join("\n");
}
