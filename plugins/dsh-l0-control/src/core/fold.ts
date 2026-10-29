/**
 * journal → state 折叠（N3-R6）：**journal 是权威**，state 只是它的物化视图。
 *
 * 用途：插件启动/重开时，把持久化的 journal（JSONL）折回 `State`，否则
 * `restoreCoreJournal` 只回灌日志、`counts` 全是 0（N2 实测的恢复缺口）。
 *
 * 覆盖面：nodes / edges / leases / lease_counters / artifacts / evidence / decisions / gates /
 *        replan_events / meta(graph_version,wish_*)
 *
 * 兼容：老事件若缺新字段（如 `artifact_added.verifier_ids`、`decision_created.decision`），
 * fold 走安全默认值，不抛错。
 */
import type { State } from "./store.ts";
import { emptyState } from "./store.ts";
import type {
  Artifact,
  DecisionRecord,
  Edge,
  EdgeKind,
  EventRecord,
  EvidenceRecord,
  Lease,
  NodeRecord,
  NodeStatus,
  ReplanEvent,
  StageGate,
  Verdict,
} from "./types.ts";
import type { Store } from "./store.ts";

function str(value: unknown, fallback = ""): string {
  return value === undefined || value === null ? fallback : String(value);
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function arrString(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

function cloneNode(node: NodeRecord): NodeRecord {
  return {
    ...node,
    deps: [...(node.deps ?? [])],
    evidence_required: [...(node.evidence_required ?? [])],
    verifier_ids: [...(node.verifier_ids ?? [])],
    budget: { ...(node.budget ?? {}) },
  };
}

/** 把事件流折成状态（纯函数：不读不写 store，只吃 events）。 */
export function foldEvents(events: EventRecord[]): State {
  const state = emptyState();
  const ordered = [...events].sort((a, b) => a.seq - b.seq);

  for (const ev of ordered) {
    const p = obj(ev.payload);
    switch (ev.kind) {
      case "wish_submitted": {
        if (p.wish_id !== undefined) state.meta.set("wish_id", str(p.wish_id));
        if (p.text !== undefined) state.meta.set("wish_text", str(p.text));
        if (p.maxParallel !== undefined) state.meta.set("wish_max_parallel", str(p.maxParallel));
        if (p.budgetTokens !== undefined) state.meta.set("wish_budget_tokens", str(p.budgetTokens));
        break;
      }
      case "node_added": {
        const node = p.node as NodeRecord | undefined;
        if (node?.node_id) state.nodes.set(node.node_id, cloneNode(node));
        break;
      }
      case "node_removed": {
        const node = p.node as NodeRecord | undefined;
        const removedId = str(node?.node_id ?? ev.node_id ?? "");
        if (!removedId) break;
        state.nodes.delete(removedId);
        state.edges = state.edges.filter((e) => e.from !== removedId && e.to !== removedId);
        state.leases.delete(removedId);
        break;
      }
      case "edge_added": {
        const edge: Edge = {
          from: str(p.from),
          to: str(p.to),
          kind: str(p.kind, "blocks") as EdgeKind,
        };
        if (!edge.from || !edge.to) break;
        if (!state.edges.some((e) => e.from === edge.from && e.to === edge.to && e.kind === edge.kind)) {
          state.edges.push(edge);
        }
        break;
      }
      case "edge_removed": {
        state.edges = state.edges.filter(
          (e) =>
            !(
              e.from === str(p.from) &&
              e.to === str(p.to) &&
              e.kind === str(p.kind, "blocks")
            ),
        );
        break;
      }
      case "status_changed": {
        const node = ev.node_id ? state.nodes.get(ev.node_id) : undefined;
        if (!node) break;
        if (p.to !== undefined) node.status = str(p.to) as NodeStatus;
        if (typeof p.at === "string") node.updated_at = p.at;
        if ("assignee" in p) node.assignee = p.assignee === null ? null : str(p.assignee);
        if ("attempts" in p) node.attempts = num(p.attempts, node.attempts);
        break;
      }
      case "assignee_changed": {
        const node = ev.node_id ? state.nodes.get(ev.node_id) : undefined;
        if (node) node.assignee = p.to === null || p.to === undefined ? null : str(p.to);
        break;
      }
      case "attempts_changed": {
        const node = ev.node_id ? state.nodes.get(ev.node_id) : undefined;
        if (node) node.attempts = num(p.to, node.attempts);
        break;
      }
      case "artifact_added": {
        const artifactId = str(p.artifact_id);
        if (!artifactId) break;
        const record: Artifact = {
          artifact_id: artifactId,
          path: str(p.path),
          sha256: str(p.sha256),
          producer_node: str(p.producer_node ?? ev.node_id ?? ""),
          verifier_ids: arrString(p.verifier_ids),
          a2a_artifact_id: p.a2a_artifact_id === undefined ? null : (p.a2a_artifact_id as string | null),
        };
        state.artifacts.set(artifactId, record);
        break;
      }
      case "evidence_added": {
        const evidenceId = str(p.evidence_id);
        if (!evidenceId || !ev.node_id) break;
        const record: EvidenceRecord = {
          evidence_id: evidenceId,
          node_id: ev.node_id,
          kind: str(p.kind),
          artifact_id: str(p.artifact_id),
          verifier_id: str(p.verifier_id),
          verdict: str(p.verdict, "unknown") as Verdict,
          attempt_no: num(p.attempt_no, 1),
          at: str(p.at, ev.ts),
          producer_instance: str(p.producer_instance),
          auditor_instance: p.auditor_instance === undefined || p.auditor_instance === null
            ? null
            : str(p.auditor_instance),
        };
        state.evidence.set(evidenceId, record);
        break;
      }
      case "lease_claimed":
      case "lease_taken_over":
      case "lease_renewed": {
        const nodeId = str(ev.node_id);
        if (!nodeId) break;
        const previous = state.leases.get(nodeId);
        const token = num(p.fencing_token, previous?.fencing_token ?? 0);
        const lease: Lease = {
          node_id: nodeId,
          owner: str(p.owner ?? p.to_owner, previous?.owner ?? ""),
          fencing_token: token,
          expires_at: num(p.expires_at, previous?.expires_at ?? 0),
          heartbeat_at: num(p.heartbeat_at, previous?.heartbeat_at ?? 0),
        };
        state.leases.set(nodeId, lease);
        state.leaseCounters.set(nodeId, Math.max(state.leaseCounters.get(nodeId) ?? 0, token));
        break;
      }
      case "lease_released":
      case "lease_expired": {
        const nodeId = str(ev.node_id);
        if (!nodeId) break;
        state.leases.delete(nodeId);
        const token = num(p.fencing_token, 0);
        if (token) {
          state.leaseCounters.set(nodeId, Math.max(state.leaseCounters.get(nodeId) ?? 0, token));
        }
        break;
      }
      case "stage_gate_changed": {
        const stage = str(p.stage);
        if (!stage) break;
        const gate: StageGate = {
          stage: stage as StageGate["stage"],
          status: str(p.status, "pending") as StageGate["status"],
          evidence_refs: arrString(p.evidence_refs),
          decided_at: p.at === undefined ? null : str(p.at),
        };
        state.gates.set(stage, gate);
        break;
      }
      case "decision_created": {
        const decisionId = str(p.decision_id);
        if (!decisionId) break;
        const full = p.decision as DecisionRecord | undefined;
        if (full?.decision_id) {
          state.decisions.set(decisionId, {
            ...full,
            options: (full.options ?? []).map((o) => ({ ...o })),
          });
        } else {
          // 老事件兜底：只还原 id/level/status
          state.decisions.set(decisionId, {
            decision_id: decisionId,
            node_id: ev.node_id,
            level: str(p.level, "L1") as DecisionRecord["level"],
            question: "",
            options: [],
            default_option_id: null,
            chosen_option_id: null,
            reversible: true,
            impact: "low",
            status: str(p.status, "proposed") as DecisionRecord["status"],
            timeout_sec: 0,
            decided_at: null,
            note: null,
            created_at: ev.ts,
            deadline_at: null,
          });
        }
        break;
      }
      case "decision_decided":
      case "decision_blocked":
      case "decision_timed_out":
      case "decision_confirmed":
      case "decision_overridden": {
        const decisionId = str(p.decision_id);
        const record = decisionId ? state.decisions.get(decisionId) : undefined;
        if (!record) break;
        if (ev.kind === "decision_blocked") {
          record.status = "blocked";
        } else if (ev.kind === "decision_timed_out") {
          record.status = "timed_out";
          record.chosen_option_id = p.chosen === undefined
            ? record.default_option_id
            : str(p.chosen);
        } else if (ev.kind === "decision_confirmed") {
          record.status = "confirmed";
          if (p.chosen !== undefined) record.chosen_option_id = str(p.chosen);
        } else if (ev.kind === "decision_overridden") {
          record.status = "overridden";
          if (p.to !== undefined) record.chosen_option_id = str(p.to);
        } else {
          // decision_decided（L0/L1 auto 或 L2 提前定）
          if (p.status !== undefined) record.status = str(p.status) as DecisionRecord["status"];
          if (p.chosen !== undefined) record.chosen_option_id = str(p.chosen);
        }
        record.decided_at = ev.ts;
        break;
      }
      case "graph_replanned": {
        const version = num(p.graph_version, 0);
        if (version) state.meta.set("graph_version", String(version));
        const record: ReplanEvent = {
          event_id: str(p.event_id, ev.event_id),
          at: str(p.at, ev.ts),
          reason: str(p.reason),
          graph_version: version,
          added: arrString(p.added),
          removed: arrString(p.removed),
          note: p.note === undefined || p.note === null ? null : str(p.note),
        };
        state.replanEvents.push(record);
        break;
      }
      default:
        break; // ready_recomputed / node_recovered / runtime_tick 等：纯审计，不影响状态
    }
  }

  return state;
}

/** 用 journal 折出的状态替换 store 的 state（journal 不动；幂等）。 */
export function rehydrate(store: Store): State {
  const folded = foldEvents(store.journal.all());
  store.state = folded;
  return folded;
}

/**
 * 重开场景：把外部加载的 journal 事件**同时**回灌日志并折叠状态。
 *
 * 这正是 N2 `restoreCoreJournal` 缺的那一半 —— 只回灌不折叠会出现
 * `records=N/restored=N` 但 `counts={0,0,0,0}`。
 */
export function restoreFromEvents(store: Store, events: EventRecord[]): State {
  store.journal.restore(events);
  return rehydrate(store);
}
