/**
 * 只追加事件日志（Python `events.py` 的等价物）。
 *
 * 不变量：
 *  - append-only：没有 update/delete API；同 event_id 再写直接抛错；
 *  - seq 单调（从 1 起）；
 *  - 关键事件必须带规定字段（`validateStream`，与 Python `events.validate_stream` 对齐）。
 */
import { ControlError, GraphError } from "./errors.ts";
import type { Clock, EventRecord } from "./types.ts";
import { systemClock } from "./types.ts";

/** 关键事件必备 payload 字段（与 Python `events.REQUIRED_FIELDS` 一致）。 */
export const REQUIRED_FIELDS: Record<string, readonly string[]> = {
  status_changed: ["from", "to", "at"],
  node_added: ["node"],
  node_removed: ["node"],
  edge_added: ["from", "to", "kind"],
  edge_removed: ["from", "to", "kind"],
  assignee_changed: ["to"],
  attempts_changed: ["to"],
};

export interface AppendOptions {
  eventId?: string;
  ts?: string;
  clock?: Clock;
}

export interface StreamIssue {
  seq: number;
  event_id?: string;
  kind?: string;
  problem: string;
  fields?: string[];
}

export interface StreamReport {
  ok: boolean;
  events: number;
  issues: StreamIssue[];
}

export class Journal {
  private readonly events: EventRecord[] = [];
  private readonly ids = new Set<string>();
  private readonly clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  get size(): number {
    return this.events.length;
  }

  append(
    kind: string,
    nodeId: string | null,
    payload: Record<string, unknown> = {},
    options: AppendOptions = {},
  ): EventRecord {
    if (!kind) throw new ControlError("invalid_event", "event kind 不能为空");
    const seq = this.events.length + 1;
    const eventId = options.eventId ?? `EVT-${String(seq).padStart(6, "0")}`;
    if (this.ids.has(eventId)) {
      throw new ControlError("duplicate_event", `事件 ID 重复且日志只追加：${eventId}`);
    }
    const record: EventRecord = {
      seq,
      event_id: eventId,
      ts: options.ts ?? this.clock.nowIso(),
      kind,
      node_id: nodeId,
      payload: { ...payload },
    };
    this.events.push(record);
    this.ids.add(eventId);
    return record;
  }

  /** 按 seq 升序返回（`afterSeq` 为严格大于）。 */
  after(afterSeq = 0): EventRecord[] {
    return this.events.filter((e) => e.seq > afterSeq).map((e) => cloneEvent(e));
  }

  all(): EventRecord[] {
    return this.after(0);
  }

  count(): number {
    return this.events.length;
  }

  /** 体检：seq 单调、event_id/ts 完整、关键事件字段齐全（不抛异常）。 */
  validateStream(): StreamReport {
    const issues: StreamIssue[] = [];
    let prev = 0;
    for (const ev of this.events) {
      if (ev.seq <= prev) {
        issues.push({ seq: ev.seq, problem: "seq_not_monotonic" });
      }
      prev = ev.seq;
      if (!ev.event_id) issues.push({ seq: ev.seq, problem: "missing_event_id" });
      if (!ev.ts) issues.push({ seq: ev.seq, problem: "missing_ts" });
      const required = REQUIRED_FIELDS[ev.kind];
      if (required) {
        const missing = required.filter((f) => !(f in ev.payload));
        if (missing.length) {
          issues.push({
            seq: ev.seq,
            event_id: ev.event_id,
            kind: ev.kind,
            problem: "missing_payload_fields",
            fields: missing,
          });
        }
      }
    }
    return { ok: issues.length === 0, events: this.events.length, issues };
  }

  /** 供 N4 持久化层读取原始记录（只读副本，改不动内部状态）。 */
  raw(): EventRecord[] {
    return this.events.map((e) => cloneEvent(e));
  }

  /**
   * 仅供 `Store.atomically()` 回滚使用（内部 API）。
   * 不是「删除事件」能力：调用方必须持有回滚前捕获的完整日志。
   */
  restore(events: EventRecord[]): void {
    this.events.length = 0;
    this.ids.clear();
    for (const ev of events) {
      this.events.push(cloneEvent(ev));
      this.ids.add(ev.event_id);
    }
  }
}

function cloneEvent(ev: EventRecord): EventRecord {
  return {
    ...ev,
    payload: JSON.parse(JSON.stringify(ev.payload)) as Record<string, unknown>,
  };
}

export function assertJournalReady(journal: Journal): void {
  const report = journal.validateStream();
  if (!report.ok) {
    throw new GraphError(`事件流体检未通过：${JSON.stringify(report.issues.slice(0, 3))}`);
  }
}
