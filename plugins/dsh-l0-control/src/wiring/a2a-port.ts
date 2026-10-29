/**
 * A2A 接线（M4）：`A2ATaskPort` → core 图（create/get/cancel）。
 *
 * 映射策略（最小可用，不伪造）：
 *   - createTask：`core.submitWish` 建图后返回**第一个 ready 节点**行；
 *   - getTask：`core.getNode` 只读，缺失返回 null；
 *   - cancelTask：`isCancelable` 判定后 `core.rejectNode`，落 `blocked` + `canceled:<reason>`。
 *
 * 只做适配，不写 core/state；鉴权在 `src/a2a` 的 token 层。
 */

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

export function createA2ATaskPort({ getCore, emit = () => {} }) {
  return {
    async createTask(input) {
      const core = await getCore();
      const message = String(input?.message ?? '').trim();
      if (!message) return { kind: 'invalid', code: 'message-required' };
      const result = core.submitWish({ text: message, maxParallel: input?.metadata?.maxParallel, budgetTokens: 0 });
      if (result?.ok === false) return { kind: 'invalid', code: result.error ?? 'wish-failed' };
      const nodes = listNodesOf(core);
      const ready = nodes.find((node) => node.status === 'ready') ?? nodes[0];
      if (!ready) return { kind: 'invalid', code: 'no-node' };
      const row = toRow(ready);
      emit('a2a_task_created', { taskId: row.nodeId, wishId: result?.wishId ?? null, actor: input?.actor ?? null });
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
}
