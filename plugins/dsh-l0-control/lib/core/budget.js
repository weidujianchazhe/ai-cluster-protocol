/**
 * 预算与速率的派生账本（只读推导，不新增状态）。
 *
 * 为什么从 journal 推导而不是另存计数器：
 *  - 单一事实源仍是 journal，重放后数值天然一致，不需要额外恢复逻辑；
 *  - 不会出现「计数器与事件不一致」这类需要修复的偏差。
 *
 * 计量口径：
 *  - 已用 token：证据提交时声明的 `usageTokens`（可选字段，未声明即 0）；
 *  - 全局上限：`policies.budgetTokens`；分区上限：`coordination.partitions[].budgetTokens`；
 *  - 节点上限：`node.budget.maxTokens`。三者相互独立；作用域各自生效，
 *    分区只约束属于自己的节点（含子分区），不会互相误伤。
 *  - 速率（领取层）：最近 `windowMs` 内 `lease_claimed` / `lease_taken_over` 的次数。
 *  - 速率（派发层）在 `dispatch/rate-window.ts`：口径是 `node_enqueued`，因为
 *    派发额度买的是「真的启动了几个 worker」，失败与候选都不该烧额度。
 */
                                        
                                                                              
                                             
import { BudgetError } from "./errors.js";

                                
                
                              
 

/** 全图与逐节点已用 token（由 journal 中的证据事件累加）。 */
export function tokenUsage(store       )                {
  const byNode = new Map                ();
  let total = 0;
  for (const event of store.journal.view()) {
    if (event.kind !== "evidence_added" && event.kind !== "evidence_submitted") continue;
    const raw = Number((event.payload                           )?.usageTokens);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    total += raw;
    const nodeId = event.node_id ?? "";
    byNode.set(nodeId, (byNode.get(nodeId) ?? 0) + raw);
  }
  return { total, byNode };
}

/** 最近 windowMs 内实际发放的租约数（用于跨 tick 的全局速率控制）。 */
export function claimsInWindow(store       , now        , windowMs = 1000)         {
  const since = now - Math.max(0, windowMs);
  let count = 0;
  const events = store.journal.view();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const at = Date.parse(event.ts);
    if (!Number.isFinite(at) || at <= since) break;
    if (event.kind === "lease_claimed" || event.kind === "lease_taken_over") count += 1;
  }
  return count;
}

function budgetOwners(coordination                         )                                     {
  const owners = new Map                               ();
  for (const partition of coordination?.partitions ?? []) {
    for (const nodeId of partition.nodeRefs) owners.set(nodeId, partition);
  }
  return owners;
}

/**
 * 该节点**自己所属的那些分区**（含祖先链），不是全部分区。
 *
 * 为什么必须收窄：预算判定原来遍历 `view.partitions` 的所有分区，于是
 * 「A 分区预算用尽 → B 分区里毫不相干的节点也 claim 不了」。这不是保守，
 * 这是错的：预算的作用域就是它声明的那个作用域，A 花完了不该冻住 B。
 * 千节点多分区场景下，一个热点分区烧完预算就会把整张图冻结。
 *
 * 祖先链要一起查：父分区是子分区的汇总口径，父满了子也不能再超。
 */
function domainsOf(
  nodeId        ,
  coordination                         ,
  owners                                    ,
)                          {
  const byId = new Map((coordination?.partitions ?? []).map((partition) => [partition.id, partition]));
  const domains                          = [];
  const seen = new Set        ();
  let cursor                                    = owners.get(nodeId);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    domains.push(cursor);
    const parentId = cursor.parentId;
    cursor = parentId ? byId.get(parentId) : undefined;
  }
  return domains;
}

                             
                
                      
                                                                
                                                                 
 

/** 预算视图：供 graphStatus / 面板读取，不参与判定。 */
export function budgetView(store       )             {
  const coordination = JSON.parse(store.state.meta.get("graph_coordination") ?? "null")                           ;
  const usage = tokenUsage(store);
  const owners = budgetOwners(coordination);
  const partitionUsed = new Map                ();
  for (const [nodeId, used] of usage.byNode) {
    // 与准入共用同一条祖先链推导：视图报的数就是判定的数，不会「面板显示还剩额度、claim 却被拒」。
    for (const domain of domainsOf(nodeId, coordination, owners)) {
      partitionUsed.set(domain.id, (partitionUsed.get(domain.id) ?? 0) + used);
    }
  }
  const nodes                      = [];
  for (const node of store.state.nodes.values()) {
    const limit = Number(node.budget?.maxTokens ?? 0);
    if (limit > 0) nodes.push({ nodeId: node.node_id, used: usage.byNode.get(node.node_id) ?? 0, limit });
  }
  return {
    total: usage.total,
    globalLimit: Number(store.state.meta.get("wish_budget_tokens") ?? 0),
    nodes: nodes.sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    partitions: (coordination?.partitions ?? [])
      .filter((partition) => Number(partition.budgetTokens) > 0)
      .map((partition) => ({ id: partition.id, used: partitionUsed.get(partition.id) ?? 0, limit: Number(partition.budgetTokens) })),
  };
}

/**
 * 预算准入：任一上限被突破即抛错（调用方在任何写入之前调用）。
 * `extraTokens` 用于「这笔提交本身」的增量，claim 时为 0。
 *
 * **相等算不算超**：`extra > 0`（提交场景）时 `used + extra === limit` **放行**——
 * 这笔提交正好用掉最后一点额度，是合法收尾；只有真的超出才拒。`extra === 0`
 * （claim 场景）时 `used === limit` **拒绝**——claim 问的是「还有没有地方开始干活」，
 * 额度正好用尽就是没有地方。
 *
 * 这条区分是为了和派活计划层对齐：`budgetBlockedNodes` 用 `>=`（额度用尽即不派），
 * 准入原来一律用 `>`，于是「额度正好用尽」的节点计划说别派、claim 却放行。
 * 两层对同一节点给出相反答案，而 `claim` 是直连路径——不经派活的调用方照样能拿到
 * 租约，然后在提交时才发现没额度。
 *
 * **快路径**：三个上限（全图 / 分区 / 节点）全为 0 时直接返回，不做任何扫描。
 * 为什么重要：`budgetView()` 要遍历全部 journal 事件累加 token，是 O(events)；
 * 而绝大多数图**根本没设预算上限**（`budgetTokens: 0`）。无脑扫一遍的代价是
 * 每次 claim 多 O(events)，总成本从 O(n) 退化成 O(n²) —— 千节点实测就是这么
 * 塌到 30 节点/秒的。上限全 0 时预算永远不可能超，早退是语义等价的。
 */
export function assertBudget(store       , nodeId        , extraTokens = 0)       {
  const extra = Number.isFinite(extraTokens) && extraTokens > 0 ? Math.floor(extraTokens) : 0;
  /** 是否已经越界：0 增量问「有没有地方」，正增量问「这笔放不放得下」。 */
  const exceeds = (used        , limit        )          =>
    extra > 0 ? used + extra > limit : used >= limit;
  if (!hasAnyBudgetLimit(store)) return;
  const view = budgetView(store);
  if (view.globalLimit > 0 && exceeds(view.total, view.globalLimit)) {
    throw new BudgetError(`全图预算超限：已用 ${view.total}，上限 ${view.globalLimit}，本次 ${extra}`, "budget_exceeded", "budget");
  }
  // 只查本节点所属分区（含祖先链），不是全部分区——见 domainsOf 的说明。
  const coordination = JSON.parse(store.state.meta.get("graph_coordination") ?? "null")                           ;
  const usedByPartition = new Map(view.partitions.map((entry) => [entry.id, entry]));
  for (const domain of domainsOf(nodeId, coordination, budgetOwners(coordination))) {
    const limit = Number(domain.budgetTokens ?? 0);
    if (limit <= 0) continue;
    const used = usedByPartition.get(domain.id)?.used ?? 0;
    if (exceeds(used, limit)) {
      throw new BudgetError(`协调域 ${domain.id} 预算超限：已用 ${used}，上限 ${limit}`, "budget_exceeded", "budget");
    }
  }
  const node = store.state.nodes.get(nodeId)                          ;
  const nodeLimit = Number(node?.budget?.maxTokens ?? 0);
  const nodeUsed = view.nodes.find((entry) => entry.nodeId === nodeId)?.used ?? 0;
  if (nodeLimit > 0 && exceeds(nodeUsed, nodeLimit)) {
    throw new BudgetError(`节点 ${nodeId} 预算超限：已用 ${nodeUsed}，上限 ${nodeLimit}`, "budget_exceeded", "budget");
  }
}

/**
 * 这张图上是否存在**任何**预算上限。
 *
 * 读的全是内存状态（meta + 节点表 + 协调域），不碰 journal —— 所以它比
 * `budgetView()`（要遍历全部证据事件累加 token）便宜几个数量级。
 *
 * 注意：这不是严格 O(1)，节点多时是 O(nodes)；但它只做数值比较、不解析事件，
 * 千节点量级在微秒级。真正的 O(1) 早退点是下面三个上限都为 0 的情形——
 * 而绝大多数图确实没设任何上限。
 */
function hasAnyBudgetLimit(store       )          {
  if (Number(store.state.meta.get("wish_budget_tokens") ?? 0) > 0) return true;
  const coordination = JSON.parse(store.state.meta.get("graph_coordination") ?? "null")                           ;
  for (const partition of coordination?.partitions ?? []) {
    if (Number(partition.budgetTokens ?? 0) > 0) return true;
  }
  for (const node of store.state.nodes.values()) {
    if (Number(node.budget?.maxTokens ?? 0) > 0) return true;
  }
  return false;
}

/** 预算耗尽的原因：供派活计划解释「为什么这一轮不派它」。 */
                              
                 
                                  
                
                  
               
                
 

/**
 * 一次性算出**所有**已耗尽预算的节点，供派活计划过滤。
 *
 * 为什么需要它：`planDispatchTick` 原来完全不看预算，于是候选里会包含
 * 注定被 `task_claim` 拒绝的节点。派出去 → claim 被拒 → worker 按契约停手，
 * 每个这样的节点白白烧一次 spawn；而登记释放后它下一轮又会被选中，
 * 形成「派了被拒、拒了再派」的空转。派活计划必须和准入用同一套预算口径。
 *
 * 返回 Map 而不是逐个 `assertBudget` 抛错：计划要的是「跳过并说明原因」，
 * 不是「第一个超限就中断整轮」。
 */
export function budgetBlockedNodes(store       )                           {
  const blocked = new Map                     ();
  if (!hasAnyBudgetLimit(store)) return blocked;
  const view = budgetView(store);
  if (view.globalLimit > 0 && view.total >= view.globalLimit) {
    // 全图满：所有节点都派不出去，但原因要落到每个节点上，调用方才好解释。
    for (const node of store.state.nodes.values()) {
      blocked.set(node.node_id, {
        nodeId: node.node_id,
        scope: "global",
        scopeId: "graph",
        used: view.total,
        limit: view.globalLimit,
      });
    }
    return blocked;
  }
  const coordination = JSON.parse(store.state.meta.get("graph_coordination") ?? "null")                           ;
  const owners = budgetOwners(coordination);
  const usedByPartition = new Map(view.partitions.map((entry) => [entry.id, entry]));
  const nodeUsage = new Map(view.nodes.map((entry) => [entry.nodeId, entry]));
  for (const node of store.state.nodes.values()) {
    const nodeId = node.node_id;
    for (const domain of domainsOf(nodeId, coordination, owners)) {
      const limit = Number(domain.budgetTokens ?? 0);
      if (limit <= 0) continue;
      const used = usedByPartition.get(domain.id)?.used ?? 0;
      if (used >= limit) {
        blocked.set(nodeId, { nodeId, scope: "partition", scopeId: domain.id, used, limit });
        break;
      }
    }
    if (blocked.has(nodeId)) continue;
    const own = nodeUsage.get(nodeId);
    if (own && own.limit > 0 && own.used >= own.limit) {
      blocked.set(nodeId, { nodeId, scope: "node", scopeId: nodeId, used: own.used, limit: own.limit });
    }
  }
  return blocked;
}

//# sourceURL=core\budget.js