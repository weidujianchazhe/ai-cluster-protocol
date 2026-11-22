/**
 * 组织审查（Organization Review）——协调闭环的**第 0 阶段：只读观测**。
 *
 * 定位（用户设计）：**组织能力落在「组成因子 + 运行流程」上，不落在常驻经理 Agent 上。**
 * 协调器是确定性控制面服务，这里只做三件事：**读图 → 分类 → 出待办**。
 * 不派活、不改图、不裁决。任何图变更必须显式走 `replan`（带 `graph_version` CAS）；
 * 语义裁决走临时协调/审计节点或人类，不由本模块给结论。
 *
 * 确定性：除 `generatedAt` 外，报告完全由 state 决定；`fingerprint` 是对确定性部分的
 * sha256——同一 journal 重放出同一 fingerprint。这是「能发现、能形成待办、能回放」的机器判据。
 *
 * 边界（写在这里，避免下一轮把它读成"全知管理器"）：
 *   - `signals` 是**发现**，不是裁决；`facet 有一条 note` ≠ `冲突已裁决`。
 *   - `proposals` 是**草案**，`replanDraft` 里刻意不含 `expectedGraphVersion`：
 *     采纳者必须自己读当前版本并带上，旧草案不得覆盖新图。
 *   - 没有承接能力时状态是 `capability-gap`，不静默回退到 CODE 或任意默认角色。
 */
import { createHash } from "node:crypto";
import type { Store } from "./store.ts";
import type { NodeRecord } from "./types.ts";
import type { Conflict, RouteContext } from "./conflict.ts";
import { summarizeRouting } from "./conflict.ts";
import { CAPABILITIES_CATALOG } from "./catalog.ts";
import { currentGraphVersion } from "./replan.ts";
import { buildClusterState, renderStateForContext } from "./state.ts";
import type { ClusterState, NextAction } from "./state.ts";

export type OrganizationSignalKind =
  | "integration-contract"
  | "conflict-routing"
  | "capability-gap"
  | "write-scope-overlap"
  | "human-decision";

/** 谁该处理这条信号。`rule` 是确定性校验器（不进图）。 */
export type SignalOwner = "rule" | "agent" | "human" | "capability";

export interface OrganizationSignal {
  kind: OrganizationSignalKind;
  id: string;
  subject: string;
  owner: SignalOwner;
  detail: string;
  /** 相关节点（可点回图） */
  nodes: string[];
  /** 必须改图才能推进（否则只是等/派/问） */
  requiresGraphChange: boolean;
  /** 依据：`node:X` / `conflict:CF-1` / `integration:IC-1` / `seq:N` */
  basis: string[];
}

export interface CoordinationProposal {
  id: string;
  kind:
    | "add-integration-node"
    | "add-coordination-node"
    | "rewire-deps"
    | "pull-capability"
    | "escalate-human"
    | "wait";
  reason: string;
  /**
   * 可直接交给 `graph_replan` 的草案。刻意**不含** `expectedGraphVersion`：
   * 采纳者必须自己读当前 graph_version 并带上（防旧草案覆盖新图）。
   */
  replanDraft: Record<string, unknown> | null;
  /** 语义裁决/高风险改图：需要人或独立实例确认，不允许协调器自行落图 */
  requiresConfirmation: boolean;
  basis: string[];
}

export interface OrganizationReview {
  ok: boolean;
  readOnly: true;
  generatedAt: string;
  graphVersion: number;
  basedOnSeq: number;
  goal: string;
  phase: string;
  /** 确定性部分的 sha256：同一 journal → 同一 fingerprint */
  fingerprint: string;
  organization: {
    contracts: ClusterState["integration"];
    summary: { total: number; waitingMembers: number; readyForIntegration: number; integrated: number };
  };
  conflicts: {
    total: number;
    byRoute: Record<string, number>;
    forHuman: Array<{ id: string; subject: string; type: string; needs: string[]; reason: string }>;
    capabilityGaps: string[];
    items: Conflict[];
  };
  signals: OrganizationSignal[];
  proposals: CoordinationProposal[];
  next: NextAction[];
  /** 进入成本：报告渲染成上下文要多少字符 */
  cost: { chars: number; approxTokens: number };
  /** 明确写出本报告的边界，避免被当成裁决 */
  boundary: string[];
}

/** 从图内节点建路由上下文：能承接的标签 → 节点；目录可拉的 → 能力 id。 */
export function routeContextOf(store: Store): RouteContext {
  const availableCapabilities = new Map<string, string[]>();
  for (const node of store.state.nodes.values()) {
    const capability = String(node.capability ?? "").trim();
    if (!capability) continue;
    const owners = availableCapabilities.get(capability) ?? [];
    owners.push(node.node_id);
    availableCapabilities.set(capability, owners);
  }
  return { availableCapabilities, catalogCapabilities: CAPABILITIES_CATALOG.map((item) => item.id) };
}

const TERMINAL = new Set(["done", "accepted"]);

function isTerminal(node: NodeRecord): boolean {
  return TERMINAL.has(node.status);
}

function writeScopesOf(node: NodeRecord): string[] {
  const raw = (node.budget ?? {}) as { writeScopes?: unknown };
  if (!Array.isArray(raw.writeScopes)) return [];
  return raw.writeScopes.map((item) => String(item)).filter((item) => item.trim().length > 0);
}

/** 两个写域前缀是否可能重叠（任一方向前缀包含即算）。 */
function scopesOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const left = norm(a);
  const right = norm(b);
  if (!left || !right) return false;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

interface ScopeCollision {
  left: string;
  right: string;
  scopes: string[];
}

/** 并行（都未终态）且写域前缀重叠 → 预防型冲突信号。 */
function findScopeCollisions(nodes: readonly NodeRecord[]): ScopeCollision[] {
  const live = nodes.filter((node) => !isTerminal(node)).map((node) => ({ node, scopes: writeScopesOf(node) }));
  const active = live.filter((item) => item.scopes.length > 0);
  const out: ScopeCollision[] = [];
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const left = active[i]!;
      const right = active[j]!;
      const hits: string[] = [];
      for (const a of left.scopes) {
        for (const b of right.scopes) {
          if (scopesOverlap(a, b)) hits.push(a === b ? a : `${a} ~ ${b}`);
        }
      }
      if (hits.length === 0) continue;
      out.push({ left: left.node.node_id, right: right.node.node_id, scopes: [...new Set(hits)] });
    }
  }
  return out;
}

type StableCore = Omit<OrganizationReview, "fingerprint" | "generatedAt" | "cost" | "readOnly" | "ok">;

/**
 * 取报告里「只由 state 决定」的部分做规范化投影，供 fingerprint 使用。
 *
 * 入参用 `unknown` 是有意的：这一步是「压成可哈希的稳定形状」，
 * 类型收窄进函数体（`as StableCore`）就够了；把签名写成 `StableCore`
 * 会让调用点的字面量推断参与检查，报错信息只落在调用行、与真正差异无关。
 */
function stableCore(input: unknown): unknown {
  const review = input as StableCore;
  return {
    graphVersion: review.graphVersion,
    basedOnSeq: review.basedOnSeq,
    goal: review.goal,
    phase: review.phase,
    organization: review.organization,
    conflicts: {
      total: review.conflicts.total,
      byRoute: review.conflicts.byRoute,
      forHuman: review.conflicts.forHuman,
      capabilityGaps: review.conflicts.capabilityGaps,
      items: review.conflicts.items.map((item) => ({
        id: item.id,
        subject: item.subject,
        type: item.type,
        needs: item.needs,
        route: item.route,
        routedTo: item.routedTo ?? null,
        reason: item.reason,
      })),
    },
    signals: review.signals,
    proposals: review.proposals,
    next: review.next,
  };
}

/**
 * 生成组织审查报告。**只读**：不写 journal、不改图、不派活。
 *
 * `generatedAt` 可注入（测试/重放），除此之外输出只由 state 决定。
 */
export function organizationReview(
  store: Store,
  options: { routeCtx?: RouteContext; generatedAt?: string } = {},
): OrganizationReview {
  const generatedAt = options.generatedAt ?? store.nowIso();
  const routeCtx = options.routeCtx ?? routeContextOf(store);
  const state = buildClusterState(store, { routeCtx });
  const nodes = [...store.state.nodes.values()];
  const routed = summarizeRouting(state.conflicts);

  // ── 信号：集成契约 ──
  const signals: OrganizationSignal[] = [];
  for (const contract of state.integration) {
    const basis = [`integration:${contract.contractId}`, `node:${contract.integrationNode}`];
    if (contract.status === "waiting-members") {
      signals.push({
        kind: "integration-contract",
        id: `ORG-IC-${contract.contractId}`,
        subject: `集成契约 ${contract.contractId} 成员未完成`,
        owner: "agent",
        detail: `未完成成员：${contract.missingMembers.join(", ")}；契约：${contract.contract}`,
        nodes: [...contract.missingMembers, contract.integrationNode],
        requiresGraphChange: false,
        basis,
      });
    } else if (contract.status === "ready-for-integration") {
      const inGraph = store.state.nodes.has(contract.integrationNode);
      signals.push({
        kind: "integration-contract",
        id: `ORG-IC-${contract.contractId}`,
        subject: inGraph
          ? `集成节点 ${contract.integrationNode} 可运行`
          : `集成节点 ${contract.integrationNode} 不在图中`,
        owner: inGraph ? "agent" : "rule",
        detail: inGraph
          ? `成员已完成，按契约验收：${contract.acceptance.join("；") || "(未给验收条目)"}`
          : `契约指定的集成节点不在当前图内；必须显式 replan 添加，不能静默忽略。`,
        nodes: [contract.integrationNode],
        requiresGraphChange: !inGraph,
        basis,
      });
    }
  }

  // ── 信号：冲突路由 + 能力缺口 + 人类裁决 ──
  for (const conflict of state.conflicts) {
    const isGap = conflict.route === "human" && conflict.reason.startsWith("集群缺口");
    const needsHuman = conflict.needs.some((need) => need === "human-experience" || need === "human-value");
    const kind: OrganizationSignalKind = isGap ? "capability-gap" : needsHuman ? "human-decision" : "conflict-routing";
    const owner: SignalOwner = isGap ? "capability" : conflict.route === "agent" ? "agent" : "human";
    signals.push({
      kind,
      id: `ORG-${conflict.id}`,
      subject: conflict.subject,
      owner,
      detail: conflict.reason || "路由未给出理由",
      nodes: [],
      requiresGraphChange: false,
      basis: [`conflict:${conflict.id}`, ...conflict.needs.map((need) => `need:${need}`)],
    });
  }

  // ── 信号：并行写域重叠（预防型） ──
  // 注意：`writeScopes` 目前是**声明**，不是文件锁；本信号只报告，不阻止并行。
  for (const collision of findScopeCollisions(nodes)) {
    signals.push({
      kind: "write-scope-overlap",
      id: `ORG-WS-${collision.left}-${collision.right}`,
      subject: `${collision.left} 与 ${collision.right} 写域重叠`,
      owner: "agent",
      detail: `重叠写域：${collision.scopes.join(", ")}；两者都未终态。建议先约定接口/所有权，或串行化重叠范围。writeScopes 只是声明，不构成文件锁。`,
      nodes: [collision.left, collision.right],
      requiresGraphChange: false,
      basis: [`node:${collision.left}`, `node:${collision.right}`, "meta:writeScopes"],
    });
  }

  // ── 提案：草案，不自动落图 ──
  const proposals: CoordinationProposal[] = [];
  for (const contract of state.integration) {
    const inGraph = store.state.nodes.has(contract.integrationNode);
    if (contract.status === "ready-for-integration" && !inGraph) {
      proposals.push({
        id: `PROP-IC-${contract.contractId}`,
        kind: "add-integration-node",
        reason: `契约 ${contract.contractId} 的成员已完成，但集成节点 ${contract.integrationNode} 不在图内`,
        replanDraft: {
          reason: "coordination",
          add: [
            {
              nodeId: contract.integrationNode,
              title: `集成：${contract.contractId}`,
              spec: contract.contract,
              stage: "build",
              deps: [...contract.members],
              evidenceRequired: ["artifact"],
              verifierIds: ["verifier-ci"],
            },
          ],
          note: `按集成契约 ${contract.contractId} 补集成节点`,
        },
        requiresConfirmation: true,
        basis: [`integration:${contract.contractId}`],
      });
    }
  }
  for (const signal of signals) {
    if (signal.kind === "capability-gap") {
      proposals.push({
        id: `PROP-GAP-${signal.id}`,
        kind: "pull-capability",
        reason: `没有任何节点或目录项能承接该冲突所需能力：${signal.basis.filter((item) => item.startsWith("need:")).map((item) => item.slice(5)).join("/")}`,
        replanDraft: null,
        requiresConfirmation: true,
        basis: signal.basis,
      });
    }
    if (signal.kind === "human-decision") {
      proposals.push({
        id: `PROP-HUMAN-${signal.id}`,
        kind: "escalate-human",
        reason: signal.detail,
        replanDraft: null,
        requiresConfirmation: false,
        basis: signal.basis,
      });
    }
    if (signal.kind === "write-scope-overlap") {
      proposals.push({
        id: `PROP-${signal.id}`,
        kind: "add-coordination-node",
        reason: signal.detail,
        replanDraft: {
          reason: "coordination",
          add: [
            {
              nodeId: `COORD-${signal.nodes[0]}-${signal.nodes[1]}`,
              title: `接口/写域协调：${signal.nodes[0]} × ${signal.nodes[1]}`,
              spec: `核对 ${signal.nodes[0]} 与 ${signal.nodes[1]} 的重叠写域（${signal.detail}），产出统一接口约定或所有权划分。不得代替任一方给自己盖章。`,
              stage: "design",
              deps: [...signal.nodes],
              evidenceRequired: ["artifact"],
              verifierIds: ["verifier-ci"],
            },
          ],
          note: `写域重叠协调：${signal.subject}`,
        },
        requiresConfirmation: true,
        basis: signal.basis,
      });
    }
  }

  const base = {
    graphVersion: currentGraphVersion(store),
    basedOnSeq: state.basedOnSeq,
    goal: state.goal,
    phase: state.phase,
    organization: {
      contracts: state.integration,
      summary: {
        total: state.integration.length,
        waitingMembers: state.integration.filter((item) => item.status === "waiting-members").length,
        readyForIntegration: state.integration.filter((item) => item.status === "ready-for-integration").length,
        integrated: state.integration.filter((item) => item.status === "integrated").length,
      },
    },
    conflicts: {
      total: routed.total,
      byRoute: routed.byRoute,
      forHuman: routed.forHuman.map((item) => ({
        id: item.id,
        subject: item.subject,
        type: item.type,
        needs: item.needs,
        reason: item.reason,
      })),
      capabilityGaps: routed.capabilityGaps,
      items: state.conflicts,
    },
    signals,
    proposals,
    next: state.next,
  };

  const fingerprint = createHash("sha256").update(JSON.stringify(stableCore(base))).digest("hex");
  const rendered = renderStateForContext(state);

  return {
    ok: true,
    readOnly: true,
    generatedAt,
    fingerprint,
    ...base,
    cost: { chars: rendered.length, approxTokens: Math.ceil(rendered.length / 3) },
    boundary: [
      "本报告只读：不派活、不改图、不裁决。",
      "`signals` 是发现，不等于已裁决；facet 有一条 note 不代表冲突关闭。",
      "`proposals.replanDraft` 不含 expectedGraphVersion：采纳者必须自己读当前 graph_version 并带上，旧草案不得覆盖新图。",
      "没有承接能力时状态是 capability-gap：不静默回退到 CODE 或任意默认角色。",
      "`writeScopes` 只是声明，不是文件锁；重叠只报告，不阻止并行。",
    ],
  };
}
