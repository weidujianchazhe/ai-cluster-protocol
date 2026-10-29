/**
 * N5 · ControlPort —— e2e 对控制面的**唯一**依赖面。
 *
 * 设计原则（R2 收敛后）：
 *  - 纯类型、无 import：不依赖 core / state / 入口。
 *  - **v1 单图**：动作按插件实例级，不带 `graphId`（Lead 2026-10-29 裁决 ①）。
 *  - **actor 不进服务签名**：由工具层写入 journal，port 从 journal 读（裁决 ②）。
 *  - 错误码大字_下划线，沿用 Python oracle 风格（见 WP10契约增量清单 §0）。
 *  - `exportProjection` 为主名，`export` 保留别名（裁决 ③）。
 */

export type ActorKind = 'agent' | 'plugin' | 'human';

export interface Actor {
  kind: ActorKind;
  /** 实例 ID（ROLE-<ROLE>-<NN>）或插件/用户标识 */
  id: string;
}

export type NodeStatus =
  | 'planned'
  | 'ready'
  | 'claimed'
  | 'running'
  | 'submitted'
  | 'verifying'
  | 'accepted'
  | 'rejected'
  | 'blocked'
  | 'done';

export type StageName = 'research' | 'design' | 'build' | 'audit' | 'deliver';

export interface Wish {
  text: string;
  acceptance: string[];
  constraints?: Record<string, string | number>;
}

export interface Node {
  node_id: string;
  title: string;
  status: NodeStatus;
  stage: StageName;
  /** 能力职务码（CODE / TEST / AUDIT_CODE …） */
  capability: string;
  role_count?: number;
  deps: string[];
  evidence_required: string[];
  assignee?: string | null;
  attempts: number;
  /** 逻辑时钟（形如 `#12`）—— e2e 的"未受影响节点不得变化"断言依赖它，不用墙上时间 */
  updated_at: string;
}

export interface Edge {
  from: string;
  to: string;
  kind: 'blocks' | 'artifact' | 'review';
}

export interface StageGate {
  stage: StageName;
  status: 'pending' | 'passed' | 'failed';
}

export interface Graph {
  graph_version: number;
  nodes: Node[];
  edges: Edge[];
  stage_gates: StageGate[];
}

export interface Evidence {
  evidence_id: string;
  node_id: string;
  kind: string;
  artifact_id: string;
  verifier_id: string;
  /** 生产该证据的实例（审计独立断言用） */
  producer_instance: string;
  verdict: 'pass' | 'fail' | 'unknown';
}

export interface Decision {
  decision_id: string;
  level: 'L0' | 'L1' | 'L2' | 'L3';
  node_id?: string;
  question: string;
  default_option?: string;
  timeout_sec?: number;
  chosen?: string;
  status: 'proposed' | 'auto' | 'timed_out' | 'confirmed' | 'overridden' | 'blocked';
}

export type Result<T> = { ok: true; value: T } | { ok: false; code: string; reason: string };

export interface TaskClaim {
  node_id: string;
  instance_id: string;
}

export interface DoneCredential {
  node_id: string;
  evidence_ids?: string[];
  verifier_ids?: string[];
  /** 审计实例（必须 ≠ 生产者；缺省视为未指派审计 → fail-closed） */
  auditor_instance?: string;
}

export interface TeamTaskProjection {
  team_task_id: string;
  node_id: string;
  status: string;
  owner?: string;
  revision: number;
}

export interface ExportResult {
  files: { path: string; bytes: number }[];
  /** 导出来源必须是 journal，不是 TeamTask */
  source: 'journal';
}

export interface ReplanRecord {
  reason: string;
  graph_version: number;
  replanned_nodes: string[];
}

/** 九个动作（实例级；v1 单图） */
export interface ControlPort {
  wishSubmit(wish: Wish): Promise<Result<{ graph_version: number }>>;
  graphStatus(): Promise<Result<Graph>>;
  taskNext(filter?: { role?: string }): Promise<Result<Node[]>>;
  taskClaim(claim: TaskClaim): Promise<Result<{ fencing_token: number }>>;
  evidenceSubmit(evidence: Evidence): Promise<Result<{ evidence_id: string }>>;
  verifyDone(credential: DoneCredential): Promise<Result<{ status: 'done' }>>;
  decide(decision: Decision): Promise<Result<{ decision_id: string; status: string }>>;
  teamStatus(): Promise<Result<TeamTaskProjection[]>>;
  /** 主名 */
  exportProjection(input?: { outDir?: string }): Promise<Result<ExportResult>>;
  /** 别名（与工具名 `export` 对齐） */
  export(input?: { outDir?: string }): Promise<Result<ExportResult>>;
  /** 仅供 e2e：主动 replan（生产里由 planner 触发） */
  replan?(record: ReplanRecord): Promise<Result<{ graph_version: number }>>;
  /** 仅供 e2e：模拟实例被杀 */
  killInstance?(instanceId: string): Promise<Result<{ killed: true }>>;
}

/** e2e 观测面：journal 事件（A1 无人工中继、A4 replan 都靠它） */
export interface JournalEvent {
  event_id: string;
  seq: number;
  actor: Actor;
  kind: string;
  refs?: Record<string, string>;
}

export interface JournalPort {
  append(actor: Actor, kind: string, refs?: Record<string, string>): JournalEvent;
  read(): JournalEvent[];
  reset(): void;
}

/** spawn 端口（N1/N2 提供；mock 时返回伪造实例） */
export interface SpawnPort {
  spawn(request: { role: string; count: number }): Promise<Result<string[]>>;
  kill(instanceId: string): Promise<Result<{ killed: true }>>;
}
