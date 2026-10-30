/**
 * Worker 自驱层：把「角色 prompt + 工具白名单 + 循环契约」交给真实子 Agent 自己跑。
 *
 * 设计边界（Lane A / 生产化）：
 *   - 插件**不代发、不代提交**：worker 自己 `task_next → task_claim → evidence_submit → pass_gate → verify_done`；
 *   - 插件只提供工具面与门禁（证据/闸门/审计独立都在 core 侧执行）；
 *   - 本模块只产出 prompt 文本与判定辅助（退避、失败分类、心跳租约），不做任何写操作。
 */

                                                                                                                                     

                              
                   
                                    
                   
                                           
                  
                 
                  
                
                  
 

const BASE_TOOLS = ['graph_status', 'task_next', 'task_claim', 'evidence_submit', 'pass_gate', 'verify_done', 'team_status', 'memory_load', 'memory_writeback'];

export const ROLE_PROFILES                              = {
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
  OPS: {
    role: 'OPS',
    stages: ['deliver'],
    tools: [...BASE_TOOLS],
    mission: '交付打包：领取 deliver 节点出交付清单。',
    rules: ['不得自审'],
  },
};

export function profileFor(role        )              {
  return ROLE_PROFILES[String(role).toUpperCase()] ?? ROLE_PROFILES.CODE;
}

                                    
               
                     
                             
                     
                         
                         
                            
                   
                                             
                        
                                               
                      
                                       
                         
 

/**
 * 生成 worker 的 prompt：**能力包 + 任务上下文** 为主体，`role` 只表示实例身份与工具白名单，
 * 不再当作"固定专家分工"。能力包没给时才回退到 role profile 的 mission（兜底）。
 */
export function buildWorkerPrompt(input                   )         {
  const profile = profileFor(input.role);
  const maxIterations = Number(input.maxIterations ?? 8);
  const peers = (input.peers ?? []).join(' / ') || '（无）';
  const auditPartner = input.auditPartner ?? '（未指定：审计节点请找一个非自己生产者的审计实例）';
  const capability = String(input.capability ?? '').trim() || `（未指定能力包，按实例身份兜底：${profile.mission}）`;
  const contextPack = (input.contextPack ?? []).map((line) => String(line).trim()).filter(Boolean);
  const stageList = input.stageHint
    ? String(input.stageHint)
    : profile.stages.join(', ');

  return [
    `你是自主 worker，实例 ID = \`${input.instanceId}\`（身份即工具参数里的 instanceId / producer_instance）。`,
    `实例身份 role = \`${profile.role}\`：**只用于实例寻址、工具白名单与审计独立性判断**，不代表固定专家分工。`,
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
    '- 读完把结论、证据、未完成项、下一步写回任务卡或报告；不要复述或重读全文。',
    '',
    '## 允许的工具（白名单，只准用这些）',
    profile.tools.map((tool) => `- ${tool}`).join('\n'),
    '',
    '## 你的循环（每轮严格按顺序，做一步看一步结果）',
    '1. `graph_status` —— 看 `counts` / `ready` / `persistence`；若 `counts.done === counts.nodes` 立即结束并回报。',
    `2. \`task_next({role:"${profile.role}"})\` —— 取 ready 集；只挑 stage ∈ {${stageList}} 的节点。没有就结束。`,
    `3. \`task_claim({nodeId, role:"${profile.role}", instanceId:"${input.instanceId}"})\` —— 用**你自己的实例 ID** 领；拿回 lease.fencing_token。`,
    '4. 产出真实 artifact（写文件/产物路径），不要编造路径。',
    `5. \`evidence_submit({nodeId, artifactPath, producer_instance:"${input.instanceId}", acceptance:{kind:"exists"}, verifier:"verifier-ci"})\`。`,
    '6. 若节点 stage 的闸门还没过：`pass_gate({stage:<该节点 stage>, evidence_refs:[artifactPath]})`。',
    `7. \`verify_done({nodeId, producer_instance:"${input.instanceId}", auditor_instance:"${auditPartner}"})\` —— **auditor 必须不是你**。`,
    '8. 回到第 1 步，最多 ' + maxIterations + ' 轮。',
    '',
    '## 失败处置（不要瞎重试）',
    '- `LeaseHeld`：说明别人在做 → 换 `task_next` 的**另一个**节点；不要抢。',
    '- `LeaseExpired` / token 不匹配：重新 `task_claim` 拿新 token 再继续。',
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
export function backoffMs(attempt        , baseMs = 500, maxMs = 8000)         {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, Number(attempt) || 0));
  const jitter = Math.floor(exp * 0.2 * Math.random());
  return exp + jitter;
}

                                                                                                            

/** 把工具错误码映射成 worker 的下一步动作。 */
export function classifyFailure(errorCode                           )              {
  switch (String(errorCode ?? '')) {
    case 'LeaseHeld':
    case 'lease-held':
      return 'retry-other-node';
    case 'LeaseExpired':
    case 'lease-expired':
    case 'fenced-out':
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

/** 心跳说明：租约 renew 的宿主语义（worker 侧目前靠重领，工具面待主窗口接线）。 */
export const HEARTBEAT_CONTRACT = {
  ttlSec: 60,
  renewMechanism: 'core.renew(store, nodeId, owner, fencingToken)',
  workerFallback: 'task_claim 重领（租约过期后 claim 会发新 token）',
  note: 'worker 侧暂无 renew 工具；生产化需把 heartbeat 暴露成工具（service 接线，不在本 lane 写域）',
}         ;


//# sourceURL=native\worker.js