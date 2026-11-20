/**
 * 控制面核心错误（与 Python `control_plane` 同名语义，便于差分断言）。
 *
 * 约定：所有「拒绝」都必须在任何状态写入 / 事件追加之前抛出。
 */

/**
 * 准入闸门：与派活计划层（`dispatch/dispatcher.ts` 的 `DispatchGate`）用**同一套词汇**。
 *
 * 为什么必须同一套：两层对同一节点给出不同原因，现场会自相矛盾——
 * 计划说「被 queue 挡」→ 运维去调 `maxQueuedTasks`；claim 却回 `graph_capacity`
 * → 运维转头去调 `maxParallel`。两个动作都做了，问题还在。
 */
                           
                                                  
              
                                            
               
                  
          
             
             

export class ControlError extends Error {
           code        ;
  /** 拒绝时命中的闸门；非限流类拒绝（状态不对、租约被占）没有这个字段。 */
           gate                ;
  constructor(code        , message        , gate                ) {
    super(message);
    this.name = "ControlError";
    this.code = code;
    if (gate) this.gate = gate;
  }
}

export class GraphError extends ControlError {
  constructor(message        , code = "graph_error") {
    super(code, message);
    this.name = "GraphError";
  }
}

export class CycleError extends GraphError {
  constructor(message        ) {
    super(message, "cycle");
    this.name = "CycleError";
  }
}

export class CredentialError extends GraphError {
  constructor(message        ) {
    super(message, "credential_required");
    this.name = "CredentialError";
  }
}

export class EvidenceError extends ControlError {
  constructor(message        , code = "evidence_error") {
    super(code, message);
    this.name = "EvidenceError";
  }
}

export class DuplicateEvidence extends EvidenceError {
  constructor(message        ) {
    super(message, "duplicate_evidence");
    this.name = "DuplicateEvidence";
  }
}

export class LeaseError extends ControlError {
  constructor(message        , code = "lease_error", gate                ) {
    super(code, message, gate);
    this.name = "LeaseError";
  }
}

export class LeaseHeld extends LeaseError {
  constructor(message        ) {
    super(message, "lease_held");
    this.name = "LeaseHeld";
  }
}

export class LeaseExpired extends LeaseError {
  constructor(message        ) {
    super(message, "lease_expired");
    this.name = "LeaseExpired";
  }
}

export class FencingError extends LeaseError {
  constructor(message        ) {
    super(message, "fencing");
    this.name = "FencingError";
  }
}

export class BudgetError extends ControlError {
  constructor(message        , code = "budget_exceeded", gate                ) {
    super(code, message, gate);
    this.name = "BudgetError";
  }
}

export class DecisionError extends ControlError {
  constructor(message        , code = "decision_error") {
    super(code, message);
    this.name = "DecisionError";
  }
}

export class ReplanError extends ControlError {
  constructor(message        , code = "replan_error") {
    super(code, message);
    this.name = "ReplanError";
  }
}

export class StageError extends ControlError {
  constructor(message        , code = "stage_error") {
    super(code, message);
    this.name = "StageError";
  }
}


//# sourceURL=core\errors.js