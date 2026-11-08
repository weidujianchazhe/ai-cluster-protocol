/**
 * 图节点 ↔ A2A 任务状态映射（纯函数，无状态）。
 *
 * 事实来源：`src/core/status.ts` 的 8 个 NodeStatus
 * （planned / ready / claimed / running / submitted / verifying / done / blocked）。
 *
 * 映射原则：
 *  1. **只降级不升级**：无法识别的原生状态 → `unknown`，绝不猜成 `completed`；
 *  2. **cancel 借道 blocked**：图里没有 canceled 状态，cancel 落 `blocked` +
 *     `canceled:<reason>`，对外渲染 `canceled`（保持图状态机白名单不变）；
 *  3. A2A 视图是**只读派生**，`metadata.nativeStatus` 保留原值供诊断。
 */
                                                                                 

/** A2A → 图状态的意图提示（仅用于诊断/建议，不在传输层直接改图）。 */
export const CANCEL_REASON_PREFIX = 'canceled:';

const NODE_TO_A2A                                         = {
  planned: 'submitted',
  ready: 'submitted',
  claimed: 'working',
  running: 'working',
  submitted: 'working',
  verifying: 'working',
  blocked: 'input-required',
  done: 'completed',
};

/** 可 cancel 的原生状态（与 `TRANSITIONS` 的 *→blocked 边一致）。 */
const CANCELABLE                      = new Set(['ready', 'claimed', 'running', 'blocked']);

/** 判定图状态是否可 cancel（verifying/done 不可——证据门禁/终态）。 */
export function isCancelable(nativeStatus        )          {
  return CANCELABLE.has(nativeStatus);
}

/** cancel 是否已生效（借道 blocked + `canceled:` 前缀）。 */
export function isCanceledRow(row            )          {
  return row.status === 'blocked' && typeof row.blockedReason === 'string'
    && row.blockedReason.startsWith(CANCEL_REASON_PREFIX);
}

/**
 * 原生状态 → A2A 状态。
 * 优先看 `canceled:` 标记，再查映射表，最后兜 `unknown`。
 */
export function toA2ATaskState(nativeStatus        , blockedReason                )               {
  if (nativeStatus === 'blocked' && typeof blockedReason === 'string'
    && blockedReason.startsWith(CANCEL_REASON_PREFIX)) {
    return 'canceled';
  }
  const mapped = NODE_TO_A2A[nativeStatus];
  if (!mapped) return 'unknown';
  if (nativeStatus === 'done') return 'completed';
  return mapped;
}

/** A2A 状态 → 期望的原生状态集合（反向查询用，供主窗口 wire 时校验）。 */
export function nativeStatusesFor(state              )           {
  const out           = [];
  for (const [native, a2a] of Object.entries(NODE_TO_A2A)) {
    if (a2a === state) out.push(native);
  }
  if (state === 'canceled' || state === 'unknown') return out;
  return out;
}

function toArtifacts(row            )                            {
  const list = row.artifacts ?? [];
  if (list.length === 0) return undefined;
  return list.map((art, index) => ({
    artifactId: `${row.nodeId}#${index}`,
    name: art.path,
    parts: [{ kind: 'text'         , text: art.text ?? art.path }],
  }));
}

/** 扁平节点行 → A2A 任务视图。 */
export function toA2ATask(row            , options                                           = {})          {
  const now = options.now ?? Date.now;
  const timestamp = row.updatedAt ?? new Date(now()).toISOString();
  const state = toA2ATaskState(row.status, row.blockedReason);
  const task          = {
    id: row.nodeId,
    status: { state, timestamp },
    metadata: {
      nodeId: row.nodeId,
      teamTaskId: row.teamTaskId ?? null,
      revision: Number(row.revision ?? 0),
      assignee: row.assignee ?? null,
      nativeStatus: row.status,
    },
  };
  if (row.contextId) task.contextId = row.contextId;
  if (options.message) task.status.message = options.message;
  const artifacts = toArtifacts(row);
  if (artifacts) task.artifacts = artifacts;
  return task;
}


//# sourceURL=a2a\mapping.js