/**
 * 9 个工具的声明与执行壳。
 *
 * 约定：
 *   - 参数校验在这里，业务不变量在 `src/core`（N3）；
 *   - 需要活 Agent 的动作取 `exec.agent`（`team_status` 必须，其余为可选绑定）；
 *   - 输出统一 JSON，便于夹具与导出对账。
 */
import { CAPABILITIES } from './capabilities.js';
import { sanitizeForHost } from './service.js';
import type { L0ControlService } from './service.js';

/**
 * 出口硬化：宿主对工具返回值做 lossless-JSON 校验，任何 `undefined` / `NaN` /
 * `Infinity` / 函数 / Map / Set / class 实例都会让整个调用被拒，且错误文本与
 * 真实原因无关。这里统一过一遍 `JSON.stringify` → `JSON.parse`，得到纯 JSON
 * 数据；序列化失败（循环引用、BigInt）时退回服务层归一化，绝不把原始对象
 * 直接交给宿主。
 */
function losslessOutput(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return sanitizeForHost(value);
  }
}

interface ToolExec {
  agent?: { id: string };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => unknown[] };
  execute: (args: any, exec: ToolExec) => Promise<unknown> | unknown;
}

const output = {
  schema: { type: 'object', additionalProperties: true },
  render(_args: unknown, value: unknown) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
  },
};

function rawName(key: string): string {
  return key;
}

export function buildTools(service: L0ControlService): ToolDefinition[] {
  const prefix = service.config.toolPrefix || '';
  const named = (key: string) => `${prefix}${rawName(key)}`;

  return [
    {
      name: named('wish_submit'),
      description:
        '记录愿望并返回 GraphSpec 模板 + 建图指令；不自动建图，下一步 graph_plan 预览、graph_commit 落图。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '愿望文本（非空）' },
          maxParallel: { type: 'number', description: '本次并发上限（覆盖 Config.maxParallel）' },
          budgetTokens: { type: 'number', description: '本次 token 预算（0=不限）' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output,
      execute: (args) => service.wishSubmit(args),
    },
    {
      name: named('graph_plan'),
      description:
        '工作图预览：校验 GraphSpec（ID 唯一/依赖存在/无环/stage 合法/可验收/预算）并返回 errors/warnings/wouldBeReady/topology，零写入。wouldBeReady 仅按依赖推导。',
      parameters: {
        type: 'object',
        properties: {
          wish: { type: 'string', description: '原始需求（写进 meta）' },
          nodes: {
            type: 'array',
            description: 'NodeSpec 数组：{nodeId,title,spec?,capability?,stage?,deps?,evidenceRequired?,verifierIds?,acceptance?,budget?}',
            items: { type: 'object', additionalProperties: true },
          },
          policies: { type: 'object', additionalProperties: true, description: '{maxParallel,maxDepth,budgetTokens}' },
          spec: { type: 'object', additionalProperties: true, description: '或直接给完整 GraphSpec（优先）' },
        },
        additionalProperties: false,
      },
      output,
      execute: (args) => service.graphPlan(args ?? {}),
    },
    {
      name: named('graph_commit'),
      description:
        '落图：校验通过才写节点/依赖并算 ready；同图重复提交幂等，校验失败零写入。',
      parameters: {
        type: 'object',
        properties: {
          wish: { type: 'string', description: '原始需求（写进 meta）' },
          nodes: {
            type: 'array',
            description: 'NodeSpec 数组（同 graph_plan）',
            items: { type: 'object', additionalProperties: true },
          },
          policies: { type: 'object', additionalProperties: true, description: '{maxParallel,maxDepth,budgetTokens}' },
          spec: { type: 'object', additionalProperties: true, description: '或直接给完整 GraphSpec（优先）' },
        },
        additionalProperties: false,
      },
      output,
      execute: (args) => service.graphCommit(args ?? {}),
    },
    {
      name: named('graph_status'),
      description: '读图状态：journal 摘要 + 快照 + 能力摘要 + core 投影（缺失 fail-closed）+ 因子巡检；节点为最小投影，默认 50/页。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '每页节点数（默认 50，上限 500）' },
          offset: { type: 'number', description: '起始偏移（默认 0）' },
        },
        additionalProperties: false,
      },
      output,
      execute: (args) => service.graphStatus(args ?? {}),
    },
    {
      name: named('dispatch'),
      description: '派活循环：省略 mode = 只读出计划（不派活）；off（默认）/interval/resident。dryRun 默认 true，仅 dryRun:false 才真的 claim。',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['off', 'interval', 'resident'], description: '切换到的模式；省略=只读状态' },
          intervalMs: { type: 'number', description: 'interval 间隔毫秒（≥30000）' },
          maxPerTick: { type: 'number', description: '单轮最多派几个（1–32）' },
          dryRun: { type: 'boolean', description: 'true=只出计划（缺省）；false=真的 claim' },
        },
        additionalProperties: false,
      },
      output,
      execute: (args) => service.dispatch(args ?? {}),
    },
    {
      name: named('task_next'),
      description: '取下一个可执行节点（ready 由 core 门控），可按职务过滤。',
      parameters: {
        type: 'object',
        properties: { role: { type: 'string', description: '职务码，如 CODE / AUDIT_CODE' } },
        additionalProperties: false,
      },
      output,
      execute: (args) => service.taskNext(args ?? {}),
    },
    {
      name: named('task_heartbeat'),
      description: '租约续期：凭证是 fencingToken 能力凭证（不绑身份，任一载体可续）；续租失败即停手并上报 lead。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: '节点 ID' },
          fencingToken: { type: 'number', description: 'claim 签发的 fencing token' },
          ttlSec: { type: 'number', description: '续期秒数（缺省 600）' },
        },
        required: ['nodeId', 'fencingToken'],
        additionalProperties: false,
      },
      output,
      execute: (args) => service.taskHeartbeat(args ?? {}),
    },
    {
      name: named('task_claim'),
      description: '领取节点：core 落租约/claim；可绑实例（ROLE-<职务>-<序号>）。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: '节点 ID' },
          role: { type: 'string', description: '领取职务' },
          instanceId: { type: 'string', description: '实例 ID（如 ROLE-CODE-01）' },
        },
        required: ['nodeId'],
        additionalProperties: false,
      },
      output,
      execute: (args) => service.taskClaim(args),
    },
    {
      name: named('evidence_submit'),
      description: '提交证据：产物须真实存在；须能确定生产实例（producer_instance 或 caller 绑定，否则 producer-unknown）；verdict 缺省由 acceptance 判。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: '节点 ID' },
          artifactPath: { type: 'string', description: '产物路径（相对 workspaceRoot 或绝对）' },
          verifier: { type: 'string', description: '验证器标识（注册表内）' },
          acceptance: { type: 'object', additionalProperties: true, description: '验收条目 {kind, expected}' },
          producer_instance: { type: 'string', description: '生产实例（缺省取 caller 绑定实例）' },
          verdict: { type: 'string', enum: ['pass', 'fail', 'unknown'], description: '显式判定（缺省由 acceptance 判）' },
          provenance: {
            type: 'string',
            enum: ['verified', 'inferred', 'assumed'],
            description: 'verified=已核验事实 / inferred=线索推断 / assumed=假设。缺省：有 acceptance→verified，无→inferred。仅 verified 能支撑 done',
          },
        },
        required: ['nodeId', 'artifactPath'],
        additionalProperties: false,
      },
      output,
      execute: (args, exec) => service.evidenceSubmit(args, exec?.agent),
    },
    {
      name: named('verify_done'),
      description: '置 done：需 auditor_instance（缺省取 caller 绑定）与 producer_instance；producer≠auditor、verifier 须审计职务，unknown 不得通过。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: '节点 ID' },
          acceptance: { type: 'object', additionalProperties: true, description: '验收条目' },
          producer_instance: { type: 'string', description: '生产实例 ID（审计独立性机检用）' },
          auditor_instance: { type: 'string', description: '审计实例 ID（缺省取 caller 绑定实例）' },
        },
        required: ['nodeId'],
        additionalProperties: false,
      },
      output,
      execute: (args, exec) => service.verifyDone(args, exec?.agent),
    },
    {
      name: named('decision_record'),
      description: '记录 L0–L2 决策（账本由 core 维护）；L3 不经此工具。',
      parameters: {
        type: 'object',
        properties: {
          decisionId: { type: 'string', description: '决策 ID' },
          nodeId: { type: 'string', description: '关联节点（可选）' },
          level: { type: 'string', enum: ['L0', 'L1', 'L2'], description: '决策层级' },
          optionId: { type: 'string', description: '选定选项' },
          note: { type: 'string', description: '备注' },
        },
        additionalProperties: false,
      },
      output,
      execute: (args) => service.decide(args ?? {}),
    },
    {
      name: named('pass_gate'),
      description: '通过阶段闸门（research/design/build/audit/deliver）：记 passed + 证据引用；不改节点状态，推进仍走 verify_done。',
      parameters: {
        type: 'object',
        properties: {
          stage: {
            type: 'string',
            enum: ['research', 'design', 'build', 'audit', 'deliver'],
            description: '阶段（5 段枚举）',
          },
          evidence_refs: {
            type: 'array',
            items: { type: 'string' },
            description: '证据引用（产物路径 / 证据 ID 列表）',
          },
        },
        required: ['stage'],
        additionalProperties: false,
      },
      output,
      execute: (args) => service.passGate(args ?? {}),
    },
    {
      name: named('memory_load'),
      description: '按需读管理区任务卡/STATE/一篇报告，返回紧凑文本与引用；不自动注入、不返回全量历史。',
      parameters: {
        type: 'object',
        properties: {
          taskCard: { type: 'string', description: '任务卡文件名（tasks/ 下；可省略 .md）' },
          record: { type: 'string', description: '报告文件名（reports/ 下；可省略 .md）' },
          maxChars: { type: 'number', description: '返回文本上限（1000–30000，默认 12000）' },
        },
        additionalProperties: false,
      },
      output,
      execute: (args) => service.memoryLoad(args ?? {}),
    },
    {
      name: named('memory_writeback'),
      description: '把本轮结论/下一步/证据写成短报告；有任务卡时追加指针。只写结论。',
      parameters: {
        type: 'object',
        properties: {
          taskCard: { type: 'string', description: '任务卡文件名（tasks/ 下；可省略 .md）' },
          summary: { type: 'string', description: '本轮结论（必填，建议 1–5 条）' },
          next: { type: 'string', description: '下一步指针' },
          evidence: { type: 'string', description: '证据/文件路径/命令结果摘要' },
        },
        required: ['summary'],
        additionalProperties: false,
      },
      output,
      execute: (args) => service.memoryWriteback(args ?? {}),
    },
    {
      name: named('team_status'),
      description: '读原生团队成员板/任务板 + 本插件派生的子 Agent 实例（缺 caller fail-closed）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output,
      execute: (_args, exec) => service.teamStatus(exec?.agent),
    },
    {
      name: named('agent_spawn'),
      description: '起真实子 Agent（parent=exec.agent，带 maxDepth）；实例 ID=ROLE-<职务>-<序号>，登记落 journal。',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', description: '职务码，如 CODE / AUDIT_CODE' },
          task: { type: 'string', description: '初始任务文本' },
          index: { type: 'number', description: '同职务序号（缺省自增）' },
          label: { type: 'string', description: '展示标签' },
          maxDepth: { type: 'number', description: '递归深度上限（缺省取 Config）' },
          agentPreset: { type: 'string', description: 'Agent 预设名' },
          capability: { type: 'string', description: '本次任务所需能力（role 只是实例身份）' },
          contextPack: {
            type: 'array',
            items: { type: 'string' },
            description: '任务上下文，每行一条事实/约束',
          },
          cwd: { type: 'string', description: '子 Agent 工作目录（缺省 workspaceRoot）' },
          via: { type: 'string', enum: ['auto', 'team', 'activation', 'provider'], description: '组装策略：auto/team=A；activation=B；provider=C' },
          provider: { type: 'string', description: 'provider 名（C 用，缺省 spawn）' },
          heartbeatTtlSec: { type: 'number', description: 'worker 心跳 TTL 秒（worker 按 ≤ TTL/3 续租；缺省 60）' },
        },
        required: ['role', 'task'],
        additionalProperties: false,
      },
      output,
      execute: (args, exec) => service.spawnAgent(args ?? {}, exec?.agent),
    },
    {
      name: named('agent_message'),
      description: '给直接子 Agent 投消息（subagents.sendMessage）；缺 caller/未知实例 fail-closed。',
      parameters: {
        type: 'object',
        properties: {
          instanceId: { type: 'string', description: '实例 ID，如 ROLE-CODE-01' },
          text: { type: 'string', description: '消息文本' },
          awaitOutput: { type: 'boolean', description: 'true=轮询到 turn/end 并回收回执与 usage' },
          timeoutMs: { type: 'number', description: '等回执超时（默认 120000）' },
        },
        required: ['instanceId', 'text'],
        additionalProperties: false,
      },
      output,
      execute: (args, exec) => service.sendMessage(args ?? {}, exec?.agent),
    },
    {
      name: named('agent_reap'),
      description: '回收空闲子 Agent：默认 dry-run（reapEnabled=false 时拒绝执行）；running 跳过；只释放/归档，不硬删 journal/证据。',
      parameters: {
        type: 'object',
        properties: {
          sessionIds: { type: 'array', items: { type: 'string' }, description: '只回收这些 sessionId；省略=全部子孙' },
          apply: { type: 'boolean', description: 'true=执行；仍需 reapEnabled=true 且 reapDryRun=false' },
        },
        additionalProperties: false,
      },
      output,
      execute: (args, exec) => service.reapAgents(args ?? {}, exec?.agent),
    },
    {
      name: named('board_task_create'),
      description: '建团队板任务（投影非权威）；caller 须为 Team 成员。',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: '任务标题' },
          description: { type: 'string', description: '任务详情/验收' },
          nodeId: { type: 'string', description: '对应图节点（同源校验）' },
          blockedBy: { type: 'array', items: { type: 'string' }, description: '阻塞任务 ID' },
          writeScopes: { type: 'array', items: { type: 'string' }, description: '写域前缀（advisory）' },
          ownerInstance: { type: 'string', description: '建完 reassign 给该实例' },
        },
        required: ['subject', 'description'],
        additionalProperties: false,
      },
      output,
      execute: (args, exec) => service.createTeamTask(args ?? {}, exec?.agent),
    },
    {
      name: named('board_task_update'),
      description: 'CAS 更新团队任务（expectedRevision 必填）：投影更新，不写图状态。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '任务 ID（如 task-17）' },
          expectedRevision: { type: 'number', description: '当前 revision（CAS 前置）' },
          action: {
            type: 'string',
            enum: ['claim', 'release', 'complete', 'reopen', 'reassign', 'edit', 'set_dependencies', 'delete'],
            description: '任务动作',
          },
          owner: { type: 'string', description: 'reassign 的成员名' },
        },
        required: ['taskId', 'expectedRevision', 'action'],
        additionalProperties: false,
      },
      output,
      execute: (args, exec) => service.updateTeamTask(args ?? {}, exec?.agent),
    },
    {
      name: named('graph_export'),
      description: '导出人读投影（capabilities.json/STATE.md + core 导出）；投影不是第二事实源。',
      parameters: {
        type: 'object',
        properties: { outDir: { type: 'string', description: '导出目录（相对 workspaceRoot）' } },
        additionalProperties: false,
      },
      output,
      execute: (args) => service.exportProjection(args ?? {}),
    },
    {
      name: named('project_init'),
      description:
        'Bootstrap 工程区 + 管理区骨架 + .l0-control/project.json（缺省 dry-run；只 git init）。',
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: '项目名（缺省取 slug/wish）' },
          wish: { type: 'string', description: '一句话愿望（写进 README/STATE）' },
          slug: { type: 'string', description: '目录 slug（缺省由项目名生成）' },
          root: { type: 'string', description: '目标目录（须在选中工作区内；缺省 projects/<slug>）' },
          workspaceRoot: {
            type: 'string',
            description: '选中工作区（别名 selectedWorkspace/workspacePath）；须存在且在实例 workspaceRoot 或其父目录下',
          },
          managementRoot: {
            type: 'string',
            description: '管理区目录（缺省同级 <root>-管理区；须落在工作区内）',
          },
          dryRun: { type: 'boolean', description: 'true=不写盘（缺省）' },
          gitInit: { type: 'boolean', description: '只 git init（缺省 true）' },
          management: { type: 'boolean', description: '建管理区骨架（缺省 true）' },
          allowEmptyExisting: { type: 'boolean', description: '目标为空目录时允许多写（缺省 false）' },
        },
        additionalProperties: false,
      },
      output,
      execute: (args, exec) => service.projectInit(args ?? {}, exec?.agent?.id),
    },
  ].map((tool) => ({
    ...tool,
    surface: CAPABILITIES.tools[tool.name.replace(prefix, '')],
    execute: async (args: any, exec: ToolExec) => losslessOutput(await tool.execute(args, exec)),
  }));
}
