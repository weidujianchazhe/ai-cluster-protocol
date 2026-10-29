/**
 * N4 · 状态层契约（lane N4 / task-13）
 *
 * 依据：
 *   - 管理区 `designs/_research/DSH原生插件-60轮长任务.md` §2 权威边界、§4 P3
 *   - 宿主 `fs` 服务 CAS 契约：`writeText(target, content, expected?: FsWriteIntent)`
 *     `FsWriteIntent = {kind:'createIfAbsent'} | {kind:'replaceIfVersion', version}`
 *     `FsWriteOutcome = {operation, version, before, after}`
 *   - Python `control_plane/events.py` + `graph.replay_snapshot()` 作为语义 oracle
 *
 * 本文件只放**类型与错误码**，不放实现；N3（core）与 N5（e2e）按此契约编码。
 * 语义约束（实现见 store.ts / recovery.ts）：
 *   1. journal 只追加，`seq` 严格 +1；`hash` 形成链，断链即 `STATE_HASH_BREAK`（fail-closed）。
 *   2. `revision === seq`（状态序），`graphRevision` 对应 Python `graph_version`（replan 递增）。
 *   3. journal 是权威；快照只是可重建缓存（plan §2）。快照超前于 journal → `STATE_SNAPSHOT_AHEAD`。
 *   4. 单写者：进程内串行 + 跨进程锁文件；锁不新鲜切需 `takeover()` 签发的 fencing token。
 */

export const STATE_SCHEMA = 1 as const;

export type JsonScalar = null | boolean | number | string;
export type Json = JsonScalar | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** 状态错误码（全部 fail-closed，绝不静默覆盖）。 */
export type StateErrorCode =
  | 'STATE_LOCKED'
  | 'STATE_READONLY'
  | 'STATE_STALE_VERSION'
  | 'STATE_SNAPSHOT_AHEAD'
  | 'STATE_DIVERGED'
  | 'STATE_SEQ_GAP'
  | 'STATE_HASH_BREAK'
  | 'STATE_CORRUPT'
  | 'STATE_FENCED_OUT'
  | 'STATE_NOT_OPEN';

export class StateError extends Error {
  readonly code: StateErrorCode;
  readonly detail: JsonObject;

  constructor(code: StateErrorCode, message: string, detail: JsonObject = {}) {
    super(`[${code}] ${message}`);
    this.name = 'StateError';
    this.code = code;
    this.detail = detail;
  }
}

/** journal 单条记录：Python `events` 表的一行 + 哈希链。 */
export interface JournalRecord {
  /** 1 起、严格 +1。对应 Python `events.seq`。 */
  seq: number;
  /** `EVT-%06d`，与 Python `_next_event_id` 同格式。 */
  eventId: string;
  /** ISO 8601（本地时区，带偏移），与 Python `db.now_iso()` 同形。 */
  ts: string;
  /** 事件种类，取值与 Python 对齐（node_added / status_changed / ...）。 */
  kind: string;
  nodeId: string | null;
  payload: JsonObject;
  /** 上一条记录的 hash；seq=1 时为空串。 */
  prevHash: string;
  /** sha256(canonicalJson(record 去掉 hash 字段))。 */
  hash: string;
}

/** 图节点（字段名与 Python tasks 表一一对应，便于差分）。 */
export interface GraphNode {
  nodeId: string;
  title: string;
  spec: string;
  capability: string | null;
  stage: string | null;
  status: NodeStatus;
  deps: string[];
  evidenceRequired: string[];
  decisionId: string | null;
  assignee: string | null;
  attempts: number;
  verifierIds: string[];
  budget: JsonObject;
  createdAt: string;
  updatedAt: string;
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

export type EdgeKind = 'blocks' | 'artifact' | 'review';

export interface GraphEdge {
  fromId: string;
  toId: string;
  kind: EdgeKind;
}

export interface ArtifactRecord {
  artifactId: string;
  path: string;
  sha256: string;
  producerNode: string | null;
  verifierIds: string[];
}

export interface EvidenceRecord {
  evidenceId: string;
  nodeId: string;
  kind: string;
  artifactId: string;
  verifierId: string;
  verdict: 'pass' | 'fail' | 'unknown';
  at: string;
}

export interface DecisionRecord {
  decisionId: string;
  nodeId: string | null;
  level: 'L0' | 'L1' | 'L2' | 'L3';
  status: string;
  chosenOptionId: string | null;
  defaultOptionId: string | null;
  deadlineAt: number | null;
  decidedAt: string | null;
}

export interface GateRecord {
  stage: string;
  status: 'pending' | 'passed' | 'failed';
  evidenceRefs: string[];
}

export interface LeaseRecord {
  nodeId: string;
  owner: string;
  fencingToken: number;
  expiresAt: number;
  heartbeatAt: number;
}

/** 外部序列空间游标：把「core 的 seq」映射到「journal revision」。 */
export interface CursorRecord {
  /** 游标名，core 用 `core`。 */
  name: string;
  /** 外部空间已消费到的序号（= core 内存日志长度）。 */
  coreSeq: number;
  /** 写该游标时的 journal 位置（该 `cursor_aligned` 记录自己的 seq）。 */
  revision: number;
  at: string;
}

/** 物化状态（journal 折叠结果）。`revision === seq`。 */
export interface StateDoc {
  schema: number;
  revision: number;
  graphRevision: number;
  updatedAt: string;
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
  evidence: Record<string, EvidenceRecord>;
  artifacts: Record<string, ArtifactRecord>;
  decisions: Record<string, DecisionRecord>;
  gates: Record<string, GateRecord>;
  leases: Record<string, LeaseRecord>;
  /** 外部序列空间游标（诊断事件维护，不参与业务判定）。 */
  cursors: Record<string, CursorRecord>;
}

/** fs CAS 期望：映射宿主 `FsWriteIntent`；`unconditional` 仅测试/初始化使用。 */
export type CasExpectation =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion'; version: string }
  | { kind: 'unconditional' };

export interface FileStat {
  size: number;
  mtimeMs: number;
}

export interface DirEntry {
  name: string;
  type: 'file' | 'directory' | 'other';
}

/**
 * 文件系统端口。两套实现：
 *   - `NodeFsPort`（node:fs，追加 + fsync + 临时文件 rename 发布）
 *   - `DshFsPort`（宿主 `fs` 服务，写走 `writeText` + `FsVersion`）
 * 测试用 `MemoryFsPort`（含 CAS 与故障注入）。
 */
export interface FsPort {
  readText(path: string): Promise<string | null>;
  /** 返回 CAS 版本（Node 实现用内容 sha256；DSH 实现用 `FsVersion`）。 */
  versionOf(path: string): Promise<string | null>;
  writeCas(
    path: string,
    content: string,
    expected: CasExpectation,
  ): Promise<{ operation: 'create' | 'update'; version: string }>;
  /** 追加并落盘（fsync），返回追加的字节数。 */
  append(path: string, chunk: string): Promise<number>;
  stat(path: string): Promise<FileStat | null>;
  listDir(path: string): Promise<DirEntry[]>;
  remove(path: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  /** 读原始字节区间（torn line 截断修复用）。 */
  truncate(path: string, size: number): Promise<void>;
}

export interface LockRecord {
  pid: number;
  host: string;
  owner: string;
  epoch: number;
  startedAt: string;
  heartbeatAt: string;
  ttlMs: number;
}

export interface FenceToken {
  token: number;
  owner: string;
  issuedAt: string;
  expiresAt: string;
  previousToken: number;
}

export interface Checkpoint {
  checkpointId: string;
  seq: number;
  revision: number;
  graphRevision: number;
  owner: string;
  at: string;
  stateSha256: string;
  /** 可选：宿主会话对账锚点（`sessionController.inspect` 冷读值）。 */
  sessionId: string | null;
  lastSeq: number | null;
}

export interface SnapshotMeta {
  schema: number;
  seq: number;
  revision: number;
  graphRevision: number;
  journalBytes: number;
  journalHash: string;
  stateSha256: string;
  createdAt: string;
}

export interface SnapshotFile {
  meta: SnapshotMeta;
  state: StateDoc;
}

export interface StoreOptions {
  /** 状态根目录（绝对或相对 `cwd`）。 */
  dir: string;
  fs: FsPort;
  /** 单写者标识，默认 `${hostname}:${pid}`。 */
  owner?: string;
  /** 锁 TTL（毫秒）。 */
  ttlMs?: number;
  /** 是否在 open 时修复 torn tail（默认 true）。 */
  repairTail?: boolean;
  /** 只读模式（拒绝任何 append / checkpoint）。 */
  readonly?: boolean;
  now?: () => number;
}

export interface AppendInput {
  kind: string;
  nodeId?: string | null;
  payload?: JsonObject;
  /** 显式指定校验过的时间戳（测试/回放对齐用）。 */
  ts?: string;
  /** 非空时要求当前 fencing token 匹配，否则 `STATE_FENCED_OUT`。 */
  fencingToken?: number | null;
}

/** TeamTask 投影（N1/N2 的投影目标；本层只负责"可重建"）。 */
export interface ProjectedTask {
  subject: string;
  description: string;
  status: NodeStatus | 'unknown';
  owner: string | null;
  nodeId: string;
  stage: string | null;
  deps: string[];
}

export interface TeamTaskProjection {
  seq: number;
  revision: number;
  graphRevision: number;
  projectionHash: string;
  tasks: ProjectedTask[];
  promptSummary: string;
}
