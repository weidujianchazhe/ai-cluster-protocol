/**
 * 租约 / 心跳 / 过期接管 / fencing token（Python `leases.py` 的等价物）。
 *
 * 规则：
 *  - 只有 `ready` 节点可被 claim；同一时刻只有一个 owner；
 *  - fencing token 每节点单调递增（release 后也不回退）；
 *  - 过期租约必须先 expire 或 takeover，不能直接覆盖；
 *  - 状态变更一律经 `graph.setStatus`（唯一入口），事件与后像由它统一写。
 */
import { FencingError, LeaseError, LeaseExpired, LeaseHeld } from "./errors.ts";
import { assertBudget, claimsInWindow } from "./budget.ts";
import { leaseCapacity } from "./admission.ts";
import { getNode, rejectNode, setStatus } from "./graph.ts";
import type { Lease } from "./types.ts";
import type { Store } from "./store.ts";

export function currentLease(store: Store, nodeId: string): Lease | undefined {
  const lease = store.state.leases.get(nodeId);
  return lease ? { ...lease } : undefined;
}

function nextToken(store: Store, nodeId: string): number {
  const last = (store.state.leaseCounters.get(nodeId) ?? 0) + 1;
  store.state.leaseCounters.set(nodeId, last);
  return last;
}

function assertCapacity(store: Store, nodeId: string, now: number, hostLimit?: number): void {
  const capacity = leaseCapacity(store, now, hostLimit);
  // 分区（局部）先判：分区满员是**局部**原因，同图其它域照常放行。
  // 若先判全图，运维会去调 maxParallel，而那个参数对分区满员毫无作用。
  for (const { id, maxActive } of capacity.domainsFor(nodeId)) {
    if (maxActive !== undefined && (capacity.activeByPartition.get(id) ?? 0) >= maxActive) {
      throw new LeaseError(`协调域 ${id} 活跃租约达到上限 ${maxActive}`, 'partition_capacity', 'partition');
    }
  }
  if (capacity.active >= capacity.maxActive) {
    throw new LeaseError(`全图活跃租约达到上限 ${capacity.maxActive}`, 'graph_capacity', 'capacity');
  }
}

function assertRate(store: Store, now: number, ratePerSecond?: number): void {
  const limit = Number(ratePerSecond);
  if (!Number.isFinite(limit) || limit <= 0) return;
  const used = claimsInWindow(store, now, 1000);
  if (used >= limit) throw new LeaseError(`租约发放速率超限：本秒已发 ${used}，上限 ${limit}`, "rate_limited", "rate");
}

export interface ClaimOptions {
  ttlSec?: number;
  now?: number;
  hostLimit?: number;
  ratePerSecond?: number;
}

export function claim(store: Store, nodeId: string, owner: string, options: ClaimOptions = {}): Lease {
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
  assertCapacity(store, nodeId, t, options.hostLimit);
  assertRate(store, t, options.ratePerSecond);
  assertBudget(store, nodeId);
  const token = nextToken(store, nodeId);
  const lease: Lease = {
    node_id: nodeId,
    owner,
    fencing_token: token,
    expires_at: t + ttl * 1000,
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

export interface RenewOptions {
  ttlSec?: number;
  now?: number;
}

export function renew(
  store: Store,
  nodeId: string,
  owner: string,
  fencingToken: number,
  options: RenewOptions = {},
): Lease {
  const lease = currentLease(store, nodeId);
  if (!lease) throw new LeaseExpired(`租约不存在：${nodeId}`);
  if (lease.owner !== owner || lease.fencing_token !== Number(fencingToken)) {
    throw new FencingError(`fencing 不匹配：${nodeId} owner=${owner} token=${fencingToken}`);
  }
  const t = options.now ?? store.nowMs();
  if (lease.expires_at <= t) throw new LeaseExpired(`租约已过期：${nodeId}`);
  const ttl = options.ttlSec ?? 60;
  lease.expires_at = t + ttl * 1000;
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

/**
 * 审计期租约延长（**系统行为，不要求 owner / fencingToken**）。
 *
 * 为什么需要它：`verify_done` 要求**活租约**（`assertFencing`），而租约的默认 TTL 是给
 * 「生产阶段」定的（60 s，快速失败）。但证据一提交，节点就进入「等审计」——
 * 一轮真审计要复核产物哈希、复算数值，**很容易超过 60 s**。
 *
 * 而 worker 提交证据后通常就不再心跳了，**审计方又没有 fencingToken**（token 是生产者的），
 * 于是谁都续不了这个租约 → 到期 → 节点卡在 submitted。本轮就是这样连环卡死 7 个节点。
 *
 * 所以：证据落账的那一刻由**系统**把租约延长到审计窗口，而不是指望谁去心跳。
 * 只延长不缩短（`Math.max`）——绝不因为这次调用把别人的窗口改小。
 * 延长后仍会正常过期：审计一直不来时，`expire()` 的两层修复会把它驳回 ready，不会死锁。
 */
export function extendForAudit(
  store: Store,
  nodeId: string,
  ttlSec: number,
  options: { now?: number } = {},
): Lease | null {
  const lease = currentLease(store, nodeId);
  if (!lease) return null; // 没有租约 = 已经不在审计窗口，没什么可延的
  const ttl = Number(ttlSec);
  if (!Number.isFinite(ttl) || ttl <= 0) return { ...lease };
  const t = options.now ?? store.nowMs();
  const target = t + ttl * 1000;
  if (lease.expires_at >= target) return { ...lease }; // 已更宽，不动
  lease.expires_at = target;
  lease.heartbeat_at = t;
  store.state.leases.set(nodeId, lease);
  store.journal.append("lease_audit_extended", nodeId, {
    owner: lease.owner,
    fencing_token: lease.fencing_token,
    expires_at: lease.expires_at,
    heartbeat_at: lease.heartbeat_at, // fold 重建租约用
    ttl_sec: ttl,
  });
  return { ...lease };
}

export function release(store: Store, nodeId: string, owner: string, fencingToken: number): void {
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
export function expire(store: Store, options: { now?: number } = {}): string[] {
  const t = options.now ?? store.nowMs();
  const expired = [...store.state.leases.values()]
    .filter((l) => l.expires_at <= t)
    .sort((a, b) => a.node_id.localeCompare(b.node_id));
  const result: string[] = [];
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
    } else if (node && (node.status === "submitted" || node.status === "verifying")) {
      // ── 已提交但租约先过期的节点：不处理就是**永久死锁** ──────────────────
      //
      // 这个分支以前不存在，后果是一条**不可自愈**的路径：
      //   节点 submitted ∧ 租约被 expire 删掉
      //     → task_claim 要求 ready            → 拒（"节点不在 ready"）
      //     → verify_done 要求活租约（assertFencing）→ 拒（"租约不存在"）
      //     → rejectNode 是唯一能把它送回 ready 的函数，而它只被 verifyDone 的
      //       credential-unavailable 分支调用 —— 那个分支在 assertFencing **之后**
      //     ⇒ 到达不了。节点从此既不能领、也不能验。
      //
      // 现实触发条件一点都不苛刻：**worker 交了证据、但没在 TTL 内完成 verify**
      // （TTL 默认 60 s，而一轮真审计要复核产物哈希、复算数值，很容易超）。
      // 实测就是这么卡住了 6 个节点。
      //
      // 修复走既有的 `rejectNode`（ready + dropLease + attempts+1 + `rejected:` 留痕），
      // 与 P1 那次修 verify 失败的路径同一条——不新造一套状态迁移。
      try {
        rejectNode(store, nodeId, "lease_expired", {
          detail: { fromStatus: node.status, fencingToken: lease.fencing_token },
          at: store.nowIso(),
        });
      } catch {
        // 驳回失败不得让整轮 expire 中断：租约已经删除并留痕，
        // 下一轮还会再尝试（节点仍是 submitted，仍会命中本分支）。
      }
    }
    result.push(nodeId);
  }
  return result;
}

export interface TakeoverOptions extends ClaimOptions {}

export function takeover(
  store: Store,
  nodeId: string,
  newOwner: string,
  options: TakeoverOptions = {},
): Lease {
  const lease = currentLease(store, nodeId);
  if (!lease) throw new LeaseExpired(`租约不存在，无法接管：${nodeId}`);
  const t = options.now ?? store.nowMs();
  if (lease.expires_at > t) {
    throw new LeaseHeld(`租约未过期，不能接管：${nodeId}（owner=${lease.owner}）`);
  }
  assertCapacity(store, nodeId, t, options.hostLimit);
  assertRate(store, t, options.ratePerSecond);
  assertBudget(store, nodeId);
  const token = nextToken(store, nodeId);
  const ttl = options.ttlSec ?? 60;
  const next: Lease = {
    node_id: nodeId,
    owner: newOwner,
    fencing_token: token,
    expires_at: t + ttl * 1000,
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
  store: Store,
  nodeId: string,
  owner: string,
  fencingToken: number,
  options: { now?: number } = {},
): void {
  const lease = currentLease(store, nodeId);
  if (!lease) throw new LeaseExpired(`租约不存在：${nodeId}`);
  if (lease.owner !== owner || lease.fencing_token !== Number(fencingToken)) {
    throw new FencingError(`fencing 不匹配：${nodeId}`);
  }
  if (lease.expires_at <= (options.now ?? store.nowMs())) {
    throw new LeaseExpired(`租约已过期：${nodeId}`);
  }
}
