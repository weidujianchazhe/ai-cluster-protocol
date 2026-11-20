/**
 * 协作图：从因果标注（`context_refs`）算出「谁读了谁」，并接上质量分。
 *
 * ## 它要回答的问题
 *
 * 单看质量分只能回答「这批活干得好不好」。加了耦合之后才能回答那个真正的问题：
 *
 * > **有耦合的节点，质量是不是更好？**
 *
 * 这是"协作到底有没有用"的唯一实证路径。没有这个对比，「多智能体比单智能体强」
 * 永远只是信念而不是结论。
 *
 * ## 三条诚实约束
 *
 * 1. **它测的是"声明"，不是"证明"**：`context_refs` 是生产者自己填的，没有机制验证
 *    产物真的引用了被引用节点。所以它是"耦合声明图"，不是"事实依赖图"。
 * 2. **样本不足时不下结论**：少于 `MIN_SAMPLE` 个节点时 `delta` 为 null，
 *    并明确写「样本不足」。宁可说不知道，也不给一个会被人当结论的数字。
 * 3. **相关不等于因果**：即便 delta 是正的，也只能说"有耦合的节点质量分更高"，
 *    不能说"因为耦合所以更好"——可能是高能力节点更容易引用别人。
 *
 * ## 为什么它不破坏现有性质
 *
 * 它纯读 journal：不改变执行顺序、不让节点互相等待、不增加任何运行时代价。
 * 被引用的节点甚至不知道自己被读了。所以可复现性、审计独立性、成本线性三条都不受影响。
 */

                                        
                                                             
import { buildReworkIndex, scoreNode } from './quality.js';
                                                 

/** 少于这个样本量就不下「耦合与质量有关」的结论。 */
const MIN_SAMPLE = 3;

                                    
                    
               
                     
             
                           
               
                   
                     
                                                  
                         
 

                                    
                 
                
                    
                  
                     
                   
                          
                  
                              
                             
 

                                      
           
                             
                             
           
                  
                    
                  
                              
                    
                                       
                    
    
     
                               
                                   
     
            
                                                        
                                                         
                                                            
                         
                    
    
                        
                                                   
               
 

function str(v         )         {
  return typeof v === 'string' ? v : '';
}

/**
 * 建协作图。**纯读**：只读 store，不写 journal、不改状态。
 *
 * @param opts.minSample 覆盖默认的最小样本量（测试用）
 */
export function collaborationMap(store       , opts                         = {})                      {
  const minSample = Number.isFinite(Number(opts.minSample)) ? Math.max(1, Number(opts.minSample)) : MIN_SAMPLE;

  const nodeIds = [...store.state.nodes.keys()].sort();
  const nodeMap = new Map                    ();
  for (const id of nodeIds) nodeMap.set(id, store.state.nodes.get(id)              );

  // 全部证据按 evidence_id 稳定排序，保证可回放
  const allEvidence = ([...store.state.evidence.values()]                    )
    .slice()
    .sort((a, b) => (a.evidence_id < b.evidence_id ? -1 : a.evidence_id > b.evidence_id ? 1 : 0));

  const edges                      = [];
  for (const ev of allEvidence) {
    const refs = Array.isArray(ev.context_refs) ? ev.context_refs : [];
    for (const r of refs) {
      const to = str(r?.nodeId);
      if (!to) continue;
      const target = nodeMap.get(to);
      edges.push({
        from: ev.node_id,
        to,
        ...(r.how ? { how: r.how } : {}),
        evidenceId: ev.evidence_id,
        toStatusAtRead: target ? String(target.status) : 'missing',
      });
    }
  }

  // 入度/出度
  const inbound = new Map                ();
  const outbound = new Map                ();
  for (const id of nodeIds) { inbound.set(id, 0); outbound.set(id, 0); }
  for (const e of edges) {
    if (outbound.has(e.from)) outbound.set(e.from, (outbound.get(e.from) ?? 0) + 1);
    if (inbound.has(e.to)) inbound.set(e.to, (inbound.get(e.to) ?? 0) + 1);
  }

  // 返工分因索引：一次扫 journal，供所有节点复用（否则每个节点各扫一遍）
  const reworkIndex = buildReworkIndex(store);
  const nodes                      = nodeIds.map((id) => {
    const n = nodeMap.get(id)              ;
    const q = scoreNode(store, id, { reworkIndex });
    const i = inbound.get(id) ?? 0;
    const o = outbound.get(id) ?? 0;
    return {
      nodeId: id,
      title: String(n?.title ?? ''),
      inbound: i,
      outbound: o,
      island: i === 0 && o === 0,
      qualityScore: q.score,
      qualityGrade: q.grade,
    };
  });

  const coupledNodes = nodes.filter((n) => n.inbound > 0 || n.outbound > 0);
  const islandNodes = nodes.filter((n) => n.island);
  const possible = nodeIds.length * (nodeIds.length - 1);

  // 质量对比（只算有分数的节点；无证据的节点不参与比较）
  const scored = (list                     ) => list.filter((n) => n.qualityScore !== null);
  const avgOf = (list                     ) => {
    const s = scored(list);
    return s.length ? Math.round(s.reduce((a, n) => a + (n.qualityScore          ), 0) / s.length) : null;
  };
  const coupledScored = scored(coupledNodes);
  const isolatedScored = scored(islandNodes);
  const coupledAvg = avgOf(coupledNodes);
  const isolatedAvg = avgOf(islandNodes);
  const enough = coupledScored.length >= minSample && isolatedScored.length >= minSample;
  const delta = enough && coupledAvg !== null && isolatedAvg !== null ? coupledAvg - isolatedAvg : null;

  let verdict        ;
  if (!enough) {
    verdict =
      `样本不足，不下结论（有耦合且有分数 ${coupledScored.length} 个 / 无耦合且有分数 ${isolatedScored.length} 个，` +
      `各需 ≥${minSample} 个）。这是刻意的：给一个样本不足的数字，会被当成结论用。`;
  } else if (delta === null) {
    verdict = '无法比较（某一侧没有可打分的节点）';
  } else if (delta > 0) {
    verdict =
      `有耦合的节点平均分高 ${delta} 分（${coupledAvg} vs ${isolatedAvg}）。` +
      '**这是相关性，不是因果**——可能是高能力节点更容易引用别人，而不是引用让别人做得更好。';
  } else if (delta < 0) {
    verdict =
      `有耦合的节点平均分反而低 ${Math.abs(delta)} 分（${coupledAvg} vs ${isolatedAvg}）。` +
      '说明目前的耦合没有带来质量收益，值得查清是被迫引用（依赖）还是主动参考。';
  } else {
    verdict = `两侧平均分相同（${coupledAvg}），耦合目前没有可观测的质量差异。`;
  }

  const hubs = nodes
    .filter((n) => n.inbound > 0)
    .sort((a, b) => b.inbound - a.inbound || (a.nodeId < b.nodeId ? -1 : 1))
    .slice(0, 5)
    .map((n) => ({ nodeId: n.nodeId, inbound: n.inbound }));

  return {
    ok: true,
    edges,
    nodes,
    totals: {
      nodes: nodeIds.length,
      islands: islandNodes.length,
      edges: edges.length,
      coupled: coupledNodes.length,
      density: possible > 0 ? Number((edges.length / possible).toFixed(4)) : 0,
    },
    quality: {
      coupled: { nodes: coupledScored.length, avgScore: coupledAvg },
      isolated: { nodes: isolatedScored.length, avgScore: isolatedAvg },
      delta,
      verdict,
    },
    hubs,
    note:
      'context_refs 是**生产者自己填的声明**，没有机制验证产物真的引用了对方——' +
      '所以这是「耦合声明图」，不是「事实依赖图」。它纯读 journal，不改变执行顺序、不增加运行时代价。',
  };
}


//# sourceURL=core\collaboration.js