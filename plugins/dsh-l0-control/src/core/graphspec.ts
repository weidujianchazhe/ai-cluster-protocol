/**
 * 工作图**组成因子**：GraphSpec / NodeSpec + 校验 + plan/commit。
 *
 * 原则（见 `control_plane/GRAPH-工作图组成因子.md`）：
 *   - 不提供"固定 6 节点 / 固定流水线 / 固定角色架构"；
 *   - 只给可组合因子 + 校验；节点、依赖、阶段由 AI 按需求决定；
 *   - `plan` **零写入**；`commit` 校验通过才落图，同一份图重复 commit 幂等。
 */
import type { Store } from './store.ts';
import type { NodeRecord } from './types.ts';
import { addNode, getNode, listNodes, edges } from './graph.ts';
import { bootstrap, readySet } from './ready.ts';

const STAGES = ['research', 'design', 'build', 'audit', 'deliver'] as const;

export interface NodeSpec {
  nodeId: string;
  title: string;
  spec?: string;
  /** 自由能力标签（不是固定角色枚举）。 */
  capability?: string;
  stage?: (typeof STAGES)[number] | null;
  /** 回填历史节点时可显式指定状态；新规划通常留空（planned）。 */
  status?: 'planned' | 'ready' | 'claimed' | 'running' | 'submitted' | 'verifying' | 'accepted' | 'rejected' | 'blocked' | 'done';
  deps?: string[];
  evidenceRequired?: string[];
  verifierIds?: string[];
  /** 验收条件；与 evidence/verifier 二选一即可。 */
  acceptance?: { kind: string; expected?: unknown } | null;
  budget?: { maxTokens?: number; maxParallel?: number };
  writeScopes?: string[];
  contextRefs?: string[];
  risk?: string;
}

export interface GraphSpec {
  version?: number;
  wish?: string;
  nodes?: NodeSpec[];
  policies?: { maxParallel?: number; maxDepth?: number; budgetTokens?: number };
  notes?: string[];
}

export interface SpecIssue {
  code: string;
  nodeId?: string;
  message: string;
}

export interface GraphPlan {
  ok: boolean;
  planId: string;
  errors: SpecIssue[];
  warnings: string[];
  ready: string[];
  order: string[];
  counts: { nodes: number; edges: number };
  spec: { wish: string; nodes: Array<{ nodeId: string; deps: string[]; stage: string | null }> };
}

function issue(code: string, message: string, nodeId?: string): SpecIssue {
  return nodeId ? { code, nodeId, message } : { code, message };
}

/** 纯校验：不碰 store、不写 journal。 */
export function planGraph(specInput: GraphSpec): GraphPlan {
  const spec = specInput ?? {};
  const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
  const errors: SpecIssue[] = [];
  const warnings: string[] = [];

  if (!nodes.length) {
    errors.push(issue('spec-empty', 'GraphSpec 至少要有一个节点（没有固定模板兜底）'));
  }
  if (!String(spec.wish ?? '').trim()) {
    warnings.push('wish 为空：建议写明原始需求，便于以后追溯');
  }

  const ids = new Set<string>();
  const byId = new Map<string, NodeSpec>();
  for (const raw of nodes) {
    const nodeId = String(raw?.nodeId ?? '').trim();
    if (!nodeId) {
      errors.push(issue('node-id-required', '节点缺少 nodeId'));
      continue;
    }
    if (ids.has(nodeId)) {
      errors.push(issue('duplicate-node-id', `重复的 nodeId：${nodeId}`, nodeId));
      continue;
    }
    ids.add(nodeId);
    byId.set(nodeId, raw);
  }

  for (const raw of nodes) {
    const nodeId = String(raw?.nodeId ?? '').trim();
    if (!nodeId || !byId.has(nodeId)) continue;
    if (!String(raw?.title ?? '').trim()) {
      errors.push(issue('node-title-required', '节点缺少 title', nodeId));
    }
    const stage = raw?.stage ?? null;
    if (stage !== null && stage !== undefined && !STAGES.includes(stage as (typeof STAGES)[number])) {
      errors.push(issue('stage-invalid', `stage 非法：${String(stage)}（允许 ${STAGES.join('/')}）`, nodeId));
    }
    const deps = Array.isArray(raw?.deps) ? raw.deps.map((dep) => String(dep)) : [];
    for (const dep of deps) {
      if (dep === nodeId) {
        errors.push(issue('dep-self', `依赖自己：${nodeId}`, nodeId));
        continue;
      }
      if (!ids.has(dep)) {
        errors.push(issue('dep-unknown', `依赖不存在：${dep}`, nodeId));
      }
    }
    const hasAcceptance = Boolean(raw?.acceptance && typeof raw.acceptance === 'object' && raw.acceptance.kind);
    const hasEvidence = Array.isArray(raw?.evidenceRequired) && raw.evidenceRequired.length > 0;
    const hasVerifier = Array.isArray(raw?.verifierIds) && raw.verifierIds.length > 0;
    if (!hasAcceptance && !(hasEvidence && hasVerifier)) {
      errors.push(issue('node-acceptance-required', '节点必须有 acceptance，或同时给 evidenceRequired + verifierIds', nodeId));
    }
    const budget = raw?.budget ?? {};
    if (budget.maxTokens !== undefined && (!Number.isInteger(Number(budget.maxTokens)) || Number(budget.maxTokens) < 0)) {
      errors.push(issue('budget-invalid', `budget.maxTokens 必须是非负整数：${String(budget.maxTokens)}`, nodeId));
    }
    if (budget.maxParallel !== undefined && (!Number.isInteger(Number(budget.maxParallel)) || Number(budget.maxParallel) < 1)) {
      errors.push(issue('budget-invalid', `budget.maxParallel 必须是 ≥1 的整数：${String(budget.maxParallel)}`, nodeId));
    }
    if (!hasAcceptance) {
      warnings.push(`${nodeId}：只有 evidence+verifier，没有显式 acceptance（可用但不够精确）`);
    }
  }

  // 环检测（DFS；只看 spec 内部依赖）
  const marks = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (nodeId: string): boolean => {
    const mark = marks.get(nodeId) ?? 0;
    if (mark === 1) {
      errors.push(issue('cycle', `检测到环：${[...stack, nodeId].join(' → ')}`, nodeId));
      return true;
    }
    if (mark === 2) return false;
    marks.set(nodeId, 1);
    stack.push(nodeId);
    let cyclic = false;
    for (const dep of (byId.get(nodeId)?.deps ?? []).map((item) => String(item))) {
      if (!byId.has(dep)) continue;
      if (visit(dep)) cyclic = true;
    }
    stack.pop();
    marks.set(nodeId, 2);
    return cyclic;
  };
  for (const nodeId of ids) visit(nodeId);

  // 拓扑序（Kahn）：commit 时按依赖顺序 addNode
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const nodeId of ids) {
    indegree.set(nodeId, 0);
    children.set(nodeId, []);
  }
  for (const [nodeId, raw] of byId) {
    for (const dep of (raw?.deps ?? []).map((item) => String(item))) {
      if (!byId.has(dep)) continue;
      indegree.set(nodeId, (indegree.get(nodeId) ?? 0) + 1);
      children.get(dep)!.push(nodeId);
    }
  }
  const queue = [...ids].filter((nodeId) => (indegree.get(nodeId) ?? 0) === 0).sort();
  const order: string[] = [];
  while (queue.length) {
    const nodeId = queue.shift()!;
    order.push(nodeId);
    for (const child of (children.get(nodeId) ?? []).sort()) {
      const next = (indegree.get(child) ?? 1) - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }
  if (order.length !== ids.size && !errors.some((row) => row.code === 'cycle')) {
    errors.push(issue('topo-incomplete', '依赖关系无法构成拓扑序（可能存在环）'));
  }

  const ready = [...ids].filter((nodeId) => (byId.get(nodeId)?.deps ?? []).length === 0).sort();
  const edgeCount = [...byId.values()].reduce(
    (sum, raw) => sum + (raw?.deps ?? []).filter((dep) => byId.has(String(dep))).length,
    0,
  );

  const digest = `${String(spec.wish ?? '')}::${order.join(',')}`;
  let hash = 0;
  for (let index = 0; index < digest.length; index += 1) hash = (hash * 31 + digest.charCodeAt(index)) % 1000000007;

  return {
    ok: errors.length === 0,
    planId: `PLAN-${Math.abs(hash)}`,
    errors,
    warnings,
    ready: errors.length ? [] : ready,
    order,
    counts: { nodes: ids.size, edges: edgeCount },
    spec: {
      wish: String(spec.wish ?? ''),
      nodes: order.map((nodeId) => ({
        nodeId,
        deps: (byId.get(nodeId)?.deps ?? []).map((dep) => String(dep)),
        stage: (byId.get(nodeId)?.stage ?? null) as string | null,
      })),
    },
  };
}

export interface GraphCommitResult extends GraphPlan {
  committed: boolean;
  idempotent: boolean;
  graph?: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
}

/** 校验通过后落图（store 由调用方给出，保持 core 单一事实源）。 */
export function commitGraph(store: Store, specInput: GraphSpec): GraphCommitResult {
  const plan = planGraph(specInput);
  if (!plan.ok) {
    return { ...plan, ok: false, committed: false, idempotent: false };
  }
  const spec = specInput ?? {};
  const nodes = (Array.isArray(spec.nodes) ? spec.nodes : []).slice();

  const existingIds = nodes.map((raw) => String(raw?.nodeId ?? '')).filter((nodeId) => nodeId);
  const already = existingIds.filter((nodeId) => Boolean(getNode(store, nodeId)));
  if (already.length === existingIds.length && already.length > 0) {
    const current = listNodes(store);
    return {
      ...plan,
      ok: true,
      committed: false,
      idempotent: true,
      ready: readySet(store),
      counts: { nodes: current.length, edges: edges(store).length },
    };
  }
  if (already.length > 0) {
    return {
      ...plan,
      ok: false,
      committed: false,
      idempotent: false,
      errors: [...plan.errors, issue('partial-existing', `部分节点已存在（${already.join(',')}），拒绝半途落图`)],
    };
  }

  const maxParallel = Number(spec.policies?.maxParallel ?? 2);
  const budgetTokens = Number(spec.policies?.budgetTokens ?? 0);
  const wishId = `WISH-${store.nowMs()}`;
  const byId = new Map(nodes.map((raw) => [String(raw.nodeId), raw] as const));

  store.atomically(() => {
    store.state.meta.set('wish_id', wishId);
    store.state.meta.set('wish_text', String(spec.wish ?? ''));
    store.state.meta.set('wish_max_parallel', String(maxParallel));
    store.state.meta.set('wish_budget_tokens', String(budgetTokens));
    if (String(spec.wish ?? '').trim()) {
      store.journal.append('wish_submitted', null, { wish_id: wishId, text: String(spec.wish), maxParallel, budgetTokens });
    }
    for (const nodeId of plan.order) {
      const raw = byId.get(nodeId)!;
      addNode(store, {
        nodeId,
        title: String(raw.title),
        spec: String(raw.spec ?? raw.title ?? ''),
        capability: raw.capability ?? null,
        stage: (raw.stage ?? null) as NodeRecord['stage'],
        status: (raw.status ?? 'planned') as NodeRecord['status'],
        deps: (raw.deps ?? []).map((dep) => String(dep)),
        evidenceRequired: (raw.evidenceRequired ?? ['artifact']).map((item) => String(item)),
        verifierIds: (raw.verifierIds ?? ['verifier-ci']).map((item) => String(item)),
        budget: {
          maxTokens: Number(raw.budget?.maxTokens ?? budgetTokens) || 0,
          maxParallel: Number(raw.budget?.maxParallel ?? maxParallel) || 2,
        },
      });
    }
    store.journal.append('graph_created', null, { wish_id: wishId, nodes: plan.order, plan_id: plan.planId });
  });

  const promoted = bootstrap(store);
  const current = listNodes(store);
  return {
    ...plan,
    ok: true,
    committed: true,
    idempotent: false,
    ready: promoted.length ? promoted : readySet(store),
    counts: { nodes: current.length, edges: edges(store).length },
    graph: {
      nodes: current.map((node) => ({
        node_id: node.node_id,
        title: node.title,
        status: node.status,
        stage: node.stage,
        deps: node.deps,
      })),
      edges: edges(store).map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind })),
    },
  };
}

/** 给 AI 的模板（只有因子，没有固定架构）。 */
export function graphSpecTemplate(wish = ''): GraphSpec {
  return {
    version: 1,
    wish,
    nodes: [
      {
        nodeId: 'NODE-EXAMPLE',
        title: '节点标题（自己起，按需增删）',
        spec: '要做什么、边界、约束',
        capability: '自由能力标签',
        stage: 'build',
        deps: [],
        evidenceRequired: ['artifact'],
        verifierIds: ['verifier-ci'],
        acceptance: { kind: 'exists' },
        budget: { maxTokens: 0, maxParallel: 2 },
      },
    ],
    policies: { maxParallel: 2, maxDepth: 3, budgetTokens: 0 },
    notes: ['节点数量由工作决定，不由团队规模决定；强依赖必须显式 deps'],
  };
}
