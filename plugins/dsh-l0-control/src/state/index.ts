/**
 * N4 状态层导出面（N2 `l0control` / N5 e2e 从这里 import 即可）
 *
 * 只导出稳定符号；`self-test.ts` / `crash-child.ts` 属测试资产，不从 barrel 导出。
 * 关键入口：`Store.open()` → `persistCoreEvents()` / `appendFromSeq()` → `rebuildProjection()`。
 */

export type {
  AppendInput,
  ArtifactRecord,
  CasExpectation,
  Checkpoint,
  CursorRecord,
  DirEntry,
  EdgeKind,
  EvidenceRecord,
  FenceToken,
  FileStat,
  FsPort,
  GateRecord,
  GraphEdge,
  GraphNode,
  JournalRecord,
  Json,
  JsonObject,
  LeaseRecord,
  LockRecord,
  NodeStatus,
  ProjectedTask,
  SnapshotFile,
  SnapshotMeta,
  StateDoc,
  StateErrorCode,
  StoreOptions,
  TeamTaskProjection,
} from './types.ts';
export { STATE_SCHEMA, StateError } from './types.ts';

export { Journal, statePaths } from './journal.ts';
export type { JournalStatus, StatePaths } from './journal.ts';

export { DEFAULT_WAIT_MS, Store } from './store.ts';
export type {
  AppendFromSeqResult,
  StoreOpenOptions,
  TakeoverResult,
  WaitForUnlockResult,
  WaitInfo,
} from './store.ts';

export { openAndRecover, recoverWithJournal } from './recovery.ts';
export type { RecoveryReport, RecoverySource } from './recovery.ts';

export { DIAGNOSTIC_KINDS, emptyState, fold, foldUntil, graphProjection } from './reducer.ts';

export { buildSnapshot, checkAnchor, readSnapshot, updateSnapshot, verifySnapshot, writeSnapshot } from './snapshot.ts';

export {
  projectTeamTasks,
  projectionStatus,
  readProjection,
  rebuildProjection,
  diffProjection,
} from './projection.ts';
export type { ProjectionFile, ProjectionStatus, RebuildResult } from './projection.ts';

export {
  businessRecords,
  persistCoreEvents,
  pythonEventView,
  restoreCoreJournal,
  toCoreGraph,
  toEventRecords,
} from './bridge.ts';
export type { CoreEventRecord, CoreJournalLike, PersistOptions, PersistResult } from './bridge.ts';

export { MemoryFsPort, NodeFsPort, DshFsPort } from './fs-port.ts';
export type { HostFsService } from './fs-port.ts';

export { checkEventIdFormat, diffOracle, parseOracleFixture, resolveFixturePath, runOracleScript } from './python-diff.ts';
export type { OracleCheck, OracleDiff, OracleFixture, OracleRun } from './python-diff.ts';

export { canonicalJson, eventIdOf, nowIso, sha256Hex } from './canonical.ts';
