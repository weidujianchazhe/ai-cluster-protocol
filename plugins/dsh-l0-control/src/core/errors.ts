/**
 * 控制面核心错误（与 Python `control_plane` 同名语义，便于差分断言）。
 *
 * 约定：所有「拒绝」都必须在任何状态写入 / 事件追加之前抛出。
 */

export class ControlError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ControlError";
    this.code = code;
  }
}

export class GraphError extends ControlError {
  constructor(message: string, code = "graph_error") {
    super(code, message);
    this.name = "GraphError";
  }
}

export class CycleError extends GraphError {
  constructor(message: string) {
    super(message, "cycle");
    this.name = "CycleError";
  }
}

export class CredentialError extends GraphError {
  constructor(message: string) {
    super(message, "credential_required");
    this.name = "CredentialError";
  }
}

export class EvidenceError extends ControlError {
  constructor(message: string, code = "evidence_error") {
    super(code, message);
    this.name = "EvidenceError";
  }
}

export class DuplicateEvidence extends EvidenceError {
  constructor(message: string) {
    super(message, "duplicate_evidence");
    this.name = "DuplicateEvidence";
  }
}

export class LeaseError extends ControlError {
  constructor(message: string, code = "lease_error") {
    super(code, message);
    this.name = "LeaseError";
  }
}

export class LeaseHeld extends LeaseError {
  constructor(message: string) {
    super(message, "lease_held");
    this.name = "LeaseHeld";
  }
}

export class LeaseExpired extends LeaseError {
  constructor(message: string) {
    super(message, "lease_expired");
    this.name = "LeaseExpired";
  }
}

export class FencingError extends LeaseError {
  constructor(message: string) {
    super(message, "fencing");
    this.name = "FencingError";
  }
}

export class DecisionError extends ControlError {
  constructor(message: string, code = "decision_error") {
    super(code, message);
    this.name = "DecisionError";
  }
}

export class ReplanError extends ControlError {
  constructor(message: string, code = "replan_error") {
    super(code, message);
    this.name = "ReplanError";
  }
}

export class StageError extends ControlError {
  constructor(message: string, code = "stage_error") {
    super(code, message);
    this.name = "StageError";
  }
}
