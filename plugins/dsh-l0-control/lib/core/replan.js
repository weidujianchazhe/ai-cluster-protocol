/**
 * replan（Python `graph.replan()` R5 的等价物）：**单事务**改图 + 版本 + 事件。
 *
 * 全成或全不成：任何一步抛错 → `Store.atomically()` 回滚「图 / 版本 / 事件 / replan_events」。
 */
import { GraphError, ReplanError } from "./errors.js";
import { addNode, removeNode, setEdges } from "./graph.js";
                                               
import { recomputeReady } from "./ready.js";
import { getNode } from "./graph.js";
                                              
                                        

export const REPLAN_REASONS = [
  "gate_failed",
  "evidence_insufficient",
  "scope_change",
  "decision_override",
  "failure_retry",
  "coordination",
]         ;
                                                           

                              
                       
                       
                    
                                                  
                                     
                       
                                    
                                
                                  
                      
 

                               
           
                   
             
                 
                        
                  
                    
                                                                    
                      
                     
 

export function currentGraphVersion(store       )         {
  return Number(store.state.meta.get("graph_version") ?? "1");
}

function bumpGraphVersion(store       )         {
  const next = currentGraphVersion(store) + 1;
  store.state.meta.set("graph_version", String(next));
  return next;
}

export function replan(store       , input             )               {
  const { reason } = input;
  if (!REPLAN_REASONS.includes(reason)) throw new ReplanError(`非法 replan 原因：${reason}`);
  const versionBefore = currentGraphVersion(store);
  if (input.expectedGraphVersion !== undefined && Number(input.expectedGraphVersion) !== versionBefore) {
    throw new ReplanError(
      `图版本已变化：expected=${input.expectedGraphVersion} actual=${versionBefore}；拒绝基于过期协调状态重规划`,
      "replan_stale_graph",
    );
  }
  const addSpecs = (input.add ?? []).map((spec) => {
    const raw = spec                                             ;
    const scopes = Array.isArray(raw.writeScopes) ? raw.writeScopes.map(String) : [];
    return {
      ...raw,
      deps: [...new Set((raw.deps ?? []).map(String))],
      // 与 graph_commit 一致：writeScopes 随 budget 袋子落到 NodeRecord，供组织审查算写域重叠。
      budget: scopes.length > 0 ? { ...(raw.budget ?? {}), writeScopes: scopes } : (raw.budget ?? {}),
    };
  });
  const removeIds = [...new Set((input.remove ?? []).map(String))];
  const depChanges = Object.entries(input.setDeps ?? {}).map(([nodeId, deps]) => [String(nodeId), [...new Set(deps.map(String))]]         );
  const removedSet = new Set(removeIds);
  const addById = new Map(addSpecs.map((spec) => [spec.nodeId, spec]));
  if (addById.size !== addSpecs.length) throw new ReplanError('replan add 内有重复 nodeId');
  if (removedSet.size !== removeIds.length) throw new ReplanError('replan remove 内有重复 nodeId');
  const changedDeps = new Map(depChanges);
  if (changedDeps.size !== depChanges.length) throw new ReplanError('replan setDeps 内有重复 nodeId');

  for (const spec of addSpecs) {
    if (!spec.nodeId) throw new ReplanError(`replan add 缺少 nodeId：${JSON.stringify(spec)}`);
    if (getNode(store, spec.nodeId)) throw new ReplanError(`replan add 节点已存在：${spec.nodeId}`);
  }
  for (const nodeId of removeIds) {
    const node = getNode(store, nodeId);
    if (!node) throw new ReplanError(`replan remove 节点不存在：${nodeId}`);
    if (node.status === "done" || node.status === "accepted") {
      // 前置拒绝：绝不通过 replan 绕过终态
      throw new ReplanError(`replan 不得删除终态节点：${nodeId}（status=${node.status}）`);
    }
  }

  for (const [nodeId] of depChanges) {
    const node = getNode(store, nodeId);
    if (!node && !addById.has(nodeId)) throw new ReplanError(`replan setDeps 节点不存在：${nodeId}`);
    if (removedSet.has(nodeId)) throw new ReplanError(`replan 不能同时修改并删除节点：${nodeId}`);
    if (node && (node.status === 'done' || node.status === 'accepted')) throw new ReplanError(`replan 不得改终态节点依赖：${nodeId}（status=${node.status}）`);
  }

  // 构造最终图的节点集合与依赖，写事务前拒绝悬空依赖、自环和环。
  const finalIds = new Set        ([
    ...[...store.state.nodes.keys()].filter((id) => !removedSet.has(id)),
    ...addById.keys(),
  ]);
  const finalDeps = new Map                           ();
  for (const [id, node] of store.state.nodes) {
    if (removedSet.has(id)) continue;
    finalDeps.set(id, changedDeps.get(id) ?? [...node.deps]);
  }
  for (const [id, spec] of addById) finalDeps.set(id, changedDeps.get(id) ?? [...(spec.deps ?? [])]);
  for (const [id, deps] of finalDeps) {
    if (deps.includes(id)) throw new ReplanError(`replan 不得添加自依赖：${id}`);
    for (const dep of deps) if (!finalIds.has(dep)) throw new ReplanError(`replan 会产生悬空依赖：${id} → ${dep}`);
  }
  const visiting = new Set        ();
  const visited = new Set        ();
  const visit = (id        )       => {
    if (visiting.has(id)) throw new ReplanError(`replan 依赖变更会形成环：${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of finalDeps.get(id) ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of finalIds) visit(id);

  const added           = [];
  const removed           = [];
  const rewired                                                           = [];
  const at = store.nowIso();

  const committed = store.atomically(() => {
    if (input.expectedGraphVersion !== undefined && currentGraphVersion(store) !== Number(input.expectedGraphVersion)) {
      throw new ReplanError(
        `图版本在重规划提交前变化：expected=${input.expectedGraphVersion} actual=${currentGraphVersion(store)}`,
        "replan_stale_graph",
      );
    }
    for (const spec of addSpecs) {
      addNode(store, spec);
      added.push(spec.nodeId);
    }
    for (const [nodeId, deps] of depChanges) {
      const node = getNode(store, nodeId);
      if (!node) throw new ReplanError(`replan setDeps 节点不存在：${nodeId}`);
      rewired.push({ node_id: nodeId, from: [...node.deps], to: [...deps] });
      setEdges(store, nodeId, [...deps]);
    }
    for (const nodeId of removeIds) {
      removeNode(store, nodeId);
      removed.push(nodeId);
    }
    const version = bumpGraphVersion(store);
    const eventId = `EVT-R${String(version).padStart(4, "0")}`;
    const record              = {
      event_id: eventId,
      at,
      reason,
      graph_version: version,
      added: [...added],
      removed: [...removed],
      rewired: rewired.map((row) => ({ node_id: row.node_id, from: [...row.from], to: [...row.to] })),
      note: input.note ?? null,
    };
    store.state.replanEvents.push(record);
    store.journal.append("graph_replanned", null, {
      event_id: eventId, // fold 重建 replan_events 用
      reason,
      graph_version: version,
      added: [...added],
      removed: [...removed],
      rewired: rewired.map((row) => ({ node_id: row.node_id, from: [...row.from], to: [...row.to] })),
      note: input.note ?? null,
      at,
    });
    return record;
  });

  const promoted =
    input.recompute === false ? [] : recomputeReady(store, { reason: "replan" }).promoted;

  return {
    ok: true,
    event_id: committed.event_id,
    at: committed.at,
    reason: committed.reason,
    graph_version: committed.graph_version,
    added: committed.added,
    removed: committed.removed,
    rewired: committed.rewired,
    note: committed.note,
    promoted,
  };
}

export function listReplanEvents(store       )                {
  return store.state.replanEvents.map((r) => ({ ...r, added: [...r.added], removed: [...r.removed] }));
}

export { GraphError };


//# sourceURL=core\replan.js