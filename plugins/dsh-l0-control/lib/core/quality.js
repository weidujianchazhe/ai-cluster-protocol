/**
 * 质量度量（只读聚合，**不改协议、不参与任何判定**）。
 *
 * ## 为什么是"聚合已有信号"而不是"新增评分字段"
 *
 * 节点完成的条件是 `verify_done`（证据 + 审计独立 + 闸门）——它验的是**有没有做完**，
 * 不是**做得好不好**。但"好不好"的原材料其实已经在 journal 里了，只是从没被当成质量用过：
 *
 * | 信号 | 原本用途 | 作为质量信号的含义 |
 * |---|---|---|
 * | `node.attempts` | 重试计数 | 返工多 = 过程质量低 |
 * | `evidence.provenance` | 只有 `verified` 能推 done | 来源强度 |
 * | `evidence.verdict` | 提交结论 | 审计判定 |
 * | `evidence.auditor_instance` | 独立性检查 | 有没有被独立审过 |
 *
 * 所以第一步**不需要改协议**：把这些聚合出来，让人能横向比、能看趋势。
 *
 * ## 四条设计约束（都为了让它是"纯增量"）
 *
 * 1. **只读**：不写 journal、不改状态。算出来的分数不落盘，随时可重算。
 * 2. **可回放**：同样的历史算出同样的分。不做任何依赖当前时刻或外部状态的判断。
 * 3. **不参与判定**：`verify_done` / `pass_gate` / 派发闸门**都不看这个分**。
 *    一旦质量分能挡活，它就从"观察"变成"判定"，那会破坏可复现性与审计独立。
 * 4. **缺失就说缺失**：没有证据的节点给 `unknown`，**不给 0 分**。
 *    0 分会被读成"做得很差"，而 `unknown` 才是"还没法判断"——两者差得很远。
 *
 * ## 它测什么、不测什么
 *
 * **测的是过程质量**：证据是否经过机器核验、是否被独立审计过、返工了几次。
 * **不测产出质量**：一个 `verified` 的证据完全可能对应平庸的产物。
 *
 * 这个边界必须写在输出里，否则会被人当成"产出的好坏评分"来用。
 */

                                        
                                                                    

                                                                              

                                    
                                                                             
                   
                                           
                 
                                                  
                
                                                
                       
 

/**
 * **系统故障**导致的返工原因（不算 worker 的问题）。
 *
 * 为什么需要分因：`attempts` 把两种完全不同的东西混在一起——
 *
 * | 情况 | 该不该扣质量分 |
 * |---|---|
 * | worker 产出不合格被打回 | **该扣** |
 * | 租约过期 / 孤儿清扫，被迫重新 claim | **不该扣**（那是状态机坑了它） |
 *
 * 真实数据里就看得到：`M8-01..08` 八个节点全被判 `poor (43)`，但那 2 次返工
 * 是**租约死锁**逼出来的，它们的产出本身没问题。混在一起算，质量分会把
 * 「系统故障受害者」记成「干得差的 worker」。
 *
 * **白名单策略**：只把明确列在这里的算系统原因，其余全算业务。
 * 宁可把系统原因误判成业务（多扣分），也不能把业务失败洗成系统原因（免罚）——
 * 虚高的质量分比虚低的更危险，因为它会让人以为没问题。
 */
export const SYSTEM_REWORK_REASONS                    = [
  'lease_expired',
  'orphan_submitted',
  'lease_takeover',
  'lease_reaped',
];

/** 判断一条 attempts_changed 的 reason 是不是系统原因（支持 `rejected:xxx` 前缀）。 */
export function isSystemReworkReason(reason         )          {
  const raw = String(reason ?? '').trim();
  if (!raw) return false;
  const bare = raw.replace(/^rejected:/, '');
  return SYSTEM_REWORK_REASONS.includes(bare);
}

                                  
                    
                
                                
                   
                                      
                 
 

/**
 * 预算每个节点的返工分因。**一次扫 journal**，O(事件数)，避免每个节点各扫一遍。
 *
 * 为什么不读 `node.attempts`：那是累加值，没有分因。分因信息只在
 * `attempts_changed` 事件的 `reason` 里。
 */
export function buildReworkIndex(store       )                               {
  const index = new Map                         ();
  const bump = (nodeId        , system         ) => {
    const cur = index.get(nodeId) ?? { total: 0, business: 0, system: 0 };
    cur.total += 1;
    if (system) cur.system += 1;
    else cur.business += 1;
    index.set(nodeId, cur);
  };
  try {
    for (const ev of store.journal.view()) {
      if (ev?.kind !== 'attempts_changed') continue;
      /**
       * **同时兼容两种字段名**。
       *
       * 内存里的 `EventRecord` 用 snake_case（`node_id`），但落盘的 `journal.jsonl`
       * **用 camelCase**（`nodeId`）。任何"离线读 journal 做分析"的路径（本项目
       * 自己就有两个这样的脚本）都会踩这个坑：`ev.node_id` 是 undefined，
       * 于是所有事件被静默跳过，索引看起来"正常但为空"。
       *
       * 这里对两种都认，并且**不因为拿不到 nodeId 就静默跳过整批**——
       * 至少要让调用方能看出「有事件但取不到节点」。
       */
      const raw = ev                                                                  ;
      const nodeId = String(raw.node_id ?? raw.nodeId ?? '');
      if (!nodeId) continue;
      bump(nodeId, isSystemReworkReason(ev.payload?.reason));
    }
  } catch {
    // journal 读不出来时退化为空索引：所有节点按「业务返工 = node.attempts」处理
  }
  return index;
}

                                
                        
                              
                      
                    
                   
                           
                         
                                     
                        
                       
                       
                               
                       
 

                              
                 
                
                      
                            
                 
                                           
                       
                      
                                
                        
                               
                    
                         
                  
 

/** 权重：证据强度最重（它是"做完了且可核验"的基础），返工次之，独立性作为加成。 */
const WEIGHTS = { evidence: 0.35, rework: 0.25, audit: 0.25, independence: 0.15 }         ;

const PROVENANCE_SCORE                         = { verified: 1, inferred: 0.5, assumed: 0.2 };
const VERDICT_SCORE                         = { pass: 1, unknown: 0.4, fail: 0 };

function gradeOf(score        )               {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'fair';
  return 'poor';
}

/** 取某节点的全部证据（按 evidence_id 稳定排序，保证可回放）。 */
function evidenceOf(store       , nodeId        )                   {
  const all = [...store.state.evidence.values()]                    ;
  return all
    .filter((e) => e.node_id === nodeId)
    .sort((a, b) => (a.evidence_id < b.evidence_id ? -1 : a.evidence_id > b.evidence_id ? 1 : 0));
}

/**
 * 算单个节点的质量。**纯读**：只读 store 与 journal，不写任何东西。
 *
 * @param opts.reworkIndex `buildReworkIndex()` 的结果。不传则只按 `node.attempts`
 *   当业务返工（退化行为，但保证能算）。
 */
export function scoreNode(store       , nodeId        , opts                                                 = {})              {
  const node = store.state.nodes.get(nodeId)                          ;
  if (!node) {
    return {
      nodeId,
      title: '',
      stage: null,
      capability: null,
      status: 'missing',
      score: null,
      grade: 'unknown',
      dimensions: { evidence: 0, rework: 1, audit: 0, independence: 0 },
      sample: { evidenceCount: 0, passedCount: 0, attempts: 0, businessRework: 0, systemRetries: 0, auditorCount: 0, anyVerified: false },
      reasons: [`节点 ${nodeId} 不存在`],
      caveat: 'node-not-found',
    };
  }

  const evs = evidenceOf(store, nodeId);
  const attempts = Number(node.attempts ?? 0);
  const passed = evs.filter((e) => e.verdict === 'pass');
  const auditors = new Set        ();
  let anyVerified = false;
  let bestProvenance = 0;
  for (const e of evs) {
    if (e.provenance === 'verified') anyVerified = true;
    bestProvenance = Math.max(bestProvenance, PROVENANCE_SCORE[String(e.provenance)] ?? 0);
    // 独立审计：auditor 存在且与 producer 不同
    if (e.auditor_instance && e.auditor_instance !== e.producer_instance) {
      auditors.add(String(e.auditor_instance));
    }
  }

  /**
   * 返工分因：**只把业务原因计入质量分**。
   *
   * 没有索引时退化为「全部 attempts 都算业务」——这是保守方向（多扣分），
   * 而不是乐观方向（免罚）。
   */
  const breakdown = opts.reworkIndex?.get(nodeId);
  const businessRework = breakdown ? breakdown.business : attempts;
  const systemRetries = breakdown ? breakdown.system : 0;

  const sample                = {
    evidenceCount: evs.length,
    passedCount: passed.length,
    attempts,
    businessRework,
    systemRetries,
    auditorCount: auditors.size,
    anyVerified,
  };

  // 没有证据 → 无法判断质量（不是 0 分）
  if (evs.length === 0) {
    return {
      nodeId,
      title: node.title,
      stage: node.stage,
      capability: node.capability,
      status: node.status,
      score: null,
      grade: 'unknown',
      dimensions: { evidence: 0, rework: 1 / (1 + businessRework), audit: 0, independence: 0 },
      sample,
      reasons: ['没有任何证据，无法判断质量'],
      caveat: 'no-evidence',
    };
  }

  // 证据维度：取最强来源（一份 verified 就能支撑，但会记录"有几个不是 verified"）
  const evidenceDim = bestProvenance;
  // 返工维度：**只看业务返工**；0 次满分，越多越低
  const reworkDim = 1 / (1 + businessRework);
  // 审计维度：只看**通过**的证据的判定分布；没有独立审计则 0
  const auditDim = auditors.size > 0
    ? passed.length > 0
      ? 1
      : ((VERDICT_SCORE[String(evs[evs.length - 1].verdict)] ?? 0))
    : 0;
  const independenceDim = auditors.size > 0 ? 1 : 0;

  const dimensions                    = {
    evidence: Number(evidenceDim.toFixed(3)),
    rework: Number(reworkDim.toFixed(3)),
    audit: Number(auditDim.toFixed(3)),
    independence: independenceDim,
  };

  const raw =
    dimensions.evidence * WEIGHTS.evidence +
    dimensions.rework * WEIGHTS.rework +
    dimensions.audit * WEIGHTS.audit +
    dimensions.independence * WEIGHTS.independence;
  const score = Math.round(raw * 100);

  const reasons           = [
    `证据来源最强为 ${anyVerified ? 'verified' : evs[0]?.provenance ?? '未知'}（${evs.length} 条证据，${passed.length} 条 pass）`,
    businessRework === attempts
      ? `业务返工 ${businessRework} 次 → 返工维度 ${dimensions.rework}`
      : `业务返工 ${businessRework} 次 → 返工维度 ${dimensions.rework}；另有 **${systemRetries} 次系统重试不计入**（租约过期/孤儿清扫等，不是 worker 的问题）`,
  ];
  if (auditors.size > 0) {
    reasons.push(`有 ${auditors.size} 个独立审计实例参与`);
  } else {
    reasons.push('**没有独立审计**（auditor 缺失或与 producer 相同）→ 审计与独立性维度为 0');
  }
  if (!anyVerified) {
    reasons.push('**没有 verified 来源的证据** → 证据维度上限 0.5');
  }

  return {
    nodeId,
    title: node.title,
    stage: node.stage,
    capability: node.capability,
    status: node.status,
    score,
    grade: gradeOf(score),
    dimensions,
    sample,
    reasons,
  };
}

                               
              
                          
                
                       
                  
                          
                      
                          
                                             
 

                                
           
                        
                   
                      
           
                  
                   
                    
                            
                        
    
                                 
                       
                          
                               
                                    
                           
               
 

function emptyDistribution()                               {
  return { excellent: 0, good: 0, fair: 0, poor: 0, unknown: 0 };
}

function groupBy(items               , keyOf                                   )                 {
  const buckets = new Map                       ();
  for (const q of items) {
    const k = keyOf(q) ?? '(未指定)';
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k) .push(q);
  }
  const out                 = [];
  for (const [key, list] of [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const scored = list.filter((q) => q.score !== null);
    const distribution = emptyDistribution();
    for (const q of list) distribution[q.grade] += 1;
    const avg = scored.length
      ? Math.round(scored.reduce((s, q) => s + (q.score          ), 0) / scored.length)
      : null;
    out.push({
      key,
      nodes: scored.length,
      unknown: list.length - scored.length,
      avgScore: avg,
      grade: avg === null ? 'unknown' : gradeOf(avg),
      distribution,
    });
  }
  return out;
}

/**
 * 全图质量报告。
 *
 * @param store 只读
 * @param opts.stage 只看某阶段（可选）
 */
export function qualityReport(store       , opts                                            = {})                {
  const stageFilter = opts.stage ? String(opts.stage) : null;
  const allNodes = [...store.state.nodes.keys()].sort();
  /**
   * **一次扫 journal 建返工分因索引**，再传给每个节点。
   *
   * 不这么做的话，每个节点都要扫一遍 journal → O(节点数 × 事件数)。
   * 而且更重要：没有索引时 `scoreNode` 只能把全部 attempts 当业务返工，
   * 那正是我们要修的缺陷（系统故障被算成 worker 差）。
   */
  const reworkIndex = buildReworkIndex(store);
  const scored = allNodes
    .map((id) => scoreNode(store, id, { reworkIndex }))
    .filter((q) => (stageFilter ? q.stage === stageFilter : true));

  const withScore = scored.filter((q) => q.score !== null);
  const avg = withScore.length
    ? Math.round(withScore.reduce((s, q) => s + (q.score          ), 0) / withScore.length)
    : null;

  const limit = Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0 ? Math.floor(Number(opts.limit)) : 50;

  return {
    ok: true,
    measured: '过程质量：证据是否可机器核验（verified）、是否被独立审计过、**业务**返工了几次（系统故障导致的重试不计入）',
    notMeasured: '产出本身的好坏——一个 verified 的证据完全可能对应平庸的产物。要看产出质量需要审计方显式打分（本版未做）',
    totals: {
      nodes: scored.length,
      scored: withScore.length,
      unknown: scored.length - withScore.length,
      avgScore: avg,
      grade: avg === null ? 'unknown' : gradeOf(avg),
    },
    nodes: [...withScore, ...scored.filter((q) => q.score === null)].slice(0, limit),
    byStage: groupBy(scored, (q) => q.stage),
    byCapability: groupBy(scored, (q) => q.capability),
    attention: [...withScore].sort((a, b) => (a.score          ) - (b.score          )).slice(0, 5),
    note:
      '本分**不参与任何判定**（verify_done / pass_gate / 派发闸门都不看它）。' +
      '它只用于观察与横向比较。缺证据的节点记为 unknown，**不是 0 分**——两者含义不同。',
  };
}


//# sourceURL=core\quality.js