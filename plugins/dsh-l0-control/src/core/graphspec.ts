/**
 * 工作图**组成因子**：GraphSpec / NodeSpec + 校验 + plan/commit。
 *
 * 原则（见 工作图组成因子原则）：
 *   - 不提供"固定 6 节点 / 固定流水线 / 固定角色架构"；
 *   - 只给可组合因子 + 校验；节点、依赖、阶段由 AI 按需求决定；
 *   - `plan` **零写入**；`commit` 校验通过才落图，同一份图重复 commit 幂等。
 */
import type { Store } from './store.ts';
import type { NodeRecord } from './types.ts';
import { addNode, getNode, listNodes, edges } from './graph.ts';
import { bootstrap, readySet } from './ready.ts';
import { deriveFacts, selectCapabilities, type SelectionResult } from './catalog.ts';

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

export interface DesignBoundary {
  /** 需求允许的最大节点数；超过即视为过度设计。 */
  maxNodes?: number;
  maxParallel?: number;
  maxDepth?: number;
  budgetTokens?: number;
  complexity?: 'small' | 'medium' | 'large';
  /** 为什么这个规模足够；产品/需求侧裁决记录。 */
  rationale?: string;
}

export interface CoordinationGroup {
  id: string;
  nodes: string[];
  note?: string;
}

export interface IntegrationContract {
  id: string;
  /** 参与同一契约的两个或更多工作节点。 */
  nodeRefs: string[];
  /** 承担集成/一致性验收的普通图节点。 */
  integrationNode: string;
  /** 各参与节点必须共同满足的接口、格式或假设。 */
  contract: string;
  /** 集成节点用于裁决契约一致性的验收条件。 */
  acceptance: string[];
}

/** 由任务需求选择性生成的组织因子；不预设固定角色树或常驻经理。 */
export interface OrganizationSpec {
  integrationContracts?: IntegrationContract[];
}

export interface CoordinationPartition {
  id: string;
  parentId?: string | null;
  nodeRefs: string[];
  writeScopes?: string[];
  maxActive?: number;
  budgetTokens?: number;
  strategy?: string;
}

export interface DelegationPolicy {
  enabled?: boolean;
  maxFanout?: number;
  maxDepth?: number;
  requireIdempotencyKey?: boolean;
}

export interface AggregationPolicy {
  completion?: 'all' | 'any' | 'quorum';
  quorum?: number;
  summarySchema?: string;
}

export interface CoordinationSpec {
  enabled?: boolean;
  strategy?: string;
  maxActive?: number;
  maxDepth?: number;
  groups?: CoordinationGroup[];
  partitions?: CoordinationPartition[];
  /** 按需启用的组织协调规则，不预设固定管理层级。 */
  organization?: OrganizationSpec;
  delegation?: DelegationPolicy;
  aggregation?: Record<string, AggregationPolicy>;
  maxQueuedTasks?: number;
  ratePerSecond?: number;
}

export interface GraphSpec {
  version?: number;
  wish?: string;
  nodes?: NodeSpec[];
  policies?: { maxParallel?: number; maxDepth?: number; budgetTokens?: number };
  /** 产品/需求侧设计边界：约束规模、并行、深度、预算，防止过度设计。 */
  designBoundary?: DesignBoundary;
  /** 大规模并行时的分层协调：分组、并发上限、协调策略。 */
  coordination?: CoordinationSpec;
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
  /**
   * P1-6：预览的「会就绪」列表（仅按 deps 推算，节点未落图）。
   * `ready` 保留作别名兼容（旧调用方读 ready 不断）；`basis`/`readyBasis`
   * 标明该列表仅基于依赖、未经过真实 ready 门控（租约/闸门/巡检）。
   */
  wouldBeReady: string[];
  ready: string[];
  basis: "deps-only";
  readyBasis: "deps-only";
  order: string[];
  counts: { nodes: number; edges: number };
  designBoundary?: DesignBoundary;
  coordination?: CoordinationSpec;
  /** 按需能力建议（selected/skipped/cost）：只建议不改图，采纳与否看 graph_commit。 */
  capabilities: SelectionResult;
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

  if (spec.policies?.maxParallel !== undefined &&
      (!Number.isSafeInteger(Number(spec.policies.maxParallel)) || Number(spec.policies.maxParallel) < 1)) {
    errors.push(issue('policy-max-parallel-invalid', 'policies.maxParallel 必须是正整数'));
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

  // 设计边界：产品/需求侧约束，优先于“多拆几个节点看起来更完整”。
  const boundary = spec.designBoundary;
  if (boundary) {
    const maxNodes = Number(boundary.maxNodes);
    if (boundary.maxNodes !== undefined && (!Number.isInteger(maxNodes) || maxNodes < 1)) {
      errors.push(issue('design-boundary-invalid', 'designBoundary.maxNodes 必须是 ≥1 的整数'));
    } else if (boundary.maxNodes !== undefined && ids.size > maxNodes) {
      errors.push(issue('design-boundary-max-nodes', `节点数 ${ids.size} 超过设计边界 maxNodes=${maxNodes}；先削减范围或拆成有依赖的子图`));
    }
    if (boundary.maxParallel !== undefined && Number(boundary.maxParallel) < 1) {
      errors.push(issue('design-boundary-invalid', 'designBoundary.maxParallel 必须是 ≥1 的整数'));
    }
    if (boundary.budgetTokens !== undefined && Number(boundary.budgetTokens) < 0) {
      errors.push(issue('design-boundary-invalid', 'designBoundary.budgetTokens 必须是非负数'));
    }
    if (!String(boundary.rationale ?? '').trim()) {
      warnings.push('designBoundary 没有 rationale：建议写明“为什么这个规模足够”，否则边界只是数字');
    }
    if (spec.policies?.maxParallel !== undefined && boundary.maxParallel !== undefined && Number(spec.policies.maxParallel) > Number(boundary.maxParallel)) {
      warnings.push(`policies.maxParallel=${spec.policies.maxParallel} 超过设计边界 maxParallel=${boundary.maxParallel}`);
    }
    if (boundary.complexity === 'small' && ids.size > 8) {
      warnings.push(`complexity=small 但节点数 ${ids.size}：疑似过度设计，先确认是否真的需要这么多工作单元`);
    }
  } else if (ids.size >= 12) {
    warnings.push('未提供 designBoundary：大规模工作图建议先写清 maxNodes/maxParallel/复杂度/理由，防止过度设计');
  }

  // 分区与协调关系独立于执行依赖 DAG；parentId 只描述管理归属，不生成阻塞边。
  const coordination = spec.coordination;
  const organization = coordination?.organization;
  if (coordination && !coordination.enabled && (coordination.partitions?.length || coordination.delegation?.enabled || organization?.integrationContracts?.length)) warnings.push('coordination 因子已提供但 enabled=false；分区校验与组织协调策略未启用');
  if (coordination?.enabled) {
    if (coordination.delegation?.enabled && !coordination.partitions?.length) warnings.push('动态委派已启用但当前无静态分区；运行时需提交 parentNodeId、revision 与幂等键，并受配置背压限制');
    const partitions = Array.isArray(coordination.partitions) ? coordination.partitions : [];
    const partitionById = new Map<string, CoordinationPartition>();
    const partitionOwner = new Map<string, string>();
    for (const partition of partitions) {
      const id = String(partition?.id ?? '').trim();
      if (!id) { errors.push(issue('partition-id-required', 'coordination.partitions[].id 必填')); continue; }
      if (partitionById.has(id)) errors.push(issue('partition-id-duplicate', `重复分区 id：${id}`));
      partitionById.set(id, partition);
      if (partition.maxActive !== undefined && (!Number.isInteger(Number(partition.maxActive)) || Number(partition.maxActive) < 1))
        errors.push(issue('partition-max-active-invalid', `分区 ${id} 的 maxActive 必须为正整数`));
      if (partition.budgetTokens !== undefined && (!Number.isInteger(Number(partition.budgetTokens)) || Number(partition.budgetTokens) < 0))
        errors.push(issue('partition-budget-invalid', `分区 ${id} 的 budgetTokens 必须为非负整数`));
      for (const nodeId of partition.nodeRefs ?? []) {
        if (!ids.has(nodeId)) errors.push(issue('partition-unknown-node', `分区 ${id} 引用了未知节点 ${nodeId}`));
        const owner = partitionOwner.get(nodeId);
        if (owner && owner !== id) errors.push(issue('partition-node-overlap', `节点 ${nodeId} 同时属于分区 ${owner} 与 ${id}`));
        partitionOwner.set(nodeId, id);
      }
    }
    for (const partition of partitions) {
      const parentId = String(partition.parentId ?? '').trim();
      if (parentId && !partitionById.has(parentId)) errors.push(issue('partition-parent-unknown', `分区 ${partition.id} 的父分区不存在：${parentId}`));
      // nodeRefs 表示直接归属；父域的间接成员由层级关系推导。
    }
    const seen = new Set<string>();
    const active = new Set<string>();
    const visit = (id: string) => {
      if (active.has(id)) { errors.push(issue('partition-cycle', `协调域树存在环：${id}`)); return; }
      if (seen.has(id)) return;
      seen.add(id); active.add(id);
      const parent = String(partitionById.get(id)?.parentId ?? '').trim();
      if (parent && partitionById.has(parent)) visit(parent);
      active.delete(id);
    };
    for (const id of partitionById.keys()) visit(id);
    const organization = coordination.organization;
    if (organization) {
      const contractIds = new Set<string>();
      for (const contract of Array.isArray(organization.integrationContracts) ? organization.integrationContracts : []) {
        const contractId = String(contract?.id ?? '').trim();
        if (!contractId) {
          errors.push(issue('integration-contract-id-required', 'coordination.organization.integrationContracts[].id 必填'));
          continue;
        }
        if (contractIds.has(contractId)) errors.push(issue('integration-contract-id-duplicate', `重复的集成契约 id：${contractId}`));
        contractIds.add(contractId);
        const refs = Array.isArray(contract.nodeRefs) ? [...new Set(contract.nodeRefs.map((id) => String(id).trim()).filter(Boolean))] : [];
        if (refs.length < 2) errors.push(issue('integration-contract-scope-invalid', `集成契约 ${contractId} 至少要关联两个不同成员节点`));
        for (const nodeId of refs) {
          if (!ids.has(nodeId)) errors.push(issue('integration-contract-unknown-node', `集成契约 ${contractId} 引用了未知成员节点 ${nodeId}`));
        }
        const integrationNodeId = String(contract.integrationNode ?? '').trim();
        if (!integrationNodeId || !ids.has(integrationNodeId)) {
          errors.push(issue('integration-node-unknown', `集成契约 ${contractId} 必须引用图内 integrationNode`));
        } else {
          if (refs.includes(integrationNodeId)) errors.push(issue('integration-node-in-members', `集成节点 ${integrationNodeId} 不能同时作为自己的参与成员`));
          const integrationSpec = nodes.find((node) => String(node.nodeId) === integrationNodeId);
          const deps = new Set((integrationSpec?.deps ?? []).map(String));
          for (const memberId of refs) {
            if (!deps.has(memberId)) errors.push(issue('integration-node-missing-dependency', `集成节点 ${integrationNodeId} 必须依赖契约成员 ${memberId}`));
          }
        }
        if (!String(contract.contract ?? '').trim()) errors.push(issue('integration-contract-text-required', `集成契约 ${contractId} 缺 contract`));
        if (!Array.isArray(contract.acceptance) || contract.acceptance.length === 0 || contract.acceptance.some((item) => !String(item ?? '').trim())) {
          errors.push(issue('integration-contract-acceptance-required', `集成契约 ${contractId} 必须有非空 acceptance`));
        }
      }
    }

    const delegation = coordination.delegation;
    if (delegation?.maxFanout !== undefined && (!Number.isInteger(Number(delegation.maxFanout)) || Number(delegation.maxFanout) < 1))
      errors.push(issue('delegation-fanout-invalid', 'delegation.maxFanout 必须是正整数'));
    if (coordination.maxQueuedTasks !== undefined && (!Number.isInteger(Number(coordination.maxQueuedTasks)) || Number(coordination.maxQueuedTasks) < 1))
      errors.push(issue('coordination-queue-limit-invalid', 'coordination.maxQueuedTasks 必须是正整数'));
    if (coordination.ratePerSecond !== undefined && (!Number.isFinite(Number(coordination.ratePerSecond)) || Number(coordination.ratePerSecond) <= 0))
      errors.push(issue('coordination-rate-invalid', 'coordination.ratePerSecond 必须大于 0'));
  }

  // 协调边界：大规模并行时，先分组/分层，不靠“多开 Agent”本身解决问题。
  if (ids.size >= 20 && !coordination?.enabled) {
    warnings.push(`节点数 ${ids.size} 较大：建议启用 coordination（分组/并发上限/协调策略），否则容易变成无结构并行`);
  }
  if (coordination?.enabled) {
    if (coordination.maxActive !== undefined && (!Number.isInteger(Number(coordination.maxActive)) || Number(coordination.maxActive) < 1)) {
      errors.push(issue('coordination-invalid', 'coordination.maxActive 必须是 ≥1 的整数'));
    }
    const grouped = new Set<string>();
    for (const group of Array.isArray(coordination.groups) ? coordination.groups : []) {
      const groupId = String(group?.id ?? '').trim();
      if (!groupId) {
        errors.push(issue('coordination-group-id', 'coordination.groups[].id 必填'));
        continue;
      }
      const groupNodes = Array.isArray(group.nodes) ? group.nodes.map((node) => String(node)) : [];
      if (!groupNodes.length) warnings.push(`coordination group ${groupId} 没有节点`);
      for (const nodeId of groupNodes) {
        if (!ids.has(nodeId)) {
          errors.push(issue('coordination-group-unknown-node', `coordination group ${groupId} 引用了不存在的节点：${nodeId}`));
        }
        if (grouped.has(nodeId)) warnings.push(`节点 ${nodeId} 出现在多个 coordination group 中`);
        grouped.add(nodeId);
      }
    }
  }

  const digest = `${String(spec.wish ?? '')}::${order.join(',')}`;
  let hash = 0;
  for (let index = 0; index < digest.length; index += 1) hash = (hash * 31 + digest.charCodeAt(index)) % 1000000007;

  const wouldBeReady = errors.length ? [] : ready;
  return {
    ok: errors.length === 0,
    planId: `PLAN-${Math.abs(hash)}`,
    errors,
    warnings,
    wouldBeReady,
    ready: wouldBeReady,
    basis: "deps-only",
    readyBasis: "deps-only",
    order,
    counts: { nodes: ids.size, edges: edgeCount },
    // 显式 null：未提供时保持可序列化（undefined 会破坏宿主的 lossless-JSON 校验）
    designBoundary: boundary ?? null,
    coordination: coordination ?? null,
    /**
     * 按需能力建议：由这张图的事实（节点数/阶段/外部写/预算）算出该装哪些能力，
     * 以及为什么不需要其余的。只建议不改图——采纳与否由 graph_commit 的 capabilities 决定。
     */
    capabilities: selectCapabilities(deriveFacts(nodes)),
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
    // 无条件写事件：wish 为空时内存也会被覆盖，若不留痕，重启后 meta 会回退到旧值。
    const coordination = JSON.stringify(plan.coordination ?? null);
    store.state.meta.set('graph_coordination', coordination);
    const graphMaxParallel = spec.policies?.maxParallel == null ? null : maxParallel;
    store.state.meta.set('graph_max_parallel', String(graphMaxParallel ?? ''));
    store.journal.append('wish_submitted', null, { wish_id: wishId, text: String(spec.wish ?? ''), maxParallel, budgetTokens, graphCoordination: coordination, graphMaxParallel });
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
          // writeScopes 以前只在校验里声明、落图即丢；组织审查要算「并行写域重叠」，
          // 所以随 budget 袋子落到 NodeRecord 上（bag 是既有扩展位，不新增字段）。
          writeScopes: (raw.writeScopes ?? []).map((item) => String(item)),
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
    coordination: { enabled: false, strategy: 'hierarchical-partitions', maxActive: 16, maxQueuedTasks: 10000, ratePerSecond: 100, partitions: [], delegation: { enabled: false, maxFanout: 16, requireIdempotencyKey: true }, aggregation: {} },
    notes: ['节点数量由工作决定，不由团队规模决定；强依赖必须显式 deps；管理关系与执行 deps 分离'],
  };
}
