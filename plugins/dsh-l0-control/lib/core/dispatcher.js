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
                                        
                                             
import { readySet } from "./ready.js";
import { runFactorGuards,                   } from "./guards.js";

                                                           

                                  
                     
                                              
                     
                             
                     
                                    
                  
                    
                             
                  
                
 

export const DEFAULT_DISPATCH_OPTIONS                                 = {
  mode: "off",
  intervalMs: 5 * 60 * 1000,
  maxPerTick: 3,
  dryRun: true,
  dispatcherInstance: "ROLE-DISPATCH-01",
};

                                   
                 
                            
                                                              
                                                 
                 
 

                                     
                     
                  
                  
                                      
                     
                           
                                   
                           
                                  
                         
                  
                  
                                   
                
 

/** 同一节点被这些 critical finding 命中时，本轮不派——先让人看一眼。 */
const BLOCKING_CHECKS = new Set([
  "stalled",
  "unsatisfied-while-active",
  "gate-not-passed",
]);

function nodeCapability(node            )                {
  return node.capability ?? null;
}

/**
 * 跑一轮派活计划。
 *
 * 只读 store；不会调用 claim。是否真的派活由调用方根据 `willDispatch` 决定，
 * 因此这个函数在 off 模式、dryRun 模式、正式模式下都是安全的。
 */
export function planDispatchTick(store       , options                 )                     {
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

  const ready = readySet(store);
  const plan                     = [];
  const candidates           = [];

  for (const nodeId of ready) {
    const node = store.state.nodes.get(nodeId);
    if (!node) continue;
    if (blockedNodes.has(nodeId)) {
      const why = blocking.find((f) => f.nodeId === nodeId);
      plan.push({
        nodeId,
        capability: nodeCapability(node),
        action: "skip",
        reason: `巡检拦截：${why?.check ?? "critical"} — ${why?.message ?? ""}`.trim(),
      });
      continue;
    }
    if (candidates.length >= options.maxPerTick) {
      plan.push({
        nodeId,
        capability: nodeCapability(node),
        action: "skip",
        reason: `本轮已达上限 maxPerTick=${options.maxPerTick}`,
      });
      continue;
    }
    candidates.push(nodeId);
    plan.push({
      nodeId,
      capability: nodeCapability(node),
      action: options.dryRun ? "would-dispatch" : "dispatch",
      reason: options.dryRun ? "dryRun：只出计划，不实际派活" : "就绪且无阻塞",
    });
  }

  const willDispatch = candidates;
  const summary = options.dryRun
    ? `[dryRun] 就绪 ${ready.length}，本轮可派 ${willDispatch.length}，拦截 ${blockedNodes.size}`
    : `就绪 ${ready.length}，本轮派 ${willDispatch.length}，拦截 ${blockedNodes.size}`;

  return { mode: options.mode, ready, readyCount: ready.length, plan, blocking, willDispatch, summary };
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
    nowMs,
  };
}


//# sourceURL=core\dispatcher.js