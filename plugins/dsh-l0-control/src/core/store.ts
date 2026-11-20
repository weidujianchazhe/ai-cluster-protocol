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
  /**
   * 影响「就绪集合」的变更计数（单调递增）。
   *
   * 为什么需要它：`readySet()` 要遍历全图筛 ready 再排序，而 `task_next` 每次调用都会
   * 用到它（worker 唯一问活的入口）。就绪集合只在**状态迁移 / 节点增删 / 依赖变更**时
   * 才会变，可这三件事之外的调用占绝大多数。
   *
   * 为什么不用 `journal.count()` 当键：`Store.atomically()` 回滚会把日志截短，之后
   * 重写可能让它回到同一个条数，而内容不同——那样的键会命中过期缓存。这个计数器
   * 由**变更函数自己** bump，回滚不会把它退回，因此不会出现「同一键两种内容」。
   */
  private epochCounter = 0;

  constructor(options: { clock?: Clock; journal?: Journal; state?: State } = {}) {
    this.clock = options.clock ?? systemClock;
    this.journal = options.journal ?? new Journal(this.clock);
    this.state = options.state ?? emptyState();
  }

  /** 就绪集合相关状态的版本号（每次变更 +1，只增不减）。 */
  get epoch(): number {
    return this.epochCounter;
  }

  /** 由 `graph.ts` 的变更函数调用（状态迁移 / 节点增删 / 依赖变更）。 */
  bumpEpoch(): void {
    this.epochCounter += 1;
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

  /** 状态 + 回滚点的**轻量**快照（回滚专用）。 */
  captureForRollback(): { state: State; mark: { length: number } } {
    return { state: cloneState(this.state), mark: this.journal.mark() };
  }

  restore(snapshot: { state: State; events: EventRecord[] }): void {
    this.state = cloneState(snapshot.state);
    this.journal.restore(snapshot.events);
  }

  restoreFromRollback(snapshot: { state: State; mark: { length: number } }): void {
    this.state = cloneState(snapshot.state);
    this.journal.rollbackTo(snapshot.mark);
  }

  /**
   * 单事务区间：fn 抛错 → 状态与日志一起回滚后原样抛出。
   *
   * **为什么回滚点用 `journal.mark()` 而不是整份日志拷贝**：
   * 日志只追加，回滚 = 截断到 mark 之前，语义完全等价；但成本从
   * O(events) 的深拷贝降到 O(1)。16000 条事件时 `raw()` 约 11ms，
   * 而 claim / verify / submit 每次都要进出 `atomically` —— 深拷贝版把
   * 总成本从 O(n) 拉成 O(n²)，千节点吞吐 30 节点/秒。改 O(1) 回滚点后
   * 同一机器同一图跑到 441 节点/秒（×14.7）。
   *
   * `state` 仍然整份 `structuredClone`：状态是可变表（Map + 对象），
   * 没有天然的撤销日志，而它是 O(nodes) 而非 O(events)，且远小于日志。
   */
  atomically<T>(fn: () => T): T {
    const snapshot = this.captureForRollback();
    try {
      return fn();
    } catch (error) {
      this.restoreFromRollback(snapshot);
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
