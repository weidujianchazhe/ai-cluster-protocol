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
