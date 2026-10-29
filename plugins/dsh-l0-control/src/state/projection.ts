/**
 * N4 · TeamTask 投影（可重建，不是第二事实源）
 *
 * 约束（plan §2）：
 *   - 投影 = `project(state)` 的纯函数结果 + `projectionHash`；
 *   - `projection.json` 只记录"上一次投影的 seq/hash"，用于判断"要不要重建"，
 *     不允许反向写回状态；
 *   - TeamTask 更新失败不回滚 journal：下次 `rebuild()` 从 journal 重算补齐。
 *
 * 与 N1/N5 的接口：`projectTeamTasks()` 产出的 `ProjectedTask[]` 直接映射到
 * `agentTeams.createTask/updateTask` 的字段（subject/description/owner/status）。
 */

import { canonicalJson, sha256Hex } from './canonical.ts';
import { StateError, type NodeStatus, type ProjectedTask, type StateDoc, type TeamTaskProjection } from './types.ts';
import type { FsPort } from './types.ts';
import type { StatePaths } from './journal.ts';

const STAGE_ORDER = ['research', 'design', 'build', 'audit', 'deliver'] as const;

/** 稳定排序：阶段顺序 → 依赖数 → nodeId；保证同一状态两次投影哈希一致。 */
export function projectTeamTasks(state: StateDoc): TeamTaskProjection {
  const nodes = Object.values(state.nodes);
  const stageRank = (stage: string | null): number => {
    const index = stage ? (STAGE_ORDER as readonly string[]).indexOf(stage) : -1;
    return index < 0 ? STAGE_ORDER.length : index;
  };
  const sorted = [...nodes].sort((a, b) => {
    const byStage = stageRank(a.stage) - stageRank(b.stage);
    if (byStage !== 0) return byStage;
    const byDeps = a.deps.length - b.deps.length;
    if (byDeps !== 0) return byDeps;
    return a.nodeId.localeCompare(b.nodeId);
  });

  const tasks: ProjectedTask[] = sorted.map((node) => ({
    subject: `[${node.nodeId}] ${node.title}`,
    description: node.spec,
    status: node.status,
    owner: node.assignee,
    nodeId: node.nodeId,
    stage: node.stage,
    deps: [...node.deps],
  }));

  const counts = tasks.reduce<Record<string, number>>((acc, task) => {
    acc[task.status] = (acc[task.status] ?? 0) + 1;
    return acc;
  }, {});

  const ready = tasks.filter((task) => task.status === 'ready').map((task) => task.nodeId);
  const done = counts.done ?? 0;
  const blocked = (counts.blocked ?? 0) + (counts.rejected ?? 0);
  const promptSummary = [
    `控制面状态：revision=${state.revision} graphRevision=${state.graphRevision}`,
    `节点 ${tasks.length}（done=${done} ready=${ready.length} blocked=${blocked}）`,
    ready.length ? `可领取：${ready.slice(0, 8).join(', ')}${ready.length > 8 ? ' …' : ''}` : '暂无可领取节点',
  ].join('｜');

  return {
    seq: state.revision,
    revision: state.revision,
    graphRevision: state.graphRevision,
    projectionHash: sha256Hex(canonicalJson(tasks as unknown)),
    tasks,
    promptSummary,
  };
}

export interface ProjectionFile {
  seq: number;
  revision: number;
  graphRevision: number;
  projectionHash: string;
  tasks: ProjectedTask[];
  promptSummary: string;
  writtenAt: string;
}

export interface ProjectionStatus {
  needsRebuild: boolean;
  reason: 'missing' | 'seq-advanced' | 'hash-mismatch' | 'in-sync';
  projected: number;
  expected: TeamTaskProjection;
  onDisk: ProjectionFile | null;
}

export async function readProjection(fsPort: FsPort, paths: StatePaths): Promise<ProjectionFile | null> {
  const raw = await fsPort.readText(paths.projection);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as ProjectionFile;
  } catch {
    throw new StateError('STATE_CORRUPT', `projection.json 不是合法 JSON：${paths.projection}`);
  }
}

/** 判断投影是否过期（只看 seq/hash，不信任磁盘内容）。 */
export async function projectionStatus(
  fsPort: FsPort,
  paths: StatePaths,
  state: StateDoc,
): Promise<ProjectionStatus> {
  const expected = projectTeamTasks(state);
  const onDisk = await readProjection(fsPort, paths);
  if (onDisk === null) return { needsRebuild: true, reason: 'missing', projected: 0, expected, onDisk };
  if (onDisk.seq !== expected.seq) {
    return { needsRebuild: true, reason: 'seq-advanced', projected: onDisk.tasks?.length ?? 0, expected, onDisk };
  }
  if (onDisk.projectionHash !== expected.projectionHash) {
    return { needsRebuild: true, reason: 'hash-mismatch', projected: onDisk.tasks?.length ?? 0, expected, onDisk };
  }
  return { needsRebuild: false, reason: 'in-sync', projected: onDisk.tasks.length, expected, onDisk };
}

export interface RebuildResult {
  rebuilt: boolean;
  reason: ProjectionStatus['reason'];
  projection: TeamTaskProjection;
  version: string | null;
}

/**
 * 重建投影并 CAS 落盘。
 * `writer` 是 N1/N5 的 TeamTask 适配器（可选）：先算再重放差异，最后才写盘。
 */
export async function rebuildProjection(
  fsPort: FsPort,
  paths: StatePaths,
  state: StateDoc,
  options: {
    at: string;
    writer?: (plan: { upsert: ProjectedTask[]; remove: string[] }) => Promise<void>;
  },
): Promise<RebuildResult> {
  const status = await projectionStatus(fsPort, paths, state);
  if (!status.needsRebuild) {
    return { rebuilt: false, reason: status.reason, projection: status.expected, version: null };
  }
  const expected = status.expected;
  if (options.writer) {
    const known = new Set((status.onDisk?.tasks ?? []).map((task) => task.nodeId));
    const next = new Set(expected.tasks.map((task) => task.nodeId));
    const upsert = expected.tasks.filter((task) => {
      const previous = status.onDisk?.tasks.find((item) => item.nodeId === task.nodeId);
      return !previous || canonicalJson(previous as unknown) !== canonicalJson(task as unknown);
    });
    const remove = [...known].filter((nodeId) => !next.has(nodeId));
    await options.writer({ upsert, remove });
  }
  const file: ProjectionFile = { ...expected, writtenAt: options.at };
  const body = `${JSON.stringify(file, null, 2)}\n`;
  const current = await fsPort.versionOf(paths.projection);
  const outcome = await fsPort.writeCas(
    paths.projection,
    body,
    current === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: current },
  );
  return { rebuilt: true, reason: status.reason, projection: expected, version: outcome.version };
}

/** 投影差异（供 N5 断言"TeamTask 板 == 控制面状态"）。 */
export function diffProjection(
  expected: TeamTaskProjection,
  actual: ProjectedTask[],
): { missing: string[]; extra: string[]; changed: Array<{ nodeId: string; expected: string; actual: string }> } {
  const expectedMap = new Map(expected.tasks.map((task) => [task.nodeId, task]));
  const actualMap = new Map(actual.map((task) => [task.nodeId, task]));
  const missing = [...expectedMap.keys()].filter((nodeId) => !actualMap.has(nodeId));
  const extra = [...actualMap.keys()].filter((nodeId) => !expectedMap.has(nodeId));
  const changed: Array<{ nodeId: string; expected: string; actual: string }> = [];
  for (const [nodeId, task] of expectedMap) {
    const other = actualMap.get(nodeId);
    if (!other) continue;
    const left = canonicalJson(task as unknown);
    const right = canonicalJson(other as unknown);
    if (left !== right) changed.push({ nodeId, expected: left, actual: right });
  }
  return { missing, extra, changed };
}

export type { NodeStatus };
