/**
 * 9 个工具的声明与执行壳。
 *
 * 约定：
 *   - 参数校验在这里，业务不变量在 `src/core`（N3）；
 *   - 需要活 Agent 的动作取 `exec.agent`（`team_status` 必须，其余为可选绑定）；
 *   - 输出统一 JSON，便于夹具与导出对账。
 */
import { CAPABILITIES } from './capabilities.js';
import type { L0ControlService } from './service.js';

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
        '记录一条愿望并返回 GraphSpec 模板 + 建图指令：**不会自动生成固定流水线**；下一步用 graph_plan 预览、graph_commit 落图。',
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
        '工作图组成因子的**预览**：校验 GraphSpec（ID 唯一/依赖存在/无环/stage 合法/每节点可验收/预算合法）并返回 errors/warnings/ready/topology，**零写入**。不套固定模板。',
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
        '工作图组成因子的**落图**：先按 GraphSpec 校验，通过才写节点/依赖并计算 ready；同一份图重复提交返回 idempotent。校验失败零写入。',
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
      description: '读工作图状态：journal 摘要 + 快照存在性 + 能力声明摘要 + core 投影（core 缺失时 fail-closed 标注）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output,
      execute: () => service.graphStatus(),
    },
    {
      name: named('task_next'),
      description: '取下一个可执行节点（ready 门控由 core 计算）；可按职务过滤。',
      parameters: {
        type: 'object',
        properties: { role: { type: 'string', description: '职务码，如 CODE / AUDIT_CODE' } },
        additionalProperties: false,
      },
      output,
      execute: (args) => service.taskNext(args ?? {}),
    },
    {
      name: named('task_claim'),
      description: '声明领取某节点：落 journal 并由 core 执行租约/claim；可绑定具体实例（ROLE-<职务>-<序号>）。',
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
      description: '提交证据：产物必须真实存在（缺失即拒），必须能确定生产实例（producer_instance 或 caller 绑定实例，否则 producer-unknown）；verdict 缺省由 acceptance 判定。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: '节点 ID' },
          artifactPath: { type: 'string', description: '产物路径（相对 workspaceRoot 或绝对）' },
          verifier: { type: 'string', description: '验证器标识（注册表内）' },
          acceptance: { type: 'object', additionalProperties: true, description: '验收条目 {kind, expected}' },
          producer_instance: { type: 'string', description: '生产实例 ID（缺省取 caller 绑定实例）' },
          verdict: { type: 'string', enum: ['pass', 'fail', 'unknown'], description: '显式判定（缺省由 acceptance 判）' },
        },
        required: ['nodeId', 'artifactPath'],
        additionalProperties: false,
      },
      output,
      execute: (args, exec) => service.evidenceSubmit(args, exec?.agent),
    },
    {
      name: named('verify_done'),
      description: '请求把节点置 done：必须带 auditor_instance（缺省取 caller 绑定实例，否则 auditor-required）与 producer_instance；producer≠auditor 且 verifier 属审计职务，unknown 不得通过。',
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
      description: '记录一次决策（L0–L2）：决策账本由 core 维护；L3 不经此工具。',
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
      description: '通过一个阶段闸门（research/design/build/audit/deliver）：调 core.passGate 记 passed + 证据引用；不直接改节点状态（节点推进仍走 verify_done）。',
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
      description: '按需读取管理区/工程记忆：任务卡 + STATE + 一篇报告，返回紧凑文本和引用；不自动注入，不返回全量历史。',
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
      description: '把本轮结论/下一步/证据写成短报告；有任务卡时在卡末追加指针。只写结论，不复制整段上下文。',
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
      description: '原生通道：读 agentTeams 团队成员板与任务板，并列出本插件派生的真实子 Agent 实例（caller 取 exec.agent，缺 caller fail-closed）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output,
      execute: (_args, exec) => service.teamStatus(exec?.agent),
    },
    {
      name: named('agent_spawn'),
      description: '真实起一个子 Agent（subagents.startActivation，parent=exec.agent，带 maxDepth）：实例 ID = ROLE-<职务>-<序号>，登记表落 journal 可回放。',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', description: '职务码，如 CODE / AUDIT_CODE' },
          task: { type: 'string', description: '初始任务文本' },
          index: { type: 'number', description: '同职务序号（缺省自动递增）' },
          label: { type: 'string', description: '展示标签' },
          maxDepth: { type: 'number', description: '递归深度上限（缺省取 Config.nativeMaxDepth）' },
          agentPreset: { type: 'string', description: 'Agent 预设名' },
          capability: { type: 'string', description: '能力包：本次任务需要的能力（替代固定"角色职责"；role 只是实例身份）' },
          contextPack: {
            type: 'array',
            items: { type: 'string' },
            description: '任务上下文清单（每行一条事实/约束）',
          },
          cwd: { type: 'string', description: '子 Agent 工作目录（缺省 workspaceRoot）' },
          via: { type: 'string', enum: ['auto', 'team', 'activation', 'provider'], description: '组装策略：auto/team=A；activation=B；provider=C（需已注册 provider）' },
          provider: { type: 'string', description: 'subagents provider 名（C 用；缺省 spawn）' },
        },
        required: ['role', 'task'],
        additionalProperties: false,
      },
      output,
      execute: (args, exec) => service.spawnAgent(args ?? {}, exec?.agent),
    },
    {
      name: named('agent_message'),
      description: '给真实子 Agent 投递消息（subagents.sendMessage；只对直接连续子会话有效）。缺 caller / 未知实例 → fail-closed。',
      parameters: {
        type: 'object',
        properties: {
          instanceId: { type: 'string', description: '实例 ID，如 ROLE-CODE-01' },
          text: { type: 'string', description: '消息文本' },
          awaitOutput: { type: 'boolean', description: 'true 时轮询 inspect 到 turn/end，回收回执文本与实例累计 usage' },
          timeoutMs: { type: 'number', description: '等回执超时（默认 120000）' },
        },
        required: ['instanceId', 'text'],
        additionalProperties: false,
      },
      output,
      execute: (args, exec) => service.sendMessage(args ?? {}, exec?.agent),
    },
    {
      name: named('board_task_create'),
      description: '在原生团队板建一条任务（投影，不是权威）：agentTeams.createTask，caller 必须是 Team 成员。',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: '任务标题' },
          description: { type: 'string', description: '任务详情/验收' },
          nodeId: { type: 'string', description: '对应图节点（用于同源校验）' },
          blockedBy: { type: 'array', items: { type: 'string' }, description: '阻塞任务 ID 列表' },
          writeScopes: { type: 'array', items: { type: 'string' }, description: '写域前缀（advisory）' },
          ownerInstance: { type: 'string', description: '建完立即 reassign 给该实例（投影 owner 与图 assignee 同源）' },
        },
        required: ['subject', 'description'],
        additionalProperties: false,
      },
      output,
      execute: (args, exec) => service.createTeamTask(args ?? {}, exec?.agent),
    },
    {
      name: named('board_task_update'),
      description: 'CAS 更新原生团队任务（agentTeams.updateTask，expectedRevision 必填）：投影更新，不写图状态。',
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
      description: '导出人读投影（capabilities.json / STATE.md + core 导出）：投影不是第二事实源。',
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
        'Bootstrap：在 workspaceRoot 下初始化工程区 + 管理区骨架 + .l0-control/project.json（默认 dry-run；只 git init，不 commit/push）。',
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: '项目名（缺省取 slug/wish）' },
          wish: { type: 'string', description: '一句话愿望（写进 README/STATE）' },
          slug: { type: 'string', description: '目录 slug（缺省由项目名生成）' },
          root: { type: 'string', description: '目标目录（必须位于选中工作区下；缺省 projects/<slug>）' },
          workspaceRoot: {
            type: 'string',
            description: '选中工作区（别名 selectedWorkspace / workspacePath）；必须存在，且等于实例 workspaceRoot 或位于其父目录下',
          },
          managementRoot: {
            type: 'string',
            description: '管理区目录（缺省同级 <root>-管理区；相对路径按选中工作区解析；必须落在工作区内）',
          },
          dryRun: { type: 'boolean', description: '默认 true；只有 false 才写盘' },
          gitInit: { type: 'boolean', description: '默认 true；只 git init，不 commit/push' },
          management: { type: 'boolean', description: '是否创建管理区骨架（默认 true）' },
          allowEmptyExisting: { type: 'boolean', description: '目标为空目录时是否允许多写（默认 false）' },
        },
        additionalProperties: false,
      },
      output,
      execute: (args, exec) => service.projectInit(args ?? {}, exec?.agent?.id),
    },
  ].map((tool) => ({ ...tool, surface: CAPABILITIES.tools[tool.name.replace(prefix, '')] }));
}
