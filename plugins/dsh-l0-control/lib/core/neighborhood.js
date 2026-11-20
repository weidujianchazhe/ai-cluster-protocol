/**
 * 邻域感知：**只读已完成节点的定长摘要**，两个方向。
 *
 * ## 两个方向，纵向比横向更重要
 *
 * | 方向 | 载体 | 为什么 |
 * |---|---|---|
 * | **横向** | `coordination.partitions` 同分区 | 「我这个域里别人做了什麼」 |
 * | **纵向** | **`node.deps` 直接上游** | 「**我依赖的东西已经做成什么样**」 |
 *
 * 纵向有三个优势，都比横向强：
 *
 * 1. **`deps` 是显式的** —— 写在 graph 里，不需要有人去配 partitions。
 *    实际图里常常一个分区都没有，但每个节点都有 deps。
 * 2. **能 claim 时上游必然已完成** —— `deps` 全 `done` 是节点变 `ready` 的前提，
 *    所以读纵向**一定有数据可读**，不会像横向那样常常返回空。
 * 3. **比横向更严守可复现** —— 横向邻域取决于"分区里还有谁"，纵向只取决于
 *    **这个节点自己的 deps**（静态）+ `done`（终态）。完全确定。
 *
 * ## 三条硬约束（两个方向共用）
 *
 * 1. **单向**：新节点读已完成的邻居；邻居不知道、不等待。执行顺序不变。
 * 2. **无环 —— 只读 `done`**：`done` 是不可退出的终态，所以"某时刻有哪些 done 邻居"
 *    由 journal 的 seq 唯一决定 ⇒ 同一段历史回放出同一个邻域。
 *    允许读进行中的节点会让邻域随时刻漂移，那才破坏可复现。
 * 3. **只读 `title` / `spec`，不读盘**：读盘会让感知变成 I/O 依赖，还会让人读到半成品。
 *
 * ## 深度只到 1，不做祖先链
 *
 * `deps` 是 DAG，递归读祖先会爆：一个节点的 deps 有 3 个、各自的 deps 又有 4 个，
 * 深度 3 就是 24 个祖先。**深度 1 是安全的；更深的要看真需求再谈**。
 *
 * ## 成本必须算清楚
 *
 * 「让节点知道更多」在这套架构里按 `maxParallel × 每轮上下文` 线性放大。所以：
 *   - **定长截断**（`maxNeighbors` / `charsPerNeighbor`），不随图规模增长；
 *   - **算出估算 token** 随返回，让调用方知道买了多少；
 *   - **按需调用**（独立工具），不调就不花 —— 零默认成本。
 */

                                        
                                                             

const DEFAULT_CHARS = 120;
const DEFAULT_MAX = 5;

/** 邻域来源：纵向（直接上游）还是横向（同分区）。 */
                                              

/** 感知方向。默认 `partition`（保持旧行为），纵向要显式指定。 */
                                                                  

                                 
                 
                
                                      
                  
                             
                 
                                          
                           
                                                  
                   
 

                               
           
                                   
                               
                             
                              
           
                                
                 
                             
                     
                               
                        
                         
                          
                  
                  
                          
                               
    
         
                         
                  
    
               
                                                        
                        
                                 
                  
 

/**
 * 读分区定义。
 *
 * 分区不直接挂在 `state` 上，而是序列化在 `state.meta.get("graph_coordination")` 里
 * （一个 JSON 字符串，由 `graphspec.ts` 写入、`fold` 重放）。所以统一走那个入口。
 */
function readPartitions(store       )                                             {
  try {
    const raw = store.state.meta.get('graph_coordination');
    if (!raw) return [];
    const parsed = JSON.parse(String(raw))                                                                      ;
    return Array.isArray(parsed?.partitions) ? parsed.partitions : [];
  } catch {
    // 分区定义坏了不影响邻域功能：当作「不在任何分区」处理，而不是抛错
    return [];
  }
}

/** 找节点所属分区（只认直接归属，不向上找父分区）。 */
export function partitionOf(store       , nodeId        )                {
  for (const p of readPartitions(store)) {
    if (Array.isArray(p?.nodeRefs) && p.nodeRefs.includes(nodeId)) return String(p.id ?? '') || null;
  }
  return null;
}

function digestOf(
  store       ,
  id        ,
  via             ,
  chars        ,
  verifiedByNode                     ,
)                        {
  const n = store.state.nodes.get(id)                          ;
  if (!n) return null;
  // **只读 done**：这是「无环」的保证 —— done 是终态，不会在读完之后变化
  if (n.status !== 'done') return null;
  const spec = String(n.spec ?? '');
  const summary = spec.length > chars ? `${spec.slice(0, chars)}…` : spec;
  return {
    nodeId: id,
    title: String(n.title ?? ''),
    summary,
    doneAt: String(n.updated_at ?? ''),
    verifiedEvidence: verifiedByNode.get(id) ?? 0,
    via,
  };
}

/** 最近的在前；时间相同按 nodeId 稳定排序（保证可回放）。 */
function sortStable(list                  )                   {
  return list.sort((a, b) => {
    if (a.doneAt !== b.doneAt) return a.doneAt < b.doneAt ? 1 : -1;
    return a.nodeId < b.nodeId ? -1 : 1;
  });
}

/**
 * 算一个节点的邻域摘要。**纯读**：不写 journal、不读盘。
 *
 * @param opts.direction 'partition'（默认，横向）| 'deps'（纵向深度 1）| 'both'
 * @param opts.maxNeighbors 最多几个（默认 5）
 * @param opts.charsPerNeighbor 每条多少字（默认 120）
 */
export function neighborhoodOf(
  store       ,
  nodeId        ,
  opts                                                                                          = {},
)               {
  const direction                        = opts.direction === 'deps' || opts.direction === 'both' ? opts.direction : 'partition';
  const maxNeighbors = Number.isFinite(Number(opts.maxNeighbors))
    ? Math.max(0, Math.floor(Number(opts.maxNeighbors)))
    : DEFAULT_MAX;
  const chars = Number.isFinite(Number(opts.charsPerNeighbor))
    ? Math.max(20, Math.floor(Number(opts.charsPerNeighbor)))
    : DEFAULT_CHARS;

  const node = store.state.nodes.get(nodeId)                          ;
  const deps = Array.isArray(node?.deps) ? node .deps : [];

  // 已完成的证据数（粗糙可信度提示）
  const verifiedByNode = new Map                ();
  for (const e of store.state.evidence.values()                            ) {
    if (e.provenance === 'verified') {
      verifiedByNode.set(e.node_id, (verifiedByNode.get(e.node_id) ?? 0) + 1);
    }
  }

  // ── 纵向：直接 deps 里已完成的 ──
  const depDigests                   = [];
  if (direction === 'deps' || direction === 'both') {
    for (const id of deps) {
      if (id === nodeId) continue;
      const d = digestOf(store, id, 'dep', chars, verifiedByNode);
      if (d) depDigests.push(d);
    }
    sortStable(depDigests);
  }

  // ── 横向：同分区里已完成的 ──
  const partitionId = partitionOf(store, nodeId);
  let partitionRefs           = [];
  const partDigests                   = [];
  if (direction === 'partition' || direction === 'both') {
    if (partitionId) {
      partitionRefs = (readPartitions(store).find((p) => String(p.id) === partitionId)?.nodeRefs ?? [])            ;
      for (const id of partitionRefs) {
        if (id === nodeId) continue; // 不含自己
        const d = digestOf(store, id, 'partition', chars, verifiedByNode);
        if (d) partDigests.push(d);
      }
      sortStable(partDigests);
    }
  }

  /**
   * 合并且**上游优先**。
   *
   * 理由：上游是「我依赖的东西」，不读它就做不对；同分区是「同域里别人做了什么」，
   * 略过几个不影响正确性。所以名额有限时先给上游。
   */
  const merged                   = [];
  const seen = new Set        ();
  for (const d of depDigests) {
    if (seen.has(d.nodeId)) continue;
    seen.add(d.nodeId);
    merged.push(d);
  }
  for (const d of partDigests) {
    if (seen.has(d.nodeId)) continue; // 同一节点既在上游又在分区 → 只算一次（保留 dep 标记）
    seen.add(d.nodeId);
    merged.push(d);
  }

  const shown = maxNeighbors === 0 ? merged : merged.slice(0, maxNeighbors);
  const totalChars = shown.reduce((s, n) => s + n.title.length + n.summary.length, 0);
  const depsDone = deps.filter((id) => store.state.nodes.get(id)?.status === 'done').length;

  const caveats           = [];
  /**
   * 机器可判的标记，与 `caveat`（人读文本）**分开**。
   *
   * 之前只有 `caveat: 'no-partition'`（机器可判但不可读），改成人读文本后又变成
   * 程序找不到依据。**两个消费者需要两种形式**，所以都给：
   *   - `caveatFlags`：给程序判（`no-partition` / `deps-pending` / `truncated`）
   *   - `caveat`：给人读
   */
  const caveatFlags           = [];
  if (deps.length > 0 && depsDone < deps.length) {
    caveatFlags.push('deps-pending');
    caveats.push(`${deps.length} 个依赖里有 ${deps.length - depsDone} 个尚未完成，未纳入邻域`);
  }
  if (merged.length > shown.length) {
    caveatFlags.push('truncated');
    caveats.push(`还有 ${merged.length - shown.length} 个已完成邻居未展示（受 maxNeighbors 限制）`);
  }
  if (!partitionId && (direction === 'partition' || direction === 'both')) {
    caveatFlags.push('no-partition');
    caveats.push('该节点不在任何分区里，横向邻域为空（要启用请放进 coordination.partitions[].nodeRefs）');
  }

  return {
    ok: true,
    direction,
    partitionId,
    neighbors: shown,
    totals: {
      deps: deps.length,
      depsDone,
      inPartition: partitionRefs.length,
      partitionDone: partDigests.length,
      shown: shown.length,
      shownFromDeps: shown.filter((n) => n.via === 'dep').length,
      shownFromPartition: shown.filter((n) => n.via === 'partition').length,
    },
    cost: { approxTokens: Math.ceil(totalChars / 3), chars: totalChars },
    /** 机器可判的标记（与 `caveat` 的人读文本分开）。空数组表示没有需要提示的情况。 */
    caveatFlags,
    note:
      '只读已完成节点（done 是终态，同一段历史回放出同一个邻域）。' +
      '纵向只到直接依赖（深度 1，不做祖先链）。摘要来自 title/spec，**不读盘上的产物**。' +
      '这些内容不参与任何判定，只作为参考上下文。',
    ...(caveats.length ? { caveat: caveats.join('；') } : {}),
  };
}


//# sourceURL=core\neighborhood.js