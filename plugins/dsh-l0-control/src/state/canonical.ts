/**
 * N4 · 规范序列化 / 哈希链 / 事件号
 *
 * 与 Python 对齐的口径（`control_plane/db.py`、`events.py`）：
 *   - `eventIdOf(seq)` = `EVT-%06d`，与 `_next_event_id` 同格式；
 *   - `nowIso()` = 本地时区 ISO 秒精度，与 `db.now_iso()` 同形；
 *   - `canonicalJson()` 用**紧凑分隔符 + 键排序**，只作为哈希输入，
 *     不追求与 Python `json.dumps(..., sort_keys=True)` 的默认空格逐字节一致
 *     （Python 默认分隔符是 `", "` / `": "`；需要跨语言比对时用 `pythonJson`）。
 */

import { createHash } from 'node:crypto';
import type { JournalRecord, Json } from './types.ts';

/** 规范 JSON：对象键排序、无多余空格。数组顺序保留（顺序有语义）。 */
export function canonicalJson(value: Json | unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = sortValue(record[key]);
    return out;
  }
  return value;
}

/** 与 Python 默认分隔符一致的序列化，仅供跨语言 fixture 对比。 */
export function pythonJson(value: unknown): string {
  return JSON.stringify(sortValue(value), null, 0)
    .replace(/","/g, '", "')
    .replace(/":"/g, '": "')
    .replace(/^\{/, '{ ')
    .replace(/\}$/, ' }');
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function eventIdOf(seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) throw new RangeError(`seq 必须是正整数：${seq}`);
  return `EVT-${String(seq).padStart(6, '0')}`;
}

/** 本地时区 ISO 秒精度（与 Python `db.now_iso()` 同形，例如 2026-10-29T21:40:02+08:00）。 */
export function nowIso(at: number = Date.now()): string {
  const date = new Date(at);
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;
}

export interface RecordDraft {
  seq: number;
  ts: string;
  kind: string;
  nodeId: string | null;
  payload: Json;
  prevHash: string;
}

/** 计算记录哈希：哈希输入不含 `hash` 字段（含 eventId，便于与 Python 事件号对齐）。 */
export function hashRecord(draft: RecordDraft & { eventId?: string }): string {
  return sha256Hex(
    canonicalJson({
      seq: draft.seq,
      eventId: draft.eventId ?? eventIdOf(draft.seq),
      ts: draft.ts,
      kind: draft.kind,
      nodeId: draft.nodeId,
      payload: draft.payload,
      prevHash: draft.prevHash,
    }),
  );
}

export function sealRecord(
  draft: RecordDraft & { eventId?: string },
): JournalRecord {
  const eventId = draft.eventId ?? eventIdOf(draft.seq);
  const hash = hashRecord({ ...draft, eventId });
  return {
    seq: draft.seq,
    eventId,
    ts: draft.ts,
    kind: draft.kind,
    nodeId: draft.nodeId,
    payload: (draft.payload ?? {}) as JournalRecord['payload'],
    prevHash: draft.prevHash,
    hash,
  };
}

/** 校验单条记录的哈希是否自洽（不含链关系）。 */
export function recordHashOk(record: JournalRecord): boolean {
  return (
    hashRecord({
      seq: record.seq,
      eventId: record.eventId,
      ts: record.ts,
      kind: record.kind,
      nodeId: record.nodeId,
      payload: record.payload,
      prevHash: record.prevHash,
    }) === record.hash
  );
}

/** 解析一行 JSONL；返回 null 表示该行不可解析（torn / 损坏）。 */
export function parseRecordLine(line: string): JournalRecord | null {
  const text = line.trim();
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Partial<JournalRecord>;
  const okShape =
    Number.isInteger(record.seq) &&
    typeof record.eventId === 'string' &&
    typeof record.ts === 'string' &&
    typeof record.kind === 'string' &&
    typeof record.hash === 'string' &&
    typeof record.prevHash === 'string' &&
    record.payload !== undefined &&
    (record.nodeId === null || typeof record.nodeId === 'string');
  return okShape ? (record as JournalRecord) : null;
}

/** 稳定指纹（用于快照/投影比对）。 */
export function fingerprint(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
