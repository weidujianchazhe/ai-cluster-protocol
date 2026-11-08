/**
 * 能力目录（capability catalog）与按需装配。
 *
 * 解决的问题（用户原话）：
 *   "按需生成我们需要的能力，不会因为能力过大而对小项目产生负担；
 *    也不会因为项目刚开始需要的能力不多、后面变大时因能力不足而做不好。"
 *
 * 做法：把「一种能力」声明成「一组节点 + 何时需要它」。
 *  - 能力本身是静态目录（谁能被装、装出来长什么样）；
 *  - **是否需要**由图的事实（GraphFacts）判断，不由人拍脑袋。
 *
 * 关键设计：**巡检/审计也是图上的节点**，不是外挂服务。
 * 因此它们同样被验收、被依赖、被记录——容量小的时候不生成，
 * 变大时自动被提议加进来。
 */
import type { Stage } from "./types.ts";

export interface GraphFacts {
  /** 现有节点数（不含本轮要加的能力节点） */
  nodeCount: number;
  /** 是否出现 deliver 阶段节点 */
  hasDeliverStage: boolean;
  /** 是否有节点会触碰外部系统（写仓库、发消息、调第三方） */
  hasExternalWrites: boolean;
  /** 是否声明了 token 预算 */
  hasBudgetDeclared: boolean;
  /** 图里出现过几个不同的 stage */
  stageCount: number;
  /** 最大并发 */
  maxParallel: number;
}

/** 由节点列表算出图的事实，供能力选择使用。 */
export function deriveFacts(nodes: ReadonlyArray<{ stage?: Stage | null; budget?: Record<string, unknown>; writeScopes?: string[] }>): GraphFacts {
  const stageSet = new Set<string>();
  let hasDeliverStage = false;
  let hasBudgetDeclared = false;
  let hasExternalWrites = false;
  for (const node of nodes) {
    if (node.stage) {
      stageSet.add(node.stage);
      if (node.stage === "deliver") hasDeliverStage = true;
    }
    const maxTokens = Number((node.budget as Record<string, unknown> | undefined)?.maxTokens ?? 0);
    if (Number.isFinite(maxTokens) && maxTokens > 0) hasBudgetDeclared = true;
    if (Array.isArray(node.writeScopes) && node.writeScopes.length > 0) hasExternalWrites = true;
  }
  return {
    nodeCount: nodes.length,
    hasDeliverStage,
    hasExternalWrites,
    hasBudgetDeclared,
    stageCount: stageSet.size,
    maxParallel: 0,
  };
}

export interface CapabilitySeed {
  nodeId: string;
  title: string;
  spec: string;
  capability: string;
  stage: Stage;
  deps: string[];
  evidenceRequired: string[];
  verifierIds: string[];
  acceptance: { kind: string; expected?: unknown };
}

export interface Capability {
  id: string;
  /** 人类可读的用途 */
  title: string;
  /** 这个能力会往图里加几个节点（写清成本，避免"能力过大压垮小项目"） */
  cost: { nodes: number; note: string };
  /** 何时需要它——纯函数，可测 */
  requires: (facts: GraphFacts) => boolean;
  /** 生成节点；depIds 是现有图的叶子节点（作为依赖挂点） */
  build: (facts: GraphFacts, anchorIds: string[]) => CapabilitySeed[];
}

/** 锚点：新能力的上游依赖挂在这些节点之后。 */
function pickAnchors(anchorIds: string[]): string[] {
  return anchorIds.length > 0 ? anchorIds : [];
}

export const CAPABILITIES_CATALOG: readonly Capability[] = [
  {
    id: "audit",
    title: "独立审计",
    cost: { nodes: 1, note: "一个审计节点；生产与审计必须是不同实例，故只能在执行侧 1 个" },
    requires: (f) => f.nodeCount >= 8 || f.hasDeliverStage,
    build: (f, anchors) => [
      {
        nodeId: "CAP-AUDIT",
        title: "独立审计",
        spec: "对执行侧产物做独立复核：检查证据是否覆盖必需类型、来源是否为 verified、是否存在绕过闸门的迹象。审计实例不得与生产实例相同。",
        capability: "AUDIT_CODE",
        stage: "audit",
        deps: pickAnchors(anchors),
        evidenceRequired: ["artifact"],
        verifierIds: ["verifier-ci"],
        acceptance: { kind: "exists", expected: "audit-report.md" },
      },
    ],
  },
  {
    id: "watch",
    title: "巡检",
    cost: { nodes: 1, note: "一个只读巡检节点；不执行、不改状态，只产出 findings" },
    // 小图不需要巡检：人自己看两眼就够；大图或触碰外部才开始值得
    requires: (f) => f.nodeCount >= 15 || f.hasExternalWrites,
    build: (f, anchors) => [
      {
        nodeId: "CAP-WATCH",
        title: "集群巡检",
        spec: "对工作图跑组成因子巡检（status/stalled、deps/unsatisfied、attempts/exceeded、assignee/lease-mismatch 等），输出 findings 报告。只读，不派活、不改状态。",
        capability: "OBS",
        stage: "audit",
        deps: pickAnchors(anchors),
        evidenceRequired: ["artifact"],
        verifierIds: ["verifier-ci"],
        acceptance: { kind: "exists", expected: "watch-report.md" },
      },
    ],
  },
  {
    id: "meter",
    title: "计量对账",
    cost: { nodes: 1, note: "一个对账节点；仅在声明预算时才值得" },
    requires: (f) => f.hasBudgetDeclared,
    build: (f, anchors) => [
      {
        nodeId: "CAP-METER",
        title: "预算与计量对账",
        spec: "核对各节点声明的预算与实际消耗，标记超支或未接入计量的节点。",
        capability: "OBS",
        stage: "deliver",
        deps: pickAnchors(anchors),
        evidenceRequired: ["artifact"],
        verifierIds: ["verifier-ci"],
        acceptance: { kind: "exists", expected: "meter-report.md" },
      },
    ],
  },
  {
    id: "gate-chain",
    title: "阶段闸门链",
    cost: { nodes: 1, note: "一个汇总节点；只在跨 3 个以上阶段时才需要" },
    requires: (f) => f.stageCount >= 3,
    build: (f, anchors) => [
      {
        nodeId: "CAP-GATE",
        title: "阶段闸门汇总",
        spec: "核对 research/design/build/audit/deliver 各阶段闸门是否按序通过，任何跳阶段都记一条违规。",
        capability: "ORCH",
        stage: "deliver",
        deps: pickAnchors(anchors),
        evidenceRequired: ["artifact"],
        verifierIds: ["verifier-ci"],
        acceptance: { kind: "exists", expected: "gate-report.md" },
      },
    ],
  },
];

export interface SelectionResult {
  /** 被选中的能力（含理由） */
  selected: Array<{ id: string; title: string; reason: string; nodes: number }>;
  /** 被排除的能力（含为什么不需要） */
  skipped: Array<{ id: string; title: string; reason: string }>;
  /** 汇总成本 */
  cost: { nodes: number };
}

function explain(f: GraphFacts, cap: Capability): { ok: boolean; reason: string } {
  const hit = cap.requires(f);
  if (hit) {
    const why: string[] = [];
    if (cap.id === "audit") why.push(f.hasDeliverStage ? "有 deliver 阶段" : `节点数 ${f.nodeCount} ≥ 8`);
    if (cap.id === "watch") why.push(f.hasExternalWrites ? "存在外部写入" : `节点数 ${f.nodeCount} ≥ 15`);
    if (cap.id === "meter") why.push("声明了 token 预算");
    if (cap.id === "gate-chain") why.push(`跨越 ${f.stageCount} 个阶段`);
    return { ok: true, reason: why.join("；") || "满足条件" };
  }
  const whyNot: string[] = [];
  if (cap.id === "audit") whyNot.push(`节点数 ${f.nodeCount} < 8 且无 deliver 阶段`);
  if (cap.id === "watch") whyNot.push(`节点数 ${f.nodeCount} < 15 且无外部写入`);
  if (cap.id === "meter") whyNot.push("未声明 token 预算");
  if (cap.id === "gate-chain") whyNot.push(`只跨 ${f.stageCount} 个阶段 < 3`);
  return { ok: false, reason: whyNot.join("；") || "不满足条件" };
}

/**
 * 按图的事实选择能力。
 *
 * 只做**建议**，不改图——是否采纳由调用方决定（graph_commit 的 capabilities 参数）。
 * 这样"能力过大压垮小项目"与"项目变大后能力不足"都能被同一条规则处理。
 */
export function selectCapabilities(facts: GraphFacts): SelectionResult {
  const selected: SelectionResult["selected"] = [];
  const skipped: SelectionResult["skipped"] = [];
  for (const cap of CAPABILITIES_CATALOG) {
    const { ok, reason } = explain(facts, cap);
    if (ok) selected.push({ id: cap.id, title: cap.title, reason, nodes: cap.cost.nodes });
    else skipped.push({ id: cap.id, title: cap.title, reason });
  }
  const nodes = selected.reduce((sum, s) => sum + s.nodes, 0);
  return { selected, skipped, cost: { nodes } };
}

/** 把选中的能力展开成节点（供 graph_commit 使用）。 */
export function materializeCapabilities(ids: readonly string[], facts: GraphFacts, anchorIds: string[] = []): CapabilitySeed[] {
  const out: CapabilitySeed[] = [];
  for (const cap of CAPABILITIES_CATALOG) {
    if (!ids.includes(cap.id)) continue;
    if (!cap.requires(facts)) continue; // 不满足条件的忽略，防止误装
    out.push(...cap.build(facts, anchorIds));
  }
  return out;
}
