/**
 * ready 门控（Python `scheduler.py` 的等价物）。
 *
 * 规则：
 *  - `ready` 只能由「依赖全部 done」推出；不是轮询，而是由 done 事件触发 `onEvent()`；
 *  - 依赖不满足的 ready 会被降回 `planned`（防假 ready）；
 *  - 根节点（无依赖）在 bootstrap 首次重算时进入 ready。
 */
                                                          
import { getNode, listNodes, onNodeDone, setStatus } from "./graph.js";
                                        

                              
                     
                    
 

                                   
                  
              
                                                
                   
     
                                               
                                                  
     
                       
 

/**
 * 依赖是否全部 done。
 *
 * **直接读内存表，不 `getNode()`**：`getNode()` 会 `cloneNode()`（深拷贝 record 全字段），
 * 而这里只需要一个 `status` 字符串。`recomputeReady` 每次全量重算会对**每个**节点的
 * **每条**依赖调一次本函数——千节点 × 1 依赖就是 1000 次深克隆/次调用，而 `task_next`
 * 一次跑里会调它上千次。这是「看起来只是读个状态」却付了深拷贝的典型。
 *
 * 只读 `.status`，不把 record 传出去，因此不需要 `getNode` 的防御性拷贝。
 */
export function depsDone(store       , deps          )          {
  for (const dep of deps) {
    if (store.state.nodes.get(dep)?.status !== "done") return false;
  }
  return true;
}

/**
 * `readySet()` 的缓存：就绪集合只在「状态迁移 / 节点增删 / 依赖变更」时才会变，
 * 用 `store.epoch` 当版本号（由 `graph.ts` 的变更函数 bump，只增不减）。
 *
 * 为什么必须缓存：`readySet()` 要遍历全图筛 ready 再排序，而 `task_next` 每问一次活
 * 就要一份有序 ready 列表。1000→2000 节点实测每步成本涨 26%，增量就在这里。
 *
 * 为什么用 `epoch` 而不是 `journal.count()`：`atomically()` 回滚会把日志截短，
 * 之后重写可能回到同一条数而内容不同——那样的键会命中过期缓存、**派错节点**。
 * `epoch` 由变更函数自己 bump，回滚不退回，因此不存在「同键两种内容」。
 */
const readyCache = new WeakMap                                                         ();

/**
 * 就绪节点集合（按 created_at → node_id 排序，与 `listNodes` 同序）。
 *
 * **为什么不用 `listNodes().filter(...)`**：`listNodes` 对**全部**节点排序
 * （O(n log n)），而 `verifyDone` 每次要算两回（前后对比得 promoted）。
 * 只对 ready 子集排序，结果顺序完全相同（排序键相同，只是先过滤）。
 *
 * **返回的是副本**：调用方可以自由排序/修改（旧实现的语义），缓存不会被外部写坏。
 *
 * 缓存键同时含 `store.state` 的**对象身份**：`rehydrate()` 会整体替换 `store.state`，
 * 只靠 `epoch` 的话那次替换不会 bump，就会留下过期缓存。
 */
export function readySet(store       )           {
  const cached = readyCache.get(store);
  if (cached && cached.state === store.state && cached.epoch === store.epoch) return cached.ids.slice();
  const ready               = [];
  for (const node of store.state.nodes.values()) {
    if (node.status === "ready") ready.push(node);
  }
  const ids = ready
    .sort((a, b) =>
      a.created_at === b.created_at
        ? a.node_id.localeCompare(b.node_id)
        : a.created_at.localeCompare(b.created_at),
    )
    .map((node) => node.node_id);
  readyCache.set(store, { state: store.state, epoch: store.epoch, ids });
  return ids.slice();
}

/**
 * 重算 ready：先降级非法 ready，再晋升依赖已满足的 planned。
 *
 * **增量优化**：全量版会对每个节点跑 `depsDone`（每个 dep 一次 Map 查），
 * 1000 节点图上约 0.45ms，而它被挂在**每个 done 钩子**上 —— 也就是每完成
 * 一个节点就全图重算一次，总成本 O(n²)。
 *
 * 真正会变动的只有两类节点：
 *   1. 被降级的：只可能是**当前 ready** 的（planned 不可能已经满足... 反过来，
 *      只有 ready 的依赖才可能因为别的原因失效）；
 *   2. 被晋升的：只可能是**依赖里包含刚 done 的那个节点**的 planned。
 *
 * 所以给出 `unblockedBy`（刚完成的节点）时，只扫「ready 集合 + 该节点的直接
 * 后继」，结果与全量重算等价，成本从 O(nodes) 降到 O(ready + 后继数)。
 *
 * 不传 `unblockedBy` 时走全量（bootstrap / replan / 显式 recompute 需要）。
 */
export function recomputeReady(store       , options                   = {})              {
  const reason = options.reason ?? "recompute";
  const promoted           = [];
  const demoted           = [];
  const unblockedBy = options.unblockedBy;
  const incremental = typeof unblockedBy === "string" && unblockedBy.length > 0;

  // 候选集：增量模式下只看「当前 ready」+「依赖含 unblockedBy 的节点」
  let candidates              ;
  if (incremental) {
    candidates = [];
    for (const node of store.state.nodes.values()) {
      if (node.status === "ready") candidates.push(node);
      else if (node.status === "planned" && node.deps.includes(unblockedBy          )) candidates.push(node);
    }
  } else {
    // 全量模式**不排序、不克隆**：本函数只判断「谁该升降」，产出 `promoted`/`demoted`
    // 两个数组，末尾各自 `sort()` 过，因此候选顺序不参与任何可观测结果。
    //
    // 旧实现用 `listNodes(store)`——它做一次全量排序 **并且对每个节点 `cloneNode`**。
    // 而 `task_next`（worker 唯一问「我现在能干什么」的入口，千节点实测被调 2479 次
    // 才完成 1000 个节点）每次调用都会进来，于是每次白付一次全量排序 + N 次深克隆；
    // `task_next` 自己随后又 `listNodes()` 一遍，等于**每次问活都克隆两遍全图**。
    candidates = [...store.state.nodes.values()];
  }

  const status = new Map                (candidates.map((n) => [n.node_id, n.status]));

  // 1) 降级：ready 但依赖未全 done
  for (const node of candidates) {
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
  for (const node of candidates) {
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
  // 顺序稳定：增量模式的候选集来自 Map 遍历，按 node_id 归一便于断言
  promoted.sort();
  demoted.sort();
  return { promoted, demoted };
}

/** 事件驱动入口：只有节点 done 才触发 ready 重算（不轮询）。 */
export function onEvent(store       , event             )           {
  if (event.kind === "status_changed" && event.payload?.to === "done") {
    return recomputeReady(store, {
      reason: "dependency_done",
      unblockedBy: event.node_id ?? undefined,
    }).promoted;
  }
  return [];
}

/** 建图后调用一次：让根节点（无依赖）进入 ready。 */
export function bootstrap(store       )           {
  return recomputeReady(store, { reason: "bootstrap" }).promoted;
}

const wired = new WeakSet       ();

/**
 * 把 `ready` 重算挂到 `graph.setStatus` 的 done 钩子上（幂等）。
 * 等价 Python「done 后 scheduler.on_event 解锁下游」。
 */
export function installReadyHook(store       )       {
  if (wired.has(store)) return;
  wired.add(store);
  onNodeDone((target, node            ) => {
    if (target !== store) return;
    if (node.status !== "done") return;
    // 增量：只有依赖含本节点的 planned 才可能被解锁（其余节点状态不变）
    recomputeReady(store, { reason: "dependency_done", unblockedBy: node.node_id });
  });
}


//# sourceURL=core\ready.js