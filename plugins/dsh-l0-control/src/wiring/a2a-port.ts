/**
 * A2A 接线（M4）：`A2ATaskPort` → core 图（create/get/cancel）。
 *
 * 映射策略（最小可用，不伪造）：
 *   - createTask：`core.submitWish` **只记录愿望**；图必须由调用方在 `metadata.graph` 给 GraphSpec，
 *     端口再 `core.graphCommit` 落图并返回第一个 ready 节点行（缺 spec → `graph-plan-required`）；
 *   - getTask：`core.getNode` 只读，缺失返回 null；
 *   - cancelTask：`isCancelable` 判定后 `core.rejectNode`，落 `blocked` + `canceled:<reason>`。
 *
 * 只做适配，不写 core/state；鉴权在 `src/a2a` 的 token 层。
 */

import type { A2ATaskPort } from '../a2a/port.ts';

const CANCEL_PREFIX = 'canceled:';

function listNodesOf(core) {
  const status = core.graphStatus?.();
  const graph = status?.graph ?? status ?? {};
  if (Array.isArray(graph.nodes)) return graph.nodes;
  try {
    const rows = core.listNodes?.();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function toRow(node) {
  const nodeId = node.node_id ?? node.nodeId;
  const blockedReason = node.blocked_reason ?? node.blockedReason ?? null;
  return {
    nodeId: String(nodeId),
    status: String(node.status ?? 'planned'),
    assignee: node.assignee ?? null,
    blockedReason,
    artifacts: Array.isArray(node.artifacts) ? node.artifacts : [],
    updatedAt: node.updated_at ?? node.updatedAt ?? undefined,
  };
}

export interface A2ATaskPortDeps {
  /** 取 core（返回 `src/core` 的门面模块；此处按需读 submitWish/getNode/rejectNode）。 */
  getCore: () => any;
  /** 审计事件出口（缺省丢弃）：签名必须允许 (kind, payload)，否则线上调用方传不进来。 */
  emit?: (kind: string, payload: Record<string, unknown>) => unknown;
}

/**
 * 端口实现 → `A2ATaskPort`。
 *
 * 形状差异（只在失败分支上，且**不改运行时**）：
 *   - createTask 失败时返回 `{ kind:'invalid', code }`（A2ACreateTaskResult 已按此放宽）；
 *   - cancelTask 失败时返回 `{ kind:'invalid', code, message }`，而 `A2ACancelOutcome`
 *     只有 canceled / not-cancelable / not-found 三支（router 也只在这三支上分派）。
 * 这里用一次显式断言把差异标出来，而不是把类型改成 `any` 或偷偷改 router。
 * 若将来 router 增加 invalid 分支，应把该变体补进 `A2ACancelOutcome` 并删掉断言。
 */
export function createA2ATaskPort({ getCore, emit = () => {} }: A2ATaskPortDeps): A2ATaskPort {
  const port = {
    async createTask(input) {
      const core = await getCore();
      const message = String(input?.message ?? '').trim();
      if (!message) return { kind: 'invalid', code: 'message-required' };
      const result = core.submitWish({ text: message, maxParallel: input?.metadata?.maxParallel, budgetTokens: 0 });
      if (result?.ok === false) return { kind: 'invalid', code: result.error ?? 'wish-failed' };
      // 组成因子：愿望只记意图，**不再自动建图**。A2A 调用方要么自己带 GraphSpec
      // （metadata.graph / metadata.spec），要么由协调者组图后另发；端口绝不替 AI 决定图结构。
      const spec = (input?.metadata as Record<string, unknown> | undefined)?.graph
        ?? (input?.metadata as Record<string, unknown> | undefined)?.spec
        ?? null;
      if (!spec || typeof spec !== 'object') {
        return {
          kind: 'invalid',
          code: 'graph-plan-required',
          message: '愿望已记录但未建图：请在 metadata.graph 传 GraphSpec（或由协调者 graph_plan→graph_commit 组图）',
        };
      }
      const committed = core.graphCommit?.({ ...(spec as Record<string, unknown>), wish: (spec as any)?.wish ?? message });
      if (committed?.ok === false) {
        return { kind: 'invalid', code: 'graph-commit-rejected', message: JSON.stringify(committed?.errors ?? null) };
      }
      const nodes = listNodesOf(core);
      const ready = nodes.find((node) => node.status === 'ready') ?? nodes[0];
      if (!ready) return { kind: 'invalid', code: 'no-node' };
      const row = toRow(ready);
      emit('a2a_task_created', {
        taskId: row.nodeId,
        wishId: result?.wishId ?? null,
        committed: committed?.ok === true,
        actor: input?.actor ?? null,
      });
      return { taskId: row.nodeId, row };
    },

    async getTask(taskId) {
      const core = await getCore();
      const id = String(taskId ?? '');
      let node = null;
      try {
        node = core.getNode?.(id) ?? null;
      } catch {
        node = null;
      }
      if (!node) node = listNodesOf(core).find((row) => String(row.node_id ?? row.nodeId) === id) ?? null;
      return node ? toRow(node) : null;
    },

    async cancelTask(taskId, reason, actor) {
      const core = await getCore();
      const id = String(taskId ?? '');
      let node = null;
      try {
        node = core.getNode?.(id) ?? null;
      } catch {
        node = null;
      }
      if (!node) node = listNodesOf(core).find((row) => String(row.node_id ?? row.nodeId) === id) ?? null;
      if (!node) return { kind: 'not-found', nodeId: id };
      const row = toRow(node);
      const cancelable = ['planned', 'ready', 'claimed', 'running', 'submitted', 'verifying'].includes(row.status);
      if (!cancelable) return { kind: 'not-cancelable', nodeId: id, status: row.status };
      const text = `${CANCEL_PREFIX}${reason ?? 'a2a-cancel'}`;
      try {
        core.rejectNode({ nodeId: id, reason: text, actor: actor ?? 'a2a' });
      } catch (error) {
        return { kind: 'invalid', code: 'cancel-failed', message: String(error?.message ?? error) };
      }
      emit('a2a_task_canceled', { taskId: id, reason: reason ?? null, actor: actor ?? null });
      return { kind: 'canceled', row: { ...row, status: 'blocked', blockedReason: text } };
    },
  };
  return port as unknown as A2ATaskPort;
}
