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

                               
              
 

                                     
                                             
                    
                     
                         
                   
                        
 

                                  
               
               
                 
                 
                    
                       
               
                                                         
                              
 

                                   
              
                 
                      
                     
                     
                
                
                                            
                             
                         
                                                   
                                                                                                  
 

import { buildWorkerPrompt, profileFor } from './worker.js';

                                       
                     
                    
               
                                                               
                      
                
                                 
                    
                                  
 

/** 统一身份：`role-<role>-<nn>`；兼容大小写与下划线（旧 `ROLE-AUDIT_CODE-02` 也认）。 */
const INSTANCE_RE = /^role-([a-z][a-z0-9_]*(?:-[a-z0-9_]+)*)-(\d{2,})$/i;

export function roleInstanceId(role        , index        )         {
  const slug = String(role || 'code')
    .toLowerCase()
    .replace(/_/g, '-');
  return `role-${slug}-${String(index).padStart(2, '0')}`;
}

export function parseInstanceId(instanceId        )                                         {
  const match = INSTANCE_RE.exec(String(instanceId ?? '').toLowerCase());
  if (!match) return null;
  return { role: match[1].replace(/-/g, '_').toUpperCase(), index: Number(match[2]) };
}

function liveSignal()              {
  return new AbortController().signal;
}

function errorInfo(error         ) {
  const err = error                                                                  ;
  return { name: err?.name ?? 'Error', code: err?.code ?? null, message: String(err?.message || error) };
}

                                    
                    
                    
                         
 

/**
 * 实例注册表（instanceId ↔ child sessionId）。
 * 进程内 Map + 可回放：从 journal 的 `agent_spawned` 行重建（重启后 send_message 仍可用）。
 */
export class NativeTeam {
           ctx     ;
           options                                                                                ;
           instances = new Map                              ();

  constructor(ctx     , options                    = {}) {
    this.ctx = ctx;
    this.options = {
      provider: options.provider ?? 'spawn',
      maxDepth: Number(options.maxDepth ?? 2),
      ...options,
    };
  }

  get subagents()      {
    return this.ctx.get('subagents');
  }

  get agentTeams()      {
    return this.ctx.get('agentTeams');
  }

  /** 从 journal 行里恢复实例表（重启后依然能 send_message）。 */
  restoreFromJournal(rows                                )         {
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
        parentSessionId: (row.parentSessionId          ) ?? null,
        createdAt: String(row.at ?? new Date().toISOString()),
        mode: 'activation',
      });
      restored += 1;
    }
    return restored;
  }

  listInstances()                         {
    return [...this.instances.values()].sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  }

  /** Team member 名 = 实例 ID（统一身份）：`role-<role>-<nn>`。 */
  static memberName(role        , index        )         {
    return roleInstanceId(role, index);
  }

  /** 尝试走 Team member 路径：caller 必须是 Lead 且 `spawnTeammate` 可用。 */
          leadCanSpawnTeammate(caller                          )          {
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
  async spawnAgent(input                 , caller                          )                            {
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
        const record                       = {
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
        return { ...fallback, teammateError: errorInfo(error)          };
      }
    }

    // 路径 2：subagents.startActivation（parent = caller）
    return this.spawnViaActivation(input, caller, role, index, instanceId);
  }

          async spawnViaActivation(
    input                 ,
    caller              ,
    role        ,
    index        ,
    instanceId        ,
  )                            {
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
      const record                       = {
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
      return { ok: false, error: 'spawn-failed', detail: errorInfo(error)         , role };
    }
  }

  /** worker 模式下拼 prompt（能力包 + 白名单 + 循环契约 + 协调者上下文）；否则原样。 */
          promptText(input                 , role        , instanceId        )         {
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
    });
    return `${base}\n\n## 协调者给的本轮上下文\n${String(input.task)}`;
  }

          workerSummary(input                 , role        , instanceId        ) {
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

          nextIndex(role        )         {    let max = 0;
    for (const instance of this.instances.values()) {
      if (instance.role !== role) continue;
      const parsed = parseInstanceId(instance.instanceId);
      if (parsed) max = Math.max(max, parsed.index);
    }
    return max + 1;
  }

  /** 目标是否是当前 Team 成员名（`role-xxx-nn`）。 */
          teamMemberName(caller                          , target        )                {
    const teams = this.agentTeams;
    if (!teams?.listMembers || !target) return null;
    try {
      const members = teams.listMembers(caller) ?? [];
      const hit = members.find((member     ) => member?.name === target);
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
    input                                                                                 ,
    caller                          ,
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
          return { ok: false, error: 'team-send-failed', detail: errorInfo(error)         , memberName };
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
      return { ok: false, error: 'send-failed', detail: errorInfo(error)         , instanceId: instance.instanceId };
    }
  }

  /** 冷读会话末 seq（durable，不激活 Agent）。 */
          async lastSeqOf(sessionController     , sessionId        )                  {
    if (!sessionController?.inspect) return 0;
    try {
      const inspection = await sessionController.inspect(sessionId, liveSignal());
      const events = inspection?.events ?? [];
      return events.length ? Math.max(...events.map((event     ) => Number(event.seq) || 0)) : 0;
    } catch {
      return 0;
    }
  }

  /**
   * 等回执：轮询 `sessionController.inspect` 到 `turn/end`，汇总 baseline 之后的 assistant 文本。
   * 与 adapter 的 `awaitOutput` 同口径（subagent 会话看不见 `waitForChange`，只能 inspect）。
   */
  async awaitOutput(
    sessionController     ,
    sessionId        ,
    baselineSeq               ,
    timeoutMs = 120000,
  ) {
    if (!sessionController?.inspect) {
      return { sessionId, settled: false, turnEnd: null, text: '', lastSeq: baselineSeq ?? 0, timedOut: true, error: 'sessionController-unavailable' };
    }
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs));
    let lastSeq = baselineSeq ?? 0;
    const texts           = [];
    let turnEnd                                                = null;
    while (Date.now() < deadline) {
      let events        = [];
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
  instanceUsage(instanceId        ) {
    const adapter = this.ctx.get('l0adapter');
    if (!adapter?.report) return null;
    try {
      const report = adapter.report();
      const row = (report?.instances ?? []).find((instance     ) => instance.instanceId === instanceId);
      return row?.usage ?? null;
    } catch {
      return null;
    }
  }

  /** `team_task_create`：在原生团队板上建一条任务（投影；caller 必须是 Team 成员）。 */
  async createTeamTask(
    input   
                      
                          
                           
                             
                      
                             
     ,
    caller                          ,
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
      let reassigned                                         = null;
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
          reassigned = { ok: false, error: String((error                        )?.message || error) };
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
      return { ok: false, error: 'create-task-failed', detail: errorInfo(error)          };
    }
  }

  /** `team_task_update`：CAS 更新任务（expectedRevision 必填，宿主会拒过期写）。 */
  async updateTeamTask(
    input                                                                              ,
    caller                          ,
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
      return { ok: false, error: 'update-task-failed', detail: errorInfo(error)          };
    }
  }
}


//# sourceURL=native\team.js