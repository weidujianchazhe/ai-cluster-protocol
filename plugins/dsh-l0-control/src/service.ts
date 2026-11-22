/**
 * `l0control` 服务：插件内门面（进程内单实例）。
 *
 * 边界（N2 只做壳）：
 *   - 图/ready/证据/done/决策/租约的**不变量**属 `src/core`（N3 写域）；这里只做
 *     参数校验、caller 取用、journal 追加与结果整形；
 *   - core 缺失时所有图操作 **fail-closed** 返回 `core-unavailable`，不假装成功；
 *   - `team_status` 是本层唯一直接打 `agentTeams` 的动作（验收要证明原生通道可用）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { CONFIG_SPEC, normalizeConfig, reapPolicyFromConfig } from './config.js';
import { AUDITOR_ROLES, CAPABILITIES, capabilitiesDigest, isAuditorInstance, roleOfInstance } from './capabilities.js';
import { CorePersistence } from './persistence.js';
import { NativeTeam } from './native/team.js';
import { LEGAL_WORKER_ROLES } from './native/worker.js';
import { applyEnqueueRows, backoffReason, emptyEnqueueState, explainFailure, explainRelease, sweepStale, trimReleased, type EnqueueRecord, type EnqueueState } from './dispatch/enqueue-state.js';
import { dispatchedInWindow, effectiveDispatched } from './dispatch/rate-window.js';
import { GateHistoryFolder } from './dispatch/gate-history.js';
import { runProjectInit } from './bootstrap/index.js';
import type { L0ControlConfig } from './config.js';

/** 工作区管理三态：off（默认，AI 不能自行建）/ auto（AI 自行决定）/ on（允许并鼓励）。 */
export type ManagementMode = 'off' | 'auto' | 'on';

/**
 * 宿主侧对工具返回值做 lossless-JSON 校验：对象里只要出现 `undefined`、
 * 非有限数（NaN / Infinity）、BigInt、函数、Map/Set 等，就会整体拒绝，调用方
 * 看到的只是一条与真实结果无关的错误（`value is not lossless JSON`）。core 的
 * 返回值由多处拼装，无法保证每个可选字段都显式给 null，所以在服务层出口统一
 * 归一化：删除 `undefined` 键、非有限数转 null、Date 转 ISO、Map/Set 展开。
 * 同时检测循环引用（WeakSet），避免栈溢出。
 */
export function sanitizeForHost<T>(
  value: T,
  onDrop?: (path: string, reason: string) => void,
  path = '$',
  _seen = new WeakSet<object>()  // 循环引用检测（WeakSet 不阻止 GC）
): T {
  const drop = (reason: string) => {
    if (!onDrop) return;
    try {
      onDrop(path, reason);
    } catch {
      // 日志失败不影响主流程
    }
  };
  if (value === undefined) {
    drop('undefined');
    return null as unknown as T;
  }
  if (value === null) return value;
  const kind = typeof value;
  if (kind === 'number') {
    if (!Number.isFinite(value as number)) {
      drop('non-finite-number');
      return null as unknown as T;
    }
    return value;
  }
  if (kind === 'bigint') {
    drop('bigint');
    return String(value) as unknown as T;
  }
  if (kind === 'function' || kind === 'symbol') {
    drop(kind);
    return null as unknown as T;
  }
  if (value instanceof Date) return value.toISOString() as unknown as T;
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeForHost(item, onDrop, `${path}[${index}]`, _seen)) as unknown as T;
  }
  if (value instanceof Map) {
    drop('map');
    return sanitizeForHost(Object.fromEntries(value as Map<unknown, unknown>) as unknown as T, onDrop, path, _seen);
  }
  if (value instanceof Set) {
    drop('set');
    return sanitizeForHost([...(value as Set<unknown>)] as unknown as T, onDrop, path, _seen);
  }
  if (kind === 'object') {
    // 循环引用检测
    if (_seen.has(value as object)) {
      drop('circular-reference');
      return '[Circular]' as unknown as T;
    }
    _seen.add(value as object);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) {
        drop(`${path}.${key}`);
        continue;
      }
      out[key] = sanitizeForHost(item, onDrop, `${path}.${key}`, _seen);
    }
    _seen.delete(value as object);  // 回溯时移除，允许同一对象在不同分支出现
    return out as unknown as T;
  }
  return value;
}

export function normalizeManagement(value: unknown): ManagementMode {
  const text = String(value ?? '').toLowerCase();
  return text === 'auto' || text === 'on' ? (text as ManagementMode) : 'off';
}

export interface ServiceMeta {
  configSource?: string;
  configSourceFile?: string | null;
}

export interface CoreModule {
  submitWish?: (input: { text: string; maxParallel?: number; budgetTokens?: number }) => unknown | Promise<unknown>;
  graphPlan?: (spec: Record<string, unknown>) => unknown | Promise<unknown>;
  graphCommit?: (spec: Record<string, unknown>) => unknown | Promise<unknown>;
  /** 图状态：支持 limit/offset，由 core 只投影当前页（默认 50/页）。 */
  graphStatus?: (options?: { limit?: number; offset?: number }) => unknown | Promise<unknown>;
  graphCheckpoint?: (input: { partitionId: string }) => unknown | Promise<unknown>;
  graphRecover?: (input: { partitionId?: string }) => unknown | Promise<unknown>;
  graphResumePlan?: (input: { partitionId?: string }) => unknown | Promise<unknown>;
  dispatchPlan?: (raw: Record<string, unknown>) => unknown | Promise<unknown>;
  /** 回收过期租约（写动作）：崩溃 worker 的节点靠它回到 ready。 */
  reapExpiredLeases?: (raw?: Record<string, unknown>) => unknown | Promise<unknown>;
  nextTask?: (input: { role?: string }) => unknown | Promise<unknown>;
  claimTask?: (input: { nodeId: string; role?: string; instanceId?: string; hostLimit?: number; ratePerSecond?: number }) => unknown | Promise<unknown>;
  /** 租约心跳：只认 fencingToken（能力凭证），不认身份。 */
  heartbeatTask?: (input: { nodeId: string; fencingToken: number; ttlSec?: number }) => unknown | Promise<unknown>;
  submitEvidence?: (input: Record<string, unknown>) => unknown | Promise<unknown>;
  verifyDone?: (input: Record<string, unknown>) => unknown | Promise<unknown>;
  decide?: (input: Record<string, unknown>) => unknown | Promise<unknown>;
  exportProjection?: (outDir: string) => unknown | Promise<unknown>;
  passGate?: (store: unknown, stage: string, evidenceRefs?: string[]) => unknown;
  coreStore?: () => unknown;
  withCoreStore?: <T>(store: unknown, fn: () => T) => T;
  isStage?: (stage: string) => boolean;
}

/** 阶段闸门的 5 段枚举（与 core `stages.ts` / Python STAGES 对齐）。 */
export const GATE_STAGES: readonly string[] = ['research', 'design', 'build', 'audit', 'deliver'];

/**
 * 输入键名归一化：工具边界同时接受 snake_case 与 camelCase。
 *
 * 口径（Lead 2026-10-29 定）：**默认合并保留两种拼写**，让 core 自己挑
 * （core `facade.ts/evidence.ts` 读 `producerInstance` camel；Python 侧读 snake）。
 * 只有两种拼写同时存在且**值不同**才判 `key-conflict` —— 既不丢别名，也不要求"两种都得传"。
 *
 * `target` 仍可显式指定 'snake' | 'camel'，用于必须单选的调用点。
 */
const KEY_PAIRS: ReadonlyArray<readonly [snake: string, camel: string]> = [
  ['producer_instance', 'producerInstance'],
  ['auditor_instance', 'auditorInstance'],
  ['option_id', 'optionId'],
  ['default_option_id', 'defaultOptionId'],
  ['timeout_sec', 'timeoutSec'],
  ['evidence_refs', 'evidenceRefs'],
];

export function normalizeKeys<T extends Record<string, unknown> | undefined>(
  input: T,
  target: 'merge' | 'snake' | 'camel' = 'merge',
): T {
  if (!input || typeof input !== 'object') return input as T;
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const [snake, camel] of KEY_PAIRS) {
    const hasSnake = snake in out;
    const hasCamel = camel in out;
    if (!hasSnake && !hasCamel) continue;
    if (hasSnake && hasCamel && out[snake] !== out[camel]) {
      throw new Error(`key-conflict:${snake}!=${camel}`);
    }
    const value = hasSnake ? out[snake] : out[camel];
    if (target === 'merge' || target === 'snake') out[snake] = value;
    if (target === 'merge' || target === 'camel') out[camel] = value;
    if (target === 'snake') delete out[camel];
    if (target === 'camel') delete out[snake];
  }
  return out as T;
}

/** 两种拼写都补齐（值相同），供 core 直接取用。 */
export function withAliases(input: Record<string, unknown>): Record<string, unknown> {
  return normalizeKeys({ ...input }, 'merge');
}

function errorInfo(error: unknown) {
  const err = error as { name?: string; code?: string; message?: string; gate?: string } | undefined;
  return {
    name: err?.name ?? 'Error',
    code: err?.code ?? null,
    message: String(err?.message || error),
    // 闸门归因：core 抛的限流类错误带 `gate`（capacity/partition/rate/budget），
    // 与派活计划层同一套词汇。不透出来的话，调用方只能看到
    // `graph_capacity` / `partition_capacity` / `rate_limited` 三个码，
    // 得自己映射回「该调哪个参数」——而映射表本来就是 core 的领域知识。
    ...(err?.gate ? { gate: err.gate } : {}),
  };
}

/** 读本插件 package.json 的 version（`lib/../package.json`）。 */
function readLocalVersion(): string {
  try {
    const pkgPath = new URL('../package.json', import.meta.url);
    const raw = fs.readFileSync(pkgPath, 'utf8');
    return String((JSON.parse(raw) as { version?: string })?.version ?? '').trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 轻量 semver 比较：只按数字段比，缺失段补 0；返回 -1 / 0 / 1。 */
function compareSemver(a: string, b: string): number {
  const norm = (value: string) =>
    String(value ?? '')
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = norm(a);
  const right = norm(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const x = left[index] ?? 0;
    const y = right[index] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * 工具输出必须是 lossless JSON：宿主会拒收含类实例/代理/branded 的值
 * （`Agent` 句柄、`TeamMembership.root` 都会踩）。
 *
 * 策略（N1 spike 后收紧）：
 *   1. 只取**标量白名单**；嵌套结构降级成字符串或直接丢弃；
 *   2. 整段 `JSON.parse(JSON.stringify(...))` 兜底；
 *   3. 任何一步失败 → `{ok:false, error:'projection-failed'}`，绝不把原值抛给宿主。
 */
function scalar(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return null;
}

function projectTeam(caller: any, membership: any, members: any[], tasks: any[]) {
  return {
    ok: true,
    native: true,
    caller: scalar(caller?.id),
    membership: {
      rootId: scalar(membership?.root?.id),
      id: scalar(membership?.id),
      role: scalar(membership?.role),
      name: scalar(membership?.name),
    },
    memberCount: members.length,
    members: members.map((member: any) => ({
      id: scalar(member?.id),
      name: scalar(member?.name),
      role: scalar(member?.role),
      status: scalar(member?.status),
      model: scalar(member?.model),
      provider: scalar(member?.provider),
    })),
    taskCount: tasks.length,
    tasks: tasks.map((task: any) => ({
      id: scalar(task?.id),
      revision: scalar(task?.revision),
      subject: scalar(task?.subject),
      status: scalar(task?.status),
      ownerName: scalar(task?.ownerName),
      ready: scalar(task?.ready),
      blockedByCount: Array.isArray(task?.blockedBy) ? task.blockedBy.length : 0,
    })),
  };
}
function toLossless(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function listEntries(dir: string, limit = 40): Array<{ name: string; type: 'dir' | 'file' }> {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'dir' as const : 'file' as const }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
      .slice(0, limit);
  } catch {
    return [];
  }
}

function readManagementCards(dir: string, limit = 30): Array<{ name: string; status: string | null; next: string | null; taskId: string | null }> {
  try {
    const tasksDir = path.join(dir, 'tasks');
    if (!fs.existsSync(tasksDir)) return [];
    return fs.readdirSync(tasksDir)
      .filter((name) => name.endsWith('.md') && !name.endsWith('.lock'))
      .sort()
      .slice(0, limit)
      .map((name) => {
        let text = '';
        try {
          text = fs.readFileSync(path.join(tasksDir, name), 'utf8');
        } catch {
          return { name: name.replace(/\.md$/, ''), status: null, next: null, taskId: null };
        }
        const status = /\*\*状态\*\*：(.+)/.exec(text)?.[1]?.trim() ?? null;
        const next = /\*\*下一步\*\*：(.+)/.exec(text)?.[1]?.trim()
          ?? /-\s*①\s*(.+)/.exec(text)?.[1]?.trim() ?? null;
        const taskId = /\*\*TASK-ID\*\*：(.+)/.exec(text)?.[1]?.trim() ?? null;
        return { name: name.replace(/\.md$/, ''), status, next, taskId };
      });
  } catch {
    return [];
  }
}

export class L0ControlService {
  readonly ctx: any;
  readonly config: L0ControlConfig;
  readonly meta: ServiceMeta;
  readonly workspaceRoot: string;
  readonly managementRoot: string;
  readonly stateDir: string;
  readonly journalPath: string;
  readonly snapshotPath: string;
  private corePromise: Promise<CoreModule | null> | null = null;
  private persistenceRef: CorePersistence | null = null;
  private persistenceError: string | null = null;
  private nativeTeamRef: NativeTeam | null = null;
  private lastCaller: any = null;
  /** 每个 session（对话窗口）最近一次成功投影的团队板快照；reload 后从 journal 逐 session 恢复。 */
  private teamSnapshots = new Map<string, { capturedAt: string; team: Record<string, unknown> }>();
  /** 派活循环：会话内覆盖（不写配置文件；重启回到 config 默认 off）。 */
  private dispatchOverride: { mode?: string; intervalMs?: number; maxPerTick?: number; dryRun?: boolean; dispatcherInstance?: string } | null = null;
  /** 派活定时器；off 模式下为 null。 */
  private dispatchTimer: ReturnType<typeof setInterval> | null = null;
  private dispatchTimes: number[] = [];
  private dispatchTickBusy = false;
  /**
   * journal 增量读缓存：`bytes` = 已消费到的字节偏移，`rows` = 已解析的行，
   * `skipped` = 已完成的坏行数，`tailBad` = 末个**已完成**行是否坏，
   * `pending` = 尾部残留字节数（未换行 = 正在写，留到下次）。
   *
   * 为什么要 4 个字段而不是 1 个：`events` / `lastKind` 必须能分清三件事——
   *   「已写完的好行」、「已写完的坏行」、「还没写完的尾巴」。
   * 混为一谈的话，正常的并发写入期间每次摘要都会报 `unparsable`（其实没坏），
   * 而真正的坏行反而被这类噪音埋掉。
   *
   * 文件变短（旋转/截断）时整块失效重读——见 `journalRows()`。
   */
  private journalCursor: {
    bytes: number;
    rows: Array<Record<string, unknown>>;
    skipped: number;
    tailBad: boolean;
    pending: number;
  } | null = null;
  /** 派发登记的增量折叠位置：`rows` = 已折叠到第几行，`state` = 折叠结果。 */
  private enqueueFolded: { rows: number; state: EnqueueState } | null = null;
  /**
   * 闸门累积的增量折叠器：与 `enqueueFolded` 同构。
   *
   * 为什么不能用一次性全量折叠：`foldGateHistory` 每次从尾部扫到窗口边界，
   * 成本是**窗口内的 journal 行数**。默认 5 分钟窗口只有几十行 tick，可忽略；
   * 但 `dispatchGateWindowMs` 调到 1 小时，窗口里是万行（journal 里绝大多数行
   * 不是 tick），而 `dispatchView()` 每轮派发都会被调一次。增量版只处理新增行，
   * 聚合只走窗口内 ring，成本与历史长度和窗口行数都脱钩。
   */
  private gateFolded: GateHistoryFolder | null = null;
  /**
   * 派发登记：**从 journal 推导**，不用进程内 Set。
   *
   * 旧实现 `enqueuedNodes = new Set()` 有两个反向的错：重启即失忆（同节点被重复派），
   * 永不释放（claim 被拒后节点重新 ready 却再没人看 ⇒ 永久停滞）。
   * 判据与推导规则见 `dispatch/enqueue-state.ts`。
   */
  private enqueueState(): EnqueueState {
    const cfg = this.config as unknown as Record<string, unknown>;
    const staleMs = Number(cfg.enqueueStaleMs);
    const unclaimedMs = Number(cfg.enqueueUnclaimedStaleMs);
    // 两个阈值回答两个不同的问题（见 `DeriveOptions.unclaimedMaxAgeMs`）：
    //   - 已 claim：worker 在长跑，沉默可疑但可能还活着 → 30 分钟；
    //   - 未 claim：连 claim 都没到，没有任何存活信号 → 2 分钟。
    // 旧实现共用一个 30 分钟，于是崩在启动阶段的 worker 会把
    // `queuedWorkers()` 撑满 30 分钟，期间 queue 闸门把新节点全挡住。
    const sweep = {
      now: Date.now(),
      maxAgeMs: Number.isFinite(staleMs) && staleMs > 0 ? staleMs : 0,
      unclaimedMaxAgeMs: Number.isFinite(unclaimedMs) && unclaimedMs > 0 ? unclaimedMs : 0,
    };

    // 取增量：`journalRows()` 已按字节做增量解析，这里只折叠「上次没折叠过的那几行」，
    // 于是每轮成本与历史长度无关（70000 行全量重折叠要 22 ms）。
    //
    // 用 `journalTail(folded.rows)` 而不是 `readJournal().slice(folded.rows)`：
    // 后者先拷全部 71400 个引用再切掉 99%——这正是第 23 轮量到的那 0.35 ms
    // 中的绝大部分，而它每轮 tick 都要付一次。
    const folded = this.enqueueFolded;
    let total = 0;
    let fresh: Array<Record<string, unknown>> = [];
    try {
      total = this.journalLength();
      // journal 变短（旋转/截断）时总行数会比上次少 → 必须整块重折叠。
      const mustRefold = !folded || total < folded.rows;
      const state = mustRefold ? emptyEnqueueState() : folded.state;
      fresh = this.journalTail(mustRefold ? 0 : folded.rows);
      applyEnqueueRows(state, fresh as never);
      // ★ 失联判定与裁剪的结果**写回折叠态**。
      //
      // 旧实现只把它们作用在返回值上，折叠态保持原样。后果不是"多算一点"，而是
      // **同一份状态对同一个问题有两个相反答案**：`enqueueState()` 说 live=0
      // （60000 条全部判过期），`this.enqueueFolded.state` 里仍是 live=60000。
      // 于是下一轮又从 60000 条出发重新判一遍——每轮恒定 26 ms，与是不是真有
      // 活 worker 无关，且永不衰减。live 的口径是「已派未释放」的累积量
      // （上界 ≈ 30 分钟 × 派发速率 ≈ 18 万条），这条恒定税会随运行时长一直涨。
      //
      // 写回后 live 只保留「确实还在 maxAgeMs 内活动过」的记录，成本回到真实并发量级。
      // 语义上也才自洽：既然已经对外说"该节点失联释放"（`released` 里带 `stale`
      // 原因），内部就不能还留着它的活登记——否则未来任何读折叠态的判定都会看见幽灵 worker。
      //
      // 等价性不受影响：`applyEnqueueRows` 的注释已经钉住「折叠只忠于行序」，
      // 而失联本来就只在折叠完成后按观测时刻判一次；分块折叠 + 末尾判一次，
      // 与全量折叠 + 末尾判一次的结果相同（`verify-enqueue-state` 的 60 组随机比对守着）。
      trimReleased(state);
      const swept = sweepStale(state, sweep);
      this.enqueueFolded = { rows: total, state: swept };
      return swept;
    } catch {
      // 读失败按「没有登记」处理，与旧行为一致（但不能因此把整张图判成满）。
      return sweepStale(emptyEnqueueState(), { now: sweep.now, maxAgeMs: 0 });
    }
  }

  /** 按对话的子 Agent（递归）快照；team_snapshot 只存团队板，descendants 要单独存。 */
  private descendantSnapshots = new Map<string, { count: number; active: number; at: string; items?: unknown[] }>();
  /** 按对话的双轴状态：coordination（协作，默认 false）+ management（管理区，默认 'off'）。 */
  private enabledSessions = new Map<string, { coordination: boolean; management: ManagementMode; at: string; by: string | null }>();
  /** 工作区级默认：第一次启用集群后，新会话默认继承协作。 */
  private workspaceCoordinationDefault = false;
  private workspaceClusterId: string | null = null;
  private observability: { projection?: (input?: Record<string, unknown>) => unknown; health?: () => unknown; snapshot?: () => unknown } | null = null;

  constructor(ctx: any, config: unknown = {}, meta: ServiceMeta = {}) {
    this.ctx = ctx;
    this.config = normalizeConfig(config);
    this.meta = meta;
    const configuredRoot = String(this.config.workspaceRoot ?? '').trim();
    let hostRoot = '';
    try {
      const workingDirectory = this.ctx.get?.('workingDirectory');
      hostRoot = String(workingDirectory?.defaultDirectory ?? '').trim();
    } catch {
      hostRoot = '';
    }
    const effectiveRoot = configuredRoot && configuredRoot !== '.' ? configuredRoot : (hostRoot || process.cwd());
    this.workspaceRoot = path.resolve(effectiveRoot);
    this.managementRoot = this.resolveManagementRoot();
    this.stateDir = path.resolve(this.workspaceRoot, this.config.stateDir);
    this.journalPath = path.join(this.stateDir, this.config.journalFile);
    this.snapshotPath = path.join(this.stateDir, this.config.snapshotFile);
    // reload 后恢复每个 session 的团队板快照：没有 live caller 时 UI 也能按对话窗口显示
    this.restoreTeamSnapshots();
    this.restoreAccess();
    this.restoreDescendantSnapshots();
  }

  private resolveManagementRoot(): string {
    const configured = String(this.config.managementRoot ?? '').trim();
    if (configured) {
      const resolved = path.resolve(path.isAbsolute(configured) ? configured : path.join(this.workspaceRoot, configured));
      const relative = path.relative(this.workspaceRoot, resolved);
      const sibling = path.resolve(this.workspaceRoot, '..', `${path.basename(this.workspaceRoot)}-管理区`);
      if (resolved !== sibling && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
        // 这是抛给人的文案：说清「允许的两个位置」比说「越界」有用。
        throw new Error('managementRoot 必须落在 workspaceRoot 之内，或落在它同级的 `<工作区名>-管理区` 目录');
      }
      return resolved;
    }
    const candidates = [
      path.join(this.workspaceRoot, '管理区'),
      path.join(this.workspaceRoot, 'AI集群工作协议-管理区'),
      path.resolve(this.workspaceRoot, '..', `${path.basename(this.workspaceRoot)}-管理区`),
      path.resolve(this.workspaceRoot, '..', 'AI集群工作协议-管理区'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, 'STATE.md')) || fs.existsSync(path.join(candidate, 'tasks'))) return candidate;
    }
    return candidates[1];
  }

  /**
   * 从 journal 恢复**每个 session** 的最后一条 `team_snapshot`（后写覆盖前写）。
   * 旧格式（无 sessionId）的行忽略：跨 session 复用正是要修掉的 bug。
   */
  private restoreTeamSnapshots(): void {
    try {
      if (!fs.existsSync(this.journalPath)) return;
      const rows = this.readJournal();
      for (const row of rows) {
        if (row?.kind !== 'team_snapshot') continue;
        const sessionId = String(row.sessionId ?? '');
        const team = row.team as Record<string, unknown> | undefined;
        if (!sessionId || !team || typeof team !== 'object') continue;
        this.teamSnapshots.set(sessionId, {
          capturedAt: String(row.capturedAt ?? row.at ?? ''),
          team,
        });
      }
    } catch {
      // 恢复失败不阻断：UI 会显示 source='none'
    }
  }

  /** 原生执行层（懒建；实例表从 journal 回放，重启后 send_message 仍可用）。 */
  get native(): NativeTeam {
    if (!this.nativeTeamRef) {
      this.nativeTeamRef = new NativeTeam(this.ctx, {
        provider: this.config.nativeProvider,
        maxDepth: this.config.nativeMaxDepth,
      });
      try {
        this.nativeTeamRef.restoreFromJournal(this.readJournal());
      } catch {
        // 回放失败不阻断：实例表空着，spawn 会重新登记
      }
    }
    return this.nativeTeamRef;
  }

  // ── 宿主访问 ────────────────────────────────────────────────
  get agentTeams(): any {
    return this.ctx.get('agentTeams');
  }

  get toolNames(): string[] {
    const prefix = this.config.toolPrefix || '';
    return Object.keys(CAPABILITIES.tools).map((name) => `${prefix}${name}`);
  }

  // ── core 装载（N3 的模块；缺失则 fail-closed） ──────────────
  /** 打开 core↔state 桥（含 configureCore）；失败只记录，不阻断工具面。 */
  async persistence(): Promise<CorePersistence | null> {
    if (!this.persistenceRef && !this.persistenceError) {
      try {
        const dir = path.resolve(this.stateDir, this.config.persistenceDir || 'core-state');
        this.persistenceRef = await CorePersistence.open({
          dir,
          mode: this.config.persistence === 'node' ? 'node' : 'memory',
          owner: 'dsh-l0-control',
          waitMs: Number((this.config as { lockWaitMs?: number }).lockWaitMs ?? 15000),
          ttlMs: Number((this.config as { lockTtlMs?: number }).lockTtlMs ?? 1800000),
          // 单文件有 512 MB 物理上限（V8 MAX_STRING_LENGTH），超过根本读不进来。
          // 0 = 不滚动（显式关掉）；未配置时由 N4 用默认 64 MB。
          segmentMaxBytes: Number((this.config as { journalSegmentMaxBytes?: number }).journalSegmentMaxBytes ?? 0),
        });
      } catch (error) {
        this.persistenceError = String((error as { message?: string })?.message || error);
      }
    }
    return this.persistenceRef;
  }

  /**
   * 落盘（**不吞错**）：返回 `{appended, revision, cursor, deferred, error}`；
   * 失败时把 `{code,message}` 记进 `persistenceError`，由 `graph_status.persistence.error` 透出。
   */
  async persist(): Promise<{
    appended: number;
    revision: number;
    cursor: number;
    deferred?: number;
    error?: { code: string | null; message: string } | null;
  } | null> {
    const persistence = await this.persistence();
    if (!persistence) {
      return { appended: 0, revision: 0, cursor: 0, error: { code: 'PERSISTENCE_UNAVAILABLE', message: this.persistenceError ?? 'not-opened' } };
    }
    try {
      const outcome = await persistence.persist();
      this.persistenceError = outcome?.error ? `${outcome.error.code}: ${outcome.error.message}` : null;
      return outcome;
    } catch (error) {
      const info = { code: (error as { code?: string })?.code ?? null, message: String((error as { message?: string })?.message || error) };
      this.persistenceError = `${info.code}: ${info.message}`;
      return { appended: 0, revision: persistence.snapshot().revision, cursor: persistence.snapshot().coreCursor, error: info };
    }
  }

  /**
   * 插件卸载 / disable 时调用：**释放 journal lock**（STATE_LOCKED 的根治点）。
   * 幂等；即使落盘失败也会 close（N4 的 close 负责释放锁）。
   */
  async dispose(): Promise<{ closed: boolean; error: string | null }> {
    // 协调器必须先停：它是唯一「没有调用者」的写者，留着会在 dispose 之后继续
    // 触碰已关闭的 persistence，把关闭过程搅成假错误。
    this.stopCoordinator();
    const persistence = this.persistenceRef;
    this.persistenceRef = null;
    if (!persistence) return { closed: false, error: null };
    try {
      await persistence.close({ snapshot: true });
      this.persistenceError = null;
      return { closed: true, error: null };
    } catch (error) {
      const message = String((error as { message?: string })?.message || error);
      this.persistenceError = message;
      return { closed: false, error: message };
    }
  }

  async core(): Promise<CoreModule | null> {
    if (!this.corePromise) {
      this.corePromise = (async () => {
        try {
          // 先开桥：configureCore 必须在任何 core 调用前完成，否则 core 会用自己的内存单例
          await this.persistence();
          const mod = await import('./core/index.js');
          // core/index 只有具名导出；`default` 是给将来「带 default 的变体」留的兼容口，
          // 所以按「可能不存在」声明（运行时行为不变：mod.default ?? mod）。
          const shape = mod as unknown as CoreModule & { default?: CoreModule };
          return (shape?.default ?? shape) as CoreModule;
        } catch {
          return null;
        }
      })();
    }
    return this.corePromise;
  }

  private async withCore(
    action: string,
    fn: (core: CoreModule) => unknown | Promise<unknown>,
  ): Promise<unknown> {
    const core = await this.core();
    if (!core) {
      return {
        ok: false,
        error: 'core-unavailable',
        action,
        hint: 'src/core 归 N3；core 缺失时插件不得假装成功',
        stateAuthority: 'plugin-journal',
      };
    }
    try {
      const persistence = await this.persistence();
      if (!persistence) throw new Error(`persistence-unavailable: ${this.persistenceError ?? 'not-opened'}`);
      const result = core.withCoreStore
        ? await core.withCoreStore(persistence.coreStore, () => fn(core))
        : await fn(core);
      // core 的语义拒绝必须**冒泡**到顶层 ok，否则调用方会把 {ok:true, result:{ok:false}} 当成功
      const rejected = Boolean(result && typeof result === 'object' && (result as { ok?: unknown }).ok === false);
      if (rejected) {
        const typed = result as { error?: string; hint?: string };
        return sanitizeForHost(
          {
            ok: false,
            action,
            error: typed.error ?? 'core-rejected',
            result,
            ...(typed.hint ? { hint: typed.hint } : {}),
            persistence: await this.persist(),
          },
          (dropPath, reason) => this.logHostDrop(action, dropPath, reason),
        );
      }
      const persisted = await this.persist();
      if (persisted?.error) {
        return sanitizeForHost(
          { ok: false, action, error: 'persistence-failed', result, persistence: persisted },
          (dropPath, reason) => this.logHostDrop(action, dropPath, reason),
        );
      }
      return sanitizeForHost(
        { ok: true, action, result, persistence: persisted },
        (dropPath, reason) => this.logHostDrop(action, dropPath, reason),
      );
    } catch (error) {
      /**
       * core 抛出的**带类型拒绝**必须原码上浮。
       *
       * 原来这里一律压成 `error: 'core-failed'`，于是 `graph_capacity`、
       * `partition_capacity`、`rate_limited`、`budget_exceeded` 四个语义完全不同的
       * 拒绝在顶层长得一模一样：调用方拿到的 `error` 全是 `core-failed`，
       * 真正的码只剩在 `detail.code` 里，而 worker 契约判的是顶层 `error`——
       * 结果「分区满员该换域」与「预算耗尽该人工介入」被当成同一个未知码退避。
       *
       * 现在：有码用码，无码才是 `core-failed`；`gate` 一并上浮，与派活计划层同词汇。
       */
      const info = errorInfo(error);
      const code = typeof info.code === 'string' && info.code ? info.code : 'core-failed';
      return sanitizeForHost(
        {
          ok: false,
          action,
          error: code,
          detail: info,
          ...(info.gate ? { gate: info.gate } : {}),
          persistence: await this.persist(),
        },
        (dropPath, reason) => this.logHostDrop(action, dropPath, reason),
      );
    }
  }

  /** 记录被 `sanitizeForHost` 归一化掉的路径：排查「哪个字段不是 lossless」的唯一线索。 */
  private logHostDrop(action: string, dropPath: string, reason: string): void {
    try {
      this.ensureStateDir();
      fs.appendFileSync(
        path.join(this.stateDir, 'lossless-drops.log'),
        `${new Date().toISOString()}\t${action}\t${dropPath}\t${reason}\n`,
        'utf8',
      );
    } catch {
      // 观测失败不影响返回值
    }
  }

  // ── journal（append-only；N4 会把它升级成带 revision 的权威日志） ──
  ensureStateDir(): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
  }

  appendJournal(kind: string, payload: Record<string, unknown>): Record<string, unknown> {
    this.ensureStateDir();
    const row = { at: new Date().toISOString(), kind, ...payload };
    fs.appendFileSync(this.journalPath, JSON.stringify(row) + '\n', 'utf8');
    return row;
  }

  /**
   * 读全量 journal 行（用于实例表回放、UI 黑板）。
   *
   * **增量**：journal 在本层是 append-only 的（`appendJournal` 只追加），所以
   * 「已读到的字节数 + 已解析的行」可以缓存；下一次只要文件变长就从断点续读。
   *
   * 为什么必须增量：70000 行 / 13 MB 时全量读 + 逐行 JSON.parse 是 **86 ms**，
   * 而派发登记推导、UI 快照、实例回放都各要读一遍——一个 tick 就吃掉几百毫秒，
   * 千级规模下这会直接变成吞吐上限。全量口径保留给「文件变短」（旋转/截断）时的兜底。
   *
   * ⚠️ 本方法返回**全量副本**（`journalRows().slice()`）。`dispatchView()` 一次
   * 调用里曾被它调 4 次，合计拷贝 285600 个元素引用，而四处**没有一处需要全量副本**。
   * 现在只剩真正需要全量数组的调用方（实例表回放、UI 黑板摘要）用它；只要总数用
   * `journalLength()`、只要尾部增量用 `journalTail()`、只读扫一遍用 `journalRows()`。
   */
  readJournal(): Array<Record<string, unknown>> {
    return this.journalRows().slice();
  }

  /**
   * journal 的**总行数**（只 stat + 必要时续读，不拷贝数组）。
   *
   * 与 `readJournal().length` 的区别：后者在 71400 行时要拷 71400 个引用
   * （实测 0.35 ms）。而 `dispatchView()` 一次调用里 `readJournal()` 被调 4 次
   * （`enqueueState` / `usedDispatchQuota` / `lastTick` / `gateHistory`），
   * 合计拷贝 285600 个元素——**全部只为了拿一个 length 和一段尾巴**。
   */
  journalLength(): number {
    return this.journalRows().length;
  }

  /**
   * 尾部新增：`rows[fromIndex..]`（**拷贝**，长度 = 总行数 − fromIndex）。
   *
   * 这是增量折叠的正确入口：`enqueueState` 与 `gateHistory` 都只要「上次之后
   * 新增的那几行」，而 `readJournal().slice(cursor)` 会先拷全量再切——拷的
   * 99% 是它们即将丢掉的部分。
   *
   * `fromIndex` 大于总行数（journal 被截断/旋转）时返回空数组，调用方据此
   * 整块重折。传 0 即等价于 `readJournal()`。
   */
  journalTail(fromIndex: number): Array<Record<string, unknown>> {
    const rows = this.journalRows();
    const start = Number.isFinite(fromIndex) && fromIndex > 0 ? Math.floor(fromIndex) : 0;
    if (start >= rows.length) return [];
    return rows.slice(start);
  }

  /**
   * journal 缓存本体（**只读**，不拷贝）。
   *
   * 只给「纯读、且会就地扫一遍全部行」的调用方用——比如从尾部往前找最后一条
   * `dispatch_tick`、从尾部往前数速率窗口。这类场景连 `slice()` 都是浪费：
   * 它们既不改数组也不持有引用。
   *
   * 契约：**不得修改返回的数组**（push/splice/sort/reverse 都会污染缓存，
   * 让后续所有读者看到假数据）。行对象本身已在 `readJournalSlice` 里浅冻结。
   * 需要副本的调用方用 `readJournal()`。
   */
  journalRows(): Array<Record<string, unknown>> {
    if (!fs.existsSync(this.journalPath)) {
      this.journalCursor = { bytes: 0, rows: [], skipped: 0, tailBad: false, pending: 0 };
      return this.journalCursor.rows;
    }
    let size = 0;
    try {
      size = fs.statSync(this.journalPath).size;
    } catch {
      size = 0;
    }
    const cursor = this.journalCursor;
    // 文件变短 = 被截断/替换：缓存失效，全量重读。
    if (!cursor || size < cursor.bytes) {
      this.journalCursor = { bytes: 0, rows: [], skipped: 0, tailBad: false, pending: 0 };
      this.readJournalSlice(0);
      return this.journalCursor!.rows;
    }
    if (size !== cursor.bytes) this.readJournalSlice(cursor.bytes);
    return this.journalCursor!.rows;
  }

  /**
   * 从 `fromByte` 起续读，把新行并入缓存。
   *
   * 返回的是**缓存数组本身**（就地 `push`），不是副本——`journalRows()` 依赖这一点
   * 才能做到「两次调用返回同一数组」。要副本的调用方走 `readJournal()`。
   */
  private readJournalSlice(fromByte: number): Array<Record<string, unknown>> {
    let fd: number | null = null;
    try {
      fd = fs.openSync(this.journalPath, 'r');
      const stat = fs.fstatSync(fd);
      const length = Math.max(0, stat.size - fromByte);
      if (length === 0) return this.journalCursor?.rows ?? [];
      const buffer = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buffer, 0, length, fromByte);
      const chunk = buffer.subarray(0, read).toString('utf8');
      // 只消费到最后一个换行为止：末行可能正在被写（撕裂写），留到下次。
      const lastBreak = chunk.lastIndexOf('\n');
      const consumable = lastBreak < 0 ? '' : chunk.slice(0, lastBreak + 1);
      // 残留字节数：还没换行的尾巴。**它不是行**，不能算进 events，但必须让
      // `journalSummary()` 知道「文件末尾还有东西没成行」——否则并发写入期间
      // 摘要会安静地报上一行的 kind，看起来像"最后发生的就是那件事"。
      const pending = Buffer.byteLength(lastBreak < 0 ? chunk : chunk.slice(lastBreak + 1), 'utf8');
      const rows = this.journalCursor?.rows ?? [];
      let bad = 0;
      // 尾部坏行判定必须在解读循环里顺手记：出了循环再 `JSON.parse` 一遍
      // 等于把最后一行解析两次，而这一行的解析刚刚才失败过。
      let tailBad = this.journalCursor?.tailBad ?? false;
      for (const line of consumable.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object') {
            // 冻结（浅）：行对象在缓存与调用方之间**共用**。
            // 不冻结的话调用方 `row.nodeId = x` 就把缓存里的历史改了，之后每次读都是假数据。
            // 浅冻结够用：所有消费者只读顶层字段（kind/nodeId/at/instanceId…），
            // 嵌套 payload 无人就地改；深冻结会让解析成本翻倍而收益为零。
            rows.push(Object.freeze(parsed));
            tailBad = false;
          } else {
            bad += 1;
            tailBad = true;
          }
        } catch {
          // 坏行跳过（与旧行为一致）：journal 是投影来源，坏一行不该让整块面板/派发失效。
          // 但要**计数**并记住尾部是否坏：`journalSummary()` 的 `events` / `lastKind`
          // 若只按解析成功数算，就会在有坏行时与真实文件内容不一致——而"少了一行"
          // 恰恰是最难在 10 万行 journal 里查出来的那种问题。
          bad += 1;
          tailBad = true;
        }
      }
      this.journalCursor = {
        bytes: fromByte + Buffer.byteLength(consumable, 'utf8'),
        rows,
        skipped: (this.journalCursor?.skipped ?? 0) + bad,
        tailBad,
        pending,
      };
      return rows;
    } catch {
      return this.journalCursor?.rows ?? [];
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // 关不掉不影响结果
        }
      }
    }
  }

  /**
   * journal 摘要：`events` = 可解析行数 + 被跳过的坏行数（两者都算「文件里的事件」）。
   *
   * 旧实现每次 `readFileSync(...).split('\n').filter(...)`：70000 行实测 **22.5 ms**，
   * 而 `journalSummary()` 在 `status()` / `dispatchView()` 的 hint 里、每次 UI 快照
   * 都要被调——它是这条读路径上**唯一**还在全量重读的方法（读 + 切分 + 过滤三个
   * 全量拷贝）。缓存里已经有现成的行数，`statSync` 一次就够。
   *
   * 坏行必须计入 `events`：读路径按「解析成功的行」累计，若摘要只报成功数，
   * 两者会在有坏行时不一致——而"少了一行"恰恰是最该被发现的那种问题。
   */
  journalSummary(): { path: string; events: number; lastKind: string | null } {
    if (!fs.existsSync(this.journalPath)) return { path: this.journalPath, events: 0, lastKind: null };
    let rows: Array<Record<string, unknown>>;
    let skipped = 0;
    let tailBad = false;
    let pending = 0;
    try {
      rows = this.journalRows();
      skipped = this.journalCursor?.skipped ?? 0;
      tailBad = this.journalCursor?.tailBad ?? false;
      pending = this.journalCursor?.pending ?? 0;
    } catch {
      // 读失败（权限/竞态）：按「什么都没读到」返回。摘要用于排障，
      // 它自己崩掉就没人能看现场了——所以这里不抛。
      return { path: this.journalPath, events: 0, lastKind: null };
    }
    const events = rows.length + skipped;
    if (events === 0 && pending === 0) return { path: this.journalPath, events: 0, lastKind: null };
    // `lastKind` 有三种「不是正常 kind」的情形，都归为 `unparsable`（沿用旧口径）：
    //   - 末个已完成的行就是坏的（`tailBad`）；
    //   - 尾部有尚未换行的残留字节（`pending`）：正在写，还构不成一行，
    //     此时报上一行会让人以为"最后一件事是 dispatch_tick"，而实际上后面还有东西；
    //   - 一条行都没有却又有内容。
    // `events` 只数**已完成**的行（含坏行），不含 `pending`——那不是行。
    const lastKind = tailBad || pending > 0 || rows.length === 0
      ? 'unparsable'
      : String(rows[rows.length - 1]?.kind ?? 'unknown');
    return { path: this.journalPath, events, lastKind };
  }

  // ── 9 个工具的实现 ─────────────────────────────────────────
  async wishSubmit(input: { text: string; maxParallel?: number; budgetTokens?: number }) {
    if (!input?.text || !String(input.text).trim()) {
      return { ok: false, error: 'wish-text-required' };
    }
    this.appendJournal('wish_submitted', {
      text: String(input.text),
      maxParallel: input.maxParallel ?? this.config.maxParallel,
      budgetTokens: input.budgetTokens ?? this.config.defaultBudgetTokens,
    });
    return this.withCore('wish_submit', (core) =>
      core.submitWish
        ? core.submitWish({ text: String(input.text), maxParallel: input.maxParallel, budgetTokens: input.budgetTokens })
        : Promise.resolve({ delegated: false, reason: 'core.submitWish 未实现' }),
    );
  }

  /**
   * 工作图**组成因子**：`graph_plan` —— 纯校验 + 预览（errors/warnings/ready），零写入。
   * 不做固定模板：节点/依赖由调用方按需求给出。
   */
  async graphPlan(input: { spec?: Record<string, unknown>; nodes?: unknown[]; wish?: string; policies?: Record<string, unknown>; designBoundary?: Record<string, unknown>; coordination?: Record<string, unknown> }) {
    const spec = input?.spec ?? { wish: input?.wish ?? '', nodes: input?.nodes ?? [], policies: input?.policies ?? {}, designBoundary: input?.designBoundary, coordination: input?.coordination };
    this.appendJournal('graph_plan_preview', {
      wish: String((spec as { wish?: string }).wish ?? '').slice(0, 200),
      nodes: Array.isArray((spec as { nodes?: unknown[] }).nodes) ? ((spec as { nodes: unknown[] }).nodes as unknown[]).length : 0,
    });
    return this.withCore('graph_plan', (core) =>
      core.graphPlan ? core.graphPlan(spec) : Promise.resolve({ delegated: false, reason: 'core.graphPlan 未实现' }),
    );
  }

  /** 工作图组成因子：`graph_commit` —— 校验通过后落图；同一份图重复提交幂等。 */
  async graphCommit(input: { spec?: Record<string, unknown>; nodes?: unknown[]; wish?: string; policies?: Record<string, unknown>; designBoundary?: Record<string, unknown>; coordination?: Record<string, unknown> }) {
    const spec = input?.spec ?? { wish: input?.wish ?? '', nodes: input?.nodes ?? [], policies: input?.policies ?? {}, designBoundary: input?.designBoundary, coordination: input?.coordination };
    const result = await this.withCore('graph_commit', (core) =>
      core.graphCommit ? core.graphCommit(spec) : Promise.resolve({ delegated: false, reason: 'core.graphCommit 未实现' }),
    );
    const row = result as { ok?: boolean; committed?: boolean; idempotent?: boolean; counts?: unknown; errors?: unknown };
    this.appendJournal('graph_committed', {
      ok: row?.ok === true,
      committed: row?.committed === true,
      idempotent: row?.idempotent === true,
      counts: row?.counts ?? null,
      errors: Array.isArray(row?.errors) ? (row.errors as unknown[]).length : 0,
    });
    return result;
  }

  // ── 子 Agent（递归）快照：team_snapshot 不含 descendants，单独持久化 ──
  /** 从 journal 恢复每个 session 最后一条 `descendants_snapshot`。 */
  private restoreDescendantSnapshots(): void {
    try {
      if (!fs.existsSync(this.journalPath)) return;
      for (const row of this.readJournal()) {
        if (row?.kind !== 'descendants_snapshot') continue;
        const sessionId = String(row.sessionId ?? '');
        if (!sessionId) continue;
        this.descendantSnapshots.set(sessionId, {
          count: Number(row.count ?? 0) || 0,
          active: Number(row.active ?? 0) || 0,
          at: String(row.at ?? ''),
          items: Array.isArray(row.items) ? (row.items as unknown[]) : [],
        });
      }
    } catch {
      // 恢复失败 → 只能显示 —（不伪造 0）
    }
  }

  /** `teamStatus` 成功后异步抓一次递归子 Agent 数，落 `descendants_snapshot`。 */
  private async captureDescendants(sessionId: string, caller: any): Promise<void> {
    try {
      const subagents = this.ctx.get?.('subagents');
      if (!sessionId || !caller?.id || typeof subagents?.listDescendants !== 'function') return;
      const rows = await subagents.listDescendants(caller.id);
      const items = Array.isArray(rows) ? rows : [];
      const children = items.filter((row: any) => row?.kind === 'child');
      const record = {
        count: children.length,
        active: children.filter((row: any) => row?.activity === 'running').length,
        at: new Date().toISOString(),
        items: children.slice(0, 60).map((row: any) => ({
          id: row.id ?? null,
          parentId: row.parentId ?? null,
          depth: row.depth ?? null,
          mode: row.mode ?? null,
          label: row.label ?? null,
          activity: row.activity ?? null,
        })),
      };
      this.descendantSnapshots.set(sessionId, record);
      try {
        this.appendJournal('descendants_snapshot', { sessionId, ...record });
      } catch {
        // 落盘失败不影响返回
      }
    } catch {
      // 抓取失败保持上一次快照
    }
  }

  // ── 按对话（session）双开关：协作 coordination / 工作区管理 management ──
  /** 恢复：按 journal 逐 session 重建（后写覆盖）；旧记录只有 `enabled` 时迁移为 coordination + management='off'。 */
  private restoreAccess(): void {
    try {
      if (!fs.existsSync(this.journalPath)) return;
      for (const row of this.readJournal()) {
        if (row?.kind !== 'access_changed') continue;
        const sessionId = String(row.sessionId ?? '');
        if (!sessionId) continue;
        const migrated = !('coordination' in row);
        this.enabledSessions.set(sessionId, {
          coordination: migrated ? row.enabled === true : row.coordination === true,
          management: migrated ? 'off' : normalizeManagement(row.management),
          at: String(row.at ?? ''),
          by: row.by ? String(row.by) : null,
        });
      }
      // 恢复不等价于「刚启用」——但**放开 Team 上限的效果必须跟着状态走**，
      // 否则重载一次就把上限退回 16，而 coordination 看起来仍是开的：
      // 表现为所有 worker 突然变成 ownerCapable:false，一次报错都不留。
      // 所以恢复后若存在已启用的会话，补一次放开（幂等：已够大就只记 kept）。
      if ([...this.enabledSessions.values()].some((row) => row.coordination)) {
        this.raiseTeamMemberLimit('restore-access');
      }
    } catch {
      // 恢复失败 → 全部按默认（协作关、管理 off）处理（fail-closed）
    }
  }

  /** guard 只看协作：没有记录 / coordination=false 都算未启用。 */
  isSessionEnabled(sessionId: string | null | undefined): boolean {
    const id = String(sessionId ?? '');
    if (!id) return false;
    const explicit = this.enabledSessions.get(id);
    return explicit ? explicit.coordination === true : this.workspaceCoordinationDefault === true;
  }

  /** 工作区第一次启用集群后，设为默认；显式 session 记录仍然覆盖。 */
  setWorkspaceCoordinationDefault(value: boolean): void {
    this.workspaceCoordinationDefault = value === true;
  }

  setWorkspaceClusterInfo(input: { clusterId?: string | null; coordinationDefault?: boolean }): void {
    if (input?.clusterId !== undefined) this.workspaceClusterId = input.clusterId ? String(input.clusterId) : null;
    if (input?.coordinationDefault !== undefined) this.workspaceCoordinationDefault = input.coordinationDefault === true;
  }

  get workspaceCluster(): { clusterId: string | null; coordinationDefault: boolean } {
    return { clusterId: this.workspaceClusterId, coordinationDefault: this.workspaceCoordinationDefault };
  }

  /** 该对话的工作区管理态：`off`（默认）| `auto` | `on`。 */
  managementFor(sessionId: string | null | undefined): ManagementMode {
    const id = String(sessionId ?? '');
    if (!id) return 'off';
    return this.enabledSessions.get(id)?.management ?? 'off';
  }

  /**
   * 启用/停用：两个轴独立更新（只传一个轴时另一个保持不变）。
   * 每次变更落 journal `access_changed {sessionId, coordination, management, at, by}`。
   */
  setSessionAccess(
    sessionId: string,
    patch: { coordination?: boolean; management?: ManagementMode | string },
    by?: string,
  ) {
    const id = String(sessionId ?? '').trim();
    if (!id) return { ok: false, error: 'session-id-required' };
    const current = this.enabledSessions.get(id) ?? { coordination: false, management: 'off' as ManagementMode, at: '', by: null };
    const coordination = typeof patch?.coordination === 'boolean' ? patch.coordination : current.coordination;
    const management = patch?.management === undefined ? current.management : normalizeManagement(patch.management);
    const at = new Date().toISOString();
    const record = { coordination, management, at, by: by ? String(by) : null };
    this.enabledSessions.set(id, record);
    try {
      this.appendJournal('access_changed', { sessionId: id, coordination, management, at, by: record.by });
    } catch {
      // journal 写失败不改变内存态，但下次 reload 会回到旧值
    }
    // 启用协作即**自动放开宿主的 Team 成员上限**——这是本插件唯一的「开关」。
    //
    // 为什么放在这里而不是加一个独立配置开关：Team 上限是宿主的（`agentTeams` 的
    // `maxMembers`，默认 16），而「用本插件跑集群」本身就意味着要超过它。
    // 再加一个「是否放开」的开关，等于让使用者有机会把自己配成一个**必然降级**的状态，
    // 而那个状态的表现（`ownerCapable:false`）很难在事后归因。
    // 所以：**开插件 = 放开上限；关协作 = 不动宿主**。
    if (coordination) {
      this.raiseTeamMemberLimit('coordination-enabled');
      // 同一时刻放开**真并发天花板**：Team 成员数（256）与子会话并发数（默认 8）
      // 是两层不同的限制，只放开前者仍只有 8 个子会话能同时活。
      this.raiseSubagentCapacity('coordination-enabled');
    }
    return { ok: true, sessionId: id, coordination, management, enabled: coordination, at, by: record.by };
  }

  /**
   * 把宿主 `agentTeams` 的成员上限提到插件配置的目标值。
   *
   * 事实依据（从 `app.asar` 源码读出，不是猜）：上限是 Cordis 的 **Config 项**
   * `agentTeams.maxMembers`（`z.number().default(16)`），检查点是
   * `if (state.members.length >= this.maxMembers) throw TeamError('TEAM_MEMBER_LIMIT')`，
   * 而它被传给 `TeamRoster` 的**公开字段** `maxMembers`。
   *
   * 所以有两条路：
   *   1. 改配置 + 重载插件（干净，但要重启）；
   *   2. 运行时改 `roster.maxMembers`（立即生效，但依赖内部字段名）。
   * 这里两条都试：先试运行时字段（立即可用），失败就只留一条 journal 提示让人去改配置。
   * **任何失败都不阻断启用**——放开上限是优化，不是启用协作的前提。
   */
  /**
   * 一次性确保宿主子会话并发上限已放开（工具入口兜底用）。
   *
   * 为什么需要两处触发：`restoreAccess()` 管重载路径，这里管运行期。
   * 只要漏一处，就会出现「coordination 看着是开的，但 worker 全是 ownerCapable:false」
   * ——一个不报错、只在能力上悄悄降级的状态。
   */
  private teamLimitEnsured = false;

  ensureTeamLimitOnce(reason: string): void {
    if (this.teamLimitEnsured) return;
    this.teamLimitEnsured = true;
    try { this.reportHostServicesOnce(reason); } catch { /* 自检失败不影响工具调用 */ }
    try { this.reportStorageOnce(reason); } catch { /* 同上 */ }
    try { this.raiseTeamMemberLimit(reason); } catch { /* 放开失败不影响工具调用 */ }
    try { this.raiseSubagentCapacity(reason); } catch { /* 同上 */ }
  }

  /**
   * 把宿主 `subagents.maxActiveSubagents` 调大 —— **这才是「千 Agent」的真正天花板**。
   *
   * 事实依据（从 `app.asar` 读源码，不是猜）：
   * ```js
   * static Config = z.object({
   *   maxDepth:            z.number().default(1).volatile(),
   *   maxActiveSubagents:  z.number().min(1).max(MAX_SAFE_INTEGER).default(8).volatile(),
   * })
   * // 每次开新子会话时现读，不是构造时快照：
   * const releaseSlot = pool.reserve(this.maxActiveSubagents())   // = () => config.maxActiveSubagents.get()
   * ```
   *
   * 所以它是**活引用**：改完立即生效，不需要重启宿主（这一点和 Team 的 `maxMembers`
   * 不同——那个是构造时传入 roster 的）。
   *
   * 为什么必须动它：`maxParallel` 配 64、`maxMembers` 配 256 都没用——**实际只有 8 个子会话
   * 能同时活**，第 9 个起报 `subagent limit reached (active child limit: 8)`。
   * 不放开这一层，「1000 个 Agent 协作」只是名义上的：派不出 1000 个，只能分批。
   *
   * 失败不阻断（放开是优化，不是启用前提），但一定留痕，绝不谎报成功。
   */
  raiseSubagentCapacity(reason: string): { ok: boolean; from?: number; to?: number; detail?: string } {
    const target = Number(this.config.subagentMaxActive);
    if (!Number.isFinite(target) || target <= 0) return { ok: false, detail: 'disabled' };
    const read = (ref: any): number => {
      const raw = typeof ref?.get === 'function' ? ref.get() : (ref as number);
      return Number(raw);
    };
    try {
      const subagents = this.ctx.get('subagents') as any;
      const ref = subagents?.config?.maxActiveSubagents;
      if (ref === undefined || ref === null) {
        this.appendJournal('subagent_capacity_unavailable', { reason, target, detail: 'subagents.config.maxActiveSubagents 不可达' });
        return { ok: false, detail: 'ref-unreachable' };
      }
      const from = read(ref);
      if (Number.isFinite(from) && from >= target) {
        this.appendJournal('subagent_capacity_kept', { reason, from, target });
        return { ok: true, from, to: from };
      }
      // Cordis 的 config 项是响应式 Ref；按可用 API 依次尝试，兼容不写死某一种形状。
      if (typeof ref.set === 'function') ref.set(target);
      else if (typeof ref === 'object' && 'value' in ref) (ref as any).value = target;
      else subagents.config.maxActiveSubagents = target;
      // **回读确认**：不假设赋值成功（只读/被包一层时赋值会静默失效）。
      const after = read(ref);
      if (!Number.isFinite(after) || after < target) {
        this.appendJournal('subagent_capacity_failed', { reason, from, target, after, detail: '赋值未生效' });
        return { ok: false, from, detail: `赋值未生效：${after}` };
      }
      this.appendJournal('subagent_capacity_raised', { reason, from, to: after, by: 'plugin-config' });
      return { ok: true, from, to: after };
    } catch (error) {
      const detail = String((error as Error)?.message ?? error);
      try { this.appendJournal('subagent_capacity_failed', { reason, target, detail }); } catch { /* 观测失败不阻断 */ }
      return { ok: false, detail };
    }
  }

  raiseTeamMemberLimit(reason: string): { ok: boolean; from?: number; to?: number; detail?: string } {
    const target = Number(this.config.teamMemberLimit);
    if (!Number.isFinite(target) || target <= 0) return { ok: false, detail: 'disabled' };
    try {
      const teams = this.ctx.get('agentTeams') as any;
      const roster = teams?.roster;
      if (!roster || typeof roster !== 'object') {
        this.appendJournal('team_limit_unavailable', { reason, target, detail: 'agentTeams.roster 不可达' });
        return { ok: false, detail: 'roster-unreachable' };
      }
      const from = Number(roster.maxMembers);
      if (Number.isFinite(from) && from >= target) {
        this.appendJournal('team_limit_kept', { reason, from, target });
        return { ok: true, from, to: from };
      }
      roster.maxMembers = target;
      // 重新读一次，确认写入真的生效（不假设赋值成功）
      const after = Number(roster.maxMembers);
      if (!Number.isFinite(after) || after < target) {
        this.appendJournal('team_limit_failed', { reason, from, target, after, detail: '赋值未生效' });
        return { ok: false, from, detail: `赋值未生效：${after}` };
      }
      this.appendJournal('team_limit_raised', { reason, from, to: after, by: 'plugin-config' });
      return { ok: true, from, to: after };
    } catch (error) {
      const detail = String((error as Error)?.message ?? error);
      try { this.appendJournal('team_limit_failed', { reason, target, detail }); } catch { /* 观测失败不阻断 */ }
      return { ok: false, detail };
    }
  }

  /** 兼容旧入口：只改协作轴（第一次入口 / 旧调用点）。 */
  setSessionEnabled(sessionId: string, enabled: boolean, by?: string) {
    return this.setSessionAccess(sessionId, { coordination: enabled === true }, by);
  }

  /** 访问态势：`default` 恒为「协作关 + 管理 off」，`sessions` 只列有显式记录的。 */
  accessSnapshot() {
    return {
      default: 'disabled' as const,
      managementDefault: 'off' as const,
      sessions: [...this.enabledSessions.entries()]
        .map(([sessionId, value]) => ({
          sessionId,
          coordination: value.coordination,
          enabled: value.coordination,
          management: value.management,
          at: value.at,
          by: value.by,
        }))
        .sort((a, b) => String(b.at).localeCompare(String(a.at))),
    };
  }

  /** 某个对话的双轴状态（给 UI 侧车 / 面板用）。 */
  accessFor(sessionId?: string | null) {
    const id = sessionId ? String(sessionId) : null;
    return {
      ok: true,
      sessionId: id,
      coordination: id ? this.isSessionEnabled(id) : false,
      enabled: id ? this.isSessionEnabled(id) : false,
      management: id ? this.managementFor(id) : ('off' as ManagementMode),
      default: 'disabled' as const,
      managementDefault: 'off' as const,
    };
  }

  /**
   * 检查更新（**只检查，不自动 apply**）。
   *
   * 读本地插件 `package.json` 的 version，拉 `raw.githubusercontent.com/<repo>/<ref>/plugins/dsh-l0-control/package.json`，
   * 做 semver 比较。网络失败 / 404 / 仓库没传 → `{ok:false, error}`（**不抛**）。
   * `fetchImpl` 可注入，便于测试。
   */
  async checkUpdate(options: { fetchImpl?: typeof fetch } = {}) {
    const repo = String(this.config.updateRepo ?? '').trim();
    const ref = String(this.config.updateRef ?? 'main').trim() || 'main';
    const currentVersion = readLocalVersion();
    const base = { repo, ref, currentVersion, latestVersion: null as string | null, available: false, url: null as string | null };
    if (!repo) {
      return { ...base, ok: false, error: 'update-repo-not-configured', message: '检查更新未配置仓库（updateRepo 为空）' };
    }
    const url = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/plugins/dsh-l0-control/package.json`;
    const fetchUrl = `https://api.github.com/repos/${repo}/contents/plugins/dsh-l0-control/package.json?ref=${encodeURIComponent(ref)}`;
    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
    if (typeof fetchImpl !== 'function') {
      return { ...base, ok: false, url, error: 'fetch-unavailable', message: '当前运行环境没有 fetch' };
    }
    try {
      const res = await fetchImpl(fetchUrl, { headers: { accept: 'application/vnd.github+json' } });
      if (res.status === 404) {
        return { ...base, ok: false, url, error: 'remote-not-found', message: '仓库里还没有发布版本（404）；上传后再检查' };
      }
      if (!res.ok) {
        return { ...base, ok: false, url, error: `http-${res.status}`, message: `远端返回 ${res.status}` };
      }
      const payload = (await res.json()) as { version?: string; content?: string; encoding?: string };
      let remote: { version?: string } = payload;
      if (typeof payload?.content === 'string' && payload.content) {
        try {
          remote = JSON.parse(Buffer.from(payload.content, 'base64').toString('utf8')) as { version?: string };
        } catch {
          return { ...base, ok: false, url, error: 'remote-version-missing', message: '远端 package.json 无法解析' };
        }
      }
      const latestVersion = String(remote?.version ?? '').trim();
      if (!latestVersion) {
        return { ...base, ok: false, url, error: 'remote-version-missing', message: '远端 package.json 没有 version' };
      }
      const cmp = compareSemver(latestVersion, currentVersion);
      return {
        ...base,
        ok: true,
        latestVersion,
        available: cmp > 0,
        url,
        ...(cmp > 0 ? {} : { message: '已是最新版本' }),
      };
    } catch (error) {
      return { ...base, ok: false, url, error: 'network-failed', message: String((error as Error)?.message ?? error) };
    }
  }

  /** O lane：注入观测层（`graph_status.observability` 由它派生）。 */
  attachObservability(obs: { projection?: (input?: Record<string, unknown>) => unknown; health?: () => unknown; snapshot?: () => unknown } | null) {
    this.observability = obs;
    return this;
  }

  /**
   * 派活循环控制。
   *
   * - 不传 mode：按当前配置返回一轮候选计划，不领取节点。
   * - 传 mode：切换模式（本会话内生效，不写配置文件；重启回到 config 默认值）
   *
   * 默认 `dispatchMode=off` + `dispatchDryRun=true`，即装好之后什么都不会自动发生。
   */
  /**
   * 在当前 core 作用域内回收过期租约，并把「回收」这一事实写进**扁平 journal**。
   *
   * 为什么两本账都要写：租约本体在 core store（N4 哈希链 journal）里，`expire()`
   * 会在那边记 `lease_expired`；而派发登记（`dispatch/enqueue-state.ts`）折叠的是
   * 扁平 service journal。少了这一行，节点虽然回到 ready，但登记仍然是 `live`，
   * `enqueuePlan` 会以 `already-enqueued` 跳过它——节点重新可就绪，却再也不会被派出去。
   *
   * 前置条件：调用方必须**已持有 core 作用域**（`withCore` 回调体内部）。
   * 返回被回收的 nodeId 列表（本轮可真派发），无过期租约时返回空数组且零写入。
   */
  private reapLeasesInScope(core: { reapExpiredLeases?: (raw?: Record<string, unknown>) => unknown }, now: number): string[] {
    if (typeof core.reapExpiredLeases !== 'function') return [];
    const report = core.reapExpiredLeases({ now }) as { reaped?: unknown; orphans?: unknown } | null;
    const reaped = Array.isArray(report?.reaped) ? (report.reaped as string[]) : [];
    // 孤儿清扫（submitted 且无租约）是同一轮 reap 的另一半，必须一起报出来：
    // 只报 `reaped` 会让运维以为「没有要回收的」，而实际上刚刚救回了几个卡死节点。
    const orphans = Array.isArray(report?.orphans) ? (report.orphans as string[]) : [];
    const at = new Date(now).toISOString();
    for (const nodeId of reaped) {
      this.appendJournal('lease_reaped', { nodeId, at, reason: 'lease_expired' });
    }
    for (const nodeId of orphans) {
      this.appendJournal('lease_reaped', { nodeId, at, reason: 'orphan_submitted' });
    }
    return [...reaped, ...orphans];
  }

  /**
   * 缓存「Lead 身份」的 caller。
   *
   * 为什么需要：协调器要自动派审计实例，而 `spawnAgent` 要求 live Agent 作 caller；
   * 定时器里没有 `exec.agent`。只有 Lead 能走 `spawnTeammate`，所以这里只记 Lead。
   * 记不到 Lead 时协调器**只做 reap、不派审计**（不猜、不降级成别的身份乱派）。
   */
  noteCaller(caller: any): void {
    if (!caller?.id) return;
    try {
      const role = this.ctx.get('agentTeams')?.membership?.(caller)?.role;
      if (role === 'lead') this.leadCaller = caller;
    } catch { /* 判不出身份就不记 */ }
  }

  /**
   * 常驻协调器：把「维护职责」从 dispatch 与 Lead 手里拿出来。
   *
   * 为什么需要它（三条都来自本轮实测）：
   *   1. **reap 挂错了地方** —— 只有 `dispatch` 会回收过期租约与孤儿，`mode:off` 时没人做。
   *      实测：重载后调 `task_next` 那 7 个孤儿毫无变化，改调 `dispatch` 才被清扫。
   *   2. **审计路由不可扩展** —— 8 个 worker 就产生 8 条需要 Lead 手工转发的审计请求；
   *      1000 个时代这件事不可能靠人做。
   *   3. worker 提交证据后就不再心跳，租约到期后没人接手。
   *
   * 它**不派活**（那是 dispatch 的职责），只做确定性维护：reap + 审计路由。
   * 全部是状态机规则、幂等、可断言——不引入第二个 LLM。
   */
  private coordinatorTimer: ReturnType<typeof setInterval> | null = null;
  private coordinatorBusy = false;
  /** nodeId → 上次派审计的时刻（防同一节点被反复派审计）。 */
  private auditRequests = new Map<string, number>();
  private leadCaller: any = null;

  ensureCoordinatorStarted(reason: string): void {
    if (this.config.coordinatorEnabled === false) return;
    if (this.coordinatorTimer) return;
    const everyMs = Math.max(5000, Number(this.config.coordinatorIntervalMs) || 30_000);
    this.coordinatorTimer = setInterval(() => {
      void this.coordinatorTick('interval').catch(() => null);
    }, everyMs);
    // 不阻止进程退出（否则测试与 CLI 会被定时器挂住）
    (this.coordinatorTimer as unknown as { unref?: () => void }).unref?.();
    try { this.appendJournal('coordinator_started', { everyMs, reason }); } catch { /* 观测失败不影响 */ }
  }

  stopCoordinator(): void {
    if (!this.coordinatorTimer) return;
    clearInterval(this.coordinatorTimer);
    this.coordinatorTimer = null;
    try { this.appendJournal('coordinator_stopped', {}); } catch { /* 同上 */ }
  }

  /**
   * 一轮维护：**先 reap，再按需派审计**。可手动调（测试/运维），也可由定时器调。
   *
   * 幂等：每轮重新算「应有状态」，做差集，不依赖上一轮的记忆（唯一例外是
   * `auditRequests` 的时间窗，用来防同一节点被反复派审计）。
   */
  async coordinatorTick(reason: string, caller?: any): Promise<Record<string, unknown>> {
    if (this.coordinatorBusy) return { ok: false, skipped: 'busy' };
    this.coordinatorBusy = true;
    const now = Date.now();
    const out: Record<string, unknown> = {
      ok: true,
      reason,
      at: new Date(now).toISOString(),
      reaped: [] as string[],
      auditDispatched: [] as string[],
      auditSkipped: [] as Array<{ nodeId: string; why: string }>,
    };
    try {
      // ① reap：过期租约 + 孤儿 submitted（不需要 caller）
      //
      // 必须走 `withCore`：`reapExpiredLeases` 内部用 `coreStore()`（AsyncLocalStorage），
      // 直接拿 CorePersistence 对象调会找不到 store。这一条踩过一次——
      // 直接把 persistence 传进 `reapLeasesInScope` 会静默返回空数组（`typeof !== 'function'`），
      // 表现成「tick 跑了但什么都没回收」，最难查。
      const report = await this.withCore('coordinator_reap', (core) => {
        const fn = (core as { reapExpiredLeases?: (raw?: Record<string, unknown>) => unknown }).reapExpiredLeases;
        return typeof fn === 'function' ? fn({ now: Date.now() }) : null;
      });
      const reapRows = (report as { result?: { reaped?: string[]; orphans?: string[] } })?.result ?? (report as { reaped?: string[]; orphans?: string[] }) ?? {};
      const reapedIds = Array.isArray(reapRows.reaped) ? reapRows.reaped : [];
      const orphanIds = Array.isArray(reapRows.orphans) ? reapRows.orphans : [];
      const at = new Date(now).toISOString();
      for (const nodeId of reapedIds) this.appendJournal('lease_reaped', { nodeId, at, reason: 'lease_expired' });
      for (const nodeId of orphanIds) this.appendJournal('lease_reaped', { nodeId, at, reason: 'orphan_submitted' });
      out.reaped = [...reapedIds, ...orphanIds];
      if ((out.reaped as string[]).length) await this.persist();

      // ② 审计路由：submitted 超时无人验 → 派审计实例
      //
      // **不能用 `|| 默认值`**：`Number(0) || 120000` 会把「0 = 关闭自动审计」这个语义吃掉，
      // 变成 120000，于是「关掉」反而等于「两分钟后派」。这类 falsy 覆盖是配置项最常见的坑。
      const rawAfter = Number(this.config.auditDispatchAfterMs);
      const afterMs = Number.isFinite(rawAfter) ? Math.max(0, rawAfter) : 120_000;
      // `afterMs === 0` = 显式关闭自动审计（只 reap，不派）。
      if (afterMs <= 0) {
        this.appendJournal('coordinator_tick', { at: out.at, reason, reaped: out.reaped, auditDispatched: [], skipped: 0, auditRouting: 'disabled' });
        return out;
      }
      const lead = caller ?? this.leadCaller;
      const role = String(this.config.auditRole || 'AUDIT_CODE').toUpperCase();
      const full = await this.coreNodes();
      // 防重复派审计的窗口**不能**复用 `afterMs`：`afterMs` 是「多久算超时」的触发条件，
      // 若把它也当冷却窗，配置成 1 秒就会每秒给同一节点派一个新审计实例（实测就这样刷屏）。
      // 冷却窗取「至少 60 秒」，与触发条件解耦。
      const cooldownMs = Math.max(afterMs, 60_000);
      for (const node of full) {
        if (node.status !== 'submitted') continue;
        const parsed = Date.parse(String(node.updated_at ?? ''));
        // 时间读不出来时**记下来而不是静默跳过**：静默 continue 会表现成
        // 「tick 跑了、什么也没派、什么也没记」，排查时完全没线索。
        if (!Number.isFinite(parsed)) {
          (out.auditSkipped as Array<{ nodeId: string; why: string }>).push({ nodeId: node.node_id, why: 'updated-at-unparsable' });
          continue;
        }
        const ageMs = now - parsed;
        if (ageMs < afterMs) continue;
        const last = this.auditRequests.get(node.node_id) ?? 0;
        if (last && now - last < cooldownMs) {
          (out.auditSkipped as Array<{ nodeId: string; why: string }>).push({ nodeId: node.node_id, why: 'recently-dispatched' });
          continue;
        }
        if (!lead?.id) {
          (out.auditSkipped as Array<{ nodeId: string; why: string }>).push({ nodeId: node.node_id, why: 'no-lead-caller' });
          continue;
        }
        const producer = String(node.assignee ?? '');
        const spawned = await this.spawnAgent({
          role,
          task: `对节点 ${node.node_id} 执行独立审计：调用 verify_done({nodeId:"${node.node_id}", producer_instance:"${producer}"})，不要传 auditor_instance。审完报告 ok 与 error。`,
          capability: role,
          contextPack: [`节点 ${node.node_id} 已提交证据，等待独立审计`, '你不得是该节点的生产者'],
          label: `audit-${node.node_id}`,
        }, lead);
        this.auditRequests.set(node.node_id, now);
        if (spawned?.ok) {
          (out.auditDispatched as string[]).push(node.node_id);
          this.appendJournal('audit_dispatched', { nodeId: node.node_id, producer, role, instanceId: spawned.instanceId ?? null, at: new Date(now).toISOString() });
        } else {
          (out.auditSkipped as Array<{ nodeId: string; why: string }>).push({ nodeId: node.node_id, why: String(spawned?.error ?? 'spawn-failed') });
        }
      }

      this.appendJournal('coordinator_tick', {
        at: out.at,
        reason,
        reaped: out.reaped,
        auditDispatched: out.auditDispatched,
        skipped: (out.auditSkipped as unknown[]).length,
      });
      return out;
    } catch (error) {
      try { this.appendJournal('coordinator_error', { reason, detail: String((error as Error)?.message ?? error) }); } catch { /* 同上 */ }
      return { ...out, ok: false, error: String((error as Error)?.message ?? error) };
    } finally {
      this.coordinatorBusy = false;
    }
  }

  /** 读全量节点状态（审计路由需要，`graphStatus` 只回一页）。 */
  private async coreNodes(): Promise<Array<{ node_id: string; status: string; updated_at: string; assignee: string | null }>> {
    const core = await this.persistence();
    const store = (core as unknown as { core?: { state?: unknown } })?.core as { state?: { nodes?: Map<string, unknown> } } | undefined;
    const nodes = store?.state?.nodes;
    if (!nodes) return [];
    return [...nodes.values()].map((raw) => {
      const n = raw as Record<string, unknown>;
      // 兼容两种命名：core 的 NodeRecord 用 snake，快照/投影里有 camel。
      // 只认一种就会静默变成「一条都匹配不上」——那种失败最难查。
      const updated = n.updated_at ?? n.updatedAt ?? n.at ?? '';
      return {
        node_id: String(n.node_id ?? n.nodeId ?? ''),
        status: String(n.status ?? ''),
        updated_at: String(updated ?? ''),
        assignee: n.assignee == null ? null : String(n.assignee),
      };
    });
  }

  async dispatch(args: { mode?: string; intervalMs?: number; maxPerTick?: number; dryRun?: boolean; enqueue?: boolean; role?: string; capability?: string; maxEnqueue?: number } = {}, caller?: any) {
    const cfg = this.config as unknown as Record<string, unknown>;
    if (!this.dispatchOverride) this.dispatchOverride = {};
    const override = this.dispatchOverride;
    if (args.mode === 'off' || args.mode === 'interval' || args.mode === 'resident') override.mode = args.mode;
    if (typeof args.intervalMs === 'number') override.intervalMs = args.intervalMs;
    if (typeof args.maxPerTick === 'number') override.maxPerTick = args.maxPerTick;
    if (typeof args.dryRun === 'boolean') override.dryRun = args.dryRun;

    const raw = {
      mode: String(override.mode ?? cfg.dispatchMode ?? 'off'),
      intervalMs: Number(override.intervalMs ?? cfg.dispatchIntervalMs ?? 0),
      maxPerTick: Number(override.maxPerTick ?? cfg.dispatchMaxPerTick ?? 0),
      dryRun: (override.dryRun ?? cfg.dispatchDryRun ?? true) as boolean,
      dispatcherInstance: String(override.dispatcherInstance ?? cfg.dispatchInstance ?? 'ROLE-DISPATCH-01'),
      maxActive: Number(cfg.maxParallel ?? 6),
      maxQueuedTasks: Number(cfg.maxQueuedTasks ?? 10000),
      ratePerSecond: Number(cfg.dispatchRatePerSecond ?? 100),
      // `currentQueueLength` 故意**不在这里算**：它必须在回收过期租约之后算，
      // 否则本轮的 queue 闸门用的是「含幽灵登记」的旧数（见下面的 withCore 回调体）。
    };

    const now = Date.now();
    const usedQuota = this.usedDispatchQuota(now);
    // 宿主退避：从 journal 推出来的截止时刻，直接喂给计划层。
    // 没有这一步，`host-capacity` 的处置只能是「每 tick 硬撞一次」——
    // 退避时长记进了 journal 却没人读，等于没记。
    const backoff = this.hostBackoff(now);
    const wrapper = await this.withCore('dispatch', (core) => {
      // 先回收过期租约，再算积压，最后才规划。
      //
      // 顺序不能反：`queuedWorkers()` 数的是「已派未领取」的登记，而崩溃的 worker
      // 留下的登记只有 `lease_reaped` 这一类事件能立刻释放它。先回收 → 写扁平
      // 事件 → 再数积压，本轮 queue 闸门看到的就是真实值；反过来就要白等一整轮。
      const reaped = this.reapLeasesInScope(core, now);
      const plan = (core.dispatchPlan as (raw: Record<string, unknown>) => Record<string, unknown>)({
        ...raw,
        currentQueueLength: this.queuedWorkers(),
        dispatchedThisSecond: usedQuota,
        ...(backoff ? { hostBackoffUntilMs: backoff.untilMs, hostBackoffNote: backoff.note } : {}),
      });
      // 回收结果随计划一起返回：面板与日志据此回答「这一轮为什么突然多出了候选」。
      return reaped.length ? { ...plan, reaped } : plan;
    });
    const result = (wrapper as { ok: boolean; result?: Record<string, unknown> }).result as Record<string, unknown> | null;

    if (!result || (result as { ok?: unknown }).ok !== true) {
      return {
        ok: false,
        mode: raw.mode,
        dryRun: raw.dryRun,
        error: (result as { error?: string } | null)?.error ?? 'core-unavailable',
        message: 'core 未初始化，无法跑派活计划',
      };
    }

    // 只有真正要跑的模式才挂定时器
    this.applyDispatchTimer(raw.mode, raw.intervalMs);

    const persistence = (wrapper as { persistence?: Record<string, unknown> }).persistence ?? null;
    if (args.enqueue === true) {
      const enqueued = await this.enqueuePlan(result, args, caller);
      // 速率额度只在**真的派出去**时才消耗：候选、dryRun、already-enqueued 都不烧额度。
      const spawned = Array.isArray((enqueued as any).enqueue?.enqueued) ? (enqueued as any).enqueue.enqueued.length : 0;
      if (spawned > 0) this.noteDispatched(spawned, now);
      return { ...result, persistence, persisted: Boolean(persistence), enqueue: (enqueued as any).enqueue };
    }

    return {
      ...result,
      persistence,
      persisted: Boolean(persistence),
      note: '重启后恢复配置中的模式。此工具只生成候选计划，领取节点请使用 task_claim。传 enqueue:true 才会真正派发 worker。',
    };
  }

  /**
   * 记一次「真的派了 n 个」进速率窗口。
   *
   * 为什么单独一个方法：额度语义必须是「实际发生的派发」，而不是「计划过多少」。
   * 旧实现无条件 push，dryRun 的 tick 也烧额度，连跑几轮后真实派活被自己判成
   * `rate_limited`——窗口里全是没发生过的派发。
   */
  private noteDispatched(count: number, atMs: number): void {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (n === 0) return;
    this.dispatchTimes = this.dispatchTimes.filter((at) => at > atMs - 1000);
    for (let i = 0; i < n; i += 1) this.dispatchTimes.push(atMs);
  }

  /**
   * 本秒已用的派发额度 = max(journal 推导值, 进程内记录值)。
   *
   * 为什么两个都要：`dispatchTimes` 只覆盖**本进程生命周期**，重启即归零，
   * 于是 `dispatchRatePerSecond` 会被一次重启绕过（实测：上限 2，重启后 1 秒内
   * 派出 4 个）。而 journal 里的 `node_enqueued` 是跨重启的权威记录。
   * journal 侧可能少算「刚写但游标未推进」的那几次，进程内记录补上这个缺口；
   * 取较大者是安全方向（宁可少派）。
   *
   * 详见 `dispatch/rate-window.ts`。
   */
  private usedDispatchQuota(now: number): number {
    const windowMs = 1000;
    this.dispatchTimes = this.dispatchTimes.filter((at) => at > now - windowMs);
    let journalCount = 0;
    try {
      // `journalRows()`：只读不拷。速率窗口从尾部倒扫、遇边界即停，既不改数组
      // 也不持有引用——这里连 `slice()` 都是纯浪费（71400 行 0.35 ms，每轮 tick 一次）。
      journalCount = dispatchedInWindow(this.journalRows() as never, now, windowMs);
    } catch {
      journalCount = 0;
    }
    return effectiveDispatched(journalCount, this.dispatchTimes.length);
  }

  /**
   * 当前生效的**宿主退避**；没有则 null。
   *
   * 数据源是 `enqueueState().backoff`——从 journal 折叠出来的，所以跨重启有效：
   * 进程重启时宿主仍在满载，而内存里什么都没留下。存成字段就有这个问题，
   * 也与 `rate-window` / `gate-history` 的判断一致（都是派生量，不存计数器）。
   *
   * 返回值刻意是「给计划层直接用的形状」：`untilMs` 喂 `hostBackoffUntilMs`，
   * `note` 喂 `hostBackoffNote`。两处各拼一次文案就会出现面板与日志说法不一致。
   */
  private hostBackoff(now: number): { untilMs: number; note: string } | null {
    try {
      const backoff = this.enqueueState().backoff;
      const reason = backoffReason(backoff, now);
      if (!backoff || !reason) return null;
      return {
        untilMs: backoff.untilMs,
        note: `${reason}${backoff.message ? `（宿主原文：${backoff.message}）` : ''}`,
      };
    } catch {
      // 读失败按「没有退避」处理：与退避出现之前的行为一致，不因读取故障停派。
      return null;
    }
  }

  /**
   * 当前**积压**量：已派出但还没 claim 到的 worker 数。
   *
   * 为什么必须真的算：`raw.currentQueueLength` 原先在两条派发路径上都硬编码 `0`
   * （`service.ts` L1040 / L1278），于是 dispatcher 里
   *
   *   pendingCapacity = max(0, maxQueuedTasks - 0) = maxQueuedTasks   ← 永不收紧
   *   saturated       = active >= maxActive || 0 >= maxQueuedTasks   ← 后者恒假
   *
   * 结果是 `maxQueuedTasks` 这个配置项**从来没生效过**，`backpressure.queued`
   * 在面板上永远是 0。密集派发下 worker 可以无上限堆积（每轮只被同节点去重拦住，
   * 不同节点则一路派下去），宿主 session 与内存被悄悄吃满。
   *
   * 「积压」与「在跑」不是一回事：
   *   - 在跑（`active`）= 拿到租约的，由 leaseCapacity 统计；
   *   - 积压（`queued`）= 派出去了但还在启动/排队 claim 的，即登记里 `claimed=false` 的那部分。
   * 只挡在跑是不够的：积压的 worker 迟早会同时抵达 claim 层。
   */
  private queuedWorkers(): number {
    try {
      const state = this.enqueueState();
      let queued = 0;
      for (const row of state.live.values()) if (!row.claimed) queued += 1;
      return queued;
    } catch {
      // 登记推导失败时按「未知」处理：宁可认为没有积压（与旧行为一致），
      // 也不要在读取故障时把整张图判成满了。
      return 0;
    }
  }

  /**
   * 把候选计划真正落到 `agent_spawn`：每个候选节点派一个自驱 worker，由 worker 自己 claim。
   *
   * 边界：
   *  - 只在显式 `enqueue:true` 且拿到活 caller 时才执行（默认不派发）；
   *  - 插件不代领节点：容量与预算仍由 `task_claim` 的准入把关；
   *  - 同节点只派一次：判据来自 journal（`enqueueState()`），跨重启有效。
   */
  private async enqueuePlan(
    plan: Record<string, unknown>,
    args: { role?: string; capability?: string; maxEnqueue?: number },
    caller: any,
  ) {
    if (!caller?.id) {
      return { enqueue: { ok: false, error: 'caller-required', hint: 'enqueue 需要活 Agent 作 caller（工具入口用 exec.agent）' } };
    }
    const candidates = Array.isArray(plan.willDispatch) ? (plan.willDispatch as string[]) : [];
    const cap = Number(args.maxEnqueue);
    const limit = Number.isFinite(cap) && cap > 0 ? Math.min(Math.floor(cap), candidates.length) : candidates.length;
    const page = Array.isArray(plan.plan) ? (plan.plan as Array<Record<string, unknown>>) : [];
    const byId = new Map<string, Record<string, unknown>>(page.map((item) => [String(item.nodeId), item]));
    const partitions = ((plan.coordination as any)?.partitions ?? []) as Array<{ id: string; nodeRefs: string[]; writeScopes?: string[] }>;
    const scopesFor = (nodeId: string) => partitions.find((p) => p.nodeRefs?.includes(nodeId))?.writeScopes ?? [];
    const state = this.enqueueState();

    const enqueued: Array<Record<string, unknown>> = [];
    const failed: Array<Record<string, unknown>> = [];
    const skipped: Array<Record<string, unknown>> = [];
    for (const nodeId of candidates.slice(0, limit)) {
      const already = state.live.get(nodeId);
      if (already) {
        failed.push({
          nodeId,
          error: 'already-enqueued',
          instanceId: already.instanceId,
          sessionId: already.sessionId,
          claimed: already.claimed,
          at: already.at,
        });
        continue;
      }
      // 确定性失败过的节点：不再派。
      // 旧实现没有这道闸口，于是「preset 不存在」这类重试一万次也不会变好的失败，
      // 每轮都白烧一次 spawn，还把 journal 刷满同样的错误。宿主满载不入册
      // （那是临时的），所以这里只挡 `retryable === false` 的那一类。
      const earlier = state.failed.get(nodeId);
      if (earlier) {
        skipped.push({
          nodeId,
          error: 'spawn-permanently-failed',
          failureCode: earlier.code,
          at: earlier.at,
          explain: explainFailure(earlier),
        });
        continue;
      }
      const node = (byId.get(nodeId) ?? {}) as Record<string, unknown>;
      const nodeCapability = String(node.capability ?? '').trim();
      const nodeCapabilityRole = nodeCapability.toUpperCase();
      // 实例职务（role）与工作所需能力（capability）分开：
      // - 节点 capability 是实际 ROLE_PROFILE 职务时，可作为兼容性默认 carrier role；
      // - 其余 capability（包括 RESEARCH/DELIVER 这类权限标签、以及自由字符串）都是工作需求，
      //   不得回退成 CODE 后丢掉，必须传进 worker 的能力包。
      const rawRole = String(
        args.role ?? (LEGAL_WORKER_ROLES.includes(nodeCapabilityRole) ? nodeCapabilityRole : 'CODE'),
      ).toUpperCase();
      const role = LEGAL_WORKER_ROLES.includes(rawRole) ? rawRole : 'CODE';
      // 已知 worker 职务若与实际 carrier role 不同（例如显式 role 覆盖），也必须保留为任务能力提示。
      const nodeCapabilityIsPackage = Boolean(nodeCapability)
        && (!LEGAL_WORKER_ROLES.includes(nodeCapabilityRole) || nodeCapabilityRole !== role);
      const capabilityParts = [
        nodeCapabilityIsPackage ? nodeCapability : '',
        String(args.capability ?? '').trim(),
      ].filter(Boolean);
      const capability = [...new Set(capabilityParts)].join('\n') || undefined;
      const spawned = await this.spawnAgent({
        role,
        task: `${nodeId} · ${String(node.title ?? nodeId)}`,
        capability,
        contextPack: [
          `本 worker 只负责节点 ${nodeId}（stage=${String(node.stage ?? 'unspecified')}）。`,
          '容量与预算由 task_claim 的准入判定；被拒（graph_capacity / partition_capacity / rate_limited / budget_exceeded）时停止，不要重试同一节点。',
        ],
        taskBrief: {
          objective: String(node.title ?? nodeId),
          writeScopes: scopesFor(nodeId),
          acceptance: ['产物真实存在且可被独立复核'],
          evidenceRefs: [],
          leaseRef: `node=${nodeId}（claim 后自行记录 fencingToken）`,
          omitted: ['父会话完整历史', '其他分区上下文'],
        },
      }, caller);
      if (spawned.ok) {
        enqueued.push({ nodeId, role, instanceId: spawned.instanceId, sessionId: spawned.sessionId });
      } else {
        failed.push({
          nodeId,
          error: spawned.error ?? 'spawn-failed',
          failureCode: spawned.failureCode ?? null,
          retryable: spawned.retryable !== false,
          retryAfterMs: spawned.retryAfterMs ?? null,
          message: spawned.hint ?? null,
        });
      }
      // `retryable` / `failureCode` 必须落进 journal：`enqueueState()` 靠它们区分
      // 「宿主满了（下轮再试）」与「组装失败（别再派了）」。只写 error 字符串的话，
      // 折叠层看不出性质，调度器只能一律重试，于是永不成功的节点每轮白烧一次 spawn。
      //
      // `retryAfterMs` 同理，但它解决的是另一个问题：宿主满载时**什么时候**再试。
      // 没有这个数，退避只能靠 interval 配置（默认 300 秒、最小 30 秒）——那是
      // 与宿主真实恢复时间毫无关系的独立数字，实际行为是每 tick 硬撞一次，
      // 撞一次写一行同样的错误。记下来，下一次派发就知道该等到什么时候。
      this.appendJournal(spawned.ok ? 'node_enqueued' : 'node_enqueue_failed', {
        nodeId,
        role,
        instanceId: spawned.instanceId ?? null,
        sessionId: spawned.sessionId ?? null,
        error: spawned.error ?? null,
        retryable: spawned.ok ? null : spawned.retryable !== false,
        failureCode: spawned.failureCode ?? null,
        ...(spawned.ok || spawned.retryAfterMs == null ? {} : { retryAfterMs: spawned.retryAfterMs }),
        caller: caller.id,
      });
    }
    // 释放解释：**全量回传，不只候选**。
    // 只回候选会漏掉最关键的一类：「节点已释放，但当前不在候选里」——比如上一个 worker
    // claim 被拒后节点变 claimed，登记已释放却没人再派它。那正是要排查的现场。
    const candidateSet = new Set(candidates);
    const releasedNotes = [...state.released.values()]
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 50)
      .map((release) => ({
        nodeId: release.nodeId,
        sessionId: release.sessionId,
        reason: release.reason,
        at: release.at,
        candidate: candidateSet.has(release.nodeId),
        explain: explainRelease(release),
      }));
    return {
      enqueue: {
        ok: failed.length === 0,
        requested: candidates.length,
        enqueued,
        failed,
        /** 因确定性失败被跳过的节点（不是本轮失败，是历史失败留下的闸口）。 */
        skipped,
        released: releasedNotes,
        liveBefore: state.live.size,
        hint: 'worker 自己 task_claim；插件不代领、不代交证据。',
      },
    };
  }

  /** 根据派活模式挂/摘定时器（off 不挂）。 */
  private applyDispatchTimer(mode: string, intervalMs: number) {
    if (this.dispatchTimer) {
      clearInterval(this.dispatchTimer);
      this.dispatchTimer = null;
    }
    if (mode !== 'interval' && mode !== 'resident') return;
    const interval = mode === 'resident' ? Math.max(30000, Math.min(intervalMs, 60000)) : Math.max(30000, intervalMs);
    this.dispatchTimer = setInterval(() => {
      void this.dispatchTick().catch(() => undefined);
    }, interval);
    (this.dispatchTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** 定时器回调：跑一轮并把摘要记进 journal（失败不抛）。 */
  private async dispatchTick() {
    if (this.dispatchTickBusy) return;
    this.dispatchTickBusy = true;
    try {
      const cfg = this.config as unknown as Record<string, unknown>;
      const override = this.dispatchOverride ?? {};
      const now = Date.now();
      const dispatchedThisSecond = this.usedDispatchQuota(now);
      // 定时器这条路径也要读退避：它才是「每 tick 硬撞」的主要现场
      // （interval 默认 300 秒、最小 30 秒，与宿主真实恢复时间毫无关系）。
      const backoff = this.hostBackoff(now);
      const raw = {
        mode: String(override.mode ?? cfg.dispatchMode ?? 'off'),
        intervalMs: Number(override.intervalMs ?? cfg.dispatchIntervalMs ?? 0),
        maxPerTick: Number(override.maxPerTick ?? cfg.dispatchMaxPerTick ?? 0),
        dryRun: (override.dryRun ?? cfg.dispatchDryRun ?? true) as boolean,
        dispatcherInstance: String(override.dispatcherInstance ?? cfg.dispatchInstance ?? 'ROLE-DISPATCH-01'),
        maxActive: Number(cfg.maxParallel ?? 6),
        maxQueuedTasks: Number(cfg.maxQueuedTasks ?? 10000),
        ratePerSecond: Number(cfg.dispatchRatePerSecond ?? 100),
        // `currentQueueLength` 在回调里、回收之后才算（同 `dispatch()` 的理由）。
      };
      // ★ `withCore` 返回的是**包装对象** `{ok, result, persistence}`，真正的计划在
      // `wrapper.result` 里。旧实现直接读包装对象，于是：
      //   - `wrapper.ok === true`（包装成功）恒成立，
      //   - `wrapper.mode` / `wrapper.willDispatch` 全是 undefined，
      //   - 每轮 tick 的 journal 都记成 `mode:'off' ready:0 willDispatch:0`。
      // 也就是说「定时器到底派没派」这件事，日志里**一直是假的**，而且不报错。
      const wrapper = (await this.withCore('dispatch_tick', (core) => {
        // 定时器是**唯一**能自己发现的路径：没有人在旁边手动调 dispatch，
        // 崩溃 worker 留下的过期租约只能在这里被回收。
        const reaped = this.reapLeasesInScope(core as never, now);
        const plan = (core as { dispatchPlan: (raw: Record<string, unknown>) => Record<string, unknown> }).dispatchPlan({
          ...raw,
          currentQueueLength: this.queuedWorkers(),
          dispatchedThisSecond,
          ...(backoff ? { hostBackoffUntilMs: backoff.untilMs, hostBackoffNote: backoff.note } : {}),
        });
        return reaped.length ? { ...plan, reaped } : plan;
      })) as {
        ok?: boolean;
        result?: Record<string, unknown> | null;
        error?: string;
      } | null;
      const result = (wrapper?.result ?? null) as Record<string, unknown> | null;
      if (result && result.ok === true) {
        const planned = Array.isArray(result.willDispatch) ? result.willDispatch.length : 0;

        // ★ 定时器必须**真的派**，否则 interval/resident 模式等于没有。
        //
        // 旧实现只跑 dispatchPlan（纯计划）就写日志收工：`willDispatch` 里有节点、面板上
        // 一片就绪，但**没有任何 worker 被派出去**，而且日志写的是 `willDispatch: N`，
        // 看起来像派了 N 个。这类"看起来在干活其实没干"比崩溃难发现得多。
        //
        // 额度也只在这里按**真实 spawn 数**记（不是按计划数），见 noteDispatched 注释。
        let spawnedCount = 0;
        let enqueueError: string | null = null;
        if (result.dryRun !== true && planned > 0) {
          // 定时器没有工具入口，派活需要一个活 Agent 当 parent：用最近一次调用本插件的
          // caller（它就是"发起派活的对话"）。拿不到就不派，并显式记下来——不假装成功。
          const caller = this.lastCaller;
          if (caller?.id) {
            try {
              const enq = await this.enqueuePlan(result, { maxEnqueue: planned }, caller);
              const list = Array.isArray((enq as any)?.enqueue?.enqueued) ? (enq as any).enqueue.enqueued : [];
              spawnedCount = list.length;
              if (spawnedCount > 0) this.noteDispatched(spawnedCount, now);
            } catch (error) {
              enqueueError = String((error as Error)?.message ?? error);
            }
          } else {
            enqueueError = 'tick-no-caller';
          }
        }

        this.appendJournal('dispatch_tick', {
          mode: String(result.mode ?? 'off'),
          dryRun: Boolean(result.dryRun),
          ready: Array.isArray(result.ready) ? result.ready.length : 0,
          willDispatch: planned,
          spawned: spawnedCount,
          rateRecorded: spawnedCount,
          ...(enqueueError ? { error: enqueueError } : {}),
          backpressure: result.backpressure ?? null,
          blocked: Array.isArray(result.blocking) ? result.blocking.length : 0,
          // 闸门分布必须进 journal：事后查「那天为什么只派了 3 个」时，只有这一份
          // 是跨重启仍在的。不记的话只能靠 `willDispatch` 与 `ready` 反推，而
          // 「ready 20 派 3」既可能是 tick 到量，也可能是容量/速率/排队，无法区分。
          gates: (result.gates as Record<string, number> | undefined) ?? {},
        });
        if (enqueueError === 'tick-no-caller') {
          // 静默空转是这种定时器最坏的失败方式；留一条可检索的事件。
          this.appendJournal('dispatch_tick_no_caller', {
            willDispatch: planned,
            hint: '定时派活需要一个活 Agent 作 caller（先在本对话里调用一次 dispatch 即可绑定）',
          });
        }
      } else {
        // 包装失败（core 未初始化 / 持久化失败）也要留痕，否则定时器静默空转。
        this.appendJournal('dispatch_tick', {
          mode: String(raw.mode),
          ok: false,
          error: wrapper?.error ?? 'core-unavailable',
          ready: 0,
          willDispatch: 0,
          spawned: 0,
          rateRecorded: 0,
        });
      }
    } catch (error) {
      this.persistenceError = String((error as Error)?.message ?? error);
    } finally {
      this.dispatchTickBusy = false;
    }
  }

  /** 停止派活定时器（dispose 时调用）。 */
  stopDispatch() {
    if (this.dispatchTimer) {
      clearInterval(this.dispatchTimer);
      this.dispatchTimer = null;
    }
  }

  get tenant(): string {
    return String((this.config as { tenant?: string }).tenant ?? 'default');
  }

  async graphStatus(input: { limit?: number; offset?: number } = {}) {
    const journal = this.journalSummary();
    // P1-5 有界输出（P3 优化）：分页参数**直接下传 core**，由 core 只投影当前页；
    // service 不再「取全量再切片」——大图时 CPU/内存都跟页大小走。
    const limit = Number.isFinite(Number(input?.limit)) && Number(input.limit) > 0 ? Math.min(Math.floor(Number(input.limit)), 500) : 50;
    const offset = Number.isFinite(Number(input?.offset)) && Number(input.offset) > 0 ? Math.floor(Number(input.offset)) : 0;
    const coreResult = await this.withCore('graph_status', (core) =>
      core.graphStatus
        ? core.graphStatus({ limit, offset })
        : Promise.resolve({ delegated: false, reason: 'core.graphStatus 未实现' }),
    );
    // 兼容：老 core 若忽略分页参数、返回全量列表，这里兜底再切一次，绝不把全量抛给上层。
    const pagedCore = (() => {
      const wrapped = coreResult as Record<string, unknown>;
      const inner = (wrapped?.result ?? wrapped) as Record<string, any>;
      const list = Array.isArray(inner?.graph?.nodes) ? inner.graph.nodes : Array.isArray(inner?.nodes) ? inner.nodes : null;
      if (!Array.isArray(list)) return coreResult;
      const total = Number(inner?.page?.total ?? inner?.counts?.nodes ?? list.length);
      const overLimit = list.length > limit; // 老 core 返回了全量 → 需要兜底切片
      const slice = overLimit ? list.slice(offset, offset + limit) : list;
      const pagedInner = {
        ...inner,
        nodes: slice,
        graph: { ...(inner?.graph ?? {}), nodes: slice },
        page: inner?.page ?? {
          limit,
          offset,
          total,
          truncated: offset + limit < total,
          hint: '完整节点走 graph_export 或按 nodeId 点查',
        },
      };
      return wrapped?.result ? { ...wrapped, result: pagedInner } : pagedInner;
    })();
    const persistence = await this.persistence();
    // `snapshot()` **只调一次**。之前是 `{...persistence.snapshot(), error: persistence.snapshot().error ?? ...}`
    // ——同一个值算两遍，而 `snapshot()` 里含 journal 全史指纹（O(全史)）。实测 4005 条记录时
    // 单次 24 ms，于是 `graphStatus` 光这一处就付 48 ms；调用方还以为"只读一次"。
    const baseSnapshot = persistence ? persistence.snapshot() : null;
    const persistenceView = baseSnapshot
      ? { ...baseSnapshot, error: baseSnapshot.error ?? (this.persistenceError ? { code: 'LAST_ERROR', message: this.persistenceError } : null) }
      : { mode: this.config.persistence, error: { code: 'PERSISTENCE_UNAVAILABLE', message: this.persistenceError ?? 'not-opened' } };
    let observability: unknown = null;
    try {
      if (this.observability?.projection) {
        observability = this.observability.projection({ health: this.observability.health?.() ?? null });
      }
    } catch (error) {
      observability = { degraded: true, error: String((error as Error)?.message ?? error) };
    }
    return {
      ok: true,
      tenant: this.tenant,
      journal,
      stateDir: this.stateDir,
      snapshotExists: fs.existsSync(this.snapshotPath),
      capabilities: { ...capabilitiesDigest(), hostServices: this.hostServicesView() },
      storage: (() => { try { return this.storageHealth(); } catch { return { ok: false, error: 'storage-health-failed' }; } })(),
      persistence: persistenceView,
      observability,
      // 派发层可观测：UI/Lead 不用翻 journal 就能回答「现在有几个 worker 在跑、上轮为什么没派」。
      dispatch: this.dispatchView(),
      graph: pagedCore,
    };
  }

  /**
   * 派发层摘要（**只读**，不触发任何派发/领取）。
   *
   * 三个问题的答案都在这里：「有几个 worker 真在跑」「上轮为什么不派」「速率额度用了多少」。
   * 之前这些都只能翻 journal 手工数，等于没有可观测性。
   */
  dispatchView(): Record<string, unknown> {
    let state: EnqueueState;
    try {
      state = this.enqueueState();
    } catch (error) {
      return {
        ok: false,
        error: 'enqueue-state-failed',
        message: String((error as Error)?.message ?? error),
      };
    }
    const cfg = this.config as unknown as Record<string, unknown>;
    const override = (this.dispatchOverride ?? {}) as Record<string, unknown>;
    const now = Date.now();
    const usedLastSecond = this.usedDispatchQuota(now);
    const ratePerSecond = Number(override.ratePerSecond ?? cfg.dispatchRatePerSecond ?? 0);
    // 三件事一遍扫完，且**不做全量排序**：
    //   1. claimed / unclaimed 计数（原来 `live.filter` 对 68600 条跑了两遍，3.5 ms）；
    //   2. `queue.queued`（原来第三遍 filter）；
    //   3. `active.rows` 只要最近 50 条（原来 `[...live].sort()` 排完 68600 条再 slice，26 ms）。
    //
    // 取「最近 50 条」用**环形缓冲 + 单调性探测**，不是「排序后截断」，也不是堆。
    // 四面方案实测（68600 条，取前 50）：
    //   localeCompare 全量排序  26 ms
    //   裸比较全量排序          12 ms
    //   最小堆（含先比时间后建对象）11 ms ← 意外地差
    //   环形缓冲 + 单调性探测   2.3 ms
    //
    // 堆为什么反而差：`at` 大体随 journal 顺序递增，于是每条新行都**真的**比堆顶新，
    // 每条都要 siftDown 6 层 → 68600×6 次写。堆适合「输入乱序、只要 top-k」，
    // 不适合「输入本身近似有序」。
    //
    // 环形缓冲的前提是「`at` 单调递增时，走过的最后 keep 条就是最新的 keep 条」，
    // 而 journal 正是 append-only + 时间单调——这个前提在真实数据上天然成立。
    // 万一不成立（乱序写、补写历史），探测到逆序就**回退全量排序**：正确性优先，
    // 罕见路径付一次 12 ms 完全可以接受。
    let claimed = 0;
    const keep = 50;
    type Row = { nodeId: string; instanceId: string | null; sessionId: string | null; claimed: boolean; at: string };
    // ring 存**记录引用**，末了才为存活的 50 条建新对象。
    //
    // 为什么不每条都建：旧写法在 60000 条 live 上新建 60000 个对象，其中 59950 个
    // 建完立刻被覆盖丢掉。实测（60000 条，取 50）：
    //   裸扫（只数 claimed）        0.76 ms   ← 下限
    //   每条都建对象                1.87 ms   ← 旧写法
    //   「会存活才建」（先比再建）   2.42 ms   ← 反而更慢
    //   ring 存引用、末了建 50 个    1.59 ms   ← 现在
    //
    // 「先比再建」为什么更慢：`at` 随 journal 单调，于是每条新行**真的**比环里最旧的
    // 那条新，判断永远成立，等于白做一次比较还要多读一次 `ring[ringPos].at`。
    // 又一次验证了「输入近似有序」时一切额外分支都是纯成本。
    const ring: Array<EnqueueRecord | undefined> = new Array(keep);
    let ringCount = 0;
    let ringPos = 0;
    let maxAt = '';
    let inverted = false;
    for (const row of state.live.values()) {
      if (row.claimed) claimed += 1;
      // 逆序探测：`at` 一旦倒退，环形缓冲的「最后 keep 条 = 最新 keep 条」前提就废了。
      if (row.at < maxAt) inverted = true;
      else maxAt = row.at;
      ring[ringPos] = row;
      ringPos = (ringPos + 1) % keep;
      if (ringCount < keep) ringCount += 1;
    }
    const liveCount = state.live.size;
    const toRow = (row: EnqueueRecord): Row => ({
      nodeId: row.nodeId,
      instanceId: row.instanceId,
      sessionId: row.sessionId,
      claimed: row.claimed,
      at: row.at,
    });
    // 按环形顺序展开（ringPos 是下一个写入位，即最旧的那一格）。
    const recent: EnqueueRecord[] = ringCount < keep
      ? (ring.slice(0, ringCount) as EnqueueRecord[])
      : [...(ring.slice(ringPos) as EnqueueRecord[]), ...(ring.slice(0, ringPos) as EnqueueRecord[])];
    const byDesc = (a: { at: string }, b: { at: string }) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
    const live: Row[] = inverted
      // 罕见路径：确实乱序，只能全量排（此时没省到，但结论一定对）。
      ? ([...state.live.values()].sort(byDesc).slice(0, keep).map(toRow))
      : recent.sort(byDesc).map(toRow);
    return {
      ok: true,
      mode: String(override.mode ?? cfg.dispatchMode ?? 'off'),
      dryRun: Boolean(override.dryRun ?? cfg.dispatchDryRun ?? true),
      maxPerTick: Number(override.maxPerTick ?? cfg.dispatchMaxPerTick ?? 0),
      maxParallel: Number(cfg.maxParallel ?? 0),
      rate: {
        perSecond: Number.isFinite(ratePerSecond) && ratePerSecond > 0 ? ratePerSecond : 0,
        usedLastSecond,
        remaining: Number.isFinite(ratePerSecond) && ratePerSecond > 0 ? Math.max(0, ratePerSecond - usedLastSecond) : null,
        saturated: Number.isFinite(ratePerSecond) && ratePerSecond > 0 ? usedLastSecond >= ratePerSecond : false,
      },
      /**
       * 积压面：`maxQueuedTasks` 到底有没有把住。
       *
       * 这一块的意义和 `rate` 一样——不报出来，配置项是否生效只能翻 journal 数。
       * `queued` 与 `active.unclaimed` 是同一个数，但那一栏是「在跑的 worker 明细」，
       * 这里是「限流的输入」，两个用途不要混：面板上问「为什么没派」应该看这里。
       */
      queue: (() => {
        const maxQueued = Number(cfg.maxQueuedTasks ?? 10000);
        // 计数来自上面那一遍扫描（`liveCount - claimed`），不再单独 filter 全量。
        const queued = liveCount - claimed;
        const limit = Number.isFinite(maxQueued) && maxQueued > 0 ? maxQueued : 0;
        return {
          queued,
          maxQueued: limit,
          remaining: limit > 0 ? Math.max(0, limit - queued) : null,
          saturated: limit > 0 ? queued >= limit : false,
          explain: limit > 0
            ? `已派未领取 ${queued} / 上限 ${limit}`
            : '未设排队上限（maxQueuedTasks=0 视为不限）',
        };
      })(),
      active: {
        count: liveCount,
        claimed,
        unclaimed: liveCount - claimed,
        rows: live,
        truncated: liveCount > keep,
      },
      released: {
        count: state.released.size,
        rows: [...state.released.values()]
          .sort((a, b) => String(b.at).localeCompare(String(a.at)))
          .slice(0, 20)
          .map((row) => ({ ...row, explain: explainRelease(row) })),
      },
      ignored: state.ignored,
      /**
       * 确定性派发失败的节点：**重试无用，已停止派发**。
       *
       * 与 `released` 是相反语义（released = 可以重派了），所以单列。要让某个节点
       * 解除，改完配置后手动派一次（成功派发会清掉登记）。
       */
      failed: {
        count: state.failed.size,
        rows: [...state.failed.values()]
          .sort((a, b) => String(b.at).localeCompare(String(a.at)))
          .slice(0, 20)
          .map((row) => ({ ...row, explain: explainFailure(row) })),
      },
      staleMs: Number(cfg.enqueueStaleMs ?? 0),
      /**
       * 宿主退避面：宿主自己报的「N 秒后再试」是否还在生效。
       *
       * 与 `failed` / `released` 都不同：那两个说的是**单个节点**的处置，
       * 这里说的是**全图**的共同处境——退避期间任何节点都派不出去。
       * 不报出来的话，面板只能显示「ready 20、派 0」，看不出是宿主不收。
       */
      hostBackoff: (() => {
        const backoff = state.backoff;
        if (!backoff) return null;
        const remaining = backoff.untilMs - now;
        return {
          active: remaining > 0,
          until: backoff.until,
          untilMs: backoff.untilMs,
          remainingMs: Math.max(0, remaining),
          retryAfterMs: backoff.retryAfterMs,
          since: backoff.since,
          nodeId: backoff.nodeId,
          message: backoff.message,
          explain: backoffReason(backoff, now) ?? `宿主退避已在 ${backoff.until} 到期`,
        };
      })(),
      /**
       * 上一轮 tick 的闸门分布（`dispatch_tick` journal 行折叠而来）。
       *
       * 面板要回答的问题是「为什么现在没派」，答案必须来自**真实跑过的那一轮**，
       * 而不是面板自己再算一遍——两次计算之间状态会变（worker claim 了、租约过期了），
       * 重算出的原因与日志、与 worker 实际收到的指示都会不一致。
       */
      lastTick: (() => {
        try {
          // 从尾部找第一条即可，不需要副本：`journalRows()` 是只读缓存本体。
          // 这里只「从后往前扫到第一条 `dispatch_tick`」，既不改数组也不持有引用。
          const rows = this.journalRows();
          let last: Record<string, unknown> | undefined;
          for (let index = rows.length - 1; index >= 0; index -= 1) {
            if (rows[index]?.kind === 'dispatch_tick') {
              last = rows[index];
              break;
            }
          }
          if (!last) return null;
          return {
            at: last.at ?? null,
            mode: last.mode ?? null,
            ready: Number(last.ready ?? 0),
            willDispatch: Number(last.willDispatch ?? 0),
            spawned: Number(last.spawned ?? 0),
            blocked: Number(last.blocked ?? 0),
            gates: (last.gates as Record<string, number> | undefined) ?? {},
            ...(last.error ? { error: last.error } : {}),
          };
        } catch {
          return null;
        }
      })(),
      /**
       * 闸门命中的**跨轮累积**（滑动窗口，从 journal 折叠）。
       *
       * 与 `lastTick.gates` 回答的是不同问题：那一份是「最近一轮为什么没派」，
       * 这一份是「这段时间主要卡在哪」。排障时最常问的其实是后者——
       * 半小时 600 轮里 580 轮只派了 1 个，逐轮看要么翻 600 行日志，要么正好
       * 撞上一轮没被挡的（瞬时原因让相邻两轮完全不同），结论随取样时刻漂移。
       */
      gateHistory: (() => {
        try {
          const windowMs = Number(cfg.dispatchGateWindowMs ?? 0) > 0
            ? Number(cfg.dispatchGateWindowMs)
            : 300_000;
          // 增量折叠：只处理上次之后的新行，聚合只走窗口内 ring。
          // 一次性 `foldGateHistory` 每轮都要扫窗口内的全部 journal 行——
          // 默认 5 分钟窗口只有几十行 tick 可忽略，但窗口调到 1 小时就是万行。
          if (!this.gateFolded) this.gateFolded = new GateHistoryFolder({ windowMs });
          else this.gateFolded.reconfigure({ windowMs });
          // 传缓存本体（只读）：`fold()` 内部自己 `slice(cursor)` 取增量，
          // 再在外层套一次 `readJournal()` 的全量浅拷贝纯属重复。
          return this.gateFolded.fold(this.journalRows() as never, now);
        } catch (error) {
          return { error: 'gate-history-failed', message: String((error as Error)?.message ?? error) };
        }
      })(),
      hint: 'active=登记仍认为有活 worker；released=上轮为什么允许重派；failed=确定性失败已停派（改配置后手动派一次解除）；rate.usedLastSecond=真实 spawn 数（候选/dryRun 不记账）；lastTick.gates=上一轮被哪道闸门挡；gateHistory=最近窗口内各闸门累计命中（回答「这段时间主要卡在哪」）。',
    };
  }

  /** 为指定分区落检查点（追加 `partition_checkpointed` 事件）。 */
  async graphCheckpoint(input: { partitionId: string }) {
    const partitionId = String(input?.partitionId ?? "").trim();
    if (!partitionId) return { ok: false, error: "partition-id-required" };
    const coreResult = await this.withCore('graph_checkpoint', (core) =>
      core.graphCheckpoint ? core.graphCheckpoint({ partitionId }) : Promise.resolve({ delegated: false, reason: 'core.graphCheckpoint 未实现' }),
    );
    const wrapped = coreResult as { ok?: boolean; result?: Record<string, unknown> };
    const result = wrapped.result ?? wrapped;
    return { ok: result.ok === true, checkpoint: (result as any).checkpoint ?? null, baseSeq: (result as any).baseSeq ?? null, error: (result as any).error ?? null };
  }

  /** 恢复报告：返回最近检查点元数据 + 需重放的事件数。 */
  async graphRecover(input: { partitionId?: string } = {}) {
    const partitionId = input?.partitionId ? String(input.partitionId).trim() : undefined;
    const coreResult = await this.withCore('graph_recover', (core) =>
      core.graphRecover ? core.graphRecover({ partitionId }) : Promise.resolve({ delegated: false, reason: 'core.graphRecover 未实现' }),
    );
    const wrapped = coreResult as { ok?: boolean; result?: Record<string, unknown> };
    const result = wrapped.result ?? wrapped;
    return {
      ok: result.ok === true,
      checkpoint: (result as any).checkpoint ?? null,
      baseSeq: (result as any).baseSeq ?? 0,
      replayed: (result as any).replayed ?? 0,
      state: (result as any).state ?? null,
      error: (result as any).error ?? null,
    };
  }

  /** 分区恢复计划：接着做 / 已完成必须跳过 / 状态退回须报警。 */
  async graphResumePlan(input: { partitionId?: string } = {}) {
    const partitionId = input?.partitionId ? String(input.partitionId).trim() : undefined;
    const coreResult = await this.withCore('graph_resume_plan', (core) =>
      core.graphResumePlan
        ? core.graphResumePlan({ partitionId })
        : Promise.resolve({ delegated: false, reason: 'core.graphResumePlan 未实现' }),
    );
    const wrapped = coreResult as { ok?: boolean; result?: Record<string, unknown> };
    const result = wrapped.result ?? wrapped;
    return {
      ok: result.ok === true,
      checkpoint: (result as any).checkpoint ?? null,
      baseSeq: (result as any).baseSeq ?? 0,
      replayed: (result as any).replayed ?? 0,
      resume: (result as any).resume ?? [],
      skipCompleted: (result as any).skipCompleted ?? [],
      drift: (result as any).drift ?? [],
      error: (result as any).error ?? null,
    };
  }

  /**
   * 写回工程记忆：把本轮结论/证据/下一步写成一篇短报告；有任务卡时在卡末追加指针。
   * 只写结论与指针，不复制整段上下文。
   */
  async memoryWriteback(input: { taskCard?: string; summary?: string; next?: string; evidence?: string; expectedCardRevision?: string | null } = {}) {
    const managementDir = this.managementRoot;
    const summary = String(input?.summary ?? '').trim();
    if (!summary) return { ok: false, error: 'summary-required' };
    const cleanName = (value: unknown, ext: string): string | null => {
      const raw = String(value ?? '').trim();
      if (!raw) return null;
      const base = path.basename(raw);
      if (!base || base === '.' || base === '..' || base !== raw) return null;
      return base.endsWith(ext) ? base : `${base}${ext}`;
    };
    const taskCard = cleanName(input?.taskCard, '.md');
    if (input?.taskCard && !taskCard) return { ok: false, error: 'task-card-name-invalid' };
    const next = String(input?.next ?? '').trim();
    const evidence = String(input?.evidence ?? '').trim();
    const candidate = taskCard ? path.join(managementDir, 'tasks', taskCard) : null;
    const reportDir = path.join(managementDir, 'reports');
    const cardBefore = candidate && fs.existsSync(candidate) ? fs.readFileSync(candidate, 'utf8') : null;
    const cardRevision = cardBefore === null ? null : createHash('sha256').update(cardBefore).digest('hex');
    if (taskCard && cardBefore === null) return { ok: false, error: 'task-card-not-found', taskCard };
    if (taskCard && input.expectedCardRevision === undefined) return { ok: false, error: 'expected-card-revision-required', cardRevision };
    if (taskCard && input.expectedCardRevision !== cardRevision) return { ok: false, error: 'stale-card-revision', cardRevision };
    if (fs.existsSync(managementDir) && !fs.statSync(managementDir).isDirectory()) return { ok: false, error: 'management-root-not-directory', managementDir };
    const reportsDir = reportDir;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportName = `MEM-${stamp}-${randomUUID()}.md`;
    const reportPath = path.join(reportsDir, reportName);
    const body = [
      `# 记忆写回 ${new Date().toISOString()}`,
      '',
      `- 任务卡：${taskCard ?? '—'}`,
      '',
      '## 本轮结论',
      summary,
      '',
      '## 下一步',
      next || '—',
      '',
      '## 证据/指针',
      evidence || '—',
      '',
    ].join('\n');
    let cardPath: string | null = null;
    let nextCardRevision: string | null = cardRevision;
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.writeFileSync(reportPath, body, { encoding: 'utf8', flag: 'wx' });
    if (taskCard && candidate) {
      const block = [
        '',
        `## 记忆写回 ${new Date().toISOString()}`,
        `- 结论：${summary.replace(/\n/g, ' ').slice(0, 500)}`,
        `- 下一步：${(next || '—').replace(/\n/g, ' ').slice(0, 300)}`,
        `- 报告：reports/${reportName}`,
        '',
      ].join('\n');
      const updatedCard = `${cardBefore ?? ''}${block}`;
      const tempCard = `${candidate}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(tempCard, updatedCard, { encoding: 'utf8', flag: 'wx' });
        const observedRevision = createHash('sha256').update(fs.readFileSync(candidate, 'utf8')).digest('hex');
        if (observedRevision !== cardRevision) {
          return { ok: false, error: 'stale-card-revision', cardRevision: observedRevision, reportPath };
        }
        fs.renameSync(tempCard, candidate);
        cardPath = candidate;
        nextCardRevision = createHash('sha256').update(updatedCard).digest('hex');
      } catch (error) {
        return { ok: false, error: 'task-card-write-failed', detail: String((error as Error).message), reportPath };
      } finally {
        try { fs.unlinkSync(tempCard); } catch { /* rename consumed it, or write failed */ }
      }
    }
    return {
      ok: true,
      action: 'memory_writeback',
      result: {
        managementDir,
        report: { name: reportName, path: reportPath, chars: body.length },
        taskCard: taskCard ? { name: taskCard, path: cardPath, appended: Boolean(cardPath), previousRevision: cardRevision, revision: nextCardRevision } : null,
        hint: '后续只读报告/任务卡指针；不要把完整本轮上下文重新塞回对话。',
      },
    };
  }

  /**
   * 按需读取管理区/工程记忆，返回紧凑任务包；不自动注入，不返回全量历史。
   * 只读：任务卡 + STATE + 一篇报告 + 可用引用列表；总字符数有上限。
   */
  async memoryLoad(input: { taskCard?: string; record?: string; maxChars?: number } = {}) {
    const managementDir = this.managementRoot;
    const requestedLimit = Number(input?.maxChars ?? 12000);
    const maxChars = Math.max(1000, Math.min(30000, Number.isFinite(requestedLimit) ? requestedLimit : 12000));
    const cleanName = (value: unknown, ext: string): string | null => {
      const raw = String(value ?? '').trim();
      if (!raw) return null;
      const base = path.basename(raw);
      if (!base || base === '.' || base === '..' || base !== raw) return null;
      return base.endsWith(ext) ? base : `${base}${ext}`;
    };
    const taskCard = cleanName(input?.taskCard, '.md');
    const record = cleanName(input?.record, '.md');
    if ((input?.taskCard && !taskCard) || (input?.record && !record)) return { ok: false, error: 'memory-name-invalid' };
    const read = (file: string): { path: string; text: string; chars: number } | null => {
      try {
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
        const text = fs.readFileSync(file, 'utf8');
        return { path: file, text, chars: text.length };
      } catch {
        return null;
      }
    };
    const state = read(path.join(managementDir, 'STATE.md'));
    const card = taskCard ? read(path.join(managementDir, 'tasks', taskCard)) : null;
    const report = record ? read(path.join(managementDir, 'reports', record)) : null;
    const list = (dir: string, max = 20): string[] => {
      try {
        return fs.readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
          .map((entry) => entry.name)
          .sort()
          .slice(0, max);
      } catch {
        return [];
      }
    };
    const sections = [
      card ? { key: 'taskCard', label: `# TASK CARD ${taskCard}`, text: card.text } : null,
      state ? { key: 'state', label: '# STATE.md', text: state.text } : null,
      report ? { key: 'record', label: `# RECORD ${record}`, text: report.text } : null,
    ].filter((section): section is { key: string; label: string; text: string } => Boolean(section));
    const fullText = sections.map((section) => `${section.label}\n${section.text}`).join('\n\n');
    const truncated = fullText.length > maxChars;
    const reserveForOmitted = truncated ? Math.min(100, Math.ceil(maxChars * 0.08)) : 0;
    let remaining = maxChars - reserveForOmitted;
    const included: string[] = [];
    const omitted: string[] = [];
    for (const [index, section] of sections.entries()) {
      const header = `${section.label}\n`;
      const separator = included.length ? 2 : 0;
      const quota = (truncated ? Math.floor(remaining / (sections.length - index)) : remaining) - separator;
      if (quota < header.length) { omitted.push(section.key); continue; }
      const clipped = section.text.length > quota - header.length;
      const marker = clipped ? '[…截断，保留末尾…]\n' : '';
      const allowance = quota - header.length - marker.length;
      if (clipped && allowance <= 0) { omitted.push(section.key); continue; }
      const excerpt = header + marker + (clipped ? section.text.slice(-allowance) : section.text);
      included.push(excerpt);
      remaining -= separator + excerpt.length;
      if (clipped) omitted.push(`${section.key}:truncated`);
    }
    let text = included.join('\n\n');
    if (omitted.length) {
      const note = `\n\n## omitted\n${omitted.join(', ')}`;
      if (text.length + note.length <= maxChars) text += note;
      else if (note.length <= maxChars) text = `${text.slice(0, Math.max(0, maxChars - note.length))}${note}`;
    }
    return {
      ok: true,
      action: 'memory_load',
      result: {
        workspaceRoot: this.workspaceRoot,
        managementDir,
        taskCard: card ? { name: taskCard, path: card.path, chars: card.chars, revision: createHash('sha256').update(card.text).digest('hex') } : null,
        state: state ? { path: state.path, chars: state.chars } : null,
        record: report ? { name: record, path: report.path, chars: report.chars } : null,
        refs: { tasks: list(path.join(managementDir, 'tasks')), reports: list(path.join(managementDir, 'reports')) },
        text,
        chars: text.length,
        maxChars,
        truncated,
        omitted,
        hint: '只按需读取；截断时优先保留各段末尾的交接/证据指针；读完把结论/下一步写回任务卡或报告，不把全文带进后续轮次。',
      },
    };
  }

  /**
   * 只保留最近 N 个用户轮次（从最近 user 消息边界开始），避免把整段历史发给模型。
   * 工具按轮次成组，切在 user 边界上，避免产生孤立的 tool 结果。
   */
  installContextGuard(): () => void {
    const agents = this.ctx.get?.('agents');
    if (!agents?.on || typeof this.ctx.on !== 'function') return () => {};
    const attached = new WeakSet<object>();
    const attach = (agent: any) => {
      if (!agent?.ctx || typeof agent.ctx.on !== 'function' || attached.has(agent)) return;
      attached.add(agent);
      const sessionId = String(agent.id ?? '');
      agent.ctx.on('agent/pre-step', async (payload: any, next: () => Promise<any>) => {
        const decision = await next();
        if (!this.config.contextTrimEnabled || !sessionId || !this.isSessionEnabled(sessionId)) return decision;
        if (!decision || decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision;
        const maxTurns = Math.max(1, Math.min(100, Number(this.config.contextRecentTurns ?? 10)));
        const messages = decision.messages;
        const userIndexes: number[] = [];
        for (let i = 0; i < messages.length; i += 1) {
          if (String(messages[i]?.role ?? '') === 'user') userIndexes.push(i);
        }
        if (userIndexes.length <= maxTurns) return decision;
        const start = userIndexes[userIndexes.length - maxTurns];
        return { ...decision, messages: messages.slice(start) };
      });
    };
    try {
      for (const agent of agents.list?.() ?? []) attach(agent);
    } catch {
      // 宿主没有可枚举的 Agent 时，只靠后续 agent/created 事件
    }
    const off = this.ctx.on('agent/created', (event: any) => attach(event?.agent));
    return typeof off === 'function' ? off : () => {};
  }

  /**
   * 从 journal 折叠出**智能体花名册**（只读，不依赖 team_status / 活 Agent）。
   *
   * 为什么需要：面板原来的"多少个 agent / 各自在干什么"全押在 `team_status` 上——
   * 而那要求**有活 Agent 主动调一次**，没人调就永远显示 `—`，面板看起来像摆设。
   * journal 里本来就有 `agent_spawned` / `task_claimed` / `evidence_submitted` /
   * `verify_done_*` / `task_heartbeat_*`，够还原：谁被派出来、领了哪个节点、
   * 交没交证据、最后活跃在什么时候。
   */
  buildAgentRoster(): {
    ok: boolean;
    total: number;
    running: number;
    idle: number;
    withLease: number;
    byRole: Record<string, number>;
    items: Array<Record<string, unknown>>;
    generatedAt: string;
  } {
    interface Entry {
      instanceId: string;
      role: string | null;
      label: string | null;
      sessionId: string | null;
      parentSessionId: string | null;
      spawnedAt: string | null;
      lastSeen: string | null;
      lastEvent: string | null;
      nodes: string[];
      currentNode: string | null;
      claimedAt: string | null;
      evidenceCount: number;
      doneCount: number;
      heartbeatAt: string | null;
      heartbeatFailed: boolean;
    }
    const roster = new Map<string, Entry>();
    const ensure = (instanceId: string): Entry => {
      const id = String(instanceId);
      let entry = roster.get(id);
      if (!entry) {
        entry = {
          instanceId: id,
          role: roleOfInstance(id),
          label: null,
          sessionId: null,
          parentSessionId: null,
          spawnedAt: null,
          lastSeen: null,
          lastEvent: null,
          nodes: [],
          currentNode: null,
          claimedAt: null,
          evidenceCount: 0,
          doneCount: 0,
          heartbeatAt: null,
          heartbeatFailed: false,
        };
        roster.set(id, entry);
      }
      return entry;
    };
    const touch = (entry: Entry, at: string | null, kind: string) => {
      if (at && (!entry.lastSeen || at > entry.lastSeen)) entry.lastSeen = at;
      entry.lastEvent = kind;
    };

    let rows: Record<string, unknown>[] = [];
    try {
      rows = this.readJournal();
    } catch {
      rows = [];
    }
    for (const row of rows) {
      const kind = String(row?.kind ?? '');
      const at = row?.at ? String(row.at) : null;
      const nodeId = row?.nodeId ? String(row.nodeId) : row?.node_id ? String(row.node_id) : null;
      if (kind === 'agent_spawned') {
        const instanceId = row?.instanceId ? String(row.instanceId) : '';
        if (!instanceId) continue;
        const entry = ensure(instanceId);
        entry.label = row?.label ? String(row.label) : entry.label;
        entry.sessionId = row?.sessionId ? String(row.sessionId) : entry.sessionId;
        entry.parentSessionId = row?.parentSessionId ? String(row.parentSessionId) : entry.parentSessionId;
        entry.spawnedAt = at;
        entry.role = entry.role ?? (row?.role ? String(row.role) : null);
        touch(entry, at, kind);
        continue;
      }
      const actor =
        (row?.instanceId ? String(row.instanceId) : null) ??
        (row?.producer_instance ? String(row.producer_instance) : null) ??
        (row?.auditor_instance ? String(row.auditor_instance) : null);
      if (!actor || !roleOfInstance(actor)) continue;

      if (kind === 'task_claimed') {
        const entry = ensure(actor);
        entry.currentNode = nodeId;
        entry.claimedAt = at;
        if (nodeId && !entry.nodes.includes(nodeId)) entry.nodes.push(nodeId);
        touch(entry, at, kind);
      } else if (kind === 'task_heartbeat_ok' || kind === 'task_heartbeat_failed') {
        const entry = ensure(actor);
        entry.heartbeatAt = at;
        entry.heartbeatFailed = kind === 'task_heartbeat_failed';
        touch(entry, at, kind);
      } else if (kind === 'evidence_submitted') {
        const entry = ensure(actor);
        entry.evidenceCount += 1;
        touch(entry, at, kind);
      } else if (kind === 'verify_done_requested' || kind === 'verify_done_rejected') {
        const entry = ensure(actor);
        if (kind === 'verify_done_requested') entry.doneCount += 1;
        touch(entry, at, kind);
      }
    }

    const items = [...roster.values()].map((entry) => {
      const role = entry.role ?? 'UNKNOWN';
      // 活跃判定：有当前节点 = running（领了活没交完）；否则 idle。
      const activity = entry.currentNode ? 'running' : 'idle';
      return {
        instanceId: entry.instanceId,
        role,
        label: entry.label,
        sessionId: entry.sessionId,
        parentSessionId: entry.parentSessionId,
        activity,
        currentNode: entry.currentNode,
        claimedAt: entry.claimedAt,
        nodes: entry.nodes.slice(-10),
        evidenceCount: entry.evidenceCount,
        doneCount: entry.doneCount,
        spawnedAt: entry.spawnedAt,
        lastSeen: entry.lastSeen,
        lastEvent: entry.lastEvent,
        heartbeatAt: entry.heartbeatAt,
        heartbeatFailed: entry.heartbeatFailed,
      };
    });
    items.sort((a, b) => String(b.lastSeen ?? '').localeCompare(String(a.lastSeen ?? '')) || a.instanceId.localeCompare(b.instanceId));

    const byRole: Record<string, number> = {};
    for (const item of items) byRole[item.role] = (byRole[item.role] ?? 0) + 1;
    const running = items.filter((item) => item.activity === 'running').length;
    return {
      ok: true,
      total: items.length,
      running,
      idle: items.length - running,
      withLease: items.filter((item) => Boolean(item.currentNode)).length,
      byRole,
      items,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 只读 UI 快照（侧车专用，不参与决策）。
   *
   * **按对话窗口（session）隔离**：`uiSnapshot({sessionId})` 只返回该 session 的团队板；
   * 有 live caller 且 caller.id === sessionId 才走实时投影，否则用该 session 的 `team_snapshot`；
   * 未知 session / 未指定 session 一律 `source='none'`，**不跨 session 复用**。
   */
  async uiSnapshot(input: { sessionId?: string; sinceSeq?: number; withRecovery?: boolean } = {}) {
    const graphView = await this.graphStatus();
    const coreGraph = (graphView as any)?.graph?.result ?? (graphView as any)?.graph ?? null;
    // core 内存态偶尔落后于持久层（例如 graph_commit 后 UI 侧实例未重放）；
    // 显示计数时以 recoveryReport.state 兜底，避免“图已落盘但面板 0 nodes”。
    const recovered = (graphView as any)?.persistence?.recoveryReport?.state;
    const recoveredNodes = recovered?.nodes && typeof recovered.nodes === 'object' ? Object.values(recovered.nodes) : [];
    const recoveredEdges = Array.isArray(recovered?.edges) ? recovered.edges : [];
    const recoveredDone = recoveredNodes.filter((node: any) => node?.status === 'done').length;
    const effectiveCounts = coreGraph?.counts && Number(coreGraph.counts.nodes) > 0
      ? coreGraph.counts
      : recoveredNodes.length
        ? { nodes: recoveredNodes.length, edges: recoveredEdges.length, done: recoveredDone, blocked: 0 }
        : coreGraph?.counts ?? null;
    // 只认调用方显式给的 sessionId：不拿 lastCaller 兜底，避免把本窗口数据喂给别的窗口
    const requested = input?.sessionId ? String(input.sessionId) : null;
    let team: Record<string, unknown>;
    let teamSource: 'live' | 'snapshot' | 'none' = 'none';
    let teamCapturedAt: string | null = null;
    if (requested && this.lastCaller?.id && String(this.lastCaller.id) === requested) {
      const live = this.teamStatus(this.lastCaller, { capture: false }) as Record<string, unknown>;
      team = live;
      teamSource = live?.ok === true ? 'live' : 'none';
      teamCapturedAt = new Date().toISOString();
    } else if (requested && this.teamSnapshots.has(requested)) {
      const cached = this.teamSnapshots.get(requested)!;
      team = cached.team;
      teamSource = 'snapshot';
      teamCapturedAt = cached.capturedAt;
    } else {
      team = {
        ok: false,
        error: requested ? 'no-snapshot-for-session' : 'session-required',
        hint: requested
          ? '该对话窗口还没有团队快照（未接入 / 未调用过 team_status）'
          : 'UI 必须带 sessionId：每个对话窗口各自统计，不跨 session 复用',
      };
    }
    team = { ...team, sessionId: requested, source: teamSource, capturedAt: teamCapturedAt };
    const sessions = [...this.teamSnapshots.entries()]
      .map(([sessionId, value]) => ({ sessionId, capturedAt: value.capturedAt }))
      .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
    const managementDir = this.managementRoot;
    const workspaces = [
      { id: 'code', label: '工程目录', path: this.workspaceRoot, exists: fs.existsSync(this.workspaceRoot), entries: listEntries(this.workspaceRoot) },
      { id: 'management', label: '管理区', path: managementDir, exists: fs.existsSync(managementDir), entries: listEntries(managementDir) },
      { id: 'plugins', label: '插件目录', path: path.join(this.workspaceRoot, 'plugins'), exists: fs.existsSync(path.join(this.workspaceRoot, 'plugins')), entries: listEntries(path.join(this.workspaceRoot, 'plugins')) },
      { id: 'state', label: '状态目录', path: this.stateDir, exists: fs.existsSync(this.stateDir), entries: listEntries(this.stateDir) },
    ];
    // 黑板：**增量**（sinceSeq 之后的新行，最多 40 条）+ 摘要（不全量回传历史）
    const journalRows = this.readJournal();
    const journalTotal = journalRows.length;
    const sinceRaw = Number((input as { sinceSeq?: number })?.sinceSeq);
    const sinceSeq = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? Math.floor(sinceRaw) : null;
    const BLACKBOARD_LIMIT = 40;
    const toRow = (row: Record<string, unknown>) => ({
      at: row.at ?? null,
      kind: row.kind ?? null,
      nodeId: row.nodeId ?? row.node_id ?? null,
      text: row.text ?? row.message ?? row.reason ?? null,
      action: row.action ?? null,
      status: row.status ?? null,
      actor: row.actor ?? row.instanceId ?? row.instance_id ?? null,
    });
    let blackboardMode: 'initial' | 'incremental' | 'fallback' = 'initial';
    let sliceStart = Math.max(0, journalTotal - BLACKBOARD_LIMIT);
    if (sinceSeq !== null) {
      if (sinceSeq <= journalTotal) {
        // 增量：从 cursor 到末尾；超过上限就取末尾 40 并标记 truncated
        sliceStart = sinceSeq;
        blackboardMode = 'incremental';
      } else {
        // cursor 超界 / 倒回（journal 被截断或换了状态目录）→ 回退最近 40
        blackboardMode = 'fallback';
      }
    }
    const pendingRows = journalRows.slice(sliceStart);
    const blackboardTruncated = blackboardMode !== 'incremental' && journalTotal > BLACKBOARD_LIMIT
      ? true
      : pendingRows.length > BLACKBOARD_LIMIT;
    const blackboardRows = pendingRows.slice(-BLACKBOARD_LIMIT);
    const blackboard = blackboardRows.reverse().map(toRow);

    // 摘要：总数 / 按 kind / 最近失败与决策 / 旧事件数（UI 只显示摘要，不拉历史）
    const byKind: Record<string, number> = {};
    for (const row of journalRows) {
      const kind = String(row?.kind ?? 'unknown');
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
    const failedDecisions = journalRows
      .filter((row) => {
        const status = String(row?.status ?? '').toLowerCase();
        const kind = String(row?.kind ?? '');
        return (
          status === 'rejected' ||
          status === 'failed' ||
          kind.includes('rejected') ||
          kind.includes('failed') ||
          row?.error != null
        );
      })
      .slice(-5)
      .reverse()
      .map((row) => ({
        at: row.at ?? null,
        kind: row.kind ?? null,
        reason: row.reason ?? row.error ?? row.message ?? null,
        nodeId: row.nodeId ?? row.node_id ?? null,
      }));
    const blackboardSummary = {
      total: journalTotal,
      shown: blackboardRows.length,
      older: Math.max(0, journalTotal - blackboardRows.length),
      byKind,
      failedDecisions,
      cursor: journalTotal,
    };
    let managementRevision: string | null = null;
    try {
      const statePath = path.join(managementDir, 'STATE.md');
      if (fs.existsSync(statePath)) {
        managementRevision = /revision：(\d+)/.exec(fs.readFileSync(statePath, 'utf8'))?.[1] ?? null;
      }
    } catch {
      managementRevision = null;
    }
    const management = {
      dir: managementDir,
      exists: fs.existsSync(managementDir),
      revision: managementRevision,
      cards: readManagementCards(managementDir),
    };
    let descendants: {
      ok: boolean;
      count: number;
      active?: number;
      items?: unknown[];
      error?: string;
      source?: 'live' | 'snapshot' | 'none';
      capturedAt?: string | null;
    } = { ok: false, count: 0, source: 'none', capturedAt: null };
    try {
      const subagents = this.ctx.get?.('subagents');
      if (requested && subagents?.listDescendants) {
        // 只要 UI 指定了 sessionId，就直接以它作为 root 拉实时 descendants；
        // 不要求 lastCaller 等于该 session——子 Agent 调工具后 lastCaller 会变成子 Agent，
        // 此时 lead 窗口仍应看到“正在运行”的子孙。
        const rows = await subagents.listDescendants(requested);
        const items = Array.isArray(rows) ? rows : [];
        const children = items.filter((row: any) => row?.kind === 'child');
        descendants = {
          ok: true,
          count: children.length,
          active: children.filter((row: any) => row?.activity === 'running').length,
          source: 'live',
          capturedAt: new Date().toISOString(),
          items: items.slice(0, 60).map((row: any) => ({
            id: row.id ?? null,
            parentId: row.parentId ?? null,
            depth: row.depth ?? null,
            mode: row.mode ?? null,
            label: row.label ?? null,
            activity: row.activity ?? null,
            kind: row.kind ?? null,
            reason: row.reason ?? null,
          })),
        };
        this.descendantSnapshots.set(requested, {
          count: descendants.count,
          active: Number(descendants.active ?? 0),
          at: String(descendants.capturedAt),
        });
      } else if (requested && this.descendantSnapshots.has(requested)) {
        // reload 后没有 live caller：用该 session 的快照（含 items）
        const cached = this.descendantSnapshots.get(requested)!;
        descendants = {
          ok: true,
          count: cached.count,
          active: cached.active,
          source: 'snapshot',
          capturedAt: cached.at,
          items: cached.items ?? [],
        };
      }
    } catch (error) {
      descendants = { ok: false, count: 0, source: 'none', capturedAt: null, error: String((error as Error)?.message ?? error) };
    }
    return {
      ok: true,
      at: new Date().toISOString(),
      tenant: this.tenant,
      sessionId: requested,
      sessions,
      access: {
        default: 'disabled' as const,
        enabled: requested ? this.isSessionEnabled(requested) : false,
        coordination: requested ? this.isSessionEnabled(requested) : false,
        management: requested ? this.managementFor(requested) : ('off' as ManagementMode),
        managementDefault: 'off' as const,
        sessionId: requested,
      },
      cluster: {
        clusterId: this.workspaceClusterId,
        coordinationDefault: this.workspaceCoordinationDefault,
        enabled: this.workspaceCoordinationDefault === true,
      },
      suggestedSessionId: this.lastCaller?.id ? String(this.lastCaller.id) : null,
      workspaceRoot: this.workspaceRoot,
      stateDir: this.stateDir,
      journal: this.journalSummary(),
      team,
      descendants,
      /** 花名册：从 journal 折叠，不依赖 team_status 与活 Agent。 */
      agents: (() => {
        try {
          return this.buildAgentRoster();
        } catch (error) {
          return {
            ok: false,
            total: 0,
            running: 0,
            idle: 0,
            withLease: 0,
            byRole: {},
            items: [],
            generatedAt: new Date().toISOString(),
            error: String((error as Error)?.message ?? error),
          };
        }
      })(),
      graph: coreGraph ? {
        version: coreGraph.version ?? null,
        ready: coreGraph.ready ?? [],
        counts: effectiveCounts,
      } : null,
      blackboard,
      blackboardCursor: journalTotal,
      blackboardTruncated,
      blackboardMode,
      sinceSeq,
      blackboardSummary,
      workspaces,
      management,
      // 派发层：面板要能直接回答「几个 worker 在跑 / 上轮为什么没派 / 额度剩多少」。
      dispatch: (() => {
        try {
          return this.dispatchView();
        } catch (error) {
          return { ok: false, error: 'dispatch-view-failed', message: String((error as Error)?.message ?? error) };
        }
      })(),
      // 恢复面**按需**：`recoveryView()` 要折叠 journal + 重放检查点，每 10 秒无条件跑一次
      // 在千级规模下是纯浪费（面板绝大多数时间没人看这一页）。UI 只在「调度」页时带上
      // `withRecovery=1`，其余时候这里是 null——不是"没数据"，是"没问"。
      recovery: input?.withRecovery === true ? await this.safeRecoveryView() : null,
    };
  }

  /** `recoveryView()` 的兜底包装：**观测失败不能把整个快照打成错误**。 */
  async safeRecoveryView(): Promise<Record<string, unknown> | null> {
    try {
      return await this.recoveryView({});
    } catch (error) {
      return { ok: false, error: 'recovery-view-failed', message: String((error as Error)?.message ?? error) };
    }
  }

  /**
   * 恢复面（只读）：最近检查点 / 需重放事件数 / 分区续做计划。
   *
   * 面板原来只能看「图长什么样」，看不到「崩了之后从哪儿接」——而后者才是
   * 千级运行真正会出问题的地方。这里把 checkpoint/recover/resume 三件套一次给全。
   */
  async recoveryView(input: { partitionId?: string } = {}): Promise<Record<string, unknown>> {
    const partitionId = input?.partitionId ? String(input.partitionId).trim() : undefined;
    const out: Record<string, unknown> = { ok: true, partitionId: partitionId ?? null };
    try {
      const recover = await this.graphRecover({ partitionId });
      out.checkpoint = recover.checkpoint ?? null;
      out.baseSeq = recover.baseSeq ?? null;
      out.replayed = recover.replayed ?? null;
      out.recoverOk = recover.ok === true;
      if (recover.error) out.recoverError = recover.error;
    } catch (error) {
      out.ok = false;
      out.recoverError = String((error as Error)?.message ?? error);
    }
    try {
      const plan = await this.graphResumePlan({ partitionId });
      out.resume = plan.resume ?? [];
      out.skipCompleted = plan.skipCompleted ?? [];
      out.drift = plan.drift ?? [];
      out.resumeOk = plan.ok === true;
      // 退步告警：一旦出现，说明 journal 被截断/重写过，必须显式喊出来。
      out.driftDetected = Array.isArray(out.drift) && out.drift.length > 0;
      if (plan.error) out.resumeError = plan.error;
    } catch (error) {
      out.ok = false;
      out.resumeError = String((error as Error)?.message ?? error);
    }
    try {
      const persistence = this.persistence as unknown as { recoveryReport?: { repaired?: unknown; error?: unknown } } | null;
      const report = persistence?.recoveryReport;
      out.journalRepaired = report?.repaired ?? null;
      out.journalError = report?.error ?? null;
    } catch {
      out.journalRepaired = null;
    }
    out.hint = 'checkpoint/baseSeq=从哪儿接；replayed=要重放多少事件；driftDetected=true 说明有节点状态退步（journal 被截断或改写）。';
    return out;
  }

  async taskNext(input: { role?: string }) {
    return this.withCore('task_next', (core) =>
      core.nextTask ? core.nextTask({ role: input?.role }) : Promise.resolve({ delegated: false, reason: 'core.nextTask 未实现' }),
    );
  }

  async taskClaim(input: { nodeId: string; role?: string; instanceId?: string }, caller?: any) {
    if (!input?.nodeId) return { ok: false, error: 'node-id-required' };
    const bound = this.callerInstance(caller);
    if (bound && input.instanceId && input.instanceId !== bound) {
      return { ok: false, error: 'claim-caller-mismatch', callerInstance: bound };
    }
    const instanceId = bound ?? input.instanceId;
    const result = await this.withCore('task_claim', (core) =>
      core.claimTask
        ? core.claimTask({
        nodeId: input.nodeId,
        role: input.role,
        instanceId,
        hostLimit: Number(this.config.maxParallel) || undefined,
        ratePerSecond: Number(this.config.dispatchRatePerSecond) || undefined,
      })
        : Promise.resolve({ ok: false, error: 'core-unavailable' }),
    );
    this.appendJournal((result as any)?.ok === true ? 'task_claimed' : 'task_claim_rejected', {
      nodeId: input.nodeId,
      role: input.role ?? null,
      instanceId: instanceId ?? null,
      error: (result as any)?.error ?? null,
      // 闸门归因必须进 journal：事后查「这个节点那天为什么 claim 不上」时，
      // 只有 `graph_capacity` 这样的码是不够的——它和 `partition_capacity`
      // 该做的动作相反（一个等全图、一个换域），journal 里分不出来就查不出根因。
      gate: (result as any)?.detail?.gate ?? (result as any)?.gate ?? null,
    });
    return result;
  }

  /**
   * 租约心跳（P0-3）：绑定 fencingToken 能力凭证，不绑智能体身份——任一载体
   * 持有当前 token 即可续期，owner 取自当前租约（集群身份脱离）。
   * 续租失败 = 停手信号，调用方必须停止并上报 lead，不得继续写。
   */
  async taskHeartbeat(input: { nodeId: string; fencingToken: number; ttlSec?: number }) {
    if (!input?.nodeId) return { ok: false, error: 'node-id-required' };
    if (!Number.isFinite(Number(input?.fencingToken))) return { ok: false, error: 'fencing-token-required' };
    const result = await this.withCore('task_heartbeat', (core) =>
      core.heartbeatTask
        ? core.heartbeatTask({ nodeId: input.nodeId, fencingToken: Number(input.fencingToken), ttlSec: input.ttlSec })
        : Promise.resolve({ delegated: false, reason: 'core.heartbeatTask 未实现' }),
    );
    this.appendJournal((result as any)?.ok ? 'task_heartbeat_ok' : 'task_heartbeat_failed', {
      nodeId: input.nodeId,
      error: (result as any)?.error ?? null,
    });
    return result;
  }

  /**
   * caller 绑定的实例：用 `l0adapter` 服务按 sessionId 反查（同一宿主进程内可取到）。
   * 优先取本工作区原生实例绑定，未绑定时审计调用不放行。
   */
  callerInstance(caller: any): string | null {
    const sessionId = caller?.id;
    if (!sessionId) return null;
    const native = this.native.listInstances().find((row) => row.sessionId === sessionId);
    if (native) return native.instanceId;
    const adapter = this.ctx.get('l0adapter');
    if (!adapter?.report || typeof adapter.report !== 'function') return null;
    try {
      const report = adapter.report();
      const hit = (report?.instances ?? []).find((row: any) => row.sessionId === sessionId);
      return hit?.instanceId ?? null;
    } catch {
      return null;
    }
  }

  /** acceptance → verdict（显式 verdict 优先；判定不了就是 unknown，绝不当 pass）。 */
  verdictFor(acceptance: any, resolved: string): 'pass' | 'fail' | 'unknown' {
    const kind = acceptance?.kind ?? 'exists';
    if (!acceptance || typeof acceptance !== 'object') return 'unknown';
    if (kind === 'exists') return 'pass';
    try {
      if (kind === 'sha256') {
        const expected = String(acceptance.expected ?? '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(expected)) return 'unknown';
        const actual = createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
        return actual === expected ? 'pass' : 'fail';
      }
      if (kind === 'contains') {
        const expected = acceptance.expected;
        if (typeof expected !== 'string' || expected.length === 0) return 'unknown';
        return fs.readFileSync(resolved, 'utf8').includes(expected) ? 'pass' : 'fail';
      }
    } catch {
      return 'unknown';
    }
    return 'unknown';
  }

  async evidenceSubmit(rawInput: Record<string, unknown>, caller?: any) {
    let input: Record<string, unknown>;
    try {
      input = normalizeKeys(rawInput);
    } catch (error) {
      return { ok: false, error: 'key-conflict', detail: String((error as Error)?.message || error) };
    }
    if (!input?.nodeId || !input?.artifactPath) {
      return { ok: false, error: 'nodeId 与 artifactPath 必填' };
    }
    const callerProducer = this.callerInstance(caller);
    const producer = String(callerProducer ?? input.producer_instance ?? '');
    if (callerProducer && input.producer_instance && String(input.producer_instance) !== callerProducer) {
      return { ok: false, error: 'producer-caller-mismatch', callerInstance: callerProducer };
    }
    if (!producer) {
      return {
        ok: false,
        error: 'producer-unknown',
        hint: '传 producer_instance，或让 caller 绑定一个 ROLE-<职务>-<序号> 实例',
      };
    }
    const resolved = path.isAbsolute(String(input.artifactPath))
      ? String(input.artifactPath)
      : path.resolve(this.workspaceRoot, String(input.artifactPath));
    const exists = fs.existsSync(resolved);
    if (!exists) {
      this.appendJournal('evidence_rejected', { nodeId: input.nodeId, producer_instance: producer, reason: 'artifact-missing' });
      return { ok: false, error: 'artifact-missing', resolved, producer_instance: producer };
    }
    const explicit = typeof input.verdict === 'string' ? String(input.verdict).toLowerCase() : null;
    if (explicit && !['pass', 'fail', 'unknown'].includes(explicit)) {
      return { ok: false, error: 'verdict-invalid', hint: 'verdict ∈ pass|fail|unknown' };
    }
    // 门禁（Lead 2026-10-29 裁决）：既无 acceptance 又无 verdict → 不得提交
    // （core 对 `kind:'none'` 曾按 caller-asserts-pass 记 pass，等于 unknown 变 pass）
    const hasAcceptance = Boolean(input.acceptance && typeof input.acceptance === 'object');
    if (!hasAcceptance && !explicit) {
      this.appendJournal('evidence_rejected', {
        nodeId: input.nodeId,
        producer_instance: producer,
        reason: 'acceptance-required',
      });
      return {
        ok: false,
        error: 'acceptance-required',
        hint: '传 acceptance:{kind: exists|sha256|contains} 或显式 verdict；无判据不得 pass',
        producer_instance: producer,
      };
    }
    const verdict = explicit ?? this.verdictFor(input.acceptance, resolved);
    if (verdict === 'unknown') {
      // 判定不了就是 unknown：可以记录，但不能被下游当 pass
      this.appendJournal('evidence_recorded_unknown', { nodeId: input.nodeId, producer_instance: producer });
    }
    const result = await this.withCore('evidence_submit', (core) =>
      core.submitEvidence
        ? core.submitEvidence(
            withAliases({ ...input, resolved, producer_instance: producer, producerInstance: producer, verdict, fencingToken: Number(input.fencingToken), auditLeaseTtlSec: Number(this.config.auditLeaseTtlSec ?? 0) }),
          )
        : Promise.resolve({ delegated: false, reason: 'core.submitEvidence 未实现', resolved, producer_instance: producer, verdict }),
    );
    const accepted = (result as { ok?: boolean })?.ok === true;
    this.appendJournal(accepted ? 'evidence_submitted' : 'evidence_rejected', {
      nodeId: input.nodeId,
      artifactPath: String(input.artifactPath),
      verifier: input.verifier ?? null,
      producer_instance: producer,
      verdict,
      verdictSource: explicit ? 'explicit' : 'acceptance',
      exists,
      reason: accepted ? null : (result as { error?: string })?.error ?? 'unknown',
    });
    return result;
  }

  async verifyDone(rawInput: Record<string, unknown>, caller?: any) {
    let input: Record<string, unknown>;
    try {
      input = normalizeKeys(rawInput);
    } catch (error) {
      return { ok: false, error: 'key-conflict', detail: String((error as Error)?.message || error) };
    }
    if (!input?.nodeId) return { ok: false, error: 'node-id-required' };
    if (!Number.isFinite(Number(input.fencingToken))) return { ok: false, error: 'fencing-token-required' };
    const callerAuditor = this.callerInstance(caller);
    const auditor = String(callerAuditor ?? '');
    if (input.auditor_instance && String(input.auditor_instance) !== auditor) {
      return { ok: false, error: 'auditor-caller-mismatch', callerInstance: callerAuditor };
    }
    if (!auditor) {
      return {
        ok: false,
        error: 'auditor-required',
        hint: '审计必须由已绑定的真实审计 caller 执行',
      };
    }
    const producer = String(input.producer_instance ?? '');
    if (!producer) {
      return { ok: false, error: 'producer-required', hint: '审计独立性需要 producer_instance 才能机检' };
    }
    // 硬门禁：同实例生产+审计一律拒（不放宽）
    if (producer === auditor) {
      this.appendJournal('verify_done_rejected', { nodeId: input.nodeId, producer_instance: producer, auditor_instance: auditor, reason: 'audit-independence' });
      return {
        ok: false,
        error: 'audit-independence-violated',
        hint: '同一产物的生产实例与审计实例不得相同（复合实例含审计职务时亦然）',
        producer_instance: producer,
        auditor_instance: auditor,
      };
    }
    if (!isAuditorInstance(auditor)) {
      return {
        ok: false,
        error: 'auditor-role-required',
        hint: `auditor_instance 的职务必须属审计职务（${AUDITOR_ROLES.join('/')}）`,
        auditorRole: roleOfInstance(auditor),
      };
    }
    const result = await this.withCore('verify_done', (core) =>
      core.verifyDone
        ? core.verifyDone(
            withAliases({
              ...input,
              producer_instance: producer,
              producerInstance: producer,
              auditor_instance: auditor,
              auditorInstance: auditor,
              fencingToken: Number(input.fencingToken),
            }),
          )
        : Promise.resolve({ delegated: false, reason: 'core.verifyDone 未实现' }),
    );
    const accepted = (result as { ok?: boolean })?.ok === true;
    this.appendJournal(accepted ? 'verify_done_requested' : 'verify_done_rejected', {
      nodeId: input.nodeId,
      acceptance: input.acceptance ?? null,
      producer_instance: producer,
      auditor_instance: auditor,
      auditorRole: roleOfInstance(auditor),
      reason: accepted ? null : (result as { error?: string })?.error ?? 'unknown',
    });
    return result;
  }

  async decide(rawInput: Record<string, unknown>) {
    let input: Record<string, unknown>;
    try {
      input = normalizeKeys(rawInput);
    } catch (error) {
      return { ok: false, error: 'key-conflict', detail: String((error as Error)?.message || error) };
    }
    if (!input?.decisionId && !input?.nodeId) return { ok: false, error: 'decisionId 或 nodeId 必填' };
    this.appendJournal('decision_requested', {
      decisionId: input.decisionId ?? null,
      nodeId: input.nodeId ?? null,
      optionId: input.optionId ?? null,
      level: input.level ?? null,
    });
    return this.withCore('decide', (core) =>
      core.decide ? core.decide(input) : Promise.resolve({ delegated: false, reason: 'core.decide 未实现' }),
    );
  }

  /** 阶段闸门：只接受 5 段枚举；直接调 core.passGate，**不允许改节点状态**。 */
  async passGate(rawInput: Record<string, unknown>) {
    let input: Record<string, unknown>;
    try {
      input = normalizeKeys(rawInput);
    } catch (error) {
      return { ok: false, error: 'key-conflict', detail: String((error as Error)?.message || error) };
    }
    const stage = String(input?.stage ?? '').toLowerCase();
    if (!GATE_STAGES.includes(stage)) {
      return { ok: false, error: 'stage-invalid', stage, allowed: [...GATE_STAGES] };
    }
    const refs = Array.isArray(input.evidence_refs) ? (input.evidence_refs as unknown[]).map(String) : [];
    const result = await this.withCore('pass_gate', (core) => {
      if (typeof core.passGate !== 'function' || typeof core.coreStore !== 'function') {
        return { ok: false, error: 'core-gate-unavailable' };
      }
      const store = core.coreStore();
      const gate = core.passGate(store, stage, refs);
      return { ok: true, stage, evidence_refs: refs, gate };
    });
    this.appendJournal((result as { ok?: boolean })?.ok ? 'gate_passed' : 'gate_rejected', {
      stage,
      evidence_refs: refs,
      reason: (result as { error?: string })?.error ?? null,
    });
    return result;
  }

  /**
   * 原生通道：直接读 agentTeams 团队板（caller 必须是活 Agent）。
   * 成功时把**投影后的安全快照**写 journal `team_snapshot`（`capture:false` 可关，UI 轮询不刷盘）。
   */
  teamStatus(caller: any, options: { capture?: boolean } = {}) {
    this.lastCaller = caller ?? null;
    if (!caller?.id) {
      return {
        ok: false,
        error: 'caller-required',
        hint: 'agentTeams 的每个方法都要活 Agent 作 caller；工具入口用 exec.agent',
      };
    }
    const teams = this.agentTeams;
    if (!teams) {
      return { ok: false, error: 'agentTeams-absent', hint: '该部署未挂载 Agent Teams 服务' };
    }
    try {
      const membership = teams.membership(caller);
      const members = teams.listMembers(caller) ?? [];
      const tasks = teams.listTasks(caller) ?? [];
      // 先投影成纯标量，再 JSON 兜底；两步任一失败都走 projection-failed
      const projected = toLossless(projectTeam(caller, membership, members, tasks)) as Record<string, unknown>;
      // 同时带出本插件派生的真实子 Agent 实例（native 执行层的登记表）
      const value = {
        ...projected,
        nativeInstanceCount: this.native.listInstances().length,
        nativeInstances: this.native.listInstances().map((row) => ({
          instanceId: row.instanceId,
          sessionId: row.sessionId,
          role: row.role,
          mode: row.mode,
        })),
      };
      if (options.capture !== false) {
        const capturedAt = new Date().toISOString();
        const sessionId = String(caller?.id ?? '');
        if (sessionId) {
          this.teamSnapshots.set(sessionId, { capturedAt, team: value });
          try {
            this.appendJournal('team_snapshot', { sessionId, capturedAt, team: value });
          } catch {
            // 落 journal 失败不影响本次返回
          }
          // 异步补子 Agent 快照（不阻塞团队板返回）
          void this.captureDescendants(sessionId, caller);
        }
      }
      return value;
    } catch (error) {
      return { ok: false, error: 'projection-failed', detail: errorInfo(error) };
    }
  }

  /**
   * Bootstrap：`project_init`。
   * 先写 `project_init_planned`，再跑（dry-run 同样是纯读），最后写 `project_init_result`。
   */
  async projectInit(input: {
    projectName?: string;
    wish?: string;
    slug?: string;
    root?: string;
    /** 选中工作区（别名 selectedWorkspace / workspacePath）。 */
    workspaceRoot?: string;
    selectedWorkspace?: string;
    workspacePath?: string;
    managementRoot?: string;
    dryRun?: boolean;
    gitInit?: boolean;
    management?: boolean;
    allowEmptyExisting?: boolean;
  }, sessionId?: string | null) {
    const safeInput = input ?? {};
    // 第二个轴：工作区管理。off → 直接拒绝（AI 不能自行建管理区）；auto/on 放行
    const managementMode = this.managementFor(sessionId);
    if (managementMode === 'off') {
      this.appendJournal('project_init_blocked', { sessionId: sessionId ? String(sessionId) : null, reason: 'management-disabled' });
      return {
        ok: false,
        error: 'management-disabled',
        sessionId: sessionId ? String(sessionId) : null,
        management: managementMode,
        hint: '本对话的「工作区管理」是关；在面板把它设为 自动/开 后再调用 project_init',
      };
    }
    this.appendJournal('project_init_planned', {
      projectName: safeInput.projectName ?? null,
      slug: safeInput.slug ?? null,
      root: safeInput.root ?? null,
      workspaceRoot: safeInput.workspaceRoot ?? safeInput.selectedWorkspace ?? safeInput.workspacePath ?? null,
      managementRoot: safeInput.managementRoot ?? null,
      dryRun: safeInput.dryRun !== false,
      gitInit: safeInput.gitInit !== false,
      management: safeInput.management !== false,
      allowEmptyExisting: safeInput.allowEmptyExisting === true,
    });
    const result = runProjectInit(safeInput, { workspaceRoot: this.workspaceRoot });
    this.appendJournal('project_init_result', {
      ok: result.ok,
      dryRun: result.dryRun,
      root: result.project.root,
      managementDir: result.project.managementDir,
      workspaceRoot: result.project.workspaceRoot,
      slug: result.project.slug,
      created: result.actions.filter((row) => row.status === 'created').length,
      skipped: result.actions.filter((row) => row.status === 'skipped').length,
      conflicts: result.conflicts,
      git: result.git.state,
    });
    return result;
  }

  async exportProjection(input: { outDir?: string }) {
    const outDir = path.resolve(this.workspaceRoot, input?.outDir || path.join(this.config.stateDir, 'export'));
    this.ensureStateDir();
    fs.mkdirSync(outDir, { recursive: true });
    const files: string[] = [];
    const capsPath = path.join(outDir, 'capabilities.json');
    fs.writeFileSync(capsPath, JSON.stringify(CAPABILITIES, null, 2), 'utf8');
    files.push(capsPath);
    const statePath = path.join(outDir, 'STATE.md');
    const journal = this.journalSummary();
    fs.writeFileSync(
      statePath,
      ['# L0 控制面快照（导出）', '', `- 导出时间：${new Date().toISOString()}`, `- 状态目录：${this.stateDir}`, `- journal 事件：${journal.events}`, `- 最新事件：${journal.lastKind ?? '-'}`, ''].join('\n'),
      'utf8',
    );
    files.push(statePath);
    const coreResult = await this.withCore('export', (core) =>
      core.exportProjection ? core.exportProjection(outDir) : Promise.resolve({ delegated: false, reason: 'core.exportProjection 未实现' }),
    );
    return { ok: true, outDir, files, core: coreResult, persistence: await this.persist() };
  }

  // ── 原生执行层（真实 Agent / 原生团队板） ──────────────────
  async spawnAgent(input: {
    role: string;
    task: string;
    /** —— 扁平写法（兼容旧调用，优先级低于分组） —— */
    index?: number;
    label?: string;
    maxDepth?: number;
    agentPreset?: string;
    cwd?: string;
    via?: 'auto' | 'team' | 'activation' | 'provider';
    provider?: string;
    capability?: string;
    contextPack?: string[];
    heartbeatTtlSec?: number;
    taskBrief?: import('./native/worker.js').WorkerPromptInput['taskBrief'];
    worker?: { enabled?: boolean; capability?: string; contextPack?: string[]; maxIterations?: number; heartbeatTtlSec?: number; taskBrief?: import('./native/worker.js').WorkerPromptInput['taskBrief'] };
    /** —— 分组写法：把"这个 agent 是谁/带什么包"和"走哪条通道"分开 —— */
    agent?: {
      preset?: string;
      capability?: string;
      contextPack?: string[];
      cwd?: string;
      maxDepth?: number;
      label?: string;
      index?: number;
      heartbeatTtlSec?: number;
      taskBrief?: import('./native/worker.js').WorkerPromptInput['taskBrief'];
    };
    transport?: {
      via?: 'auto' | 'team' | 'activation' | 'provider';
      provider?: string;
    };
  }, caller?: any) {
    // 分组参数摊平：`agent.*` / `transport.*` 覆盖同名扁平字段（分组是"更明确的意图"）。
    // 保留扁平写法不动，老调用方零改动。
    if (input?.agent && typeof input.agent === 'object') {
      const a = input.agent;
      if (a.preset !== undefined) input.agentPreset = a.preset;
      if (a.capability !== undefined) input.capability = a.capability;
      if (a.contextPack !== undefined) input.contextPack = a.contextPack;
      if (a.cwd !== undefined) input.cwd = a.cwd;
      if (a.maxDepth !== undefined) input.maxDepth = a.maxDepth;
      if (a.label !== undefined) input.label = a.label;
      if (a.index !== undefined) input.index = a.index;
      if (a.heartbeatTtlSec !== undefined) input.heartbeatTtlSec = a.heartbeatTtlSec;
    }
    if (input?.transport && typeof input.transport === 'object') {
      const t = input.transport;
      if (t.via !== undefined) input.via = t.via;
      if (t.provider !== undefined) input.provider = t.provider;
    }
    // 能力包可以在顶层或 worker 子对象里给（顶层写法更顺手）
    const parentEnabled = Boolean(caller?.id) && this.isSessionEnabled(String(caller.id));
    const parentContextPack = Array.isArray(input?.contextPack) ? input.contextPack : [];
    const worker = {
      ...(input?.worker ?? {}),
      ...(input?.capability ? { capability: input.capability } : {}),
      taskBrief: input?.agent?.taskBrief ?? input?.taskBrief ?? input?.worker?.taskBrief,
      // 心跳 TTL 由派发方决定（worker 按 ≤ TTL/3 自驱续租）；租约默认 600s，worker 侧默认 60s。
      ...(Number.isFinite(Number(input?.heartbeatTtlSec)) ? { heartbeatTtlSec: Number(input.heartbeatTtlSec) } : {}),
      contextPack: parentContextPack.length ? parentContextPack : (parentEnabled ? ['父会话只提供任务定位；不继承完整历史。'] : []),
      enabled: parentEnabled || input?.worker?.enabled === true || Boolean(input?.capability || input?.taskBrief || input?.agent?.taskBrief || input?.worker?.taskBrief) || parentContextPack.length > 0,
    };
    // **默认不指定 agentPreset**（让子实例继承父会话的预设）。
    //
    // 原来这里硬编码了 `'memory-first'`：只要父会话启用了记忆，就给子实例指定这个预设。
    // 它在本机没问题（`presets/memory-first` 已通过 Junction 装进 profile），但**别人未必装**。
    // 而宿主的处理是硬的：
    //
    //   if (composition.agentPreset !== undefined) {
    //     const presets = childCtx.get('agentPresets');
    //     if (presets === undefined) throw new SubagentError(..., 'PRESET_UNAVAILABLE');
    //     return presets.mount(childCtx, composition.agentPreset);   // 未知名字在这里失败
    //   }
    //
    // 也就是：**传一个没注册的预设名，会让 spawn 直接失败**——不是降级，是派不出去。
    // 而不传时宿主走 `selectedPreset ?? parent.composedPreset(parent)`，子实例**继承父的预设**，
    // 既不需要那个包存在，也不会丢掉父会话的记忆能力。
    //
    // 所以改成：默认继承；要用特定预设就配 `defaultAgentPreset`（并自行安装那个包）。
    const configuredPreset = String(this.config.defaultAgentPreset ?? '').trim();
    const agentPreset = input?.agentPreset ?? (configuredPreset || undefined);
    const result = await this.native.spawnAgent({ ...input, agentPreset, worker, cwd: input?.cwd ?? this.workspaceRoot }, caller);
    if (result.ok && result.sessionId && parentEnabled) {
      this.setSessionAccess(
        String(result.sessionId),
        {
          coordination: true,
          management: this.managementFor(String(caller.id)),
        },
        'inherit',
      );
    }
    this.appendJournal(result.ok ? 'agent_spawned' : 'agent_spawn_failed', {
      instanceId: result.instanceId ?? null,
      sessionId: result.sessionId ?? null,
      role: result.role ?? String(input?.role ?? '').toUpperCase(),
      label: input?.label ?? null,
      parentSessionId: caller?.id ?? null,
      parentEnabled,
      agentPreset: agentPreset ?? null,
      messageId: result.messageId ?? null,
      error: result.error ?? null,
      // 「撞宿主 Team 成员上限 → 自动改走 activation」是**预期路径**，不是失败。
      // 必须落进 journal：否则事后看到 `teammateError: TEAM_MEMBER_LIMIT` 会误判成
      // 「派不出去」而去调 maxParallel / 预算，而那两个参数对这件事毫无作用。
      teamLimitFallback: (result as { teamLimitFallback?: boolean }).teamLimitFallback === true,
    });
    return { ...result, persistence: await this.persist(), memorySensitivity: {
      strategy: input?.via ?? 'auto',
      parentEnabled,
      contextTrimEnabled: Boolean(this.config.contextTrimEnabled),
      recentTurns: Number(this.config.contextRecentTurns ?? 30),
      agentPreset: agentPreset ?? null,
      contextPackSize: worker.contextPack?.length ?? 0,
      hint: parentEnabled
        ? '父会话已启用裁剪与记忆；A=team 记忆 prompt，B=activation preset，C=provider。读大文件前先 memory_load，读完 memory_writeback。'
        : '父会话未启用插件：子 Agent 不继承 access/裁剪；需要时先启用父会话再选 B/C。',
    } };
  }

  /**
   * 回收空闲子 Agent：默认 dry-run；扫描全部递归子孙，running 一律跳过。
   * apply 时直接子会话先 drainChildren，再尝试 archiveSession；不硬删 journal/证据。
   */
  async reapAgents(input: { sessionIds?: string[]; apply?: boolean } = {}, caller?: any) {
    if (!caller?.id) return { ok: false, error: 'caller-required' };
    // P2-12 触发策略（config，默认全关）：enabled=false 时即使 apply=true 也拒绝执行；
    // dryRun 只决定缺省，显式 apply:true + enabled=true 才执行。无定时器。
    const policy = reapPolicyFromConfig(this.config as never);
    const wantApply = input?.apply === true;
    if (wantApply && !policy.enabled) {
      this.appendJournal('agent_reap_refused', { caller: caller.id, reason: 'reap-disabled', policy });
      return { ok: false, error: 'reap-disabled', policy, hint: 'reapEnabled=false（默认）：先在配置开启回收，再显式 apply=true。' };
    }
    const subagents = this.ctx.get?.('subagents');
    if (!subagents?.listDescendants || !subagents?.drainChildren) {
      return { ok: false, error: 'subagents-unavailable' };
    }
    const rows = await subagents.listDescendants(caller.id);
    const descendants = (Array.isArray(rows) ? rows : []).filter((row: any) => row?.kind === 'child');
    const requested = Array.isArray(input?.sessionIds) ? new Set(input.sessionIds.map(String)) : null;
    const targets = descendants.filter((row: any) => !requested || requested.has(String(row.id)));
    // 子树 running 判定：候选的子孙树含 running 时整棵跳过（requireNoRunningDescendants）。
    const childrenOf = new Map<string, string[]>();
    for (const row of descendants) {
      const parent = String(row.parentId ?? caller.id);
      const list = childrenOf.get(parent) ?? [];
      list.push(String(row.id));
      childrenOf.set(parent, list);
    }
    const runningIds = new Set(descendants.filter((row: any) => String(row?.activity ?? '') === 'running').map((row: any) => String(row.id)));
    const subtreeHasRunning = (id: string, seen = new Set<string>()): boolean => {
      if (seen.has(id)) return false;
      seen.add(id);
      for (const child of childrenOf.get(id) ?? []) {
        if (runningIds.has(child) || subtreeHasRunning(child, seen)) return true;
      }
      return false;
    };
    const nowMs = Date.now();
    const idleMinutesOf = (row: any): number | null => {
      const raw = row.lastActiveAt ?? row.updatedAt ?? row.lastUsedAt ?? row.lastSeenAt;
      const ts = raw ? Date.parse(String(raw)) : NaN;
      return Number.isFinite(ts) ? Math.max(0, Math.floor((nowMs - ts) / 60000)) : null;
    };
    const skipped: Array<{ sessionId: string; reason: string }> = [];
    const candidates = targets
      .filter((row: any) => {
        const id = String(row.id);
        if (String(row?.activity ?? '') === 'running') { skipped.push({ sessionId: id, reason: 'running' }); return false; }
        if (policy.requireNoRunningDescendants && subtreeHasRunning(id)) { skipped.push({ sessionId: id, reason: 'running-descendant' }); return false; }
        const idle = idleMinutesOf(row);
        if (idle !== null && idle < policy.idleThresholdMinutes) { skipped.push({ sessionId: id, reason: `idle-${idle}m-below-threshold-${policy.idleThresholdMinutes}m` }); return false; }
        return true;
      })
      .map((row: any) => ({
        sessionId: String(row.id),
        label: row.label ?? null,
        activity: row.activity ?? null,
        mode: row.mode ?? null,
        depth: row.depth ?? null,
        parentId: row.parentId ?? null,
        idleMinutes: idleMinutesOf(row),
        idleUnknown: idleMinutesOf(row) === null,
      }));
    const willApply = wantApply && policy.enabled && !policy.dryRun;
    const planned = {
      ok: true,
      action: 'agent_reap',
      dryRun: !willApply,
      policy,
      candidates,
      skipped,
      hint: willApply
        ? 'apply 执行：只释放直接子会话并归档，不硬删 journal 与证据。'
        : 'dry-run：候选仅列出；执行需 reapEnabled=true、reapDryRun=false 且 apply=true。',
    };
    this.appendJournal('agent_reap_planned', { caller: caller.id, candidates: candidates.map((row) => row.sessionId), skipped });
    if (!willApply) return planned;
    const ids = candidates.map((row) => row.sessionId);
    if (!ids.length) return { ...planned, applied: [], archived: [], errors: [] };
    const applied: string[] = [];
    const archived: string[] = [];
    const errors: Array<{ sessionId: string; error: string }> = [];
    const directIds = candidates.filter((row) => String(row.parentId ?? '') === String(caller.id)).map((row) => row.sessionId);
    try {
      if (directIds.length) await subagents.drainChildren(caller, directIds);
      applied.push(...directIds);
    } catch (error) {
      errors.push({ sessionId: '*', error: String((error as Error)?.message ?? error) });
    }
    const registry = this.ctx.get?.('workspaceRegistry');
    for (const sessionId of ids) {
      try {
        if (typeof registry?.archiveSession === 'function') {
          await registry.archiveSession(sessionId);
          archived.push(sessionId);
        }
      } catch (error) {
        errors.push({ sessionId, error: String((error as Error)?.message ?? error) });
      }
    }
    this.appendJournal('agent_reap_applied', { caller: caller.id, applied, archived, errors });
    return { ...planned, dryRun: false, applied, archived, errors };
  }

  async sendMessage(input: { instanceId: string; text: string; awaitOutput?: boolean; timeoutMs?: number }, caller?: any) {
    const parentEnabled = Boolean(caller?.id) && this.isSessionEnabled(String(caller.id));
    const marker = '[L0-MEMORY]';
    const original = String(input?.text ?? '');
    const reminded = parentEnabled && !original.includes(marker);
    const text = reminded
      ? `${original}\n\n${marker}\n接手/续跑时：先用 memory_load 读当前任务卡/STATE/一篇报告；只参考最近对话，不重读父会话完整历史；完成/阶段结束用 memory_writeback 写回结论、证据、下一步。`
      : original;
    const result = await this.native.sendMessage({ ...input, text }, caller);
    if (result.ok && result.sessionId && parentEnabled) {
      this.setSessionAccess(String(result.sessionId), { coordination: true }, 'inherit');
    }
    this.appendJournal(result.ok ? 'agent_message_sent' : 'agent_message_failed', {
      instanceId: result.instanceId ?? input?.instanceId ?? null,
      sessionId: result.sessionId ?? null,
      messageId: result.messageId ?? null,
      awaitOutput: input?.awaitOutput === true,
      memoryReminded: reminded,
      settled: (result as any)?.output?.settled ?? null,
      turnEndReason: (result as any)?.output?.turnEnd?.reason ?? null,
      replyText: (result as any)?.output?.text ?? null,
      error: result.error ?? null,
    });
    return { ...result, memoryReminded: reminded, persistence: await this.persist() };
  }

  async createTeamTask(input: { subject: string; description: string; blockedBy?: string[]; writeScopes?: string[]; nodeId?: string; ownerInstance?: string }, caller?: any) {
    const result = await this.native.createTeamTask(input, caller);
    this.appendJournal(result.ok ? 'team_task_created' : 'team_task_create_failed', {
      taskId: (result as any)?.task?.id ?? null,
      nodeId: input?.nodeId ?? null,
      subject: input?.subject ?? null,
      error: (result as any)?.error ?? null,
    });
    return { ...result, persistence: await this.persist() };
  }

  async updateTeamTask(input: { taskId: string; expectedRevision: number; action: string; owner?: string }, caller?: any) {
    const result = await this.native.updateTeamTask(input, caller);
    this.appendJournal(result.ok ? 'team_task_updated' : 'team_task_update_failed', {
      taskId: input?.taskId ?? null,
      action: input?.action ?? null,
      revision: (result as any)?.task?.revision ?? null,
      error: (result as any)?.error ?? null,
    });
    return { ...result, persistence: await this.persist() };
  }

  /**
   * 宿主服务自检：**缺了不报错，但必须能看见**。
   *
   * 为什么需要它：本插件的 `inject` 只声明了 `['tools']`，而 `agentTeams` / `subagents` /
   * `sessionController` 全是运行时 `ctx.get()` 取的。宿主没提供时插件照常加载、工具照常可用，
   * 只是**能力悄悄降级**——`agent_spawn` 全部退回 activation（`ownerCapable:false`），
   * `teamMemberLimit` 放开无效。这种"不报错的降级"只能从返回值里倒推，太隐蔽。
   *
   * 所以：启动/首次工具调用时探一次，缺什么写清楚缺什么、影响什么、怎么补。
   */
  hostServices(): {
    agentTeams: boolean;
    subagents: boolean;
    sessionController: boolean;
    missing: string[];
    degraded: string[];
  } {
    const probe = (name: string): boolean => {
      try { return this.ctx.get(name) != null; } catch { return false; }
    };
    const agentTeams = probe('agentTeams');
    const subagents = probe('subagents');
    const sessionController = probe('sessionController');
    const missing: string[] = [];
    const degraded: string[] = [];
    if (!agentTeams) {
      missing.push('agentTeams');
      degraded.push(
        'agent_spawn 将全部退回 activation（子实例不能当 TeamTask owner）；teamMemberLimit 放开无效。其余功能正常。' +
        '补法：在 DSH 里启用 @deepseek-ai/dsh-experimental-agent-team（宿主自带）。',
      );
    }
    if (!subagents) {
      missing.push('subagents');
      degraded.push('无法派发任何子会话（agent_spawn 不可用）；reap/协调器/图操作仍正常。');
    }
    if (!sessionController) {
      missing.push('sessionController');
      degraded.push('无法观测/接管既有会话，续跑与消息转发不可用。');
    }
    return { agentTeams, subagents, sessionController, missing, degraded };
  }

  private hostServicesReported = false;

  /**
   * **存储落点体检**：开工前就告诉你数据会写到哪、那个盘还剩多少、按你的规模够不够。
   *
   * 为什么必须在源头做，而不是等满了再处理：
   *
   *   - **协作记录**（journal/快照/证据）跟随工作区：`stateDir` 相对 `workspaceRoot` 解析，
   *     工作区在哪个盘就落哪个盘。这部分**天生可控**。
   *   - **每个 Agent 的会话**却集中落在 `$DSH_HOME/sessions/`，**默认就是系统盘**。
   *     实测约 **1 MB/会话**（本机 187 会话 = 242 MB）。1000 个 Agent ≈ 0.9 GB、
   *     10000 个 ≈ 9 GB，而且**只增不减**。
   *
   * 也就是：别人的机器很可能**一开始就在往 C 盘堆**，运行时没有任何提示——
   * 等发现时已经满了，迁移成本远高于开工前改一个环境变量。
   *
   * 阈值刻意保守：只在「会话在系统盘」且（可用 < 20 GB 或 千级预估 > 可用 30%）时告警，
   * 避免对「小项目本来就在 C 盘」这种合理场景天天喊狼来了。
   */
  storageHealth(): Record<string, unknown> {
    const driveOf = (p: string): string => {
      const m = /^([A-Za-z]:)/.exec(path.resolve(p));
      return m ? m[1].toUpperCase() : '';
    };
    const freeOf = (root: string): { freeGb: number; totalGb: number } => {
      try {
        const st = (fs as unknown as {
          statfsSync?: (x: string) => { bsize: number; bavail: number; blocks: number };
        }).statfsSync?.(`${root}\\`);
        if (!st) return { freeGb: -1, totalGb: -1 };
        const gb = (n: number) => n / 1024 / 1024 / 1024;
        return { freeGb: Number(gb(st.bsize * st.bavail).toFixed(1)), totalGb: Number(gb(st.bsize * st.blocks).toFixed(1)) };
      } catch { return { freeGb: -1, totalGb: -1 }; }
    };

    const systemDrive = String(process.env.SystemDrive ?? 'C:').toUpperCase();
    const dshHome = String(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'));
    const sessionDir = path.join(dshHome, 'sessions');
    const tempDir = os.tmpdir();

    // 实测速率：数一遍已有会话算平均大小（没有就按 1 MB 保守估）
    let sessions = 0;
    let sessionsMb = 0;
    const walkStock = (dir: string, depth = 0): void => {
      if (depth > 4) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walkStock(full, depth + 1);
        else {
          sessions += 1;
          try { sessionsMb += fs.statSync(full).size / 1024 / 1024; } catch { /* 忽略 */ }
        }
      }
    };
    walkStock(sessionDir);
    const perAgentMb = sessions > 0 ? sessionsMb / sessions : 1;
    const perNodeJournalKb = 0.53 * 8; // 528 B/行 × 约 8 行/节点

    const locations = {
      stateDir: { path: this.stateDir, drive: driveOf(this.stateDir) },
      sessionDir: { path: sessionDir, drive: driveOf(sessionDir), sessions, sessionsMb: Number(sessionsMb.toFixed(1)) },
      tempDir: { path: tempDir, drive: driveOf(tempDir) },
    };
    const roots = [...new Set([locations.stateDir.drive, locations.sessionDir.drive, locations.tempDir.drive, systemDrive])].filter(Boolean);
    const drives = roots.map((root) => ({ root, ...freeOf(root) }));

    const warnings: string[] = [];
    const advice: string[] = [];
    const sessionDrive = locations.sessionDir.drive;
    const sessionFree = drives.find((d) => d.root === sessionDrive)?.freeGb ?? -1;
    const for1000Gb = (perAgentMb * 1000) / 1024;
    const for10000Gb = (perAgentMb * 10000) / 1024;

    if (sessionDrive === systemDrive) {
      const tight = sessionFree >= 0 && sessionFree < 20;
      const willOverflow = sessionFree >= 0 && for1000Gb > sessionFree * 0.3;
      if (tight || willOverflow) {
        warnings.push(
          `Agent 会话集中写在系统盘 ${sessionDrive}（可用 ${sessionFree.toFixed(1)} GB）。` +
          `实测 ${perAgentMb.toFixed(2)} MB/会话 → 1000 个 Agent 约 ${for1000Gb.toFixed(2)} GB、10000 个约 ${for10000Gb.toFixed(2)} GB，且只增不减。`,
        );
        const better = drives
          .filter((d) => d.root !== systemDrive && d.freeGb > sessionFree * 2)
          .sort((a, b) => b.freeGb - a.freeGb)[0];
        advice.push(
          `把 DSH 数据目录迁到更宽的盘${better ? `（${better.root} 现可用 ${better.freeGb.toFixed(1)} GB）` : ''}：` +
          `先设新 home 再启动 DSH，例如 setx DSH_HOME "D:\\\\dsh-home"（Windows）/ export DSH_HOME=/data/dsh-home，` +
          `改完重开 DSH 即整体迁走（含 sessions / profiles / runtimes）。` +
          `这是**宿主环境变量**，插件不改也不想偷偷改；改之前把旧 ${dshHome} 里的内容一并搬过去。`,
        );
      }
    }
    if (sessionFree >= 0 && sessionFree < 2) {
      warnings.push(`${sessionDrive} 仅剩 ${sessionFree.toFixed(1)} GB，已低于安全余量（2 GB）。`);
    }
    if (locations.stateDir.drive === systemDrive) {
      warnings.push(
        `协作记录（journal/证据）也落在系统盘 ${locations.stateDir.drive}——它跟随工作区（${this.workspaceRoot}）。` +
        `journal 约 ${perNodeJournalKb.toFixed(1)} KB/节点，50 万节点会到 512 MB 的分段上限。`,
      );
      advice.push('想挪走：把工作区放到数据盘，或在 profile 里把 stateDir 设成指向数据盘的绝对路径。');
    }
    if (locations.tempDir.drive === systemDrive && sessionFree >= 0 && sessionFree < 20) {
      advice.push(`测试/自检临时目录也在系统盘（${tempDir}）；量小，但紧张时可把 TMPDIR/TEMP 指到数据盘。`);
    }

    return {
      ok: warnings.length === 0,
      systemDrive,
      drives,
      locations,
      estimate: {
        perAgentMb: Number(perAgentMb.toFixed(2)),
        perNodeJournalKb: Number(perNodeJournalKb.toFixed(1)),
        for1000AgentsGb: Number(for1000Gb.toFixed(2)),
        for10000AgentsGb: Number(for10000Gb.toFixed(2)),
      },
      warnings,
      advice,
    };
  }

  private storageReported = false;

  /** 存储体检只报一次（空间是慢变量，不必每次工具调用都算一遍目录）。 */
  reportStorageOnce(reason: string): void {
    if (this.storageReported) return;
    this.storageReported = true;
    try {
      const health = this.storageHealth();
      this.appendJournal(health.ok === true ? 'storage_ok' : 'storage_tight', { reason, ...health });
    } catch { /* 体检失败不影响工具调用 */ }
  }

  /**
   * **开工前环境体检**（工具 `env_check`）：一次问清「这台机器能不能跑、数据会写到哪、还差什么」。
   *
   * 为什么做成独立工具，而不只是 `graph_status` 里的一个字段：
   *
   *   - `graph_status` 回答的是「图现在什么样」，没人会为了查磁盘去翻它；
   *   - 而「这机器适合跑多少 Agent、数据会不会撑爆系统盘、Team 能力有没有」是**开工前**的问题，
   *     应该在派第一个 Agent 之前就能单独问一次，并且答案要**能直接照做**。
   *
   * 三块合在一起，因为它们共同决定「能跑多大」：
   *   1. 宿主服务（缺 agentTeams → 派出的实例当不了 TeamTask owner）
   *   2. 存储落点与容量（会话默认落系统盘，实测约 1.29 MB/个）
   *   3. 规模建议（按实测速率反推这台机器实际能跑多少）
   */
  /**
   * 邻域摘要（工具 `neighbor_digest`）：**只读**，不写 journal、不读盘、不参与任何判定。
   *
   * 同分区内已完成的节点会成为新节点的参考上下文。只读 `done`（终态）是无环的保证，
   * 也是可复现的保证——同一段历史回放出同一个邻域。
   */
  async neighborhoodDigest(input: { nodeId?: string; direction?: string; maxNeighbors?: number; charsPerNeighbor?: number } = {}): Promise<Record<string, unknown>> {
    if (!input?.nodeId) return { ok: false, error: 'nodeId-required', hint: '需要指定为哪个节点构造邻域' };
    try {
      const result = await this.withCore('neighbor_digest', (core) => {
        const fn = (core as { neighborhoodStatus?: (o: unknown) => unknown }).neighborhoodStatus;
        return typeof fn === 'function'
          ? fn({ nodeId: input.nodeId, direction: input.direction, maxNeighbors: input.maxNeighbors, charsPerNeighbor: input.charsPerNeighbor })
          : { ok: false, error: 'neighborhood-unavailable', hint: 'core 未实现 neighborhoodStatus' };
      });
      return { ...(result as Record<string, unknown>), persistence: await this.persist() };
    } catch (error) {
      return { ok: false, error: String((error as Error)?.message ?? error) };
    }
  }

  /**
   * 协作图（工具 `collaboration_map`）：**只读聚合，不写 journal、不参与任何判定**。
   *
   * 它算「谁读了谁」并把质量分接进来，回答那个关键问题：**有耦合的节点是不是更好**。
   * 样本不足时不下结论——宁可说不知道，也不给一个会被当结论用的数字。
   */
  async collaborationMap(input: { minSample?: number } = {}): Promise<Record<string, unknown>> {
    try {
      const result = await this.withCore('collaboration_map', (core) => {
        const fn = (core as { collaborationStatus?: (o: unknown) => unknown }).collaborationStatus;
        return typeof fn === 'function'
          ? fn({ minSample: input?.minSample })
          : { ok: false, error: 'collab-unavailable', hint: 'core 未实现 collaborationStatus' };
      });
      return { ...(result as Record<string, unknown>), persistence: await this.persist() };
    } catch (error) {
      return { ok: false, error: String((error as Error)?.message ?? error) };
    }
  }

  /**
   * 质量报告（工具 `quality_report`）：**只读聚合，不写 journal、不参与任何判定**。
   *
   * 它回答的是「这批活干得怎么样」——证据来源强度、返工次数、有没有被独立审计过。
   * **不回答**「产出好不好」：那需要审计方显式打分，本版没做。
   *
   * 之所以放在这里包一层而不是直接在工具里调 core：core 的函数需要 AsyncLocalStorage 里的
   * store（`coreStore()`），只有走 `withCore` 才有那个上下文。
   */
  async qualityReport(input: { stage?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
    try {
      const result = await this.withCore('quality_report', (core) => {
        const fn = (core as { qualityStatus?: (o: unknown) => unknown }).qualityStatus;
        return typeof fn === 'function'
          ? fn({ stage: input?.stage ?? null, limit: input?.limit })
          : { ok: false, error: 'quality-unavailable', hint: 'core 未实现 qualityStatus' };
      });
      return { ...(result as Record<string, unknown>), persistence: await this.persist() };
    } catch (error) {
      return { ok: false, error: String((error as Error)?.message ?? error) };
    }
  }

  /**
   * 组织审查（工具 `organization_review`）：**只读**——不派活、不改图、不裁决。
   *
   * 这是协调闭环的第 0 阶段：把已有的 conflict / cluster-state 投影公开成「能发现、
   * 能形成待办、能回放」的报告。同一 journal 重放出同一 `fingerprint`（`generatedAt` 除外）。
   * 想改图必须显式走 `graph_replan`，且要带上当前 `graph_version`。
   */
  async organizationReview(input: { generatedAt?: string } = {}): Promise<Record<string, unknown>> {
    try {
      const result = await this.withCore('organization_review', (core) => {
        const fn = (core as { organizationStatus?: (o: unknown) => unknown }).organizationStatus;
        return typeof fn === 'function'
          ? fn({ generatedAt: input?.generatedAt })
          : { ok: false, error: 'organization-unavailable', hint: 'core 未实现 organizationStatus' };
      });
      return { ...(result as Record<string, unknown>), persistence: await this.persist() };
    } catch (error) {
      return { ok: false, error: String((error as Error)?.message ?? error) };
    }
  }

  /**
   * 重规划（工具 `graph_replan`）：协调闭环里**唯一会改图**的动作。
   *
   * 三条硬约束（都写进参数/返回，不靠调用方自觉）：
   *   1. `expectedGraphVersion` 必填 → 旧组织审查结果不得覆盖新图（`replan_stale_graph`）；
   *   2. 终态保护在 core 里前置拒绝，不提供绕过参数；
   *   3. 每次成功/失败都在服务 journal 留 `actor` —— 记「谁、基于什么版本、改了什么」，
   *      因为 core 的 `graph_replanned` 只记图变更本身，不记执行者。
   */
  async graphReplan(
    input: {
      reason?: string;
      expectedGraphVersion?: number;
      add?: unknown[];
      remove?: string[];
      setDeps?: Record<string, string[]>;
      note?: string | null;
    } = {},
    caller?: any,
  ): Promise<Record<string, unknown>> {
    const actor = this.callerInstance(caller) ?? (caller?.id ? String(caller.id) : null);
    const expected = Number(input?.expectedGraphVersion);
    if (!Number.isFinite(expected)) {
      this.appendJournal('graph_replan_rejected', { actor, reason: input?.reason ?? null, error: 'expected-graph-version-required' });
      return {
        ok: false,
        error: 'expected-graph-version-required',
        hint: '先读 graph_status 的 graph_version，再带同一个值提交；这是防止用过期协调结果覆盖新图的 CAS。',
      };
    }
    try {
      const result = await this.withCore('graph_replan', (core) => {
        const fn = (core as { graphReplan?: (o: unknown) => unknown }).graphReplan;
        return typeof fn === 'function'
          ? fn({
              reason: String(input?.reason ?? 'coordination'),
              expectedGraphVersion: expected,
              add: input?.add ?? [],
              remove: (input?.remove ?? []).map(String),
              setDeps: input?.setDeps ?? {},
              note: input?.note ?? null,
            })
          : { ok: false, error: 'replan-unavailable', hint: 'core 未实现 graphReplan' };
      });
      const row = result as { ok?: boolean; error?: string; graph_version?: number; added?: unknown[]; removed?: unknown[]; rewired?: unknown[] };
      const ok = row?.ok === true;
      this.appendJournal(ok ? 'graph_replanned_by' : 'graph_replan_rejected', {
        actor,
        reason: String(input?.reason ?? 'coordination'),
        expectedGraphVersion: expected,
        graph_version: row?.graph_version ?? null,
        added: Array.isArray(row?.added) ? row.added : [],
        removed: Array.isArray(row?.removed) ? row.removed : [],
        rewired: Array.isArray(row?.rewired) ? row.rewired : [],
        error: ok ? null : (row?.error ?? 'unknown'),
      });
      return { ...(result as Record<string, unknown>), actor, persistence: await this.persist() };
    } catch (error) {
      return { ok: false, error: String((error as Error)?.message ?? error), actor };
    }
  }

  envCheck(): Record<string, unknown> {
    const host = this.hostServicesView();
    const storage = this.storageHealth();
    const estimate = (storage.estimate ?? {}) as Record<string, number>;
    const locations = (storage.locations ?? {}) as Record<string, { drive?: string }>;
    const drives = (storage.drives ?? []) as Array<{ root: string; freeGb: number; totalGb: number }>;
    const warnings = [...(((storage.warnings ?? []) as string[]))];
    const advice = [...(((storage.advice ?? []) as string[]))];

    // 拼成「能不能开跑」的结论，而不是丢一堆字段让人自己判断
    const blockers: string[] = [];
    if (host.missing.includes('agentTeams')) {
      blockers.push('缺 agentTeams：派出的子实例不能当 TeamTask owner（agent_spawn 全退回 activation）');
    }
    if (host.missing.includes('subagents')) {
      blockers.push('缺 subagents：完全派不出子会话，当前环境无法运行本插件');
    }
    const sessionDrive = String(locations.sessionDir?.drive ?? '');
    const sessionFree = drives.find((d) => d.root === sessionDrive)?.freeGb ?? -1;
    const perAgentMb = Number(estimate.perAgentMb ?? 1);
    const for1000 = Number(estimate.for1000AgentsGb ?? 0);
    if (sessionFree >= 0 && for1000 > sessionFree) {
      blockers.push(`会话盘 ${sessionDrive} 可用 ${sessionFree} GB，装不下千级预估 ${for1000} GB`);
    }

    return {
      ok: blockers.length === 0 && warnings.length === 0,
      ready: blockers.length === 0,
      blockers,
      hostServices: host,
      storage,
      scale: {
        perAgentMb: estimate.perAgentMb ?? null,
        perNodeJournalKb: estimate.perNodeJournalKb ?? null,
        for1000AgentsGb: estimate.for1000AgentsGb ?? null,
        for10000AgentsGb: estimate.for10000AgentsGb ?? null,
        // 按会话盘可用空间反推「这台机器实际能跑多少」（保守：只用一半可用）
        suggestedMaxAgents:
          sessionFree > 0
            ? Math.max(0, Math.floor((sessionFree * 1024 * 0.5) / Math.max(0.1, perAgentMb)))
            : null,
      },
      warnings,
      advice,
      note: sessionFree > 0
        ? 'suggestedMaxAgents 按「只用会话盘一半可用空间」保守估，不是硬上限；只算会话数据，不含 journal（journal 跟随工作区）。'
        : `suggestedMaxAgents 无法推算：会话盘可用空间探测不可用（fs.statfsSync 返回 ${sessionFree}）。常见于容器/受限权限/非 Windows 路径。其余体检项仍然有效。`,
    };
  }



  /** `graph_status` 里展示的宿主服务视图：缺什么、怎么降级，一眼看见。 */
  hostServicesView(): { ok: boolean; present: string[]; missing: string[]; degraded: string[] } {
    const host = this.hostServices();
    const present: string[] = [];
    if (host.agentTeams) present.push('agentTeams');
    if (host.subagents) present.push('subagents');
    if (host.sessionController) present.push('sessionController');
    return { ok: host.missing.length === 0, present, missing: host.missing, degraded: host.degraded };
  }

  /** 只报一次：缺服务是稳定的环境事实，不必每次工具调用都写一条。 */
  reportHostServicesOnce(reason: string): void {
    if (this.hostServicesReported) return;
    this.hostServicesReported = true;
    try {
      const host = this.hostServices();
      if (!host.missing.length) {
        this.appendJournal('host_services_ok', { reason, services: ['agentTeams', 'subagents', 'sessionController'] });
        return;
      }
      this.appendJournal('host_service_missing', {
        reason,
        missing: host.missing,
        degraded: host.degraded,
      });
    } catch { /* 自检失败不影响工具调用 */ }
  }

  nativeStatus() {
    return {
      ok: true,
      provider: this.config.nativeProvider,
      maxDepth: this.config.nativeMaxDepth,
      instances: this.native.listInstances(),
      capabilities: {
        spawnAgent: typeof this.native.subagents?.startActivation === 'function',
        sendMessage: typeof this.native.subagents?.sendMessage === 'function',
        agentTeams: Boolean(this.native.agentTeams?.createTask),
      },
    };
  }

  // ── 自述 ──────────────────────────────────────────────────
  describe() {
    return {
      plugin: CAPABILITIES.plugin,
      contractVersion: CAPABILITIES.contractVersion,
      tools: this.toolNames,
      toolCount: this.toolNames.length,
      config: this.config,
      configSpec: Object.fromEntries(Object.entries(CONFIG_SPEC).map(([key, spec]) => [key, spec.default])),
      configSource: this.meta.configSource ?? null,
      configSourceFile: this.meta.configSourceFile ?? null,
      workspaceRoot: this.workspaceRoot,
      stateDir: this.stateDir,
      journal: this.journalSummary(),
      capabilities: CAPABILITIES,
    };
  }
}
