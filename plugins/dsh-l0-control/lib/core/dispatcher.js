/**
 * 派活循环（dispatcher）。
 *
 * 模式由用户选择，默认**不激活**：
 *   off        —— 完全不跑（默认），图只能靠人手动 task_next / task_claim
 *   interval   —— 定时跑：每隔 intervalMs 跑一次 tick
 *   resident   —— 常驻跑：跑完立刻排下一次（仍受 maxPerTick 与冷却约束）
 *
 * 本文件只做**纯逻辑**：给定 store 与选项，算出一轮该派谁、为什么跳过谁。
 * 定时器、配置读取、与宿主生命周期的绑定都在上层（service/index），
 * 这样 tick 可以在测试里被完整驱动，不需要真的等待时间。
 */
                                        
                                             
import { leaseCapacity } from "./admission.js";
import { budgetBlockedNodes,                  } from "./budget.js";
import { planPartitionResume } from "./checkpoint.js";
import { readySet } from "./ready.js";
import { runFactorGuards,                   } from "./guards.js";

                                                           

                                  
                     
                                              
                     
                             
                     
                                    
                  
                    
                             
                  
                
                          
                         
                       
                     
                       
                              
                                
     
                                        
    
                                               
                                             
     
                              
                                           
                           
                                                           
 

export const DEFAULT_DISPATCH_OPTIONS                                 = {
  mode: "off",
  intervalMs: 5 * 60 * 1000,
  maxPerTick: 3,
  dryRun: true,
  dispatcherInstance: "ROLE-DISPATCH-01",
};

                                   
                 
                 
                        
                            
                                                              
                                                 
                 
     
                                                        
    
                                             
                                                   
                                                             
                                                            
                                      
     
                      
 

/** 派发闸门：四道限流 + 四道拦截，各有各的处置方式。 */
                          
     
                             
    
                                                 
                                                             
                                         
                                              
     
                  
                                      
          
                                  
              
                                        
               
                           
          
                                  
           
                           
           
                          
            
                              
             

                                     
                     
                  
                  
                                      
                     
                           
                                   
                           
                                  
                         
                  
                  
                                   
                
                                                                                                                                                                  
                                                  
                                                
 

/** 同一节点被这些 critical finding 命中时，本轮不派——先让人看一眼。 */
const BLOCKING_CHECKS = new Set([
  "stalled",
  "unsatisfied-while-active",
  "gate-not-passed",
]);

function nodeCapability(node            )                {
  return node.capability ?? null;
}

/** 预算拦截的一行原因：说清是哪个作用域、用了多少、上限多少。 */
function budgetReason(block             )         {
  const where = block.scope === "global" ? "全图" : block.scope === "partition" ? `协调域 ${block.scopeId}` : `节点 ${block.scopeId}`;
  return `预算拦截：${where} 已用 ${block.used}/${block.limit}，派出去也会被 claim 拒绝`;
}

/**
 * 四道限流闸门里，**到底是哪一道**卡住了。
 *
 * `effectiveLimit = min(maxPerTick, pendingCapacity, activeCapacity, rateCapacity)`，
 * 取到最小值的那个才是真正的原因。所以这里直接求最小值——**不能**像第一版那样
 * `if (!(gap > 0)) continue` 跳过 0：额度为 0 恰恰是「这道闸门完全没余量」，
 * 是最该被报出来的那一个，跳过它等于永远报出第二小的那个。
 *
 * 相等时按「越难恢复的越优先报」排序：
 *
 *   capacity > partition > queue > rate > tick
 *
 * 理由：报出来的原因应当指向**最该处理**的那件事。容量要等 worker 完成、排队要等
 * claim 或释放，都不是调个参数就能好的；`rate` 一个窗口后自动恢复，`tick` 下一轮
 * 就恢复。如果四者同时见底却报「tick 到量了」，会让人误以为等下一轮就行——而真正
 * 卡住的是容量。
 */
function limitingGate(capacities   
               
                   
               
                
 )               {
  const ordered                                = [
    ["capacity", capacities.capacity],
    ["queue", capacities.queue],
    ["rate", capacities.rate],
    ["tick", capacities.tick],
  ];
  let best                                      = { gate: "tick", gap: Number.POSITIVE_INFINITY };
  for (const [gate, gap] of ordered) {
    if (gap < best.gap) best = { gate, gap };
  }
  return best.gate;
}

/** 每道闸门一句人话，说清「现在该做什么」。 */
function gateAdvice(gate              )         {
  switch (gate) {
    case "tick":
      return "单轮限额已满，下一轮自动继续（要更快就调 dispatchMaxPerTick）";
    case "capacity":
      return "在跑 worker 已达容量上限，等它们完成或租约释放后自动继续（要更快就调 maxParallel）";
    case "partition":
      return "该协调域已达到分区 maxActive，等域内 worker 完成；同图其它域不受影响";
    case "rate":
      return "本秒派发额度已用尽，下一窗口自动恢复（要更快就调 dispatchRatePerSecond）";
    case "queue":
      return "已派未领取的积压已达 maxQueuedTasks，等 worker claim 或释放后自动继续";
    case "host-backoff":
      return "宿主自己报了退避窗口（并发/配额/速率被挡），窗口内派也是白派；等到点再试，或降低 dispatchRatePerSecond";
    case "guard":
      return "巡检发现 critical 问题，先人工看一眼再放行";
    case "budget":
      return "预算已用尽，加预算或缩小任务范围";
    case "replay":
      return "检查点说该节点已完成、当前却就绪，先确认 journal 是否被截断或改写";
  }
}

/**
 * 恢复防重放闸口：把「检查点说已完成、现在却 ready」的节点挑出来。
 *
 * 为什么要在派活前拦：`ready` 是由依赖与状态算出来的，正常情况下 done 的节点
 * 永远不回 ready。如果 journal 被截断/改写、或检查点写在了状态回滚之后，
 * done 可能退回 ready —— 此时派出去就是**把已完成的 activity 重做一遍**，
 * 产生重复证据、重复产物、重复预算消耗。
 *
 * 取不到检查点时返回空数组（没检查点的图不受影响），不阻断正常派活。
 */
function replayGuardedNodes(
  store       ,
  ready          ,
)                                                                      {
  if (ready.length === 0) return [];
  const guarded                                                                      = [];
  const seen = new Set        ();
  for (const partitionId of partitionIdsOf(store)) {
    let plan                                        ;
    try {
      plan = planPartitionResume(store, partitionId);
    } catch {
      continue;
    }
    if (!plan.ok && plan.drift.length === 0) continue;
    for (const row of plan.drift) {
      if (!ready.includes(row.nodeId) || seen.has(row.nodeId)) continue;
      seen.add(row.nodeId);
      guarded.push({
        nodeId: row.nodeId,
        checkpointStatus: row.checkpointStatus,
        reason: `恢复防重放：检查点说 ${row.checkpointStatus}，当前 ${row.currentStatus}（${row.reason}）`,
      });
    }
  }
  return guarded;
}

/** 从图 meta 里取分区 ID 列表；无协调配置时返回空。 */
function partitionIdsOf(store       )           {
  try {
    const coordination = JSON.parse(store.state.meta.get("graph_coordination") ?? "null")   
                                               
            ;
    return (coordination?.partitions ?? [])
      .map((partition) => String(partition?.id ?? "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 跑一轮派活计划。
 *
 * 只读 store；不会调用 claim。是否真的派活由调用方根据 `willDispatch` 决定，
 * 因此这个函数在 off 模式、dryRun 模式、正式模式下都是安全的。
 */
export function planDispatchTick(store       , options                 )                     {
  const configuredMaxActive = Math.floor(Number(options.maxActive ?? options.maxPerTick));
  const maxActive = Number.isFinite(configuredMaxActive) && configuredMaxActive > 0 ? configuredMaxActive : options.maxPerTick;
  const { active, maxActive: effectiveMaxActive, activeByPartition, domainsFor } = leaseCapacity(store, options.nowMs, maxActive);
  const currentQueueLength = Math.max(0, Math.floor(options.currentQueueLength ?? 0));
  const dispatchedThisSecond = Math.max(0, Number(options.dispatchedThisSecond ?? 0));
  const configuredMaxQueued = Math.floor(Number(options.maxQueuedTasks ?? 10_000));
  const maxQueuedTasks = Number.isFinite(configuredMaxQueued) && configuredMaxQueued > 0 ? configuredMaxQueued : 10_000;
  const configuredRate = Number(options.ratePerSecond ?? 100);
  const ratePerSecond = Number.isFinite(configuredRate) && configuredRate > 0 ? configuredRate : 100;
  const partitionCounts = Object.fromEntries(activeByPartition);
  const saturated = active >= effectiveMaxActive || currentQueueLength >= maxQueuedTasks;

  /**
   * 宿主退避：宿主自己说了「N 秒后再试」，窗口内一个都不派。
   *
   * 为什么在 plan 阶段就挡、而不是靠 `ratePerSecond` 顺带拦住：
   * 退避描述的是**宿主**的额度，与本图的速率上限无关。宿主满载时本图速率
   * 可能只用了 1/100，`rate` 闸门一点余量都没用掉，于是每一轮照派、
   * 每一轮都被宿主拒——把 journal 刷满同样的错误，还白占一次 spawn。
   *
   * 判据是 `untilMs > nowMs`，**不猜**「宿主可能已经恢复」：提前解除退避
   * 正是要修的那个行为。真提前恢复了的话，`node_enqueued` 会清空退避
   * （见 `dispatch/enqueue-state.ts`），不会留下假卡顿。
   */
  const backoffUntilMs = Number(options.hostBackoffUntilMs);
  const backoffActive = Number.isFinite(backoffUntilMs) && backoffUntilMs > options.nowMs;
  const backoffNote = String(options.hostBackoffNote ?? "").trim();
  const backoffRemainingMs = backoffActive ? backoffUntilMs - options.nowMs : 0;

  const backpressure = {
    active,
    maxActive: effectiveMaxActive,
    queued: currentQueueLength,
    maxQueued: maxQueuedTasks,
    ratePerSecond,
    dispatchedThisSecond,
    saturated,
    activeByPartition: partitionCounts,
    // 退避必须出现在 backpressure 里：面板问「为什么现在没派」时，
    // 这一栏是唯一能区分「我们满了」与「宿主不收了」的地方。
    hostBackoff: backoffActive ? { untilMs: backoffUntilMs, remainingMs: backoffRemainingMs, note: backoffNote || null } : null,
  };
  if (options.mode === "off") {
    // P1-10：off 也不派活，但返回 ready 计数与 hint（只读统计，不 claim、不写 journal）。
    // dryRun/would-dispatch 语义不变：off 下 plan 为空、willDispatch 为空。
    const ready = readySet(store);
    return {
      mode: "off",
      ready,
      readyCount: ready.length,
      plan: [],
      blocking: [],
      willDispatch: [],
      backpressure,
      summary: `派活循环未激活（mode=off）；就绪 ${ready.length}，未派活`,
      hint: ready.length
        ? `mode=off 下不派活；${ready.length} 个节点就绪，可手动 task_next/task_claim，或用 dispatch 工具切换为 interval/resident`
        : "mode=off 下不派活；当前无就绪节点，需要时用 dispatch 工具切换为 interval/resident",
    };
  }

  const guardReport = runFactorGuards({ store, nowMs: options.nowMs });
  const blocking = guardReport.findings.filter(
    (f) => f.severity === "critical" && BLOCKING_CHECKS.has(f.check),
  );
  const blockedNodes = new Set(blocking.map((f) => f.nodeId));

  // ── 预算闸口 ──────────────────────────────────────────────────────────
  // 与 `task_claim` 用同一套预算口径（core/budget.ts）。计划里给出注定被拒的
  // 候选，等于每轮白烧一次 spawn：派出去 → claim 被拒 → worker 按契约停手 →
  // 登记释放 → 下一轮又选中它。必须在这里就挡掉并说明原因。
  // 无任何预算上限时 budgetBlockedNodes 直接返回空 Map，不扫 journal。
  const budgetBlocked = budgetBlockedNodes(store);

  const ready = readySet(store);

  // ── 恢复防重放闸口 ────────────────────────────────────────────────────
  // 检查点说「已完成」、现在却出现在 ready 里 —— 这是 done 退回（drift），
  // 派出去就等于把已完成的 activity 重做一遍。宁可这一轮不派，也不重放。
  // 判据来自 planPartitionResume 的 drift 分类（core/checkpoint.ts）。
  const replayGuard = replayGuardedNodes(store, ready);
  for (const row of replayGuard) blockedNodes.add(row.nodeId);
  const pendingCapacity = Math.max(0, maxQueuedTasks - currentQueueLength);
  const activeCapacity = Math.max(0, effectiveMaxActive - active);
  const rateCapacity = Math.max(0, Math.floor(ratePerSecond - dispatchedThisSecond));
  const effectiveLimit = Math.min(options.maxPerTick, pendingCapacity, activeCapacity, rateCapacity);
  const plan                     = [];
  const candidates           = [];

  /**
   * 本轮**到底是哪一道闸门**卡住了。
   *
   * 判据只有一条：`effectiveLimit = min(maxPerTick, pendingCapacity, activeCapacity, rateCapacity)`
   * 取到最小值的那个才是原因——不需要再减 `candidates.length`，因为循环走到这里时
   * `candidates.length === effectiveLimit`，而 `effectiveLimit` 本身就是四者的最小值。
   *
   * 第一个版本写成了 `闸门额度 - 已选`，于是「已选 1 个、tick 额度 1」算出 gap=0、
   * 而容量 100-1=99，把 tick 误报成唯一原因——但它其实是唯一没见底的。
   * 这类错不会崩，只会给出反向建议，必须靠断言钉住。
   */
  const limitingGateNow = ()               =>
    limitingGate({
      tick: options.maxPerTick,
      capacity: activeCapacity,
      rate: rateCapacity,
      queue: pendingCapacity,
    });

  /**
   * 宿主退避在**拦截顺序**里的位置：
   *
   *   巡检 critical / 恢复防重放 > 预算 > **宿主退避** > 分区满员 > 四道限流
   *
   * 前两者是节点自身的、不会自己好转的问题，归因成 `host-backoff` 就等于用
   * 「等一会儿」掩盖「需要人去改」。而它又必须排在分区满员之前：分区满员至少
   * 还能派别的域，宿主退避时**全图一个都派不出去**——报出局部的 `partition`
   * 会让人以为换个域就能绕开。
   */

  const plannedByPartition = new Map                ();
  for (const nodeId of ready) {
    const node = store.state.nodes.get(nodeId);
    if (!node) continue;
    // 顺序要紧：**确定性拦截先于退避**。
    //
    // 巡检 critical / 预算耗尽 / 恢复防重放都是节点自身的、不会自己好转的问题，
    // 把它们的归因盖成 `host-backoff` 就等于用「等一会儿」掩盖「需要人去改」。
    // 退避是临时的、全体的，只该接管那些**本来真能派出去**的节点。
    if (blockedNodes.has(nodeId)) {
      const why = blocking.find((f) => f.nodeId === nodeId);
      const replay = replayGuard.find((row) => row.nodeId === nodeId);
      plan.push({
        nodeId,
        title: node.title,
        stage: node.stage ?? null,
        capability: nodeCapability(node),
        action: "skip",
        reason: replay
          ? replay.reason
          : `巡检拦截：${why?.check ?? "critical"} — ${why?.message ?? ""}`.trim(),
        gate: replay ? "replay" : "guard",
      });
      continue;
    }
    const overBudget = budgetBlocked.get(nodeId);
    if (overBudget) {
      plan.push({
        nodeId,
        title: node.title,
        stage: node.stage ?? null,
        capability: nodeCapability(node),
        action: "skip",
        reason: budgetReason(overBudget),
        gate: "budget",
      });
      continue;
    }
    // 宿主退避：排在确定性拦截之后、四道限流之前。
    // 它比 `partition` 还靠前，因为分区满员至少还能派别的域，而宿主退避时
    // **全图一个都派不出去**——报出局部的 `partition` 会让人以为换个域就能绕开。
    if (backoffActive) {
      const seconds = Math.ceil(backoffRemainingMs / 1000);
      plan.push({
        nodeId,
        title: node.title,
        stage: node.stage ?? null,
        capability: nodeCapability(node),
        action: "skip",
        reason: `宿主退避中（还剩 ${seconds} 秒）：${backoffNote || "宿主报了重试窗口"}；${gateAdvice("host-backoff")}`,
        gate: "host-backoff",
      });
      continue;
    }
    const domains = domainsFor(nodeId);
    const fullDomain = domains.find(({ id, maxActive }) => maxActive !== undefined &&
      (activeByPartition.get(id) ?? 0) + (plannedByPartition.get(id) ?? 0) >= maxActive);
    if (candidates.length >= effectiveLimit || fullDomain) {
      if (fullDomain) {
        // 分区满员是**局部**原因：同图其它域照常派。所以它优先于全局限流被报出，
        // 否则运维会去调 maxParallel，而那个参数对这里毫无作用。
        plan.push({
          nodeId,
          title: node.title,
          stage: node.stage ?? null,
          capability: nodeCapability(node),
          action: "skip",
          reason: `backpressure：协调域 ${fullDomain.id} 达到 maxActive`,
          gate: "partition",
        });
        continue;
      }
      const gate = limitingGateNow();
      const detail = `tick=${options.maxPerTick} active=${activeCapacity} rate=${rateCapacity} queue=${pendingCapacity}`;
      plan.push({
        nodeId,
        title: node.title,
        stage: node.stage ?? null,
        capability: nodeCapability(node),
        action: "skip",
        // 一句人话 + 一句原始额度：人看前半句知道该做什么，机器看 `gate` 字段。
        reason: `本轮额度已用尽（${gate}）：${gateAdvice(gate)}；额度 ${detail}`,
        gate,
      });
      continue;
    }
    candidates.push(nodeId);
    for (const { id } of domains) plannedByPartition.set(id, (plannedByPartition.get(id) ?? 0) + 1);
    plan.push({
      nodeId,
      title: node.title,
      stage: node.stage ?? null,
      capability: nodeCapability(node),
      action: options.dryRun ? "would-dispatch" : "dispatch",
      reason: options.dryRun ? "dryRun：只出计划，不实际派活" : "就绪且无阻塞",
    });
  }

  const willDispatch = candidates;
  /**
   * 按闸门汇总本轮的跳过。`summary` 里那句「拦截 N」只说有几个，不说为什么——
   * 千级运行时真正要回答的问题是「为什么这一轮只派了 3 个」，答案必须一眼可见。
   */
  const gates                                        = {};
  for (const item of plan) {
    if (item.action !== "skip" || !item.gate) continue;
    gates[item.gate] = (gates[item.gate] ?? 0) + 1;
  }
  const gateText = Object.entries(gates)
    .sort((a, b) => b[1] - a[1])
    .map(([gate, count]) => `${gate}×${count}`)
    .join(" ");
  const summary = options.dryRun
    ? `[dryRun] 就绪 ${ready.length}，本轮可派 ${willDispatch.length}，拦截 ${blockedNodes.size}${gateText ? `（${gateText}）` : ""}`
    : `就绪 ${ready.length}，本轮候选 ${willDispatch.length}，拦截 ${blockedNodes.size}${gateText ? `（${gateText}）` : ""}`;

  return { mode: options.mode, ready, readyCount: ready.length, plan, blocking, willDispatch, summary, backpressure, gates };
}

/** 从宿主配置里读派活选项，做取值收敛（非法值一律回落到默认）。 */
export function normalizeDispatchOptions(raw                                      , nowMs        )                  {
  const mode = raw?.mode;
  const safeMode               = mode === "interval" || mode === "resident" ? mode : "off";
  const intervalMs = Number(raw?.intervalMs);
  const maxPerTick = Number(raw?.maxPerTick);
  return {
    mode: safeMode,
    intervalMs: Number.isFinite(intervalMs) && intervalMs >= 30_000 ? intervalMs : DEFAULT_DISPATCH_OPTIONS.intervalMs,
    maxPerTick: Number.isFinite(maxPerTick) && maxPerTick >= 1 ? Math.min(maxPerTick, 32) : DEFAULT_DISPATCH_OPTIONS.maxPerTick,
    // 默认按 dryRun 处理：只有显式 false 才真的派活
    dryRun: raw?.dryRun !== false,
    dispatcherInstance: raw?.dispatcherInstance || DEFAULT_DISPATCH_OPTIONS.dispatcherInstance,
    maxQueuedTasks: Number.isInteger(Number(raw?.maxQueuedTasks)) && Number(raw?.maxQueuedTasks) > 0 ? Number(raw?.maxQueuedTasks) : 10_000,
    ratePerSecond: Number.isFinite(Number(raw?.ratePerSecond)) && Number(raw?.ratePerSecond) > 0 ? Number(raw?.ratePerSecond) : 100,
    activeCount: Math.max(0, Math.floor(Number(raw?.activeCount ?? 0))),
    maxActive: Number.isInteger(Number(raw?.maxActive)) && Number(raw?.maxActive) > 0 ? Number(raw?.maxActive) : (Number.isInteger(Number(raw?.maxParallel)) && Number(raw?.maxParallel) > 0 ? Number(raw?.maxParallel) : DEFAULT_DISPATCH_OPTIONS.maxPerTick),
    currentQueueLength: Math.max(0, Math.floor(Number(raw?.currentQueueLength ?? 0))),
    dispatchedThisSecond: Math.max(0, Math.floor(Number(raw?.dispatchedThisSecond ?? 0))),
    // 退避时刻原样透传（**不**在这里 clamp 成 nowMs）：归一化层不该知道时钟。
    // 非法值一律丢弃 = 按「没有退避」处理，与退避出现之前的行为一致。
    ...(Number.isFinite(Number(raw?.hostBackoffUntilMs)) && Number(raw?.hostBackoffUntilMs) > 0
      ? { hostBackoffUntilMs: Number(raw?.hostBackoffUntilMs) }
      : {}),
    ...(typeof raw?.hostBackoffNote === "string" && raw.hostBackoffNote.trim()
      ? { hostBackoffNote: raw.hostBackoffNote.trim() }
      : {}),
    coordination: raw?.coordination?.enabled ? raw.coordination : undefined,
    nowMs,
  };
}


//# sourceURL=core\dispatcher.js