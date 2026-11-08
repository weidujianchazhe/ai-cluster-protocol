/**
 * 进程内状态表（Python SQLite 表在 TS 侧的等价物）。
 *
 *  - 权威是「状态 + 只追加事件日志」；本类只负责状态容器与**原子区间**语义；
 *  - 持久化（JSONL journal / fs CAS）归 N4，本层不落盘；
 *  - `atomically()` 提供 replan 需要的「全成或全不成」语义：
 *    任何一步抛错 → 状态与日志一起回滚（等价 Python `with conn:`）。
 */
import { Journal } from "./journal.ts";
import type {
  Artifact,
  Clock,
  DecisionRecord,
  Edge,
  EvidenceRecord,
  EventRecord,
  Lease,
  NodeRecord,
  ReplanEvent,
  StageGate,
} from "./types.ts";
import { systemClock } from "./types.ts";

export interface State {
  nodes: Map<string, NodeRecord>;
  edges: Edge[];
  leases: Map<string, Lease>;
  leaseCounters: Map<string, number>;
  artifacts: Map<string, Artifact>;
  evidence: Map<string, EvidenceRecord>;
  decisions: Map<string, DecisionRecord>;
  gates: Map<string, StageGate>;
  replanEvents: ReplanEvent[];
  meta: Map<string, string>;
}

export function emptyState(): State {
  return {
    nodes: new Map(),
    edges: [],
    leases: new Map(),
    leaseCounters: new Map(),
    artifacts: new Map(),
    evidence: new Map(),
    decisions: new Map(),
    gates: new Map(),
    replanEvents: [],
    meta: new Map([["graph_version", "1"]]),
  };
}

function cloneState(state: State): State {
  return structuredClone(state);
}

export class Store {
  state: State;
  readonly journal: Journal;
  readonly clock: Clock;

  constructor(options: { clock?: Clock; journal?: Journal; state?: State } = {}) {
    this.clock = options.clock ?? systemClock;
    this.journal = options.journal ?? new Journal(this.clock);
    this.state = options.state ?? emptyState();
  }

  nowIso(): string {
    return this.clock.nowIso();
  }

  nowMs(): number {
    return this.clock.nowMs();
  }

  /** 状态 + 日志的一致快照（用于回滚与差分）。 */
  capture(): { state: State; events: EventRecord[] } {
    return { state: cloneState(this.state), events: this.journal.raw() };
  }

  restore(snapshot: { state: State; events: EventRecord[] }): void {
    this.state = cloneState(snapshot.state);
    this.journal.restore(snapshot.events);
  }

  /** 单事务区间：fn 抛错 → 状态与日志一起回滚后原样抛出。 */
  atomically<T>(fn: () => T): T {
    const snapshot = this.capture();
    try {
      return fn();
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  /**
   * **写入唯一入口**：把「追加事件」和「改内存」绑在同一次调用里。
   *
   * 为什么需要它：今天踩过的坑——`dropLease` 只删内存不写事件，重启后 fold 重放
   * 旧的 `lease_claimed` 把租约复活，节点停在 ready 却「已被持有」，永久卡死。
   * 这类 bug 靠代码审查防不住，必须让「只改内存」在结构上难以写出来。
   *
   * 语义：事件先追加、再执行 fn；fn 抛错时 `atomically` 会把**事件与状态一起**回滚，
   * 所以不会留下「有事件没状态」的孤儿。
   *
   * 用法：
   * ```ts
   * store.mutate({ kind: "lease_released", nodeId, payload: { reason } }, () => {
   *   store.state.leases.delete(nodeId);
   * });
   * ```
   */
  mutate<T>(
    event: { kind: string; nodeId?: string | null; payload?: Record<string, unknown> },
    fn: () => T,
  ): T {
    return this.atomically(() => {
      this.journal.append(event.kind, event.nodeId ?? null, event.payload ?? {});
      return fn();
    });
  }
}
