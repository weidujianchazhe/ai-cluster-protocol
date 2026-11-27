/**
 * 原生执行层：把控制面的"派发"接到 DSH 原生通道上。
 *
 * 用到的宿主面（本会话 live 契约）：
 *   - `subagents.startActivation({provider, label, request:{prompt, parent, signal, maxDepth}, signal, delivery})`
 *     —— parent 必须是**活 Agent**（工具入口取 `exec.agent`），maxDepth 防无界递归；
 *   - `subagents.sendMessage(sender, targetId, content, {signal})` —— 只能发给"直接连续子会话"；
 *   - `agentTeams.createTask(caller, {subject, description, blockedBy?, writeScopes?})`
 *     / `agentTeams.updateTask(caller, {taskId, expectedRevision, action, ...})` —— caller 必须是 Team 成员。
 *
 * 边界：TeamTask 只是**投影**（板是给人看的），权威仍在 core 图 + journal；
 *       本模块不写 core、不写 state，只做"派发 + 回执"。
 */

/**
 * Team 路径不可用的原因。
 *   - no-service         宿主没挂 agentTeams
 *   - host-method-removed 宿主契约里已没有 spawnTeammate / membership（nightly 常见）
 *   - not-lead           caller 不是 Lead（子会话不能拉 Team member）
 *   - membership-threw   membership 本身抛错
 */
export type TeamPathBlockReason = 'no-service' | 'host-method-removed' | 'not-lead' | 'membership-threw';

export interface NativeCaller {
  id?: string;
}

export interface WorkerSpawnOptions {
  /** 生成自驱 worker prompt（角色 + 白名单 + 循环契约）。 */
  enabled?: boolean;
  stageHint?: string;
  maxIterations?: number;
  peers?: string[];
  auditPartner?: string;
  /** 能力包（替代固定"角色职责"；写进 worker prompt，role 只是实例身份）。 */
  capability?: string;
  /** 任务上下文清单（每行一条事实/约束，写进 worker prompt）。 */
  contextPack?: string[];
  /** 心跳续期间隔上限（秒；缺省取 prompt 里的默认值）。 */
  heartbeatTtlSec?: number;
}

export interface SpawnAgentInput {
  role: string;
  task: string;
  index?: number;
  label?: string;
  maxDepth?: number;
  agentPreset?: string;
  cwd?: string;
  /** 组装策略：team=A（Team member，prompt 记忆协议）；activation=B（可带 preset）；provider=C（自定义 provider）。 */
  via?: 'auto' | 'team' | 'activation' | 'provider';
  provider?: string;
  /** 自驱模式：prompt 由 `buildWorkerPrompt` 生成（插件不代发/代提交）。 */
  worker?: WorkerSpawnOptions & { taskBrief?: import('./worker.js').WorkerPromptInput['taskBrief'] };
}

export interface SpawnAgentResult {
  ok: boolean;
  error?: string;
  instanceId?: string;
  sessionId?: string;
  messageId?: string;
  role?: string;
  hint?: string;
  via?: 'spawnTeammate' | 'startActivation';
  memberName?: string | null;
  ownerCapable?: boolean;
  /**
   * Team 路径走不了的原因（`null`/缺省 = Team 路径可用或已走通）。
   *
   * 有了它，`ownerCapable:false` 才可解释：
   *   - `host-method-removed` → 宿主 nightly 把 `spawnTeammate` 摘了（契约变更）
   *   - `no-service`          → 没挂 agentTeams
   *   - `not-lead`            → 子会话不能拉 Team member
   *   - `membership-threw`    → 成员身份读取抛错
   */
  teamPathBlocked?: TeamPathBlockReason | null;
  /** 自驱模式下，返回注入的 worker prompt 摘要（便于审计"插件没代发"）。 */
  workerPrompt?: { role: string; instanceId: string; tools: string[]; iterations: number } | null;
  /** 失败时的原始细节（宿主返回体/异常对象），只用于排障，不是契约字段。 */
  detail?: unknown;
  /** team 路径失败后回退 activation 时，带回 team 路径的失败原因。 */
  teammateError?: unknown;
  /**
   * team 路径因**宿主成员上限**（`TEAM_MEMBER_LIMIT`）而回退 activation。
   *
   * 与「真的派不出去」区分开：这是**预期路径**。宿主的 `agentTeams` 服务没有设置
   * 上限的接口（11 个方法全查过），所以插件不试图调大它，而是在撞上后改用 activation —
   * L0 全链（claim/evidence/gate/verify）不经过 Team，功能等价；
   * 唯一损失是这类实例不能当原生 TeamTask 的 owner。
   */
  teamLimitFallback?: boolean;
  /**
   * 重试是否可能成功。**只有** `false` 是确定性的（组装失败：preset 不存在、
   * prompt 超长、role 非法…）；`true` 表示宿主满载或无法归因，下一轮可以再试。
   *
   * 为什么必须区分：一律重试 = 对一个永远失败的节点每轮白烧一次 spawn；
   * 一律不重试 = 宿主短暂满载就把整张图的就绪节点全判死。判据见 `spawn-failure.ts`。
   */
  retryable?: boolean;
  /** 失败性质：`host-capacity` / `assembly-failed` / `spawn-failed`。 */
  failureCode?: 'host-capacity' | 'assembly-failed' | 'spawn-failed';
  /**
   * 宿主**自己说的**退避毫秒数；`null`/缺省 = 宿主没说。
   *
   * 为什么要往上传：`host-capacity` 只说「过一会儿可以」，没说「过一会儿」是
   * 50 ms 还是 30 秒。调度器的 interval 是独立配置（默认 300 秒），与宿主真实
   * 恢复时间无关，于是默认行为是每 tick 硬撞一次。带上这个数，退避才有依据。
   */
  retryAfterMs?: number | null;
}

import { buildWorkerPrompt, profileFor } from './worker.js';
import { classifySpawnFailure } from './spawn-failure.js';

export interface NativeInstanceRecord {
  instanceId: string;
  sessionId: string;
  role: string;
  /** Team member 名（`role-<role>-<nn>`）；仅 spawnTeammate 路径有。 */
  memberName?: string;
  label: string;
  parentSessionId: string | null;
  createdAt: string;
  mode: 'activation' | 'teammate';
  /** Team 路径走不了的原因（见 NativeTeam.teamPathBlocked）。 */
  teamPathBlocked?: TeamPathBlockReason | null;
}

/** 统一身份：`role-<role>-<nn>`；兼容大小写与下划线（旧 `ROLE-AUDIT_CODE-02` 也认）。 */
const INSTANCE_RE = /^role-([a-z][a-z0-9_]*(?:-[a-z0-9_]+)*)-(\d{2,})$/i;

export function roleInstanceId(role: string, index: number): string {
  const slug = String(role || 'code')
    .toLowerCase()
    .replace(/_/g, '-');
  return `role-${slug}-${String(index).padStart(2, '0')}`;
}

export function parseInstanceId(instanceId: string): { role: string; index: number } | null {
  const match = INSTANCE_RE.exec(String(instanceId ?? '').toLowerCase());
  if (!match) return null;
  return { role: match[1].replace(/-/g, '_').toUpperCase(), index: Number(match[2]) };
}

function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

function errorInfo(error: unknown) {
  const err = error as { name?: string; code?: string; message?: string } | undefined;
  return { name: err?.name ?? 'Error', code: err?.code ?? null, message: String(err?.message || error) };
}

/**
 * 宿主 Team 成员上限（`TEAM_MEMBER_LIMIT`）。
 *
 * **这是宿主的约束，不是本插件的**：`agentTeams` 服务的 11 个方法（membership /
 * listMembers / spawnTeammate / sendMessage / createTask / getTask / listTasks /
 * updateTask / waitForChange / interrupt / tryMembership）里**没有任何设置上限的接口**，
 * 实机自省确认。所以「把 16 调大」在宿主侧做不到。
 *
 * 本插件因此把它**降级成一条预期路径**而不是失败：Team 满了就走 activation（B），
 * 并且**不把它当能力缺失**——因为 L0 的任务板（graph）才是权威，Team board 只是投影
 * （`teamTaskRole: 'projection'`），而 activation worker 走的 `task_claim` 完全不经过 Team。
 *
 * 唯一真实损失：activation 实例没有 memberName，因此**不能当原生 TeamTask 的 owner**。
 * 这条写进 README，不藏。
 */
export function isTeamMemberLimit(error: unknown): boolean {
  const info = errorInfo(error);
  return info.code === 'TEAM_MEMBER_LIMIT' || /TEAM_MEMBER_LIMIT|member limit/i.test(info.message);
}

export interface NativeTeamOptions {
  provider?: string;
  maxDepth?: number;
  workspaceRoot?: string;
}

/**
 * P2-11 provider C 诚实化：`via:'provider'` 声明的是"走自定义 provider"，
 * 未注册时静默落到默认 spawn 会让调用方误以为已用自定义 provider 派发。
 * 因此这里 fail-closed：显式报错，并给出等价的 activation 写法或"先注册"的指引。
 */
export const PROVIDER_NOT_REGISTERED = 'provider-not-registered' as const;

/**
 * 实例注册表（instanceId ↔ child sessionId）。
 * 进程内 Map + 可回放：从 journal 的 `agent_spawned` 行重建（重启后 send_message 仍可用）。
 */
export class NativeTeam {
  readonly ctx: any;
  readonly options: Required<Pick<NativeTeamOptions, 'provider' | 'maxDepth'>> & NativeTeamOptions;
  readonly instances = new Map<string, NativeInstanceRecord>();

  constructor(ctx: any, options: NativeTeamOptions = {}) {
    this.ctx = ctx;
    this.options = {
      provider: options.provider ?? 'spawn',
      maxDepth: Number(options.maxDepth ?? 2),
      ...options,
    };
  }

  get subagents(): any {
    return this.ctx.get('subagents');
  }

  get agentTeams(): any {
    return this.ctx.get('agentTeams');
  }

  /** 从 journal 行里恢复实例表（重启后依然能 send_message）。 */
  restoreFromJournal(rows: Array<Record<string, unknown>>): number {
    let restored = 0;
    for (const row of rows) {
      if (row?.kind !== 'agent_spawned') continue;
      const instanceId = String(row.instanceId ?? '');
      const sessionId = String(row.sessionId ?? '');
      if (!instanceId || !sessionId) continue;
      this.instances.set(instanceId, {
        instanceId,
        sessionId,
        role: String(row.role ?? parseInstanceId(instanceId)?.role ?? 'CODE'),
        label: String(row.label ?? instanceId),
        parentSessionId: (row.parentSessionId as string) ?? null,
        createdAt: String(row.at ?? new Date().toISOString()),
        mode: 'activation',
      });
      restored += 1;
    }
    return restored;
  }

  listInstances(): NativeInstanceRecord[] {
    return [...this.instances.values()].sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  }

  /** Team member 名 = 实例 ID（统一身份）：`role-<role>-<nn>`。 */
  static memberName(role: string, index: number): string {
    return roleInstanceId(role, index);
  }

  /**
   * 找一个**宿主 Team 里确实没被占用**的成员名下标。
   *
   * 为什么需要：`nextIndex()` 只看本进程内存在 `this.instances` 里的记录。插件一重载，
   * 那份 map 就空了，index 从 1 重新开始 —— 但宿主的 Team 成员还在，于是
   * `spawnTeammate` 抛 `TEAM_MEMBER_NAME_TAKEN`（本轮真实撞到：`role-code-68` 已被用过）。
   * 后果不是报错就完了：它会静默退回 activation（`ownerCapable:false`），
   * 让审计实例失去 TeamTask owner 能力——一个不报错的能力降级。
   *
   * 所以判据要取**宿主侧的权威名单**（`listMembers`），不是本地 counter。
   * 查不到名单时按原样返回，让宿主自己报错（不假装能避让）。
   */
  private freeMemberIndex(caller: NativeCaller, role: string, start: number): number {
    const teams = this.agentTeams;
    if (!teams || typeof teams.listMembers !== 'function') return start;
    let used: Set<string>;
    try {
      const rows = (teams.listMembers(caller) ?? []) as Array<{ name?: string }>;
      used = new Set(rows.map((row) => String(row?.name ?? '')).filter(Boolean));
    } catch {
      return start; // 拿不到权威名单 → 不猜
    }
    let index = start;
    for (let i = 0; i < 10_000; i += 1) {
      if (!used.has(roleInstanceId(role, index))) return index;
      index += 1;
    }
    return start;
  }

  /**
   * Team 路径为什么走不了；`null` = 能走。
   *
   * **必须给出原因**：`agent_spawn` 静默退回 activation 时，`ownerCapable:false`
   * 看起来像"插件自己选的方案"，实际可能是宿主能力消失。2026-11 的 nightly 把
   * `spawnTeammate` / `membership` 从 `agentTeams` 移除了（只剩
   * `isEnabled`/`setEnabled`/`createTask`/`getTask`/`listTasks`/`updateTask`），
   * 于是这类降级从"偶发"变成"每次"。不写原因，用户只会看到能力莫名消失。
   */
  private teamPathBlocked(caller: NativeCaller | undefined): TeamPathBlockReason | null {
    const teams = this.agentTeams;
    if (!teams) return 'no-service';
    if (typeof teams.spawnTeammate !== 'function') return 'host-method-removed';
    if (typeof teams.membership !== 'function') return 'host-method-removed';
    try {
      const membership = teams.membership(caller);
      return membership?.role === 'lead' ? null : 'not-lead';
    } catch {
      return 'membership-threw';
    }
  }

  /** 尝试走 Team member 路径：caller 必须是 Lead 且 `spawnTeammate` 可用。 */
  private leadCanSpawnTeammate(caller: NativeCaller | undefined): boolean {
    return this.teamPathBlocked(caller) === null;
  }

  /** 已注册 provider 列表（宿主 `subagents.list()`）；注册表不可用时返回 null。 */
  private registeredProviders(): string[] | null {
    const subagents = this.subagents;
    if (!subagents) return null;
    try {
      if (typeof subagents.list === 'function') {
        const names = subagents.list();
        if (Array.isArray(names)) return names.map(String);
      }
    } catch {
      return null;
    }
    return null;
  }

  /** 单个 provider 是否已注册（优先 getProvider，退而用 list() 名单）。 */
  private isProviderRegistered(name: string): boolean | null {
    const subagents = this.subagents;
    if (!subagents) return null;
    try {
      if (typeof subagents.getProvider === 'function') return Boolean(subagents.getProvider(name));
    } catch {
      return null;
    }
    const names = this.registeredProviders();
    return names ? names.includes(name) : null;
  }

  /**
   * P2-11：校验 via:'provider' 的自定义 provider 已注册。
   * 返回 null 表示可用；返回错误结果表示 fail-closed（绝不静默走默认 spawn）。
   */
  private providerGate(input: SpawnAgentInput): SpawnAgentResult | null {
    const providerName = String(input.provider ?? '').trim();
    if (!providerName) {
      return {
        ok: false,
        error: PROVIDER_NOT_REGISTERED,
        role: String(input.role ?? '').toUpperCase(),
        hint: 'via=provider 需显式传自定义 provider 名；或改用 via=activation（等价默认 spawn 路径）',
      };
    }
    if (providerName === 'spawn') {
      return {
        ok: false,
        error: PROVIDER_NOT_REGISTERED,
        role: String(input.role ?? '').toUpperCase(),
        hint: 'provider="spawn" 是默认内置路径，不是自定义 provider；等价写法为 via=activation，或先注册自定义 provider 再用 via=provider',
      };
    }
    const registered = this.isProviderRegistered(providerName);
    if (registered !== true) {
      const known = this.registeredProviders();
      return {
        ok: false,
        error: PROVIDER_NOT_REGISTERED,
        role: String(input.role ?? '').toUpperCase(),
        hint: `自定义 provider "${providerName}" 未注册${known ? `（已注册：${known.join(', ') || '无'}）` : '（注册表不可用）'}；请先注册该 provider，或改用 via=activation（等价默认 spawn）`,
      };
    }
    return null;
  }

  /** `spawn_agent`：Lead → `agentTeams.spawnTeammate`；否则回退 `subagents.startActivation`。 */
  async spawnAgent(input: SpawnAgentInput, caller: NativeCaller | undefined): Promise<SpawnAgentResult> {
    if (!caller?.id) {
      return { ok: false, error: 'caller-required', hint: 'spawn 需要活 Agent 作 caller（工具入口用 exec.agent）' };
    }
    const role = String(input?.role ?? '').toUpperCase();
    if (!role || !(input?.task && String(input.task).trim())) {
      return { ok: false, error: 'role-and-task-required' };
    }
    // P1-7：未知职务 fail-closed（profileFor 抛错 → 转成显式错误结果，不静默回落 CODE）
    try {
      profileFor(role);
    } catch (error) {
      return { ok: false, error: 'unknown-role', role, hint: String((error as Error)?.message ?? error) };
    }
    let index = Number(input.index ?? this.nextIndex(role));
    const via = input.via ?? 'auto';
    // 走 Team 路径前先把下标挪到「宿主名单里没被占用」的位置。
    // 重载后本地 instances 为空、而宿主成员还在，直接用 nextIndex 会撞
    // `TEAM_MEMBER_NAME_TAKEN` 并静默退回 activation（丢掉 ownerCapable）。
    // 显式传 `index` 时也检查——那是「我要这个特定下标」的意图，撞了就如实报错更好，
    // 所以只有非显式时才避让。
    if (input.index === undefined && (via === 'auto' || via === 'team') && this.leadCanSpawnTeammate(caller)) {
      index = this.freeMemberIndex(caller, role, index);
    }
    const instanceId = roleInstanceId(role, index);
    if (this.instances.has(instanceId)) {
      return { ok: false, error: 'instance-exists', instanceId, hint: '同职务换 index，或先 send_message 续跑' };
    }

    // 路径 1：Team member（A；只有 Lead 能 spawnTeammate；via=activation/provider 时跳过）
    // `via` 已在上方解析（避让逻辑要用它），这里不再重复声明。
    // P2-11：provider C 未注册自定义 provider 时显式报错，禁止静默走默认 spawn
    if (via === 'provider') {
      const gate = this.providerGate(input);
      if (gate) return gate;
    }
    if ((via === 'auto' || via === 'team') && this.leadCanSpawnTeammate(caller)) {
      try {
        const teams = this.agentTeams;
        const memberName = NativeTeam.memberName(role, index);
        const spawned = await teams.spawnTeammate(caller, {
          name: memberName,
          description: input.label ?? `${role} · ${instanceId}`,
          prompt: [{ type: 'text', text: this.promptText(input, role, instanceId) }],
          context: 'fresh',
          provider: input.provider ?? this.options.provider,
          signal: liveSignal(),
        });
        const member = spawned?.member ?? null;
        const record: NativeInstanceRecord = {
          instanceId,
          memberName: String(member?.name ?? memberName),
          sessionId: String(member?.id ?? ''),
          role,
          label: input.label ?? instanceId,
          parentSessionId: caller.id ?? null,
          createdAt: new Date().toISOString(),
          mode: 'teammate',
        };
        if (!record.sessionId) {
          return { ok: false, error: 'teammate-without-session', role, detail: spawned ?? null };
        }
        this.instances.set(instanceId, record);
        return {
          ok: true,
          via: 'spawnTeammate',
          instanceId,
          sessionId: record.sessionId,
          memberName: record.memberName ?? null,
          ownerCapable: true,
          role,
          workerPrompt: this.workerSummary(input, role, instanceId),
        };
      } catch (error) {
        // 失败不硬失败：落到 startActivation 再试一次，并把原因带回。
        //
        // 其中 `TEAM_MEMBER_LIMIT`（宿主 Team 成员上限，实测 16）是**预期路径**而不是
        // 能力缺失：宿主 `agentTeams` 没有设置上限的接口（11 个方法全查过），所以「调大」
        // 在宿主侧做不到；能做的是**不依赖它**——activation 实例走的 `task_claim`
        // 完全不经过 Team，L0 全链可用。唯一真实损失是它不能当原生 TeamTask owner
        // （Team board 只是 L0 的投影，权威在 graph）。
        //
        // 因此这里把「是不是撞上限」显式标出来，让观测面能区分
        // 「宿主满了正常降级」与「真的派不出去」——两者混在一起会让人去调错的参数。
        const fallback = await this.spawnViaActivation(input, caller, role, index, instanceId);
        const limited = isTeamMemberLimit(error);
        return {
          ...fallback,
          teammateError: errorInfo(error) as never,
          ...(limited ? { teamLimitFallback: true as const } : {}),
        };
      }
    }

    // 路径 2：subagents.startActivation（parent = caller）
    return this.spawnViaActivation(input, caller, role, index, instanceId);
  }

  private async spawnViaActivation(
    input: SpawnAgentInput,
    caller: NativeCaller,
    role: string,
    index: number,
    instanceId: string,
  ): Promise<SpawnAgentResult> {
    const subagents = this.subagents;
    if (!subagents || typeof subagents.startActivation !== 'function') {
      return { ok: false, error: 'subagents-unavailable' };
    }
    try {
      const activation = await subagents.startActivation({
        provider: input.provider ?? this.options.provider,
        label: input.label ?? instanceId,
        request: {
          prompt: [{ type: 'text', text: this.promptText(input, role, instanceId) }],
          parent: caller,
          signal: liveSignal(),
          maxDepth: Number(input.maxDepth ?? this.options.maxDepth),
          ...(input.agentPreset ? { agentPreset: input.agentPreset } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
        },
        signal: liveSignal(),
        delivery: 'caller',
      });
      const record: NativeInstanceRecord = {
        instanceId,
        sessionId: String(activation?.childId ?? ''),
        role,
        label: input.label ?? instanceId,
        parentSessionId: caller.id ?? null,
        createdAt: new Date().toISOString(),
        mode: 'activation',
      };
      if (!record.sessionId) {
        return { ok: false, error: 'activation-without-child', role, detail: activation ?? null };
      }
      this.instances.set(instanceId, record);
      const blocked = this.teamPathBlocked(caller);
      return {
        ok: true,
        via: 'startActivation',
        instanceId,
        sessionId: record.sessionId,
        messageId: activation?.messageId ?? undefined,
        ownerCapable: false,
        /**
         * 降级原因必须跟着结果一起走：`ownerCapable:false` 本身不解释自己。
         * `host-method-removed` = 宿主 nightly 已经把 spawnTeammate 摘掉了，
         * 这种降级跟"Team 满了"完全不是一回事，排障方向也不同。
         */
        teamPathBlocked: blocked,
        hint:
          blocked === 'host-method-removed'
            ? '宿主 agentTeams 已没有 spawnTeammate（nightly 契约变更）：本次只能走 activation，实例不能作 TeamTask owner。要用团队板请改用 board_task_* 的投影口径或等宿主补回该方法'
            : blocked === 'no-service'
              ? '宿主未挂 agentTeams：本次走 activation，实例不能作 TeamTask owner'
              : blocked === 'not-lead'
                ? 'caller 不是 Lead：子会话不能拉 Team member，只能走 activation'
                : 'activation 实例不是 Team member，不能作 TeamTask owner；board owner 需用 Lead spawn 的 memberName',
        role,
        workerPrompt: this.workerSummary(input, role, instanceId),
      };
    } catch (error) {
      const failure = classifySpawnFailure(error);
      return {
        ok: false,
        error: 'spawn-failed',
        detail: errorInfo(error) as never,
        role,
        retryable: failure.retryable,
        failureCode: failure.code,
        retryAfterMs: failure.retryAfterMs,
        hint: failure.message,
      };
    }
  }

  /** worker 模式下拼 prompt（能力包 + 白名单 + 循环契约 + 协调者上下文）；否则原样。 */
  private promptText(input: SpawnAgentInput, role: string, instanceId: string): string {
    const worker = input?.worker;
    if (!worker || worker.enabled === false) return String(input.task);
    const base = buildWorkerPrompt({
      role,
      instanceId,
      stageHint: worker.stageHint,
      maxIterations: worker.maxIterations,
      peers: worker.peers,
      auditPartner: worker.auditPartner,
      capability: worker.capability,
      contextPack: worker.contextPack,
      taskBrief: worker.taskBrief,
      // 心跳 TTL 必须真传到 prompt：漏传会让派发方的 ttlSec 静默失效，worker 永远按默认值续租。
      heartbeatTtlSec: worker.heartbeatTtlSec,
    });
    return `${base}\n\n## 协调者给的本轮上下文\n${String(input.task)}`;
  }

  private workerSummary(input: SpawnAgentInput, role: string, instanceId: string) {
    const worker = input?.worker;
    if (!worker || worker.enabled === false) return null;
    return {
      role,
      instanceId,
      capability: String(worker.capability ?? '').trim() || null,
      contextPackSize: (worker.contextPack ?? []).length,
      tools: profileFor(role).tools,
      iterations: Number(worker.maxIterations ?? 8),
    };
  }

  private nextIndex(role: string): number {    let max = 0;
    for (const instance of this.instances.values()) {
      if (instance.role !== role) continue;
      const parsed = parseInstanceId(instance.instanceId);
      if (parsed) max = Math.max(max, parsed.index);
    }
    return max + 1;
  }

  /** 目标是否是当前 Team 成员名（`role-xxx-nn`）。 */
  private teamMemberName(caller: NativeCaller | undefined, target: string): string | null {
    const teams = this.agentTeams;
    if (!teams?.listMembers || !target) return null;
    try {
      const members = teams.listMembers(caller) ?? [];
      const hit = members.find((member: any) => member?.name === target);
      return hit ? String(hit.name) : null;
    } catch {
      return null;
    }
  }

  /**
   * `send_message`：
   *   - 目标是 Team member（`role-xxx-nn`）→ `agentTeams.sendMessage`（原生团队通信）；
   *   - 否则按实例登记表走 `subagents.sendMessage`（直接连续子会话）。
   */
  async sendMessage(
    input: { instanceId: string; text: string; awaitOutput?: boolean; timeoutMs?: number },
    caller: NativeCaller | undefined,
  ) {
    if (!caller?.id) return { ok: false, error: 'caller-required' };
    if (!input?.text || !String(input.text).trim()) return { ok: false, error: 'text-required' };
    const target = String(input?.instanceId ?? '');
    const instance = this.instances.get(target);
    const sessionController = this.ctx.get('sessionController');

    // 路径 1：Team member（名字优先：可能是 Lead 侧 spawn 出来的 role-code-01）
    const memberName = this.teamMemberName(caller, target) ?? instance?.memberName ?? null;
    if (memberName) {
      const teams = this.agentTeams;
      if (teams && typeof teams.sendMessage === 'function') {
        const baselineSeq = input.awaitOutput && instance?.sessionId
          ? await this.lastSeqOf(sessionController, instance.sessionId)
          : null;
        try {
          const receipt = await teams.sendMessage(caller, {
            target: memberName,
            content: [{ type: 'text', text: String(input.text) }],
            signal: liveSignal(),
          });
          const output = input.awaitOutput && instance?.sessionId
            ? await this.awaitOutput(sessionController, instance.sessionId, baselineSeq, input.timeoutMs)
            : null;
          return {
            ok: true,
            via: 'agentTeams.sendMessage',
            instanceId: instance?.instanceId ?? target,
            memberName,
            sessionId: instance?.sessionId ?? null,
            messageId: String(receipt?.messageId ?? ''),
            baselineSeq,
            output,
            usage: instance ? this.instanceUsage(instance.instanceId) : null,
          };
        } catch (error) {
          return { ok: false, error: 'team-send-failed', detail: errorInfo(error) as never, memberName };
        }
      }
    }

    if (!instance) return { ok: false, error: 'instance-unknown', instanceId: target || null };
    const subagents = this.subagents;
    if (!subagents || typeof subagents.sendMessage !== 'function') return { ok: false, error: 'subagents-unavailable' };
    const baselineSeq = input.awaitOutput ? await this.lastSeqOf(sessionController, instance.sessionId) : null;
    try {
      const messageId = await subagents.sendMessage(
        caller,
        instance.sessionId,
        [{ type: 'text', text: String(input.text) }],
        { signal: liveSignal() },
      );
      const output = input.awaitOutput
        ? await this.awaitOutput(sessionController, instance.sessionId, baselineSeq, input.timeoutMs)
        : null;
      return {
        ok: true,
        via: 'subagents.sendMessage',
        instanceId: instance.instanceId,
        sessionId: instance.sessionId,
        messageId: String(messageId),
        baselineSeq,
        output,
        usage: this.instanceUsage(instance.instanceId),
      };
    } catch (error) {
      return { ok: false, error: 'send-failed', detail: errorInfo(error) as never, instanceId: instance.instanceId };
    }
  }

  /** 冷读会话末 seq（durable，不激活 Agent）。 */
  private async lastSeqOf(sessionController: any, sessionId: string): Promise<number> {
    if (!sessionController?.inspect) return 0;
    try {
      const inspection = await sessionController.inspect(sessionId, liveSignal());
      const events = inspection?.events ?? [];
      return events.length ? Math.max(...events.map((event: any) => Number(event.seq) || 0)) : 0;
    } catch {
      return 0;
    }
  }

  /**
   * 等回执：轮询 `sessionController.inspect` 到 `turn/end`，汇总 baseline 之后的 assistant 文本。
   * 与 adapter 的 `awaitOutput` 同口径（subagent 会话看不见 `waitForChange`，只能 inspect）。
   */
  async awaitOutput(
    sessionController: any,
    sessionId: string,
    baselineSeq: number | null,
    timeoutMs = 120000,
  ) {
    if (!sessionController?.inspect) {
      return { sessionId, settled: false, turnEnd: null, text: '', lastSeq: baselineSeq ?? 0, timedOut: true, error: 'sessionController-unavailable' };
    }
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs));
    let lastSeq = baselineSeq ?? 0;
    const texts: string[] = [];
    let turnEnd: { seq: number; reason: string | null } | null = null;
    while (Date.now() < deadline) {
      let events: any[] = [];
      try {
        const inspection = await sessionController.inspect(sessionId, liveSignal());
        events = inspection?.events ?? [];
      } catch {
        events = [];
      }
      for (const event of events) {
        const seq = Number(event?.seq) || 0;
        if (seq <= (baselineSeq ?? 0)) continue;
        if (event?.type === 'assistant/message') {
          for (const block of event?.data?.message?.content ?? []) {
            if (block?.type === 'text') texts.push(String(block.text ?? ''));
          }
          lastSeq = Math.max(lastSeq, seq);
        } else if (event?.type === 'turn/end') {
          turnEnd = { seq, reason: event?.data?.reason?.kind ?? null };
          lastSeq = Math.max(lastSeq, seq);
        }
      }
      if (turnEnd) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return {
      sessionId,
      settled: Boolean(turnEnd),
      turnEnd,
      lastSeq,
      text: texts.join(''),
      timedOut: !turnEnd,
    };
  }

  /** 实例累计 usage：优先问 adapter（同宿主进程内按 sessionId 归集）。 */
  instanceUsage(instanceId: string) {
    const adapter = this.ctx.get('l0adapter');
    if (!adapter?.report) return null;
    try {
      const report = adapter.report();
      const row = (report?.instances ?? []).find((instance: any) => instance.instanceId === instanceId);
      return row?.usage ?? null;
    } catch {
      return null;
    }
  }

  /** `team_task_create`：在原生团队板上建一条任务（投影；caller 必须是 Team 成员）。 */
  async createTeamTask(
    input: {
      subject: string;
      description: string;
      blockedBy?: string[];
      writeScopes?: string[];
      nodeId?: string;
      ownerInstance?: string;
    },
    caller: NativeCaller | undefined,
  ) {
    if (!caller?.id) return { ok: false, error: 'caller-required' };
    if (!input?.subject) return { ok: false, error: 'subject-required' };
    const teams = this.agentTeams;
    if (!teams?.createTask) return { ok: false, error: 'agentTeams-unavailable' };
    try {
      const task = await teams.createTask(caller, {
        subject: String(input.subject),
        description: String(input.description ?? ''),
        ...(Array.isArray(input.blockedBy) ? { blockedBy: input.blockedBy } : {}),
        ...(Array.isArray(input.writeScopes) ? { writeScopes: input.writeScopes } : {}),
      });
      let projected = task;
      let reassigned: { ok: boolean; error?: string } | null = null;
      // 投影 owner 与图 assignee 同源：建完立刻 reassign 给真实实例（CAS 用创建时 revision）
      if (input.ownerInstance && teams.updateTask && task?.id) {
        try {
          projected = await teams.updateTask(caller, {
            taskId: task.id,
            expectedRevision: task.revision ?? 1,
            action: 'reassign',
            owner: String(input.ownerInstance),
          });
          reassigned = { ok: true };
        } catch (error) {
          reassigned = { ok: false, error: String((error as { message?: string })?.message || error) };
        }
      }
      return {
        ok: true,
        projection: true,
        reassigned,
        task: {
          id: projected?.id ?? null,
          revision: projected?.revision ?? null,
          subject: projected?.subject ?? null,
          status: projected?.status ?? null,
          ownerName: projected?.ownerName ?? null,
          ready: projected?.ready ?? null,
          nodeId: input.nodeId ?? null,
        },
      };
    } catch (error) {
      return { ok: false, error: 'create-task-failed', detail: errorInfo(error) as never };
    }
  }

  /** `team_task_update`：CAS 更新任务（expectedRevision 必填，宿主会拒过期写）。 */
  async updateTeamTask(
    input: { taskId: string; expectedRevision: number; action: string; owner?: string },
    caller: NativeCaller | undefined,
  ) {
    if (!caller?.id) return { ok: false, error: 'caller-required' };
    if (!input?.taskId || input.expectedRevision === undefined || !input?.action) {
      return { ok: false, error: 'task-id-revision-action-required' };
    }
    const teams = this.agentTeams;
    if (!teams?.updateTask) return { ok: false, error: 'agentTeams-unavailable' };
    try {
      const task = await teams.updateTask(caller, {
        taskId: input.taskId,
        expectedRevision: Number(input.expectedRevision),
        action: input.action,
        ...(input.owner ? { owner: input.owner } : {}),
      });
      return {
        ok: true,
        projection: true,
        task: {
          id: task?.id ?? null,
          revision: task?.revision ?? null,
          status: task?.status ?? null,
          ownerName: task?.ownerName ?? null,
          ready: task?.ready ?? null,
        },
      };
    } catch (error) {
      return { ok: false, error: 'update-task-failed', detail: errorInfo(error) as never };
    }
  }
}
