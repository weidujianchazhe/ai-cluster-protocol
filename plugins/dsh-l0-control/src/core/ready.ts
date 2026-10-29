/**
 * ready 门控（Python `scheduler.py` 的等价物）。
 *
 * 规则：
 *  - `ready` 只能由「依赖全部 done」推出；不是轮询，而是由 done 事件触发 `onEvent()`；
 *  - 依赖不满足的 ready 会被降回 `planned`（防假 ready）；
 *  - 根节点（无依赖）在 bootstrap 首次重算时进入 ready。
 */
import type { EventRecord, NodeRecord } from "./types.ts";
import { getNode, listNodes, onNodeDone, setStatus } from "./graph.ts";
import type { Store } from "./store.ts";

export interface ReadyChange {
  promoted: string[];
  demoted: string[];
}

export interface RecomputeOptions {
  reason?: string;
  at?: string;
  /** 触发下游解锁时不写 `ready_recomputed` 汇总事件（默认写）。 */
  silent?: boolean;
}

export function depsDone(store: Store, deps: string[]): boolean {
  return deps.every((dep) => getNode(store, dep)?.status === "done");
}

export function readySet(store: Store): string[] {
  return listNodes(store)
    .filter((n) => n.status === "ready")
    .map((n) => n.node_id);
}

/** 重算 ready：先降级非法 ready，再晋升依赖已满足的 planned。 */
export function recomputeReady(store: Store, options: RecomputeOptions = {}): ReadyChange {
  const reason = options.reason ?? "recompute";
  const nodes = listNodes(store);
  const status = new Map<string, string>(nodes.map((n) => [n.node_id, n.status]));
  const promoted: string[] = [];
  const demoted: string[] = [];

  // 1) 降级：ready 但依赖未全 done
  for (const node of nodes) {
    if (node.status !== "ready") continue;
    if (depsDone(store, node.deps)) continue;
    setStatus(store, node.node_id, "planned", {
      reason: "deps_not_done",
      at: options.at,
      notify: false,
    });
    status.set(node.node_id, "planned");
    demoted.push(node.node_id);
  }

  // 2) 晋升：planned 且依赖全 done
  for (const node of nodes) {
    if (status.get(node.node_id) !== "planned") continue;
    if (!depsDone(store, node.deps)) continue;
    setStatus(store, node.node_id, "ready", {
      reason,
      at: options.at,
      notify: false,
    });
    status.set(node.node_id, "ready");
    promoted.push(node.node_id);
  }

  if ((promoted.length || demoted.length) && !options.silent) {
    store.journal.append("ready_recomputed", null, {
      promoted,
      demoted,
      reason,
      at: options.at ?? store.nowIso(),
    });
  }
  return { promoted, demoted };
}

/** 事件驱动入口：只有节点 done 才触发 ready 重算（不轮询）。 */
export function onEvent(store: Store, event: EventRecord): string[] {
  if (event.kind === "status_changed" && event.payload?.to === "done") {
    return recomputeReady(store, { reason: "dependency_done" }).promoted;
  }
  return [];
}

/** 建图后调用一次：让根节点（无依赖）进入 ready。 */
export function bootstrap(store: Store): string[] {
  return recomputeReady(store, { reason: "bootstrap" }).promoted;
}

const wired = new WeakSet<Store>();

/**
 * 把 `ready` 重算挂到 `graph.setStatus` 的 done 钩子上（幂等）。
 * 等价 Python「done 后 scheduler.on_event 解锁下游」。
 */
export function installReadyHook(store: Store): void {
  if (wired.has(store)) return;
  wired.add(store);
  onNodeDone((target, node: NodeRecord) => {
    if (target !== store) return;
    if (node.status !== "done") return;
    recomputeReady(store, { reason: "dependency_done" });
  });
}
