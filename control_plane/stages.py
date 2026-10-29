# -*- coding: utf-8 -*-
"""control_plane.stages —— 阶段闸门 + 任务图重算（replan）与版本

规则（Root 卡）：
  - 节点 done 前，所在阶段闸门必须 passed；
  - replan 使 graph_version 递增，并记录 added/removed 节点与原因；
  - 闸门状态 pending / passed / failed，可带证据引用。
"""

from __future__ import annotations

import sqlite3
from typing import Any

from . import db, events, graph

STAGES = ("research", "design", "build", "audit", "deliver")
GATE_STATUSES = ("pending", "passed", "failed")
REPLAN_REASONS = (
    "gate_failed",
    "evidence_insufficient",
    "scope_change",
    "decision_override",
    "failure_retry",
)


class StageError(Exception):
    pass


def set_gate(
    conn: sqlite3.Connection,
    stage: str,
    status: str,
    evidence_refs: list[str] | None = None,
) -> dict[str, Any]:
    if stage not in STAGES:
        raise StageError("非法阶段：%s" % stage)
    if status not in GATE_STATUSES:
        raise StageError("非法闸门状态：%s" % status)
    ts = db.now_iso()
    with conn:
        conn.execute(
            "INSERT INTO stage_gates(stage,status,evidence_refs_json,decided_at) VALUES(?,?,?,?)"
            " ON CONFLICT(stage) DO UPDATE SET status=excluded.status,"
            " evidence_refs_json=excluded.evidence_refs_json, decided_at=excluded.decided_at",
            (stage, status, db.dumps(evidence_refs or []), ts),
        )
        events.append_event(
            conn, "stage_gate_changed", None,
            {"stage": stage, "status": status, "evidence_refs": evidence_refs or [], "at": ts},
            commit=False,
        )
    return get_gate(conn, stage)  # type: ignore[return-value]


def pass_gate(conn: sqlite3.Connection, stage: str, evidence_refs: list[str] | None = None) -> dict[str, Any]:
    return set_gate(conn, stage, "passed", evidence_refs)


def fail_gate(conn: sqlite3.Connection, stage: str, evidence_refs: list[str] | None = None) -> dict[str, Any]:
    return set_gate(conn, stage, "failed", evidence_refs)


def get_gate(conn: sqlite3.Connection, stage: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM stage_gates WHERE stage=?", (stage,)).fetchone()
    if row is None:
        return None
    return {
        "stage": row["stage"],
        "status": row["status"],
        "evidence_refs": db.loads(row["evidence_refs_json"], []),
        "decided_at": row["decided_at"],
    }


def list_gates(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT stage FROM stage_gates ORDER BY stage").fetchall()
    return [get_gate(conn, r["stage"]) for r in rows]  # type: ignore[misc]


def gate_allows_done(conn: sqlite3.Connection, stage: str | None) -> bool:
    if not stage:
        return True
    gate = get_gate(conn, stage)
    return gate is not None and gate["status"] == "passed"


def current_version(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT value FROM meta WHERE key='graph_version'").fetchone()
    return int(row["value"]) if row else 1


def _bump_version(conn: sqlite3.Connection) -> int:
    conn.execute(
        "INSERT INTO meta(key,value) VALUES('graph_version','1') ON CONFLICT(key) DO NOTHING"
    )
    conn.execute("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='graph_version'")
    return current_version(conn)


def record_replan(
    conn: sqlite3.Connection,
    *,
    reason: str,
    added_nodes: list[str] | None = None,
    removed_nodes: list[str] | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    if reason not in REPLAN_REASONS:
        raise StageError("非法 replan 原因：%s" % reason)
    added = list(added_nodes or [])
    removed = list(removed_nodes or [])
    ts = db.now_iso()
    with conn:
        version = _bump_version(conn)
        event_id = "EVT-R%04d" % version
        conn.execute(
            "INSERT INTO replan_events(event_id,at,reason,graph_version,added_json,removed_json,note)"
            " VALUES(?,?,?,?,?,?,?)",
            (event_id, ts, reason, version, db.dumps(added), db.dumps(removed), note),
        )
        events.append_event(
            conn, "graph_replanned", None,
            {"reason": reason, "graph_version": version, "added": added, "removed": removed},
            commit=False,
        )
    return {
        "event_id": event_id,
        "at": ts,
        "reason": reason,
        "graph_version": version,
        "added": added,
        "removed": removed,
        "note": note,
    }


def apply_replan(
    conn: sqlite3.Connection,
    *,
    reason: str,
    add: list[dict[str, Any]] | None = None,
    remove: list[str] | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    """执行一次重算：委托 graph.replan（单事务）。"""
    return graph.replan(conn, reason=reason, add=add, remove=remove, note=note)
