/**
 * replan（Python `graph.replan()` R5 的等价物）：**单事务**改图 + 版本 + 事件。
 *
 * 全成或全不成：任何一步抛错 → `Store.atomically()` 回滚「图 / 版本 / 事件 / replan_events」。
 */
import { GraphError, ReplanError } from "./errors.js";
import { addNode, removeNode } from "./graph.js";
                                               
import { recomputeReady } from "./ready.js";
import { getNode } from "./graph.js";
                                              
                                        

export const REPLAN_REASONS = [
  "gate_failed",
  "evidence_insufficient",
  "scope_change",
  "decision_override",
  "failure_retry",
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
  const addSpecs = (input.add ?? []).map((spec) => ({ ...spec }));
  const removeIds = [...(input.remove ?? [])];

  for (const spec of addSpecs) {
    if (!spec.nodeId) throw new ReplanError(`replan add 缺少 nodeId：${JSON.stringify(spec)}`);
    if (getNode(store, spec.nodeId)) throw new ReplanError(`replan add 节点已存在：${spec.nodeId}`);
  }
  for (const nodeId of removeIds) {
    const node = getNode(store, nodeId);
    if (!node) throw new ReplanError(`replan remove 节点不存在：${nodeId}`);
    if (node.status === "done") {
      // 前置拒绝：绝不通过 replan 绕过终态
      throw new ReplanError(`replan 不得删除终态节点：${nodeId}（status=${node.status}）`);
    }
  }

  const added           = [];
  const removed           = [];
  const at = store.nowIso();

  const committed = store.atomically(() => {
    for (const spec of addSpecs) {
      addNode(store, spec);
      added.push(spec.nodeId);
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
      note: input.note ?? null,
    };
    store.state.replanEvents.push(record);
    store.journal.append("graph_replanned", null, {
      event_id: eventId, // fold 重建 replan_events 用
      reason,
      graph_version: version,
      added: [...added],
      removed: [...removed],
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
    note: committed.note,
    promoted,
  };
}

export function listReplanEvents(store       )                {
  return store.state.replanEvents.map((r) => ({ ...r, added: [...r.added], removed: [...r.removed] }));
}

export { GraphError };


//# sourceURL=core\replan.js