/**
 * journal 派生指标（Lane O）。
 *
 * 为什么需要它：token/成本来自调用方采样（adapter usage），但**重试、拒绝、blocked、租约过期**
 * 已经在 journal 里了（`attempts_changed` / `status_changed` / `lease_expired`）。
 * 从事件派生可以做到「不改 core、不改 service」，也能对齐崩溃恢复后的历史。
 *
 * 只依赖事件形状（`{seq?,kind,node_id?,payload?}`），不 import core。
 */
                                            

                                   
               
                
                          
                                           
 

                                 
                 
                
                       
                                               
                  
                                        
                                                         
                   
                                         
                         
                                   
                                   
                                         
                       
               
                 
                                       
                    
 

const REJECTED_PREFIX = "rejected:";

/** 从事件流派生指标（纯函数；同一条流重复调用结果一致）。 */
export function metricsFromEvents(events                             )                 {
  const out                 = {
    events: 0,
    leaseExpired: 0,
    retries: 0,
    retriesByNode: {},
    rejected: 0,
    rejectedByNode: {},
    statuses: {},
    attempts: {},
    verifyStarts: 0,
    done: [],
    blocked: [],
  };

  for (const event of events) {
    if (!event || typeof event.kind !== "string") continue;
    out.events += 1;
    const nodeId = event.node_id ? String(event.node_id) : null;
    const payload = (event.payload ?? {})                           ;

    switch (event.kind) {
      case "lease_expired":
        out.leaseExpired += 1;
        break;
      case "attempts_changed": {
        const from = Number(payload.from ?? 0);
        const to = Number(payload.to ?? 0);
        const delta = Number.isFinite(from) && Number.isFinite(to) && to > from ? to - from : 0;
        out.retries += delta;
        if (nodeId) {
          out.retriesByNode[nodeId] = (out.retriesByNode[nodeId] ?? 0) + delta;
          out.attempts[nodeId] = Math.max(out.attempts[nodeId] ?? 0, Number.isFinite(to) ? to : 0);
        }
        break;
      }
      case "status_changed": {
        const to = String(payload.to ?? "");
        const reason = String(payload.reason ?? "");
        if (nodeId && to) out.statuses[nodeId] = to;
        if (to === "verifying") out.verifyStarts += 1;
        if (to === "done" && nodeId) out.done.push(nodeId);
        if (reason.startsWith(REJECTED_PREFIX)) {
          out.rejected += 1;
          if (nodeId) out.rejectedByNode[nodeId] = (out.rejectedByNode[nodeId] ?? 0) + 1;
        }
        break;
      }
      case "node_added": {
        const node = payload.node                                       ;
        const id = node ? String(node.node_id ?? node.nodeId ?? "") : "";
        if (id) {
          out.statuses[id] = String(node?.status ?? "planned");
          out.attempts[id] = Number(node?.attempts ?? 0);
        }
        break;
      }
      default:
        break;
    }
  }

  out.blocked = Object.entries(out.statuses)
    .filter(([, status]) => status === "blocked")
    .map(([nodeId]) => nodeId)
    .sort();
  out.done = [...new Set(out.done)].sort();
  return out;
}

/** 把派生结果灌进 `Metrics`（租约过期计数 + 每节点状态/尝试次数）。 */
export function applyJournal(metrics         , derived                )                 {
  if (derived.leaseExpired > 0) metrics.recordLeaseExpired(derived.leaseExpired);
  for (const [nodeId, status] of Object.entries(derived.statuses)) {
    metrics.recordNode({
      nodeId,
      status,
      attempts: derived.attempts[nodeId] ?? 0,
    });
  }
  return derived;
}

/** 拒绝率（journal 口径：驳回次数 / 验收尝试数），用于和工具调用口径交叉验证。 */
export function journalRejectionRate(derived                )         {
  const attempts = Math.max(derived.verifyStarts, derived.rejected);
  if (attempts <= 0) return 0;
  return Math.min(1, derived.rejected / attempts);
}


//# sourceURL=observability\from-events.js