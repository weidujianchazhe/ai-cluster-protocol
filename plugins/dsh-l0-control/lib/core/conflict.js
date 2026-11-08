/**
 * 冲突分类与按能力路由。
 *
 * 核心原则（用户设计）：
 *   **root 不裁决，root 只路由。人不是默认裁决者，而是能力来源之一。**
 *
 * 判断依据不是"谁管这个"，而是"解决它需要什么能力"。
 * 人的位置只在两类冲突上不可替代：实用（需要真实体验）与价值（需要立场）。
 *
 * 路由顺序：
 *   1. needs 里有人类专属能力 → 升级给人，并写明为什么只有人能判
 *   2. 图里有 agent 声明了该 capability → 派给它
 *   3. 能力目录里能拉 → 拉能力（catalog.ts 机制）
 *   4. 都没有 → 升级给人，并记入「集群能力缺口」
 */
                                               
                                              

                                                                                            

/** 只有人能提供的能力：不在模型内部可补全 */
export const HUMAN_ONLY_NEEDS = new Set(["human-experience", "human-value"]);

                                
                
               
 

                           
             
                  
                     
                                          
                         
                  
                                          
                    
                          
                 
 

                               
                                  
                                               
                                    
                                
 

/**
 * 从视角摘要里检出结构性冲突。
 *
 * 只报**能说清"两边各主张什么"**的冲突；说不清的不报，避免制造噪音。
 */
export function detectConflicts(digests               , nodes                       )             {
  const out             = [];
  const byId = new Map(digests.map((d) => [d.facetId, d]));
  const cap = byId.get("capability");
  const ev = byId.get("evidence");
  const org = byId.get("org");
  const risk = byId.get("risk");
  const drift = byId.get("goal-drift");

  // type/needs 由形参给出（在下面统一补进对象），所以入参类型必须把它们也 Omit 掉。
  const pushed = (
    c                                                              ,
    needs          ,
    type              ,
  ) => {
    out.push({
      ...c,
      id: `CF-${out.length + 1}`,
      type,
      needs,
      route: "unresolved",
      reason: "",
    });
  };

  // 组织视角说"有人在做"，能力视角说"这批活没标签" → 无法确认做的是什么
  if (cap && org) {
    const unlabeled = cap.counts["(无标签)"] ?? 0;
    if (unlabeled > 0 && cap.matched >= 3) {
      pushed(
        {
          subject: `${unlabeled} 个无标签节点`,
          between: [
            { facet: "org", text: `${org.matched} 个节点已分配到执行者` },
            { facet: "capability", text: `${unlabeled} 个节点没有能力标签，无法按能力路由或复核` },
          ],
        },
        ["requirements-analysis"],
        "technical",
      );
    }
  }

  // 证据视角说"有要求"，能力视角说"没人做审计" → 产出无人独立复核
  if (cap && ev) {
    const auditish = Object.keys(cap.counts).filter((k) => k.startsWith("AUDIT")).reduce((s, k) => s + cap.counts[k], 0);
    if (ev.counts.both > 0 && auditish === 0 && cap.matched >= 5) {
      pushed(
        {
          subject: "证据要求与审计覆盖",
          between: [
            { facet: "evidence", text: `${ev.counts.both} 个节点声明了证据+验证器` },
            { facet: "capability", text: "图中没有任何审计类节点，验证由生产方自评" },
          ],
        },
        ["audit-independence"],
        "evidence",
      );
    }
  }

  // 风险视角说"反复失败"，目标视角说"可能目标有问题" → 需要重新判读需求
  if (risk && drift) {
    if (risk.counts.retried >= 2 && (drift.counts.signals ?? 0) > 0) {
      pushed(
        {
          subject: "反复失败与目标定义",
          between: [
            { facet: "risk", text: `${risk.counts.retried} 个节点反复失败` },
            { facet: "goal-drift", text: "目标视角同时报告了结构性偏离信号" },
          ],
        },
        ["requirements-analysis", "human-value"],
        "requirement",
      );
    }
  }

  // 有交付节点但没有实用判断 → 只能给人
  if (cap) {
    const deliver = cap.counts["DELIVER"] ?? 0;
    const usability = byId.get("usability");
    if (deliver > 0 && usability && (usability.counts.signals ?? 0) > 0) {
      pushed(
        {
          subject: "交付前的实用验收",
          between: [
            { facet: "capability", text: `存在 ${deliver} 个交付/验收节点` },
            { facet: "usability", text: "实用视角无法自动判定，需要真实使用体验" },
          ],
        },
        ["human-experience"],
        "usability",
      );
    }
  }

  // 悬空依赖：组织视角里 deps 指向不存在的节点
  const ids = new Set(nodes.map((n) => n.nodeId));
  const dangling = nodes.filter((n) => n.org.deps.some((dep) => !ids.has(dep)));
  if (dangling.length > 0) {
    pushed(
      {
        subject: `${dangling.length} 个节点有悬空依赖`,
        between: [
          { facet: "org", text: `依赖指向：${dangling.flatMap((n) => n.org.deps.filter((d) => !ids.has(d))).slice(0, 5).join(", ")}` },
          { facet: "org", text: "这些依赖在图里不存在，就绪判定可能永久阻塞" },
        ],
      },
      ["code-repair"],
      "technical",
    );
  }

  return out;
}

/**
 * 路由冲突。
 *
 * 人不是默认终点：只有 needs 里出现人类专属能力，或前三级都找不到承接方时，才升级给人。
 */
export function routeConflicts(conflicts            , ctx              )             {
  return conflicts.map((c) => {
    const humanNeed = c.needs.find((n) => HUMAN_ONLY_NEEDS.has(n));
    if (humanNeed) {
      return {
        ...c,
        route: "human"         ,
        reason: `需要 ${humanNeed}：这是体验/立场类能力，集群内部无法补全（可先用扮演用户的 agent 粗筛，但最终需出品人实际使用一次）`,
      };
    }
    for (const need of c.needs) {
      const owners = ctx.availableCapabilities.get(need);
      if (owners && owners.length > 0) {
        return { ...c, route: "agent"         , routedTo: owners[0], reason: `图内已有声明 ${need} 的节点：${owners[0]}` };
      }
    }
    for (const need of c.needs) {
      if (ctx.catalogCapabilities.includes(need)) {
        return { ...c, route: "agent"         , routedTo: `catalog:${need}`, reason: `能力目录可拉取 ${need}（需装配后执行）` };
      }
    }
    return {
      ...c,
      route: "human"         ,
      reason: `集群缺口：没有任何节点或目录项能承接 ${c.needs.join("/")}——这是能力缺口，不是人的日常工作量`,
    };
  });
}

/** 汇总：给人看的只有两类，其余都应在集群内消化。 */
export function summarizeRouting(conflicts            )   
                
                                  
                       
                           
  {
  const byRoute                         = { agent: 0, human: 0, unresolved: 0 };
  const forHuman             = [];
  const gaps           = [];
  for (const c of conflicts) {
    byRoute[c.route] = (byRoute[c.route] ?? 0) + 1;
    if (c.route === "human") {
      forHuman.push(c);
      if (c.reason.startsWith("集群缺口")) gaps.push(...c.needs);
    }
  }
  return { total: conflicts.length, byRoute, forHuman, capabilityGaps: [...new Set(gaps)] };
}


//# sourceURL=core\conflict.js