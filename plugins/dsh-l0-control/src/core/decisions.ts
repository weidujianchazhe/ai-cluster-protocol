/**
 * 决策 L0–L3 + 决策账本（Python `decisions.py` 的等价物）。
 *
 * 规则：
 *  - L0 / L1：AI 自动定，直接落 `auto`，不阻塞；
 *  - L2：必须带默认值 + 超时；超时后按默认推进（`timed_out`，chosen === default）；
 *  - L3：硬闸门；创建时无 chosen 则 `blocked`，必须显式确认才继续；
 *  - 所有决策可查、可推翻（`overridden` 留痕）。
 */
import { DecisionError } from "./errors.ts";
import { ALIASES, pickNumber, pickString } from "./alias.ts";
import { getNode } from "./graph.ts";
import type { DecisionLevel, DecisionOption, DecisionRecord } from "./types.ts";
import { DECISION_LEVELS } from "./types.ts";
import type { Store } from "./store.ts";

export const IMPACTS = ["low", "medium", "high"] as const;
export type Impact = (typeof IMPACTS)[number];

export interface CreateDecisionInput {
  decisionId: string;
  level: DecisionLevel;
  question: string;
  options: DecisionOption[];
  nodeId?: string | null;
  defaultOptionId?: string | null;
  chosenOptionId?: string | null;
  reversible?: boolean;
  impact?: Impact;
  timeoutSec?: number;
  note?: string | null;
  now?: number;
}

function optionIds(options: DecisionOption[]): string[] {
  return options.map((o) => o.option_id);
}

export function getDecision(store: Store, decisionId: string): DecisionRecord | undefined {
  const rec = store.state.decisions.get(decisionId);
  return rec ? { ...rec, options: rec.options.map((o) => ({ ...o })) } : undefined;
}

export function listDecisions(store: Store, options: { nodeId?: string | null } = {}): DecisionRecord[] {
  return [...store.state.decisions.values()]
    .filter((d) => (options.nodeId === undefined ? true : d.node_id === options.nodeId))
    .sort((a, b) =>
      a.created_at === b.created_at
        ? a.decision_id.localeCompare(b.decision_id)
        : a.created_at.localeCompare(b.created_at),
    )
    .map((d) => ({ ...d, options: d.options.map((o) => ({ ...o })) }));
}

export function createDecision(store: Store, input: CreateDecisionInput): DecisionRecord {
  const raw = input as unknown as Record<string, unknown>;
  // 别名兼容：decision_id/decisionId、node_id/nodeId、default_option_id/defaultOptionId、
  // chosen_option_id/chosenOptionId、timeout_sec/timeoutSec（冲突 → AliasError）
  const decisionId = pickString(raw, ALIASES.decisionId) ?? String(input.decisionId ?? "");
  const nodeId = pickString(raw, ALIASES.nodeId) ?? (input.nodeId ?? null);
  const defaultOptionId = pickString(raw, ALIASES.defaultOptionId) ?? (input.defaultOptionId ?? null);
  const chosenOptionId = pickString(raw, ALIASES.optionId) ?? (input.chosenOptionId ?? null);
  const timeoutSecRaw = pickNumber(raw, ALIASES.timeoutSec) ?? input.timeoutSec ?? 0;
  const level = input.level;
  const question = input.question;
  if (!DECISION_LEVELS.includes(level)) throw new DecisionError(`非法决策层级：${level}`);
  const impact = (input.impact ?? "low") as Impact;
  if (!IMPACTS.includes(impact)) throw new DecisionError(`非法 impact：${impact}`);
  if (!question) throw new DecisionError("question 不能为空");
  if (!decisionId) throw new DecisionError("decision_id 不能为空");
  if (store.state.decisions.has(decisionId)) throw new DecisionError(`决策已存在：${decisionId}`);

  const options = [...(input.options ?? [])].map((o) => ({
    option_id: String(
      (o as unknown as Record<string, unknown>).option_id ??
        (o as unknown as Record<string, unknown>).optionId ??
        "",
    ),
    ...(o.label === undefined ? {} : { label: o.label }),
  }));
  const ids = optionIds(options);
  if (ids.length < 2 || new Set(ids).size !== ids.length) {
    throw new DecisionError("options 至少两项且 option_id 唯一");
  }
  const pairs: Array<[string, string | null | undefined]> = [
    ["default_option_id", defaultOptionId],
    ["chosen_option_id", chosenOptionId],
  ];
  for (const [key, value] of pairs) {
    if (value !== undefined && value !== null && !ids.includes(value)) {
      throw new DecisionError(`${key} 不在 options 中：${value}`);
    }
  }
  if (nodeId && !getNode(store, nodeId)) {
    throw new DecisionError(`node_id 不存在：${nodeId}`);
  }

  const t = input.now ?? store.nowMs();
  const created = store.nowIso();
  const timeoutSec = Number(timeoutSecRaw ?? 0);
  let status: DecisionRecord["status"];
  let chosen: string | null;
  let deadline: number | null;

  if (level === "L2") {
    if (!defaultOptionId) throw new DecisionError("L2 必须提供 default_option_id/defaultOptionId");
    if (timeoutSec <= 0) throw new DecisionError("L2 必须提供 > 0 的 timeout_sec/timeoutSec");
    status = "proposed";
    chosen = null;
    deadline = t + timeoutSec;
  } else if (level === "L3") {
    status = chosenOptionId ? "confirmed" : "blocked";
    chosen = chosenOptionId ?? null;
    deadline = null;
  } else {
    if (!chosenOptionId) throw new DecisionError(`${level} 必须提供 chosen_option_id/optionId`);
    status = "auto";
    chosen = chosenOptionId;
    deadline = null;
  }

  const record: DecisionRecord = {
    decision_id: decisionId,
    node_id: nodeId ?? null,
    level,
    question,
    options,
    default_option_id: defaultOptionId ?? null,
    chosen_option_id: chosen,
    reversible: input.reversible ?? true,
    impact,
    status,
    timeout_sec: timeoutSec,
    decided_at: status === "auto" || status === "confirmed" ? store.nowIso() : null,
    note: input.note ?? null,
    created_at: created,
    deadline_at: deadline,
  };
  store.state.decisions.set(decisionId, record);
  store.journal.append("decision_created", record.node_id, {
    decision_id: decisionId,
    level,
    status,
    // 供 fold 重建完整决策记录（options/default/timeout/deadline 等）
    decision: { ...record, options: record.options.map((o) => ({ ...o })) },
  });
  if (status === "auto" || status === "confirmed") {
    store.journal.append("decision_decided", record.node_id, {
      decision_id: decisionId,
      chosen,
      level,
      status,
    });
  } else if (status === "blocked") {
    store.journal.append("decision_blocked", record.node_id, { decision_id: decisionId, level });
  }
  return getDecision(store, decisionId) as DecisionRecord;
}

/** 推进超时的 L2：`status=timed_out`，`chosen === default`。 */
export function tickL2(store: Store, options: { now?: number } = {}): string[] {
  const t = options.now ?? store.nowMs();
  const due = [...store.state.decisions.values()]
    .filter(
      (d) =>
        d.level === "L2" &&
        d.status === "proposed" &&
        d.deadline_at !== null &&
        d.deadline_at <= t,
    )
    .sort((a, b) => a.decision_id.localeCompare(b.decision_id));
  const out: string[] = [];
  for (const rec of due) {
    rec.status = "timed_out";
    rec.chosen_option_id = rec.default_option_id;
    rec.decided_at = store.nowIso();
    store.state.decisions.set(rec.decision_id, rec);
    store.journal.append("decision_timed_out", rec.node_id, {
      decision_id: rec.decision_id,
      level: "L2",
      default: rec.default_option_id,
      chosen: rec.default_option_id,
      timeout_sec: rec.timeout_sec,
    });
    out.push(rec.decision_id);
  }
  return out;
}

/** L3 硬闸门：显式确认。 */
export function confirmL3(
  store: Store,
  decisionId: string,
  chosenOptionId: string,
  options: { note?: string | null } = {},
): DecisionRecord {
  const rec = store.state.decisions.get(decisionId);
  if (!rec) throw new DecisionError(`决策不存在：${decisionId}`);
  if (rec.level !== "L3") throw new DecisionError(`只有 L3 需要 confirm：${decisionId}`);
  if (rec.status !== "blocked" && rec.status !== "proposed") {
    throw new DecisionError(`L3 当前状态不可 confirm：${rec.status}`);
  }
  if (!optionIds(rec.options).includes(chosenOptionId)) {
    throw new DecisionError(`chosen 不在 options 中：${chosenOptionId}`);
  }
  rec.status = "confirmed";
  rec.chosen_option_id = chosenOptionId;
  rec.decided_at = store.nowIso();
  if (options.note !== undefined && options.note !== null) rec.note = options.note;
  store.state.decisions.set(decisionId, rec);
  store.journal.append("decision_confirmed", rec.node_id, {
    decision_id: decisionId,
    chosen: chosenOptionId,
    level: "L3",
  });
  return getDecision(store, decisionId) as DecisionRecord;
}

/** 推翻已定决策（L0–L3 均可，留痕）。 */
export function overrideDecision(
  store: Store,
  decisionId: string,
  chosenOptionId: string,
  options: { note?: string | null } = {},
): DecisionRecord {
  const rec = store.state.decisions.get(decisionId);
  if (!rec) throw new DecisionError(`决策不存在：${decisionId}`);
  if (!optionIds(rec.options).includes(chosenOptionId)) {
    throw new DecisionError(`chosen 不在 options 中：${chosenOptionId}`);
  }
  const from = rec.chosen_option_id;
  rec.status = "overridden";
  rec.chosen_option_id = chosenOptionId;
  rec.decided_at = store.nowIso();
  if (options.note !== undefined && options.note !== null) rec.note = options.note;
  store.state.decisions.set(decisionId, rec);
  store.journal.append("decision_overridden", rec.node_id, {
    decision_id: decisionId,
    from,
    to: chosenOptionId,
  });
  return getDecision(store, decisionId) as DecisionRecord;
}

/**
 * 用户/编排层的「现在就定」：L2 提前定（`confirmed`）、L3 确认、其他层级推翻（`overridden`）。
 */
export function chooseNow(
  store: Store,
  decisionId: string,
  chosenOptionId: string,
  options: { note?: string | null } = {},
): DecisionRecord {
  const rec = store.state.decisions.get(decisionId);
  if (!rec) throw new DecisionError(`决策不存在：${decisionId}`);
  if (!optionIds(rec.options).includes(chosenOptionId)) {
    throw new DecisionError(`chosen 不在 options 中：${chosenOptionId}`);
  }
  if (rec.level === "L3") return confirmL3(store, decisionId, chosenOptionId, options);
  if (rec.level === "L2" && rec.status === "proposed") {
    rec.status = "confirmed";
    rec.chosen_option_id = chosenOptionId;
    rec.decided_at = store.nowIso();
    if (options.note !== undefined && options.note !== null) rec.note = options.note;
    store.state.decisions.set(decisionId, rec);
    store.journal.append("decision_decided", rec.node_id, {
      decision_id: decisionId,
      chosen: chosenOptionId,
      level: rec.level,
      status: rec.status,
    });
    return getDecision(store, decisionId) as DecisionRecord;
  }
  return overrideDecision(store, decisionId, chosenOptionId, options);
}

/**
 * 节点上「尚未落地」的闸门决策（信息性，供编排/投影使用）。
 *
 * 注意：**不**参与 core 的 done 判定 —— Python `evidence.finalize` 也不查决策，
 * L3 闸门由编排层在派发前检查（保持两侧行为一致）。
 */
export function blockingDecisions(store: Store, nodeId: string): DecisionRecord[] {
  return listDecisions(store, { nodeId }).filter(
    (d) => (d.level === "L3" && d.status === "blocked") || (d.level === "L2" && d.status === "proposed"),
  );
}
