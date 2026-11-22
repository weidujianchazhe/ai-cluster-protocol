/**
 * 工具面的声明与执行壳（数量以 `capabilities.ts` 的 `TOOL_SURFACE` 为准，这里不写死）。
 *
 * 约定：
 *   - 参数校验在这里，业务不变量在 `src/core`（N3）；
 *   - 需要活 Agent 的动作取 `exec.agent`（`team_status` 必须，其余为可选绑定）；
 *   - 输出统一 JSON，便于夹具与导出对账。
 */
import { CAPABILITIES } from './capabilities.js';
import { losslessOutput } from './serializer.js';
                                                     

/**
 * 出口硬化：宿主对工具返回值做 lossless-JSON 校验，任何 `undefined` / `NaN` /
 * `Infinity` / 函数 / Map / Set / class 实例都会让整个调用被拒，且错误文本与
 * 真实原因无关。这里统一走 `toJsonValue()`（单趟遍历产纯 JSON 树），
 * 不再做 `JSON.parse(JSON.stringify())` 的往返拷贝。
 */

                    
                         
 

                                 
               
                      
                                      
                                                                                                    
                                                                     
 

const output = {
  schema: { type: 'object', additionalProperties: true },
  render(_args         , value         ) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
  },
};

function rawName(key        )         {
  return key;
}

export function buildTools(service                  )                   {
  const prefix = service.config.toolPrefix || '';
  const named = (key        ) => `${prefix}${rawName(key)}`;

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
      name: named('graph_replan'),
      description:
        '重规划（**唯一会改图的协调动作**）：单事务增删节点 / 改依赖 + 递增 `graph_version` + 写 `graph_replanned` 事件。' +
        '`expectedGraphVersion` **必填**：这是 CAS——先读 `graph_status.graph_version` 再带同一个值，' +
        '旧组织审查结果不得覆盖新图；版本不符返回 `replan_stale_graph` 并给出 `actualGraphVersion`。' +
        '终态（done/accepted）节点不得删除或改依赖：要修订就新增修订节点，不改写历史。' +
        '校验在事务前完成：自依赖 / 悬空依赖 / 成环 / 半途落图一律拒绝，失败零写入。' +
        '语义裁决不走这里——技术契约矛盾交给临时协调/审计节点，价值取舍交给人。',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'gate_failed | evidence_insufficient | scope_change | decision_override | failure_retry | coordination',
          },
          expectedGraphVersion: { type: 'number', description: '当前 graph_version（CAS 前置，必填）' },
          add: {
            type: 'array',
            description: '新增节点：{nodeId,title,spec,capability?,stage?,deps?,evidenceRequired?,verifierIds?,writeScopes?,budget?}',
            items: { type: 'object', additionalProperties: true },
          },
          remove: { type: 'array', description: '删除节点 ID（不得为终态）', items: { type: 'string' } },
          setDeps: {
            type: 'object',
            additionalProperties: true,
            description: '改依赖：{nodeId: [depId...]}；删节点时其下游必须同时在这里改掉，否则按悬空依赖拒绝',
          },
          note: { type: 'string', description: '为什么要改（写进事件，供回放）' },
        },
        required: ['expectedGraphVersion'],
        additionalProperties: false,
      },
      output,
      execute: (args, exec) => service.graphReplan(args ?? {}, exec.agent),
    },
    {
      name: named('neighbor_digest'),
      description:
        '邻域摘要（**只读，不参与任何判定**）：返回**已完成**节点的定长摘要，两个方向——' +
        '`deps`（纵向：直接上游，深度 1）与 `partition`（横向：同分区）。' +
        '**纵向优先**：上游是"我依赖的东西"，名额有限时先给上游。' +
        '**只读 done**（终态），所以同一段历史回放出同一个邻域；**只读 title/spec，不读盘上的产物**。' +
        '返回里带 `cost.approxTokens`——「让节点知道更多」按 `maxParallel × 每轮上下文` 放大，必须知道买了多少。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: '要为其构造邻域的节点（必填）' },
          direction: {
            type: 'string',
            description: "感知方向：'partition'（横向，默认）| 'deps'（纵向深度 1）| 'both'",
          },
          maxNeighbors: { type: 'number', description: '最多展示几个邻居（默认 5；0=不限但受 charsPerNeighbor 兜住）' },
          charsPerNeighbor: { type: 'number', description: '每条摘要的字符上限（默认 120）' },
        },
        required: ['nodeId'],
        additionalProperties: false,
      },
      output,
      execute: (args) => service.neighborhoodDigest(args ?? {}),
    },
    {
      name: named('collaboration_map'),
      description:
        '协作图（**只读聚合，不参与任何判定**）：从证据的 `contextRefs` 声明算出「谁读了谁」，并接上质量分做对比。' +
        '返回边列表、每节点入度/出度、**孤岛**（既不引用别人也不被引用）、信息枢纽（被引用最多），' +
        '以及核心结论：**有耦合 vs 无耦合的平均质量分差**（`quality.delta`）——这是「协作有没有用」的唯一实证指标。' +
        '样本不足时 `delta=null` 并明确写「不下结论」。注意它是**耦合声明图**：`contextRefs` 由生产者自己填，' +
        '没有机制验证产物真的引用了对方。',
      parameters: {
        type: 'object',
        properties: {
          minSample: { type: 'number', description: '判定「耦合与质量有关」所需的最小样本量（默认 3）' },
        },
        additionalProperties: false,
      },
      output,
      execute: (args) => service.collaborationMap(args ?? {}),
    },
    {
      name: named('quality_report'),
      description:
        '质量报告（**只读聚合，不参与任何判定**）：从已有信号算「过程质量」——' +
        '证据来源强度（verified/inferred/assumed）、返工次数（attempts）、是否有独立审计。' +
        '返回每个节点的分数与可解释的 reasons、按 stage / capability 的分组均值、以及最需要关注的 5 个节点。' +
        '**注意**：缺证据的节点记为 `unknown`（`score=null`），不是 0 分——前者是"还没法判断"，后者会被读成"干砸了"。' +
        '它**不测产出本身的好坏**（一个 verified 的证据也可能对应平庸的产物）。',
      parameters: {
        type: 'object',
        properties: {
          stage: { type: 'string', description: '只看某阶段（research/design/build/audit/deliver）' },
          limit: { type: 'number', description: '返回的节点明细上限（默认 50）' },
        },
        additionalProperties: false,
      },
      output,
      execute: (args) => service.qualityReport(args ?? {}),
    },
    {
      name: named('organization_review'),
      description:
        '组织审查（**只读**：不派活、不改图、不裁决）。协调闭环第 0 阶段——把冲突/集成契约/写域重叠公开成报告。' +
        '返回：`organization.contracts`（集成契约状态与缺失成员）、`conflicts`（含 byRoute / 能力缺口 / 需人裁决项）、' +
        '`signals`（发现：集成契约 / 冲突路由 / 能力缺口 / 写域重叠 / 需人裁决）、`proposals`（**草案**，' +
        '`replanDraft` 刻意不含 `expectedGraphVersion`，采纳者必须自己带）、`next`。' +
        '`fingerprint` 只由 state 决定：同一 journal 重放出同一值，除 `generatedAt` 外逐字可比。' +
        '想改图必须显式走 `graph_replan`；`signals` 是发现，不等于冲突已裁决。',
      parameters: {
        type: 'object',
        properties: {
          generatedAt: { type: 'string', description: '可选：注入生成时刻（测试/重放用），不影响 fingerprint' },
        },
        additionalProperties: false,
      },
      output,
      execute: (args) => service.organizationReview(args ?? {}),
    },
    {
      name: named('env_check'),
      description:
        '开工前环境体检：一次问清「这台机器能不能跑、数据会写到哪、还差什么」。' +
        '返回宿主服务（缺 agentTeams → 派出的实例当不了 TeamTask owner）、三处数据落点与各盘可用空间、' +
        '按**实测速率**推算的千级/万级占用，以及 `suggestedMaxAgents`（按会话盘可用空间反推这台机器实际能跑多少）。' +
        '`ready=false` 时看 `blockers`——那是必须先解决的项。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output,
      execute: () => service.envCheck(),
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
      name: named('graph_checkpoint'),
      description: '为指定分区落检查点：追加 `partition_checkpointed` 事件，返回检查点元数据与 baseSeq。',
      parameters: {
        type: 'object',
        properties: {
          partitionId: { type: 'string', description: '分区 ID（coordination.partitions[].id）' },
        },
        required: ['partitionId'],
        additionalProperties: false,
      },
      output,
      execute: (args) => service.graphCheckpoint(args ?? {}),
    },
    {
      name: named('graph_recover'),
      description: '恢复报告：返回最近检查点元数据 + 需重放的事件数（实际重放由调用方用 foldEvents 完成）。',
      parameters: {
        type: 'object',
        properties: {
          partitionId: { type: 'string', description: '可选：指定分区 ID；省略=返回全图最近检查点' },
        },
        additionalProperties: false,
      },
      output,
      execute: (args) => service.graphRecover(args ?? {}),
    },
    {
      name: named('graph_resume_plan'),
      description:
        '分区恢复计划：按最近检查点逐节点对比当前状态，返回 resume（接着做）/ skipCompleted（已完成，恢复后绝不能再执行一次）/ drift（检查点说 done 却退回了，journal 被改写须报警）。',
      parameters: {
        type: 'object',
        properties: {
          partitionId: { type: 'string', description: '可选：指定分区 ID；省略=用全图最近检查点' },
        },
        additionalProperties: false,
      },
      output,
      execute: (args) => service.graphResumePlan(args ?? {}),
    },
    {
      name: named('dispatch'),
      description: '查看派活候选与容量。传 mode 可切换定时规划；默认只生成计划，enqueue:true 才真正派发 worker（worker 自己 claim）。',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['off', 'interval', 'resident'], description: '切换到的模式；省略=只读状态' },
          intervalMs: { type: 'number', description: 'interval 间隔毫秒（≥30000）' },
          maxPerTick: { type: 'number', description: '单轮最多派几个（1–32）' },
          dryRun: { type: 'boolean', description: '默认 true。false 按正式派活口径列出候选，但仍只生成计划。' },
          enqueue: { type: 'boolean', description: 'true=按候选真正 spawn worker（需活 caller；插件不代领节点）' },
          role: { type: 'string', description: 'enqueue 时的执行载体职务；省略时，节点 capability 若与 ROLE_PROFILES 职务同名则沿用，否则默认 CODE。' },
          capability: { type: 'string', description: '附加给 worker 的能力包；缺省时自由 capability 标签会从节点继承；若显式 role 覆盖节点职务，原节点职务也会保留为能力提示。' },
          maxEnqueue: { type: 'number', description: '本次最多派几个（缺省=候选数）' },
        },
        additionalProperties: false,
      },
      output,
      execute: (args, exec) => service.dispatch(args ?? {}, exec?.agent),
    },
    {
      name: named('task_next'),
      description: '取下一个可执行节点（ready 由 core 门控），返回首个符合可选职务筛选的候选。',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', description: '可选 ROLE_PROFILES 执行职务筛选：只匹配同名职务 capability；自由 capability 标签或未设 capability 的节点对所有 worker 可见。' },
        },
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
      execute: (args, exec) => service.taskClaim(args, exec?.agent),
    },
    {
      name: named('evidence_submit'),
      description: '提交证据：产物须真实存在；须能确定生产实例（producer_instance 或 caller 绑定，否则 producer-unknown）；verdict 缺省由 acceptance 判。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: '节点 ID' },
          artifactPath: { type: 'string', description: '产物路径（相对 workspaceRoot 或绝对）' },
          fencingToken: { type: 'number', description: 'task_claim 返回的当前节点 fencing token' },
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
        required: ['nodeId', 'artifactPath', 'fencingToken'],
        additionalProperties: false,
      },
      output,
      execute: (args, exec) => service.evidenceSubmit(args, exec?.agent),
    },
    {
      name: named('verify_done'),
      description: '由当前真实审计 caller 验收并置 done；auditor_instance 仅作一致性提示且必须匹配 caller，producer≠auditor，unknown 不得通过。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: '节点 ID' },
          acceptance: { type: 'object', additionalProperties: true, description: '验收条目' },
          fencingToken: { type: 'number', description: '当前节点的 task_claim token' },
          producer_instance: { type: 'string', description: '生产实例 ID（审计独立性机检用）' },
          auditor_instance: { type: 'string', description: '审计 caller 的一致性提示；必须与真实 caller 绑定实例一致' },
        },
        required: ['nodeId', 'fencingToken'],
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
          expectedCardRevision: { type: ['string', 'null'], description: '任务卡当前 SHA-256；写回前做 CAS，已有任务卡必填' },
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
          taskBrief: { type: 'object', additionalProperties: false, description: '最小任务简报：目标/写域/验收/证据引用/租约引用/省略项', properties: {
            objective: { type: 'string' }, writeScopes: { type: 'array', items: { type: 'string' } }, acceptance: { type: 'array', items: { type: 'string' } }, evidenceRefs: { type: 'array', items: { type: 'string' } }, leaseRef: { type: 'string' }, omitted: { type: 'array', items: { type: 'string' } },
          } },
          agent: {
            type: 'object',
            additionalProperties: false,
            description: '分组写法（覆盖同名扁平字段）：这个子 Agent 是谁 / 带什么包',
            properties: {
              preset: { type: 'string', description: 'Agent 预设名（等同 agentPreset）' },
              capability: { type: 'string', description: '能力包（等同 capability）' },
              contextPack: { type: 'array', items: { type: 'string' }, description: '上下文事实/指针（等同 contextPack）' },
              cwd: { type: 'string', description: '工作目录（等同 cwd）' },
              maxDepth: { type: 'number', description: '递归深度上限（等同 maxDepth）' },
              label: { type: 'string', description: '展示标签（等同 label）' },
              index: { type: 'number', description: '同职务序号（等同 index）' },
              heartbeatTtlSec: { type: 'number', description: '心跳 TTL 秒（等同 heartbeatTtlSec）' },
              taskBrief: { type: 'object', additionalProperties: false, description: '最小任务简报', properties: {
                objective: { type: 'string' }, writeScopes: { type: 'array', items: { type: 'string' } }, acceptance: { type: 'array', items: { type: 'string' } }, evidenceRefs: { type: 'array', items: { type: 'string' } }, leaseRef: { type: 'string' }, omitted: { type: 'array', items: { type: 'string' } },
              } },
            },
          },
          transport: {
            type: 'object',
            additionalProperties: false,
            description: '分组写法：走哪条组装通道',
            properties: {
              via: { type: 'string', enum: ['auto', 'team', 'activation', 'provider'], description: '组装策略（等同 via）' },
              provider: { type: 'string', description: 'provider 名（等同 provider）' },
            },
          },
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
    execute: async (args     , exec          ) => losslessOutput(await tool.execute(args, exec)),
  }));
}


//# sourceURL=tools.js