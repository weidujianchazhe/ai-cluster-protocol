/**
 * 能力声明（N2 验收要求）：
 *   - 每个工具面动作给出 **native 分级**（这个动作是走 DSH 原生服务、还是插件自建、还是投影）；
 *   - `supports_whitebox=false`（L1 白盒不在宿主插件可达范围内，与 DSH 实测清单一致）；
 *   - 声明 caller 约束：`agentTeams` / `subagents` 的方法都要**活 Agent** 作 caller。
 */

                                                                      

                               
               
                               
               
 

/** 9 个工具 → 底层依赖与分级。 */
export const TOOL_SURFACE                               = {
  wish_submit: { grade: 'self-built', nativeService: null, note: '愿望 → 图（N3 core 决策；插件只做入口与参数校验）' },
  graph_status: { grade: 'self-built', nativeService: null, note: '读 journal/快照投影 + 组成因子巡检，不触碰宿主会话' },
  dispatch: { grade: 'self-built', nativeService: null, note: '派活循环控制：off/interval/resident；默认 off + dryRun，不自动 claim' },
  memory_load: { grade: 'self-built', nativeService: null, note: '按需读取管理区任务卡/STATE/报告，紧凑文本 + 引用，不自动注入' },
  memory_writeback: { grade: 'self-built', nativeService: null, note: '写回本轮结论/下一步/证据到报告，任务卡追加指针；不复制全文' },
  task_next: { grade: 'self-built', nativeService: null, note: 'ready 门控由 N3 core 计算' },
  task_claim: { grade: 'self-built', nativeService: null, note: '租约/claim 由 core 执行；实例可绑 subagents 会话' },
  task_heartbeat: {
    grade: 'self-built',
    nativeService: null,
    note: 'fencingToken 能力凭证续租；不绑智能体身份（集群身份脱离），owner 取自当前租约',
  },
  evidence_submit: {
    grade: 'self-built',
    nativeService: null,
    note: 'artifact sha256 + append-only 证据；必须带 producer_instance（缺省取 caller 绑定实例，否则 producer-unknown）',
  },
  verify_done: {
    grade: 'self-built',
    nativeService: null,
    note: 'done 事务：必须带 auditor_instance，且 producer≠auditor、verifier 属审计职务；unknown 不得 done',
  },
  decision_record: { grade: 'self-built', nativeService: null, note: 'L0–L2 决策账本；L3 不走这里（工具名避开宿主 decide）' },
  pass_gate: {
    grade: 'self-built',
    nativeService: null,
    note: '阶段闸门：5 段枚举 → core.passGate（记录 passed + evidence_refs）；不改节点状态',
  },
  team_status: { grade: 'native', nativeService: 'agentTeams', note: 'listMembers/listTasks 直接读原生团队板（caller=exec.agent）' },
  agent_spawn: {
    grade: 'native',
    nativeService: 'subagents.startActivation',
    note: '真实子 Agent：parent=exec.agent，带 maxDepth；实例表落 journal（可回放）；名避开宿主 spawn_agent',
  },
  agent_message: {
    grade: 'native',
    nativeService: 'subagents.sendMessage',
    note: '只发给直接连续子会话；缺 caller / 未知实例 → fail-closed；名避开宿主 send_message',
  },
  agent_reap: {
    grade: 'native',
    nativeService: 'subagents + workspaceRegistry',
    note: 'dry-run 候选；apply 释放执行句柄并归档 session，不硬删 journal/证据',
  },
  board_task_create: {
    grade: 'projection',
    nativeService: 'agentTeams.createTask',
    note: '原生团队板建任务（投影，不是权威）；caller 必须是 Team 成员；名避开宿主 team_task_*',
  },
  board_task_update: {
    grade: 'projection',
    nativeService: 'agentTeams.updateTask',
    note: 'CAS 更新（expectedRevision 必填）；过期写由宿主拒绝；名避开宿主 team_task_*',
  },
  graph_export: { grade: 'projection', nativeService: 'fs', note: '人读投影导出（STATE/INDEX/capabilities）；权威仍在 journal；名避开宿主 export' },
  project_init: { grade: 'self-built', nativeService: 'fs+git', note: 'bootstrap：dry-run 默认、marker 幂等、只 git init 不 commit/push、git 缺失 fail-soft' },
  graph_plan: { grade: 'self-built', nativeService: 'core/graphspec', note: '工作图组成因子预览：校验 + errors/warnings/ready，零写入（不套固定模板）' },
  graph_commit: { grade: 'self-built', nativeService: 'core/graphspec', note: '校验通过后落图；同一份图重复提交幂等；校验失败零写入' },
};

/**
 * 审计职务清单。
 *
 * **单一事实源在 `security/roles.ts`**（那里同时用它做 `verify_done` 白名单一致性自检），
 * 这里只做 re-export，避免两份各写一遍、还不相交。
 * Python 侧的 早期原型实现的同级能力表 是行为 oracle，改动两侧要同步。
 */
import { AUDITOR_ROLES } from './security/roles.js';

export { AUDITOR_ROLES };

/** 从实例 ID 取职务码（大小写不敏感，`role-audit-code-22` → `AUDIT_CODE`）；不合法返回 null。 */
export function roleOfInstance(instanceId         )                {
  const match = /^role-([a-z][a-z0-9_]*(?:-[a-z0-9_]+)*)-(\d{2,})$/i.exec(String(instanceId ?? ''));
  if (!match) return null;
  return match[1].replace(/-/g, '_').toUpperCase();
}

export function isAuditorInstance(instanceId         )          {
  const role = roleOfInstance(instanceId);
  return role !== null && AUDITOR_ROLES.includes(role);
}

export const QUALITY = Object.freeze({
  supports_whitebox: false,
  supports_prefix_cache: 'observable-only',
  same_model_only: false,
  caller_required: 'live-agent',
  state_authority: 'plugin-journal',
  team_task_role: 'projection',
  cross_process_lock: false,
  cross_record_transactions: false,
});

export const CAPABILITIES = Object.freeze({
  plugin: 'dsh-l0-control',
  contractVersion: '0.1.0',
  backend: 'dsh-host-plugin',
  toolCount: Object.keys(TOOL_SURFACE).length,
  tools: TOOL_SURFACE,
  native: Object.freeze({
    agentTeams: ['membership', 'listMembers', 'spawnTeammate', 'sendMessage', 'createTask', 'getTask', 'listTasks', 'updateTask', 'waitForChange', 'interrupt'],
    subagents: ['startActivation', 'sendMessage', 'interrupt', 'listChildren'],
    sessionController: ['create', 'prompt', 'follow', 'inspect', 'cancel'],
    tools: ['register', 'execute', 'guard', 'restrict'],
    systemPrompt: ['section', 'context', 'variable', 'tools'],
  }),
  quality: QUALITY,
  core: {
    owner: 'N3',
    path: 'src/core/index.ts',
    state: 'delegated'                          ,
    note: 'N2 只做壳：core 不在时所有图操作 fail-closed 返回 core-unavailable',
  },
});

export function capabilitiesDigest() {
  const grades = Object.values(TOOL_SURFACE).reduce                        ((acc, entry) => {
    acc[entry.grade] = (acc[entry.grade] ?? 0) + 1;
    return acc;
  }, {});
  return {
    plugin: CAPABILITIES.plugin,
    contractVersion: CAPABILITIES.contractVersion,
    toolCount: CAPABILITIES.toolCount,
    grades,
    supports_whitebox: QUALITY.supports_whitebox,
    stateAuthority: QUALITY.state_authority,
    teamTaskRole: QUALITY.team_task_role,
    callerRequired: QUALITY.caller_required,
  };
}


//# sourceURL=capabilities.js