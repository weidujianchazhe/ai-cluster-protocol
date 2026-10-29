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
}

export interface SpawnAgentInput {
  role: string;
  task: string;
  index?: number;
  label?: string;
  maxDepth?: number;
  agentPreset?: string;
  cwd?: string;
  /** 自驱模式：prompt 由 `buildWorkerPrompt` 生成（插件不代发/代提交）。 */
  worker?: WorkerSpawnOptions;
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
  /** 自驱模式下，返回注入的 worker prompt 摘要（便于审计"插件没代发"）。 */
  workerPrompt?: { role: string; instanceId: string; tools: string[]; iterations: number } | null;
}

import { buildWorkerPrompt, profileFor } from './worker.js';

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

export interface NativeTeamOptions {
  provider?: string;
  maxDepth?: number;
  workspaceRoot?: string;
}

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

  /** 尝试走 Team member 路径：caller 必须是 Lead 且 `spawnTeammate` 可用。 */
  private leadCanSpawnTeammate(caller: NativeCaller | undefined): boolean {
    const teams = this.agentTeams;
    if (!teams || typeof teams.spawnTeammate !== 'function') return false;
    try {
      const membership = teams.membership(caller);
      return membership?.role === 'lead';
    } catch {
      return false;
    }
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
    const index = Number(input.index ?? this.nextIndex(role));
    const instanceId = roleInstanceId(role, index);
    if (this.instances.has(instanceId)) {
      return { ok: false, error: 'instance-exists', instanceId, hint: '同职务换 index，或先 send_message 续跑' };
    }

    // 路径 1：Team member（只有 Lead 能 spawnTeammate）
    if (this.leadCanSpawnTeammate(caller)) {
      try {
        const teams = this.agentTeams;
        const memberName = NativeTeam.memberName(role, index);
        const spawned = await teams.spawnTeammate(caller, {
          name: memberName,
          description: input.label ?? `${role} · ${instanceId}`,
          prompt: [{ type: 'text', text: this.promptText(input, role, instanceId) }],
          context: 'fresh',
          provider: this.options.provider,
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
        // 失败不硬失败：落到 startActivation 再试一次，并把原因带回
        const fallback = await this.spawnViaActivation(input, caller, role, index, instanceId);
        return { ...fallback, teammateError: errorInfo(error) as never };
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
        provider: this.options.provider,
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
      return {
        ok: true,
        via: 'startActivation',
        instanceId,
        sessionId: record.sessionId,
        messageId: activation?.messageId ?? undefined,
        ownerCapable: false,
        hint: 'activation 实例不是 Team member，不能作 TeamTask owner；board owner 需用 Lead spawn 的 memberName',
        role,
        workerPrompt: this.workerSummary(input, role, instanceId),
      };
    } catch (error) {
      return { ok: false, error: 'spawn-failed', detail: errorInfo(error) as never, role };
    }
  }

  /** worker 模式下拼 prompt（角色 + 白名单 + 循环契约 + 协调者上下文）；否则原样。 */
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
    });
    return `${base}\n\n## 协调者给的本轮上下文\n${String(input.task)}`;
  }

  private workerSummary(input: SpawnAgentInput, role: string, instanceId: string) {
    const worker = input?.worker;
    if (!worker || worker.enabled === false) return null;
    return {
      role,
      instanceId,
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
