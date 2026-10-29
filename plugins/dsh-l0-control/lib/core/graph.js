/**
 * 工作图（Python `graph.py` 的核心不变量在 TS 侧的实现）。
 *
 * 状态机唯一入口 `setStatus()`，拒绝顺序（全部在任何写入之前）：
 *   状态合法 → 节点存在 → 终态守卫 → 白名单 → 幂等短路 → done 凭证 → 写入+事件。
 *
 * 每次迁移写 `status_changed`（真实前态 + 后像：assignee / attempts / at），
 * 并附带 `assignee_changed` / `attempts_changed` 审计事件；`replaySnapshot()` 可完整重建。
 */
import { CredentialError, CycleError, GraphError } from "./errors.js";
             
                 
       
           
                 
                
             
             
                    
import { EDGE_KINDS } from "./types.js";
import { checkTransition, edgeKey, isGated, isNodeStatus, isTerminal, UNBLOCK_REASON_PREFIX } from "./status.js";
import { auditIndependence, passEvidence } from "./evidence.js";
import { gateAllowsDone } from "./stages.js";
                                        

/** `setStatus(assignee=…)` 的“不修改”哨兵。 */
export const UNSET                = Symbol("UNSET");
                                                         

                                   
                         
                           
                         
                                                               
              
                      
                   
                                  
 

                               
                 
                
               
                             
                              
                      
                  
                              
                             
                         
                                   
 

export function getNode(store       , nodeId        )                         {
  const node = store.state.nodes.get(nodeId);
  return node ? cloneNode(node) : undefined;
}

export function listNodes(store       )               {
  return [...store.state.nodes.values()]
    .sort((a, b) =>
      a.created_at === b.created_at
        ? a.node_id.localeCompare(b.node_id)
        : a.created_at.localeCompare(b.created_at),
    )
    .map(cloneNode);
}

export function edges(store       )         {
  return [...store.state.edges].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind),
  );
}

export function dependencies(store       , nodeId        )           {
  return store.state.edges
    .filter((e) => e.to === nodeId && e.kind === "blocks")
    .map((e) => e.from)
    .sort();
}

// ---------------------------------------------------------------------------
// 写期环检测
// ---------------------------------------------------------------------------

/** 沿 blocks 边判断 `start` 能否到达 `target`（from=前置 → to=后继）。 */
export function reachable(store       , start        , target        )          {
  if (start === target) return true;
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()          ;
    for (const e of store.state.edges) {
      if (e.kind !== "blocks" || e.from !== cur) continue;
      if (e.to === target) return true;
      if (!seen.has(e.to)) {
        seen.add(e.to);
        stack.push(e.to);
      }
    }
  }
  return false;
}

function assertNoCycle(store       , prerequisite        , dependent        )       {
  if (prerequisite === dependent) {
    throw new CycleError(`依赖成环（自依赖）：${prerequisite}`);
  }
  if (reachable(store, dependent, prerequisite)) {
    throw new CycleError(`依赖成环：${prerequisite} → ${dependent} 会形成环`);
  }
}

export function detectCycles(store       )             {
  const adjacency = new Map                  ();
  for (const e of store.state.edges) {
    if (e.kind !== "blocks") continue;
    const list = adjacency.get(e.from) ?? [];
    list.push(e.to);
    adjacency.set(e.from, list);
  }
  const colour = new Map                ();
  const stack           = [];
  const cycles             = [];

  const visit = (node        )       => {
    colour.set(node, 1);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const state = colour.get(next) ?? 0;
      if (state === 0) visit(next);
      else if (state === 1) {
        const idx = stack.indexOf(next);
        cycles.push([...stack.slice(idx), next]);
      }
    }
    stack.pop();
    colour.set(node, 2);
  };

  for (const node of [...adjacency.keys()].sort()) {
    if ((colour.get(node) ?? 0) === 0) visit(node);
  }
  return cycles;
}

// ---------------------------------------------------------------------------
// 节点 / 边
// ---------------------------------------------------------------------------

export function addNode(store       , input              )             {
  const { nodeId, title, spec } = input;
  if (!nodeId || !title || !spec) throw new GraphError("nodeId / title / spec 必填");
  const status = input.status ?? "planned";
  if (!isNodeStatus(status)) throw new GraphError(`非法状态：${status}`);
  if (store.state.nodes.has(nodeId)) throw new GraphError(`节点已存在：${nodeId}`);
  const deps = [...(input.deps ?? [])];
  for (const dep of deps) {
    if (!store.state.nodes.has(dep)) throw new GraphError(`依赖节点不存在：${dep}`);
    assertNoCycle(store, nodeId, dep);
  }
  const ts = store.nowIso();
  const node             = {
    node_id: nodeId,
    title,
    spec,
    capability: input.capability ?? null,
    stage: input.stage ?? null,
    status,
    deps,
    evidence_required: [...(input.evidenceRequired ?? [])],
    decision_id: input.decisionId ?? null,
    attempts: 0,
    assignee: null,
    verifier_ids: [...(input.verifierIds ?? [])],
    budget: { ...(input.budget ?? {}) },
    created_at: ts,
    updated_at: ts,
  };
  store.state.nodes.set(nodeId, node);
  for (const dep of deps) {
    store.state.edges.push({ from: dep, to: nodeId, kind: "blocks" });
    store.journal.append("edge_added", nodeId, { from: dep, to: nodeId, kind: "blocks" });
  }
  store.journal.append("node_added", nodeId, { node: cloneNode(node) });
  return cloneNode(node);
}

export function addEdge(store       , from        , to        , kind          )       {
  if (!EDGE_KINDS.includes(kind)) throw new GraphError(`非法边类型：${kind}`);
  for (const id of [from, to]) {
    if (!store.state.nodes.has(id)) throw new GraphError(`节点不存在：${id}`);
  }
  if (kind === "blocks") assertNoCycle(store, from, to);
  const exists = store.state.edges.some((e) => e.from === from && e.to === to && e.kind === kind);
  if (exists) return;
  store.state.edges.push({ from, to, kind });
  store.journal.append("edge_added", to, { from, to, kind });
}

export function removeNode(store       , nodeId        , options                              = {})             {
  const node = store.state.nodes.get(nodeId);
  if (!node) throw new GraphError(`节点不存在：${nodeId}`);
  if (isTerminal(node.status) && !options.allowTerminal) {
    throw new GraphError(`终态节点不可删除：${nodeId}（status=${node.status}）`);
  }
  const removedEdges = store.state.edges.filter((e) => e.from === nodeId || e.to === nodeId);
  store.state.edges = store.state.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
  store.state.nodes.delete(nodeId);
  store.state.leases.delete(nodeId);
  store.journal.append("node_removed", nodeId, {
    node: cloneNode(node),
    removed_edges: removedEdges.map((e) => ({ ...e })),
  });
  return cloneNode(node);
}

export function setEdges(store       , nodeId        , deps          )           {
  const node = store.state.nodes.get(nodeId);
  if (!node) throw new GraphError(`节点不存在：${nodeId}`);
  const next = [...new Set(deps)];
  for (const dep of next) {
    if (!store.state.nodes.has(dep)) throw new GraphError(`依赖节点不存在：${dep}`);
    assertNoCycle(store, dep, nodeId);
  }
  const removed = node.deps.filter((d) => !next.includes(d));
  for (const dep of removed) {
    store.state.edges = store.state.edges.filter(
      (e) => !(e.from === dep && e.to === nodeId && e.kind === "blocks"),
    );
    store.journal.append("edge_removed", nodeId, { from: dep, to: nodeId, kind: "blocks" });
  }
  for (const dep of next) {
    const exists = store.state.edges.some(
      (e) => e.from === dep && e.to === nodeId && e.kind === "blocks",
    );
    if (!exists) {
      store.state.edges.push({ from: dep, to: nodeId, kind: "blocks" });
      store.journal.append("edge_added", nodeId, { from: dep, to: nodeId, kind: "blocks" });
    }
  }
  node.deps = next;
  node.updated_at = store.nowIso();
  return next;
}

// ---------------------------------------------------------------------------
// 证据凭证
// ---------------------------------------------------------------------------

function validateDoneCredential(
  store       ,
  node            ,
  credential                                                             ,
)           {
  if (credential === null || credential === undefined) {
    throw new CredentialError(
      `节点 ${node.node_id} 拒绝进入 done：缺少证据凭证（用 doneCredential() 铸造后传入）`,
    );
  }
  const ids = Array.isArray((credential                  ).evidence)
    ? [...((credential                  ).evidence            )]
    : [];
  if (!ids.length) throw new CredentialError(`证据凭证为空：${node.node_id}`);
  const credNode = (credential                  ).node_id;
  if (credNode !== undefined && credNode !== null && credNode !== node.node_id) {
    throw new CredentialError(`证据凭证归属不符：${credNode} != ${node.node_id}`);
  }

  const rows                   = [];
  for (const evidenceId of ids) {
    const row = store.state.evidence.get(evidenceId);
    if (!row) throw new CredentialError(`凭证引用不存在的证据：${evidenceId}`);
    if (row.node_id !== node.node_id) {
      throw new CredentialError(`证据 ${evidenceId} 不属于节点 ${node.node_id}`);
    }
    if (row.verdict !== "pass") {
      throw new CredentialError(`证据 ${evidenceId} 未通过（verdict=${row.verdict}）`);
    }
    rows.push(row);
  }

  const got = new Set(rows.map((r) => r.kind));
  const missing = node.evidence_required.filter((kind) => !got.has(kind)).sort();
  if (missing.length) throw new CredentialError(`证据未覆盖必需类型：${missing.join(",")}`);

  // 审计独立（N5 e2e 取数依赖）：提交者实例 × 审计方实例/职务
  const independence = auditIndependence(rows);
  if (!independence.ok) {
    throw new CredentialError(
      `审计不独立（${independence.reason}）：producer=${independence.producer ?? ""} auditor=${independence.auditor ?? ""}`,
    );
  }

  const allowed = new Set(node.verifier_ids);
  if (allowed.size) {
    const bad = [...new Set(rows.map((r) => r.verifier_id))]
      .filter((v) => !allowed.has(v))
      .sort();
    if (bad.length) throw new CredentialError(`验证器不在允许清单：${bad.join(",")}`);
  }

  for (const dep of node.deps) {
    const depNode = store.state.nodes.get(dep);
    if (!depNode || depNode.status !== "done") {
      throw new CredentialError(`依赖未完成：${dep}`);
    }
  }

  if (node.stage) {
    // 单一判定源：stages.gateAllowsDone（无 stage 放行；有 stage 必须 passed）
    if (!gateAllowsDone(store, node.stage)) {
      throw new CredentialError(`阶段闸门未通过：${node.stage}`);
    }
  }
  return ids;
}

/** 按库内证据铸造 done 凭证；不满足条件返回 null（不抛异常）。 */
export function doneCredential(store       , nodeId        )                        {
  const node = store.state.nodes.get(nodeId);
  if (!node) return null;
  const rows = passEvidence(store, nodeId);
  const candidate                 = {
    node_id: nodeId,
    evidence: rows.map((r) => r.evidence_id),
    verifier_ids: [...new Set(rows.map((r) => r.verifier_id))].sort(),
    minted_at: store.nowIso(),
  };
  try {
    validateDoneCredential(store, node, candidate);
  } catch {
    return null;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// 状态机唯一入口
// ---------------------------------------------------------------------------

export function setStatus(
  store       ,
  nodeId        ,
  status            ,
  options                   = {},
)             {
  if (!isNodeStatus(status)) throw new GraphError(`非法状态：${String(status)}`);
  const node = store.state.nodes.get(nodeId);
  if (!node) throw new GraphError(`节点不存在：${nodeId}`);

  // 1) 终态守卫（P0）
  if (isTerminal(node.status) && status !== node.status) {
    throw new GraphError(
      `终态不可退出：${nodeId} 已是 ${node.status}，拒绝 ${node.status} → ${status}`,
    );
  }

  // 2) 白名单（同状态幂等路径不受限）
  const check = checkTransition(node.status, status);
  if (!check.ok) {
    throw new GraphError(
      `非法状态迁移：${nodeId} ${node.status} → ${status}（不在运行时白名单内）`,
    );
  }

  const before = cloneNode(node);
  // 注意：显式传 null 表示「清空 assignee」，只有 undefined 才是「不修改」
  const assigneeInput                =
    options.assignee === undefined ? UNSET : options.assignee;
  const attemptsDelta = options.attemptsDelta ?? 0;
  const dropLease = options.dropLease ?? false;

  // 3) 幂等短路（同状态且无后像变化）
  if (before.status === status && assigneeInput === UNSET && !attemptsDelta && !dropLease) {
    return before;
  }

  // 4) done 凭证
  let evidenceIds           = [];
  if (isGated(status)) {
    evidenceIds = validateDoneCredential(store, before, options.credential ?? null);
  }

  // 5) 阻断解除必须留痕
  if (before.status === "blocked" && status === "ready") {
    const reason = typeof options.reason === "string" ? options.reason : "";
    if (!reason.startsWith(UNBLOCK_REASON_PREFIX)) {
      throw new GraphError(
        `解除 blocked 必须带 reason="${UNBLOCK_REASON_PREFIX}<原因>"：${nodeId}（当前 reason=${JSON.stringify(options.reason ?? null)}）`,
      );
    }
    if (reason.length <= UNBLOCK_REASON_PREFIX.length) {
      throw new GraphError(`解除 blocked 的原因不能为空：${nodeId}`);
    }
  }

  const nextAssignee = assigneeInput === UNSET ? before.assignee : (assigneeInput                 );
  const nextAttempts = before.attempts + attemptsDelta;
  if (nextAttempts < 0) throw new GraphError(`attempts 不能为负：${nodeId}`);
  const ts = options.at ?? store.nowIso();

  node.status = status;
  node.assignee = nextAssignee;
  node.attempts = nextAttempts;
  node.updated_at = ts;

  const payload                          = {
    from: before.status,
    to: status,
    at: ts,
    assignee: nextAssignee,
    attempts: nextAttempts,
  };
  if (options.reason) payload.reason = options.reason;
  if (evidenceIds.length) payload.evidence = [...evidenceIds];
  if (options.extra) Object.assign(payload, options.extra);
  store.journal.append("status_changed", nodeId, payload);

  if (nextAssignee !== before.assignee) {
    store.journal.append("assignee_changed", nodeId, {
      from: before.assignee,
      to: nextAssignee,
      reason: options.reason ?? null,
      at: ts,
    });
  }
  if (nextAttempts !== before.attempts) {
    store.journal.append("attempts_changed", nodeId, {
      from: before.attempts,
      to: nextAttempts,
      reason: options.reason ?? null,
      at: ts,
    });
  }
  if (dropLease) store.state.leases.delete(nodeId);

  const result = cloneNode(node);
  if (options.notify !== false && status === "done") {
    notifyDone(store, result);
  }
  return result;
}

/**
 * 驳回（Python `evidence._reject` 的等价物，P1 修复）：
 * **`ready` + `dropLease` + `attempts+1` + `reason="rejected:<原因>"`** 一次做完。
 *
 * 为什么必须带 dropLease：否则节点回到 ready 但租约还在，后续 `claimTask` 会报
 * alreadyHeld、`submitEvidence` 不推进、`verifyDone` 判 invalid-state（真实链上 O 已复现）。
 */
export function rejectNode(
  store       ,
  nodeId        ,
  reason        ,
  options                                                    = {},
)             {
  const node = store.state.nodes.get(nodeId);
  if (!node) throw new GraphError(`节点不存在：${nodeId}`);
  if (node.status !== "submitted" && node.status !== "verifying") {
    throw new GraphError(`当前状态不可驳回：${nodeId}（${node.status}）`);
  }
  const at = options.at ?? store.nowIso();
  store.journal.append("node_rejected", nodeId, {
    reason,
    detail: options.detail ?? {},
    at,
  });
  return setStatus(store, nodeId, "ready", {
    reason: `rejected:${reason}`,
    assignee: null,
    attemptsDelta: 1,
    dropLease: true,
    at,
    notify: false,
    extra: { reject_reason: reason, ...(options.detail ?? {}) },
  });
}

/** 解除阻断：`blocked → ready`，强制 `unblocked:<原因>` 留痕。 */
export function unblock(
  store       ,
  nodeId        ,
  reason        ,
  options                                                   = {},
)             {
  if (!reason) throw new GraphError(`解除 blocked 必须给出原因：${nodeId}`);
  return setStatus(store, nodeId, "ready", {
    reason: `${UNBLOCK_REASON_PREFIX}${reason}`,
    assignee: null,
    at: options.at,
    notify: options.notify,
    extra: options.note ? { unblock_note: options.note } : undefined,
  });
}

// ---------------------------------------------------------------------------
// done → 下游解锁（R2 接入 ready 重算；R1 只留钩子，避免跨模块循环依赖）
// ---------------------------------------------------------------------------

                                                             
const doneListeners                 = [];

export function onNodeDone(listener              )       {
  doneListeners.push(listener);
}

export function resetDoneListeners()       {
  doneListeners.length = 0;
}

function notifyDone(store       , node            )       {
  for (const listener of doneListeners) listener(store, node);
}

// ---------------------------------------------------------------------------
// 快照 / 重放
// ---------------------------------------------------------------------------

export function snapshot(store       )                {
  const edgeList = edges(store);
  const nodes                             = {};
  for (const node of listNodes(store)) nodes[node.node_id] = node;
  normalizeDeps(nodes, edgeList);
  return { nodes, edges: edgeList };
}

export function replaySnapshot(store       )                {
  const nodes                             = {};
  let edgeList         = [];
  for (const ev of store.journal.all()) {
    const p = ev.payload                           ;
    switch (ev.kind) {
      case "node_added": {
        const node = p.node                          ;
        if (node) nodes[node.node_id] = structuredClone(node);
        break;
      }
      case "node_removed": {
        const node = (p.node                          ) ?? undefined;
        const removedId = node?.node_id ?? ev.node_id ?? "";
        delete nodes[removedId];
        edgeList = edgeList.filter((e) => e.from !== removedId && e.to !== removedId);
        break;
      }
      case "edge_added": {
        const edge = { from: String(p.from), to: String(p.to), kind: p.kind             };
        if (!edgeList.some((e) => e.from === edge.from && e.to === edge.to && e.kind === edge.kind)) {
          edgeList.push(edge);
        }
        break;
      }
      case "edge_removed": {
        const edge = { from: String(p.from), to: String(p.to), kind: p.kind             };
        edgeList = edgeList.filter(
          (e) => !(e.from === edge.from && e.to === edge.to && e.kind === edge.kind),
        );
        break;
      }
      case "status_changed": {
        const node = ev.node_id ? nodes[ev.node_id] : undefined;
        if (!node) break;
        node.status = p.to              ;
        if (typeof p.at === "string") node.updated_at = p.at;
        if ("assignee" in p) node.assignee = (p.assignee                 ) ?? null;
        if ("attempts" in p) node.attempts = Number(p.attempts);
        break;
      }
      case "assignee_changed": {
        const node = ev.node_id ? nodes[ev.node_id] : undefined;
        if (node) node.assignee = (p.to                 ) ?? null;
        break;
      }
      case "attempts_changed": {
        const node = ev.node_id ? nodes[ev.node_id] : undefined;
        if (node) node.attempts = Number(p.to);
        break;
      }
      default:
        break;
    }
  }
  edgeList.sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind),
  );
  const normalized                = { nodes, edges: edgeList };
  normalizeDeps(normalized.nodes, edgeList);
  return normalized;
}

function normalizeDeps(nodes                            , edgeList        )       {
  const preds = new Map                  ();
  for (const id of Object.keys(nodes)) preds.set(id, []);
  for (const e of edgeList) {
    if (e.kind !== "blocks") continue;
    const list = preds.get(e.to);
    if (list) list.push(e.from);
  }
  for (const [id, node] of Object.entries(nodes)) {
    node.deps = [...new Set(preds.get(id) ?? [])].sort();
  }
}

                             
                         
                
                    
                  
 

/** 逐字段对比 snapshot / replay（空数组 = 完全一致）。 */
export function replayMismatches(store       )               {
  const snap = snapshot(store);
  const rep = replaySnapshot(store);
  const diffs               = [];
  const ids = new Set([...Object.keys(snap.nodes), ...Object.keys(rep.nodes)]);
  for (const id of [...ids].sort()) {
    const a = snap.nodes[id];
    const b = rep.nodes[id];
    if (!a || !b) {
      diffs.push({ node_id: id, field: "node", snapshot: a ?? null, replay: b ?? null });
      continue;
    }
    for (const field of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const av = (a                                      )[field];
      const bv = (b                                      )[field];
      if (JSON.stringify(av) !== JSON.stringify(bv)) {
        diffs.push({ node_id: id, field, snapshot: av ?? null, replay: bv ?? null });
      }
    }
  }
  if (JSON.stringify(snap.edges) !== JSON.stringify(rep.edges)) {
    diffs.push({ node_id: null, field: "edges", snapshot: snap.edges, replay: rep.edges });
  }
  return diffs;
}

function cloneNode(node            )             {
  return {
    ...node,
    deps: [...node.deps],
    evidence_required: [...node.evidence_required],
    verifier_ids: [...node.verifier_ids],
    budget: { ...node.budget },
  };
}

export { edgeKey };


//# sourceURL=core\graph.js