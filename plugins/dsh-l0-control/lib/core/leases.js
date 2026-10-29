/**
 * 租约 / 心跳 / 过期接管 / fencing token（Python `leases.py` 的等价物）。
 *
 * 规则：
 *  - 只有 `ready` 节点可被 claim；同一时刻只有一个 owner；
 *  - fencing token 每节点单调递增（release 后也不回退）；
 *  - 过期租约必须先 expire 或 takeover，不能直接覆盖；
 *  - 状态变更一律经 `graph.setStatus`（唯一入口），事件与后像由它统一写。
 */
import { FencingError, LeaseError, LeaseExpired, LeaseHeld } from "./errors.js";
import { getNode, setStatus } from "./graph.js";
                                        
                                        

export function currentLease(store       , nodeId        )                    {
  const lease = store.state.leases.get(nodeId);
  return lease ? { ...lease } : undefined;
}

function nextToken(store       , nodeId        )         {
  const last = (store.state.leaseCounters.get(nodeId) ?? 0) + 1;
  store.state.leaseCounters.set(nodeId, last);
  return last;
}

                               
                  
               
 

export function claim(store       , nodeId        , owner        , options               = {})        {
  if (!owner) throw new LeaseError("owner 不能为空");
  const node = getNode(store, nodeId);
  if (!node) throw new LeaseError(`节点不存在：${nodeId}`);
  const t = options.now ?? store.nowMs();
  const ttl = options.ttlSec ?? 60;
  const existing = currentLease(store, nodeId);
  if (existing) {
    if (existing.expires_at > t) {
      throw new LeaseHeld(
        `节点已被持有：${nodeId} by ${existing.owner}（token=${existing.fencing_token}）`,
      );
    }
    throw new LeaseExpired(`存在过期租约，请先 expire 或 takeover：${nodeId}`);
  }
  if (node.status !== "ready") {
    throw new LeaseError(`节点不在 ready，不能 claim：${nodeId} (${node.status})`);
  }
  const token = nextToken(store, nodeId);
  const lease        = {
    node_id: nodeId,
    owner,
    fencing_token: token,
    expires_at: t + ttl,
    heartbeat_at: t,
  };
  store.state.leases.set(nodeId, lease);
  store.journal.append("lease_claimed", nodeId, {
    owner,
    fencing_token: token,
    ttl_sec: ttl,
    expires_at: lease.expires_at,
    heartbeat_at: lease.heartbeat_at, // fold 重建租约用
  });
  setStatus(store, nodeId, "claimed", {
    reason: "lease_claimed",
    assignee: owner,
    at: store.nowIso(),
    notify: false,
  });
  return { ...lease };
}

                               
                  
               
 

export function renew(
  store       ,
  nodeId        ,
  owner        ,
  fencingToken        ,
  options               = {},
)        {
  const lease = currentLease(store, nodeId);
  if (!lease) throw new LeaseExpired(`租约不存在：${nodeId}`);
  if (lease.owner !== owner || lease.fencing_token !== Number(fencingToken)) {
    throw new FencingError(`fencing 不匹配：${nodeId} owner=${owner} token=${fencingToken}`);
  }
  const t = options.now ?? store.nowMs();
  if (lease.expires_at <= t) throw new LeaseExpired(`租约已过期：${nodeId}`);
  const ttl = options.ttlSec ?? 60;
  lease.expires_at = t + ttl;
  lease.heartbeat_at = t;
  store.state.leases.set(nodeId, lease);
  store.journal.append("lease_renewed", nodeId, {
    owner,
    fencing_token: lease.fencing_token,
    expires_at: lease.expires_at,
    heartbeat_at: lease.heartbeat_at, // fold 重建租约用
  });
  return { ...lease };
}

export function release(store       , nodeId        , owner        , fencingToken        )       {
  const lease = currentLease(store, nodeId);
  if (!lease) throw new LeaseExpired(`租约不存在：${nodeId}`);
  if (lease.owner !== owner || lease.fencing_token !== Number(fencingToken)) {
    throw new FencingError(`fencing 不匹配：${nodeId}`);
  }
  if (!getNode(store, nodeId)) throw new LeaseError(`节点不存在：${nodeId}`);
  store.state.leases.delete(nodeId);
  store.journal.append("lease_released", nodeId, {
    owner,
    fencing_token: lease.fencing_token,
  });
  setStatus(store, nodeId, "ready", {
    reason: "lease_released",
    assignee: null,
    at: store.nowIso(),
    notify: false,
  });
}

/** 回收过期租约；返回被回收的节点 id 列表。 */
export function expire(store       , options                   = {})           {
  const t = options.now ?? store.nowMs();
  const expired = [...store.state.leases.values()]
    .filter((l) => l.expires_at <= t)
    .sort((a, b) => a.node_id.localeCompare(b.node_id));
  const result           = [];
  for (const lease of expired) {
    const nodeId = lease.node_id;
    store.state.leases.delete(nodeId);
    store.journal.append("lease_expired", nodeId, {
      owner: lease.owner,
      fencing_token: lease.fencing_token,
      at: t,
    });
    const node = getNode(store, nodeId);
    if (node && (node.status === "claimed" || node.status === "running")) {
      setStatus(store, nodeId, "ready", {
        reason: "lease_expired",
        assignee: null,
        attemptsDelta: 1,
        at: store.nowIso(),
        notify: false,
      });
    }
    result.push(nodeId);
  }
  return result;
}

                                  
                  
               
 

export function takeover(
  store       ,
  nodeId        ,
  newOwner        ,
  options                  = {},
)        {
  const lease = currentLease(store, nodeId);
  if (!lease) throw new LeaseExpired(`租约不存在，无法接管：${nodeId}`);
  const t = options.now ?? store.nowMs();
  if (lease.expires_at > t) {
    throw new LeaseHeld(`租约未过期，不能接管：${nodeId}（owner=${lease.owner}）`);
  }
  const token = nextToken(store, nodeId);
  const ttl = options.ttlSec ?? 60;
  const next        = {
    node_id: nodeId,
    owner: newOwner,
    fencing_token: token,
    expires_at: t + ttl,
    heartbeat_at: t,
  };
  store.state.leases.set(nodeId, next);
  store.journal.append("lease_taken_over", nodeId, {
    from_owner: lease.owner,
    to_owner: newOwner,
    from_token: lease.fencing_token,
    fencing_token: token,
    expires_at: next.expires_at,
    heartbeat_at: next.heartbeat_at, // fold 重建租约用
  });
  setStatus(store, nodeId, "claimed", {
    reason: "takeover",
    assignee: newOwner,
    at: store.nowIso(),
    notify: false,
  });
  return { ...next };
}

export function assertFencing(
  store       ,
  nodeId        ,
  owner        ,
  fencingToken        ,
  options                   = {},
)       {
  const lease = currentLease(store, nodeId);
  if (!lease) throw new LeaseExpired(`租约不存在：${nodeId}`);
  if (lease.owner !== owner || lease.fencing_token !== Number(fencingToken)) {
    throw new FencingError(`fencing 不匹配：${nodeId}`);
  }
  if (lease.expires_at <= (options.now ?? store.nowMs())) {
    throw new LeaseExpired(`租约已过期：${nodeId}`);
  }
}


//# sourceURL=core\leases.js