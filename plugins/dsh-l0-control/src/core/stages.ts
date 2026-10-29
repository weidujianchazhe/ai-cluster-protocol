/**
 * 阶段闸门（Python `stages.py` 的 gate 部分）。
 *
 * 规则：
 *  - 节点 `done` 前，其所在 stage 的闸门必须 `passed`（`gateAllowsDone`）；
 *  - 闸门状态 `pending / passed / failed`，可带证据引用；每次变更写 `stage_gate_changed` 事件；
 *  - 本模块不依赖 graph（避免循环），只读写 `Store`。
 */
import { StageError } from "./errors.ts";
import type { GateStatus, Stage, StageGate } from "./types.ts";
import { STAGES } from "./types.ts";
import type { Store } from "./store.ts";

export const GATE_STATUSES: readonly GateStatus[] = ["pending", "passed", "failed"];

export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

export function getGate(store: Store, stage: string): StageGate | undefined {
  const gate = store.state.gates.get(stage);
  return gate ? { ...gate, evidence_refs: [...gate.evidence_refs] } : undefined;
}

export function listGates(store: Store): StageGate[] {
  return [...store.state.gates.values()]
    .sort((a, b) => a.stage.localeCompare(b.stage))
    .map((g) => ({ ...g, evidence_refs: [...g.evidence_refs] }));
}

export interface SetGateOptions {
  evidenceRefs?: string[];
  at?: string;
}

export function setGate(
  store: Store,
  stage: string,
  status: GateStatus,
  options: SetGateOptions = {},
): StageGate {
  if (!isStage(stage)) throw new StageError(`非法阶段：${stage}`);
  if (!GATE_STATUSES.includes(status)) throw new StageError(`非法闸门状态：${status}`);
  const record: StageGate = {
    stage,
    status,
    evidence_refs: [...(options.evidenceRefs ?? [])],
    decided_at: options.at ?? store.nowIso(),
  };
  store.state.gates.set(stage, record);
  store.journal.append("stage_gate_changed", null, {
    stage,
    status,
    evidence_refs: record.evidence_refs,
    at: record.decided_at,
  });
  return { ...record, evidence_refs: [...record.evidence_refs] };
}

export function passGate(store: Store, stage: string, evidenceRefs: string[] = []): StageGate {
  return setGate(store, stage, "passed", { evidenceRefs });
}

export function failGate(store: Store, stage: string, evidenceRefs: string[] = []): StageGate {
  return setGate(store, stage, "failed", { evidenceRefs });
}

/** 节点能否进入 done：无 stage 视为放行；有 stage 必须 `passed`。 */
export function gateAllowsDone(store: Store, stage: string | null | undefined): boolean {
  if (!stage) return true;
  const gate = store.state.gates.get(stage);
  return gate !== undefined && gate.status === "passed";
}

/** 列出被闸门挡住（stage 非 passed）的节点（供编排/投影诊断）。 */
export function blockedByGates(store: Store, nodeIds: string[] = []): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const [nodeId, node] of store.state.nodes) {
    if (nodeIds.length && !nodeIds.includes(nodeId)) continue;
    if (!node.stage) continue;
    if (gateAllowsDone(store, node.stage)) continue;
    out.push({ node_id: nodeId, stage: node.stage, status: node.status });
  }
  return out.sort((a, b) => String(a.node_id).localeCompare(String(b.node_id)));
}
