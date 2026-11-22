/**
 * 控制面核心类型（Python `control_plane` schema v4 的 TS 投影）。
 *
 * 说明：只用可被 Node 类型剥离（type stripping）直接执行的语法——
 * 不用 enum / namespace / 参数属性，保证 `node src/core/*.ts` 可直接跑。
 */

/** 节点状态（与 Python `graph.STATUSES` 一致，10 态）。 */
export const NODE_STATUSES = [
  "planned",
  "ready",
  "claimed",
  "running",
  "submitted",
  "verifying",
  "accepted",
  "rejected",
  "blocked",
  "done",
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const EDGE_KINDS = ["blocks", "artifact", "review"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const VERDICTS = ["pass", "fail", "unknown"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const DECISION_LEVELS = ["L0", "L1", "L2", "L3"] as const;
export type DecisionLevel = (typeof DECISION_LEVELS)[number];

export const DECISION_STATUSES = [
  "proposed",
  "auto",
  "confirmed",
  "overridden",
  "timed_out",
  "blocked",
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const STAGES = ["research", "design", "build", "audit", "deliver"] as const;
export type Stage = (typeof STAGES)[number];
export type GateStatus = "pending" | "passed" | "failed";

export interface NodeRecord {
  node_id: string;
  title: string;
  spec: string;
  capability: string | null;
  stage: Stage | null;
  status: NodeStatus;
  deps: string[];
  evidence_required: string[];
  decision_id: string | null;
  attempts: number;
  assignee: string | null;
  verifier_ids: string[];
  budget: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface Lease {
  node_id: string;
  owner: string;
  fencing_token: number;
  expires_at: number;
  heartbeat_at: number;
}

export interface Artifact {
  artifact_id: string;
  path: string;
  sha256: string;
  producer_node: string;
  verifier_ids: string[];
  a2a_artifact_id: string | null;
}

/**
 * 证据来源标记（provenance）。
 *
 * 区分「对事实核验过」与「从线索推断出来的」——前者才能支撑节点进 done，
 * 后者只能进 journal 供人读。这是 duami 在 The Colony 讨论里提的规则：
 * 「推断出来的状态可以进 journal，只有核验过的状态才能据此对他人采取动作」。
 *
 * 缺省 `verified`：老证据（本字段引入前落账的）一律视为已验证，避免历史图翻车。
 */
export type Provenance = "verified" | "inferred" | "assumed";

export const PROVENANCES: readonly Provenance[] = ["verified", "inferred", "assumed"];

/**
 * 因果标注：**我读了谁的什么，因此做了什么不同**。
 *
 * 这是 worker 之间唯一的横向信息流，而且是**声明的、单向的、可审计的**——
 * 不是实时通信。它解决的是「C 看到 B 的产出，但看不到 B 受谁影响」这个问题。
 *
 * 三条刻意的约束：
 *   1. **只声明不强制**：不填就是没有（`[]`），不影响完成判定；
 *   2. **只引用已完成或已存在的节点**：引用不存在的节点是明确错误（拼写/幻觉），拒收；
 *   3. **不能引用自己**：自引用会造成假的耦合度。
 *
 * 注意它**不改变运行时行为**：被引用的节点不知道谁读了它，两边的执行顺序也不变。
 * 所以可复现性、审计独立性、成本线性这三条都不受影响。
 */
export interface ContextRef {
  /** 被引用的节点（必须在图中存在）。 */
  nodeId: string;
  /** 可选：具体引用了哪条证据（同一节点可能有多条）。 */
  evidenceId?: string;
  /** 可选：我因此做了什么不同（自由文本，人读；不参与任何判定）。 */
  how?: string;
}

export interface EvidenceRecord {
  evidence_id: string;
  node_id: string;
  kind: string;
  artifact_id: string;
  verifier_id: string;
  verdict: Verdict;
  attempt_no: number;
  at: string;
  /**
   * 证据提交者实例（如 `ROLE-CODE-01`）。**必填**：缺它「谁交的证据」不可审计，
   * 因此 `addEvidence` 会 fail-closed 拒绝（错误码 `producer-instance-required`）。
   */
  producer_instance: string;
  /**
   * 审计方实例（可选，审计独立判定用）：与 `producer_instance` 同实例或同职务 → 判定不独立。
   * 注意：不使用 `actor` 字段——提交者与审计者必须是两个可区分身份。
   */
  auditor_instance: string | null;
  /** 证据来源：只有 `verified` 能支撑 done（见 `validateDoneCredential`）。 */
  provenance: Provenance;
  /**
   * 本次证据声明的 token 消耗（可选，缺省 0）。
   * 预算判定用它作为增量；未声明即视为不计量，不做猜测。
   */
  usage_tokens?: number;
  /**
   * 因果标注（可选，缺省 `[]`）。老事件没有这个字段 → fold 时回退为空数组。
   * 它是 worker 之间**唯一的横向信息流**，见 `ContextRef` 的注释。
   */
  context_refs?: ContextRef[];
}

export interface DecisionOption {
  option_id: string;
  label?: string;
}

export interface DecisionRecord {
  decision_id: string;
  node_id: string | null;
  level: DecisionLevel;
  question: string;
  options: DecisionOption[];
  default_option_id: string | null;
  chosen_option_id: string | null;
  reversible: boolean;
  impact: string;
  status: DecisionStatus;
  timeout_sec: number;
  decided_at: string | null;
  note: string | null;
  created_at: string;
  deadline_at: number | null;
}

export interface EventRecord {
  seq: number;
  event_id: string;
  ts: string;
  kind: string;
  node_id: string | null;
  payload: Record<string, unknown>;
}

export interface StageGate {
  stage: Stage;
  status: GateStatus;
  evidence_refs: string[];
  decided_at: string | null;
}

export interface ReplanEvent {
  event_id: string;
  at: string;
  reason: string;
  graph_version: number;
  added: string[];
  removed: string[];
  /** 本次事务中重设的依赖边；老事件缺省为空数组。 */
  rewired?: Array<{ node_id: string; from: string[]; to: string[] }>;
  note: string | null;
}

/** `done` 凭证（与 Python `graph.done_credential()` 同形）。 */
export interface DoneCredential {
  node_id: string;
  evidence: string[];
  verifier_ids: string[];
  minted_at: string;
}

export interface GraphSnapshot {
  nodes: Record<string, NodeRecord>;
  edges: Edge[];
}

export interface Clock {
  nowIso(): string;
  nowMs(): number;
}

export const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};
