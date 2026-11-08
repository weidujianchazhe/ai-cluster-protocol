/**
 * Worker 自驱层：把「角色 prompt + 工具白名单 + 循环契约」交给真实子 Agent 自己跑。
 *
 * 设计边界（Lane A / 生产化）：
 *   - 插件**不代发、不代提交**：worker 自己 `task_next → task_claim → evidence_submit → pass_gate → verify_done`；
 *   - 插件只提供工具面与门禁（证据/闸门/审计独立都在 core 侧执行）；
 *   - 本模块只产出 prompt 文本与判定辅助（退避、失败分类、心跳租约），不做任何写操作。
 */

export type WorkerRole = 'CODE' | 'TEST' | 'DESIGN' | 'EVIDENCE' | 'AUDIT_CODE' | 'AUDIT_EVIDENCE' | 'AUDIT_DESIGN' | 'OPS' | string;

export interface RoleProfile {
  role: WorkerRole;
  /** 该角色在图上能产的阶段（用于自选 ready 节点）。 */
  stages: string[];
  /** 允许调用的工具（白名单，prompt 里显式列出；越界要说明理由）。 */
  tools: string[];
  /** 角色职责一句话。 */
  mission: string;
  /** 角色专属约束。 */
  rules: string[];
}

/**
 * worker 工具白名单。
 * `task_heartbeat` 是 P0-3 铺垫的续租工具（见下方 TASK_HEARTBEAT_CONTRACT）：
 * 仅允许以当前租约的 nodeId + fencingToken 调用；Lead 接线 tools.ts/service.ts 注册该工具后生效。
 */
const BASE_TOOLS = ['graph_status', 'task_next', 'task_claim', 'task_heartbeat', 'evidence_submit', 'pass_gate', 'verify_done', 'team_status', 'memory_load', 'memory_writeback'];

export const ROLE_PROFILES: Record<string, RoleProfile> = {
  CODE: {
    role: 'CODE',
    // 自主循环里 CODE 是"通才生产者"：research/design/build/deliver 都归它（audit 留给审计职务）
    stages: ['research', 'design', 'build', 'deliver'],
    tools: [...BASE_TOOLS, 'agent_message'],
    mission: '实现并交付：领取 research/design/build/deliver 节点，产出可验收 artifact，自己提交证据。',
    rules: ['不得领 audit 节点（那是审计职务的活）', '不得给自己的产物做审计（verify_done 的 auditor 必须是审计实例）'],
  },
  DESIGN: {
    role: 'DESIGN',
    stages: ['design'],
    tools: [...BASE_TOOLS],
    mission: '出设计与契约：领取 design 节点，产出契约/PRD 类 artifact。',
    rules: ['契约类产物要能被人读（README/契约文件）', '不得自审'],
  },
  TEST: {
    role: 'TEST',
    stages: ['build'],
    tools: [...BASE_TOOLS],
    mission: '测试与验证：为 build 节点补测试证据。',
    rules: ['只领 build', '不得自审'],
  },
  EVIDENCE: {
    role: 'EVIDENCE',
    stages: ['research', 'design'],
    tools: [...BASE_TOOLS],
    mission: '调研与证据：领取 research 节点，产出调研记录。',
    rules: ['证据必须指向真实存在的文件', '不得自审'],
  },
  AUDIT_CODE: {
    role: 'AUDIT_CODE',
    stages: ['audit'],
    tools: [...BASE_TOOLS],
    mission: '独立审计：领取 audit 节点做审计报告；并给 CODE 节点的 done 做独立复核。',
    rules: [
      '**不得审自己生产的节点**（producer_instance === 自己的实例 ID 时拒绝）',
      '被审节点必须有 evidence 且 gate passed',
    ],
  },
  AUDIT_EVIDENCE: {
    role: 'AUDIT_EVIDENCE',
    stages: ['audit'],
    tools: [...BASE_TOOLS],
    mission: '证据审计：复核证据完整性与 sha/路径。',
    rules: ['不得审自己生产的节点'],
  },
  AUDIT_DESIGN: {
    role: 'AUDIT_DESIGN',
    stages: ['audit'],
    tools: [...BASE_TOOLS],
    mission: '设计审计：复核 design 契约与验收口径。',
    rules: ['不得审自己生产的节点'],
  },
  OPS: {
    role: 'OPS',
    stages: ['deliver'],
    tools: [...BASE_TOOLS],
    mission: '交付打包：领取 deliver 节点出交付清单。',
    rules: ['不得自审'],
  },
};

/**
 * P1-7 启动职务解析（fail-closed，优先抛错而非静默回落 CODE）：
 * 未知职务静默回落 CODE 会把拼错/越界职务（如 AUDIT_* 的变体）伪装成生产者，
 * 进而绕过审计独立性与工具白名单，风险远大于一次显式失败；抛错能让调用方在 spawn 前就地修正。
 */
export function profileFor(role: string): RoleProfile {
  const key = String(role ?? '').trim().toUpperCase();
  const profile = ROLE_PROFILES[key];
  if (!profile) {
    const legal = Object.keys(ROLE_PROFILES).sort().join(', ');
    throw new Error(`unknown-role: 职务未知 "${String(role ?? '')}"，合法职务为 [${legal}]；拒绝静默回落 CODE`);
  }
  return profile;
}

/** 合法职务清单（供 Lead 接线 / 调用方做前置校验，与 profileFor 的抛错口径同源）。 */
export const LEGAL_WORKER_ROLES: readonly string[] = Object.keys(ROLE_PROFILES).sort();

export interface WorkerPromptInput {
  role: string;
  instanceId: string;
  /** 可选：本轮想让它优先看的节点/阶段提示。 */
  stageHint?: string;
  /** 最多跑几轮循环（防止无限循环）。 */
  maxIterations?: number;
  /** 同职务同伴实例（用于分工与交叉审计）。 */
  peers?: string[];
  /** 审计搭档（producer 用它做 verify 的 auditor）。 */
  auditPartner?: string;
  /** 能力包：这次任务需要的能力（替代固定"角色职责"；role 只是实例身份）。 */
  capability?: string;
  /** 任务上下文：给 worker 的事实/约束清单（每行一条）。 */
  contextPack?: string[];
  /** 心跳续租时长（秒，默认取 HEARTBEAT_CONTRACT.ttlSec）；心跳间隔自动取 ttlSec/3 向下取整、至少 1s。 */
  heartbeatTtlSec?: number;
}

/**
 * 生成 worker 的 prompt：**能力包 + 任务上下文** 为主体，`role` 只表示实例身份与工具白名单，
 * 不再当作"固定专家分工"。能力包没给时才回退到 role profile 的 mission（兜底）。
 */
export function buildWorkerPrompt(input: WorkerPromptInput): string {
  const profile = profileFor(input.role);
  const maxIterations = Number(input.maxIterations ?? 8);
  const peers = (input.peers ?? []).join(' / ') || '（无）';
  const auditPartner = input.auditPartner ?? '（未指定：审计节点请找一个非自己生产者的审计实例）';
  const capability = String(input.capability ?? '').trim() || `（未指定能力包，按实例身份兜底：${profile.mission}）`;
  const contextPack = (input.contextPack ?? []).map((line) => String(line).trim()).filter(Boolean);
  const stageList = input.stageHint
    ? String(input.stageHint)
    : profile.stages.join(', ');
  // P0-3 心跳频次：间隔 <= 租约 TTL/3（向下取整、至少 1s），保证一次心跳失败仍有两轮余量续租
  const heartbeatTtlSec = Math.max(1, Math.floor(Number(input.heartbeatTtlSec ?? 60) || 60));
  const heartbeatIntervalSec = Math.max(1, Math.floor(heartbeatTtlSec / 3));

  return [
    `你是自主 worker，实例 ID = \`${input.instanceId}\`（身份即工具参数里的 instanceId / producer_instance）。`,
    `实例身份 role = \`${profile.role}\`：**只用于实例寻址、工具白名单与审计独立性判断**，不代表固定专家分工。`,
    '',
    '## 身份脱离（总则）',
    '- 实例身份只是载体，能力/记忆挂在 MindId 上，可随载体迁移；主意识按需附体。',
    '- 换载体/换实例不改变能力与记忆归属；交接时用 `memory_writeback` 把结论挂回 MindId，不要把记忆绑在旧实例 ID 上。',
    '',
    '## 能力包（本次任务所需能力）',
    capability,
    '',
    '## 任务上下文（事实/约束，按需引用）',
    contextPack.length ? contextPack.map((line) => `- ${line}`).join('\n') : '- （无额外上下文）',
    '',
    '## 记忆优先（子 Agent）',
    '- 父会话的完整历史不是你的工作记忆；只使用本任务上下文与按需读取的工程记忆。',
    '- 需要项目背景/上次交接时调用 `memory_load`，只读当前任务卡/STATE/一篇记录。',
    '- 阶段完成或交接前调用 `memory_writeback` 写回结论、证据、下一步；不要复述或重读全文。',
    '',
    '## 允许的工具（白名单，只准用这些）',
    profile.tools.map((tool) => `- ${tool}`).join('\n'),
    '- `task_heartbeat` 只准以**你当前租约**的 `nodeId + fencingToken` 调用，禁止替别人续租、禁止编造 token。',
    '',
    '## 心跳（租约续租，P0-3 可执行指令）',
    `- 每次 \`task_claim\` 成功后立刻记下 \`nodeId\` 与 \`lease.fencing_token\`（以及租约 TTL）;本轮续租时长 ttlSec=${heartbeatTtlSec}s。`,
    `- 每 ${heartbeatIntervalSec} 秒（<= 租约 TTL/3，即 ${heartbeatTtlSec}/3）调用一次 \`task_heartbeat({nodeId, fencingToken, ttlSec:${heartbeatTtlSec}})\`；长任务每轮循环开始前先心跳一次。`,
    '- 心跳绑定的是租约 fencingToken，不是智能体身份：只有持有该 token 的租约可续租；换载体/换实例后旧 token 失效，不得用身份冒充续租。',
    '- 续租失败（`LeaseExpired` / `fencing` 不匹配 / `lease_held`）即停手：立即停止手头产出与后续 `evidence_submit`/`verify_done`，写一条 `agent_message` 给 `lead` 说明节点与 token 状态，然后结束；不要拿旧 token 硬交证据。',
    '- 停手后如需继续，必须重新走循环第 2–3 步 `task_next` → `task_claim` 拿到新 token 再重做，不要复用已失效的 fencingToken。',
    '',
    '## 你的循环（每轮严格按顺序，做一步看一步结果）',
    '1. `graph_status` —— 看 `counts` / `ready` / `persistence`；若 `counts.done === counts.nodes` 立即结束并回报。',
    `2. \`task_next({role:"${profile.role}"})\` —— 取 ready 集；只挑 stage ∈ {${stageList}} 的节点。没有就结束。`,
    `3. \`task_claim({nodeId, role:"${profile.role}", instanceId:"${input.instanceId}"})\` —— 用**你自己的实例 ID** 领；拿回 lease.fencing_token 并按上面的"心跳"节续租。`,
    '4. 产出真实 artifact（写文件/产物路径），不要编造路径。',
    `5. \`evidence_submit({nodeId, artifactPath, producer_instance:"${input.instanceId}", acceptance:{kind:"exists"}, verifier:"verifier-ci"})\`。`,
    '6. 若节点 stage 的闸门还没过：`pass_gate({stage:<该节点 stage>, evidence_refs:[artifactPath]})`。',
    `7. \`verify_done({nodeId, producer_instance:"${input.instanceId}", auditor_instance:"${auditPartner}"})\` —— **auditor 必须不是你**。`,
    '8. 回到第 1 步，最多 ' + maxIterations + ' 轮。',
    '',
    '## 失败处置（不要瞎重试）',
    '- `LeaseHeld`：说明别人在做 → 换 `task_next` 的**另一个**节点；不要抢。',
    '- `LeaseExpired` / token 不匹配（包括心跳续租失败）：即停手（见"心跳"节），不要继续 evidence/verify；确认需继续时重新 `task_claim` 拿新 token 再重做。',
    '- `invalid-state`（先提交证据）：回到第 5 步补 evidence 再 verify。',
    '- `audit-independence-violated`：换一个 auditor 实例（你不能审自己）。',
    '- `node-not-found` / `stage-invalid`：`graph_status` 重新看 ready，别硬试。',
    '- 连续 2 次同类失败：写一条 `agent_message` 给 `lead` 说明卡点，然后结束（不要空转）。',
    '',
    '## 禁止事项',
    '- 不要替别人领节点、不要改别人的证据、不要给自己做审计。',
    '- 不要直接调 `agent_spawn` / `board_task_*`（那是协调者的活）。',
    '- 不要在没产出 artifact 的情况下提交证据。',
    '',
    '## 同伴与分工',
    `同职务实例：${peers}`,
    `审计搭档：${auditPartner}`,
    '',
    '结束条件：`counts.done === counts.nodes`，或没有你可领的 ready 节点，或触发上面的"连续失败"规则。',
    '结束时用一句话回报：你领了哪些节点、提交了哪些 evidenceId、是否被驳回重试过。',
  ].join('\n');
}

/** 指数退避（带抖动），用于 worker 侧重试；上限 8s。 */
export function backoffMs(attempt: number, baseMs = 500, maxMs = 8000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, Number(attempt) || 0));
  const jitter = Math.floor(exp * 0.2 * Math.random());
  return exp + jitter;
}

export type FailureKind = 'retry-same' | 'retry-other-node' | 'backfill-evidence' | 'swap-auditor' | 'stop';

/**
 * 把工具错误码映射成 worker 的下一步动作。
 *
 * 大小写必须都认：core 抛的是**小写** `lease_expired` / `lease_held` / `fencing`（见
 * `core/leases.ts`、`core/facade.ts:heartbeatTask` 的 `String(code).toLowerCase()`），
 * 而宿主历史上有 PascalCase 写法。只认一种的后果是"租约过期"落到 default → **盲重试**，
 * 拿着失效 token 反复交证据。
 */
export function classifyFailure(errorCode: string | null | undefined): FailureKind {
  switch (String(errorCode ?? '')) {
    case 'LeaseHeld':
    case 'lease-held':
    case 'lease_held':
      return 'retry-other-node';
    case 'LeaseExpired':
    case 'lease-expired':
    case 'lease_expired':
    case 'fenced-out':
    case 'fencing':
    case 'fencing-mismatch':
    case 'lease-not-found':
      return 'retry-same';
    case 'invalid-state':
      return 'backfill-evidence';
    case 'audit-independence-violated':
    case 'auditor-role-required':
    case 'auditor-required':
      return 'swap-auditor';
    case 'node-not-found':
    case 'stage-invalid':
      return 'retry-other-node';
    default:
      return 'retry-same';
  }
}

/**
 * P0-3 `task_heartbeat` 工具契约（供 Lead 在 tools.ts/service.ts 接线时逐字对照实现）：
 *   入参 { nodeId: string, fencingToken: number, ttlSec?: number }
 *     - nodeId：当前租约节点；fencingToken：task_claim 返回的 lease.fencing_token；ttlSec：本次续租时长（秒，缺省沿用租约 TTL / HEARTBEAT_CONTRACT.ttlSec）。
 *   语义：等价 core.renew(store, nodeId, owner, fencingToken, {ttlSec}) —— 校验 owner+fencingToken 且未过期后刷新 expires_at/heartbeat_at 并写 lease_renewed。
 *   白名单：仅 worker 自驱循环可调用，且仅能续**自己当前租约**；禁止替他人续租、禁止用实例身份冒充 token（心跳绑定 fencingToken，不绑定智能体身份）。
 *   频次：调用间隔 <= 租约 TTL/3（buildWorkerPrompt 默认 ttlSec=60 → 每 20s 一次）。
 *   失败即停手：LeaseExpired / fencing 不匹配 / lease_held 一律停止产出与 evidence/verify，回报 lead；重做须重新 task_claim 拿新 token。
 *   接线状态：工具面待 Lead 在 tools.ts/service.ts 注册（本模块 只读不改）；注册前 worker 侧回退为 task_claim 重领。
 */
export const TASK_HEARTBEAT_CONTRACT = {
  toolName: 'task_heartbeat',
  params: {
    nodeId: 'string（必填）当前租约节点',
    fencingToken: 'number（必填）task_claim 返回的 lease.fencing_token',
    ttlSec: 'number（可选）本次续租时长（秒），缺省沿用租约 TTL',
  },
  renewMechanism: 'core.renew(store, nodeId, owner, fencingToken, { ttlSec })',
  whitelist: 'worker 自驱白名单内；仅当前租约 nodeId+fencingToken；禁止代续他人租约',
  intervalRule: 'intervalSec <= ttlSec/3（向下取整、至少 1s）',
  onRenewFailure: '即停手：停止产出/evidence/verify，agent_message 回报 lead；重做须重新 claim',
  identityBinding: '绑定租约 fencingToken，不绑定智能体身份/实例 ID；换载体后旧 token 失效',
  wiringStatus: 'pending-lead-wiring（tools.ts/service.ts 由 Lead 统一接线）',
} as const;

/** 心跳说明：租约 renew 的宿主语义（worker 侧目前靠重领，工具面待主窗口接线）。 */
export const HEARTBEAT_CONTRACT = {
  ttlSec: 60,
  renewMechanism: 'core.renew(store, nodeId, owner, fencingToken)',
  workerFallback: 'task_claim 重领（租约过期后 claim 会发新 token）',
  note: 'worker 侧暂无 renew 工具；生产化需把 heartbeat 暴露成工具（service 接线，不在本模块 写域）',
  /** P0-3 工具契约正文（见 TASK_HEARTBEAT_CONTRACT） */
  taskHeartbeat: TASK_HEARTBEAT_CONTRACT,
} as const;
