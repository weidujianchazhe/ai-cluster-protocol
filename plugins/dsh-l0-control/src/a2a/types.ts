/**
 * A2A 最小传输 · 类型定义（纯类型，可擦除语法）
 *
 * 边界：本目录只做「对外传输层」，不持有任何状态、不 import core/service。
 * 图状态与 TeamTask 通过 `A2ATaskPort`（见 port.ts）注入，由主窗口接线（M4）。
 */

/** A2A 任务状态（取规范最小集 + unknown，给无法映射的原生状态兜底）。 */
export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'unknown';

/** Agent Card：能力发现入口。字段按 A2A v1 最小可用子集。 */
export interface A2AAgentCard {
  name: string;
  description: string;
  version: string;
  protocolVersion: string;
  url: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2ASkill[];
  /** 实现侧附加信息（非规范字段，客户端应忽略）。 */
  metadata?: Record<string, unknown>;
}

export interface A2ASkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

/** 图节点 → A2A 任务的投影视图（只读派生，不是第二事实源）。 */
export interface A2ATask {
  id: string;
  contextId?: string;
  status: {
    state: A2ATaskState;
    timestamp: string;
    message?: string;
  };
  artifacts?: A2AArtifact[];
  metadata: {
    /** 权威来源：图节点 id。 */
    nodeId: string;
    /** 投影来源：原生 TeamTask id（可为 null，未投影时）。 */
    teamTaskId: string | null;
    revision: number;
    assignee: string | null;
    /** 原始图状态码，便于诊断；客户端不应据此分支。 */
    nativeStatus: string;
  };
}

export interface A2AArtifact {
  artifactId: string;
  name: string;
  parts: { kind: 'text'; text: string }[];
}

/** 端口返回的扁平节点行（主窗口把 core facade 的结果映射成这样即可）。 */
export interface A2ANodeRow {
  nodeId: string;
  status: string;
  revision?: number;
  teamTaskId?: string | null;
  assignee?: string | null;
  artifacts?: { path: string; text?: string }[];
  updatedAt?: string;
  contextId?: string;
  /**
   * 图里 `blocked` 的原因串。**cancel 在图上没有独立状态**（NODE_STATUSES 只有
   * planned/ready/claimed/running/submitted/verifying/done/blocked），
   * 所以 cancel 落为 `blocked` + `canceled:<reason>`，再由映射层渲染成 A2A `canceled`。
   */
  blockedReason?: string | null;
}

export interface A2ACreateTaskInput {
  message: string;
  idempotencyKey: string;
  actor: string;
  metadata?: Record<string, unknown>;
}

export interface A2ACreateTaskResult {
  taskId: string;
  row: A2ANodeRow;
}

export type A2ACancelOutcome =
  | { kind: 'canceled'; row: A2ANodeRow }
  | { kind: 'not-cancelable'; nodeId: string; status: string }
  | { kind: 'not-found'; nodeId: string };

/** 传输层入/出（与 node:http 解耦，便于纯函数测试与替换载体）。 */
export interface A2ARequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

export interface A2AResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface A2AAuthConfig {
  /** 允许的 bearer token 列表。空数组 = 一律拒绝（fail-closed）。 */
  tokens: string[];
  /** 额外允许的静态头（如 `x-a2a-key: value`）。 */
  staticHeader?: { name: string; value: string } | null;
  /** 要求 `x-a2a-tenant` 与之一致；null = 不做租户校验（租户模块归 Lane S）。 */
  requireTenant?: string | null;
  /** Agent Card 是否公开（默认 true，符合发现语义）。 */
  cardPublic?: boolean;
}

export interface A2AServerConfig {
  /** POST /a2a/tasks 是否强制 `Idempotency-Key`（默认 true，生产安全）。 */
  requireIdempotencyKey?: boolean;
  /** 幂等键保留时长（默认 24h）。 */
  idempotencyTtlMs?: number;
  /** 请求体上限（默认 1 MiB）。 */
  maxBodyBytes?: number;
  /** 时钟注入（测试用）。 */
  now?: () => number;
}

export interface A2AActor {
  kind: 'a2a-client';
  id: string;
  tokenFingerprint: string;
}

export interface A2AErrorBody {
  jsonrpc?: never;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
