/**
 * `@dsh-l0-control/core` —— 控制面核心不变量的纯 TS 实现（不依赖 DSH 宿主，可单测）。
 *
 * 分层（N3 负责的范围）：
 *   types / errors / status（状态机常量与白名单）
 *   journal（只追加事件日志）
 *   store（进程内状态 + 原子区间）
 *   evidence（产物/证据 append-only + 凭证铸造所需的 pass 证据）
 *   graph（唯一状态入口、终态/白名单/凭证、环检测、快照与重放）
 *   ready / leases / decisions / replan（R2–R5 逐步补齐）
 *   graphspec（工作图组成因子：GraphSpec/NodeSpec + plan/commit）
 *
 * 约束：本目录不含 I/O、不读 DSH 服务、不落盘——持久化与原生适配分别归 N4 / N2。
 */
export * from "./types.js";
export * from "./errors.js";
export * from "./status.js";
export { Journal, REQUIRED_FIELDS, assertJournalReady } from "./journal.js";
export { Store, emptyState } from "./store.js";
                                        
export {
  addArtifact,
  addEvidence,
  auditIndependence,
  getArtifact,
  listEvidence,
  parseInstanceId,
  passEvidence,
  roleOfInstance,
  sameInstance,
} from "./evidence.js";
             
                   
                   
                    
                 
                       
export {
  UNSET,
  addEdge,
  addNode,
  dependencies,
  detectCycles,
  doneCredential,
  edges,
  getNode,
  listNodes,
  onNodeDone,
  reachable,
  rejectNode,
  removeNode,
  replayMismatches,
  replaySnapshot,
  resetDoneListeners,
  setEdges,
  setStatus,
  snapshot,
  unblock,
} from "./graph.js";
                                                                                            
export {
  bootstrap,
  depsDone,
  installReadyHook,
  onEvent,
  readySet,
  recomputeReady,
} from "./ready.js";
                                                                
export {
  assertFencing,
  claim,
  currentLease,
  expire,
  release,
  renew,
  takeover,
} from "./leases.js";
                                                                               

// ── N2 `service.ts` 约定的门面动作（R4 起全部落地，pending=[]）──
export {
  WISH_PLAN,
  claimTask,
  configureCore,
  coreCapabilities,
  coreStore,
  decide,
  exportProjection,
  graphCommit,
  graphPlan,
  graphStatus,
  nextTask,
  nodeGates,
  rehydrateCore,
  resetCore,
  restoreCore,
  submitEvidence,
  submitWish,
  tickDecisions,
  verifyDone,
} from "./facade.js";
             
                 
              
                
                
                  
            
                     

// ── replan（单事务）────────────────────────────────────────────────────
export {
  REPLAN_REASONS,
  currentGraphVersion,
  listReplanEvents,
  replan,
} from "./replan.js";
                                                                           

// ── 决策（L0–L3）与 I/O 适配 ───────────────────────────────────────────
export {
  blockingDecisions,
  chooseNow,
  confirmL3,
  createDecision,
  getDecision,
  listDecisions,
  overrideDecision,
  tickL2,
} from "./decisions.js";
                                                                  
export { configureIo, coreIo, nodeIo } from "./io.js";
                                      

// ── 阶段闸门（done 前 stage 必须 passed）──────────────────────────────
export {
  GATE_STATUSES,
  blockedByGates,
  failGate,
  gateAllowsDone,
  getGate,
  isStage,
  listGates,
  passGate,
  setGate,
} from "./stages.js";
                                                  

// ── journal → state 折叠（journal 权威，state 只是物化视图）─────────────
export { foldEvents, rehydrate, restoreFromEvents } from "./fold.js";

// ── 工作图组成因子（不做固定架构）：GraphSpec/NodeSpec + plan/commit ─────
export { commitGraph, graphSpecTemplate, planGraph } from "./graphspec.js";
                                                                                                   


//# sourceURL=core\index.js