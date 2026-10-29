# -*- coding: utf-8 -*-
"""control_plane.recovery —— 崩溃恢复与一致性

规则（Root 卡）：
  - 只从「最近已验证稳定点」恢复：done 节点保留，中间态（claimed/running）退回 ready；
  - submitted/verifying 只有在证据完整时才保留，否则退回 ready；
  - 物化视图必须与事件重放一致；不一致要留痕（不静默）。
"""

from __future__ import annotations

import sqlite3
from typing import Any

from . import db, events, graph, leases, scheduler


def last_done_event(conn: sqlite3.Connection) -> dict[str, Any] | None:
    for ev in reversed(events.iter_events(conn)):
        if ev["kind"] == "status_changed" and ev["payload"].get("to") == "done":
            return ev
    return None


def stable_nodes(conn: sqlite3.Connection) -> list[str]:
    return [n["node_id"] for n in graph.list_nodes(conn) if n["status"] == "done"]


def _evidence_complete(conn: sqlite3.Connection, node: dict[str, Any]) -> bool:
    rows = conn.execute("SELECT * FROM evidence WHERE node_id=?", (node["node_id"],)).fetchall()
    ev = [dict(r) for r in rows]
    if not ev or any(e["verdict"] != "pass" for e in ev):
        return False
    required = set(node["evidence_required"])
    got = {e["kind"] for e in ev if e["verdict"] == "pass"}
    if required - got:
        return False
    allowed = set(node["verifier_ids"])
    if allowed and any(e["verifier_id"] not in allowed for e in ev):
        return False
    return True


def _reset_to_ready(conn: sqlite3.Connection, node_id: str, reason: str) -> None:
    """把中间态节点退回 ready（同一事务：事件 + 状态 + attempts+1 + 清租约）。

    WP-01：不再直写 tasks；WP-02：`from` 由唯一入口取真实前态（旧实现写死 "intermediate"）。
    """
    ts = db.now_iso()
    with conn:
        events.append_event(
            conn, "node_recovered", node_id, {"reason": reason, "at": ts}, commit=False
        )
        graph.set_status(
            conn, node_id, "ready",
            reason="recovered:" + reason,
            assignee=None,
            attempts_delta=1,
            at=ts,
            drop_lease=True,
            notify=False,
            commit=False,
        )


def _state_consistent(conn: sqlite3.Connection) -> bool:
    """全量一致性：状态 + assignee + attempts + 时间戳 + 边集合（WP-02 对齐口径）。"""
    return graph.replay_mismatches(conn) == []


def _mismatches(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    return graph.replay_mismatches(conn)


def recover(conn: sqlite3.Connection, *, now: float | None = None) -> dict[str, Any]:
    """崩溃恢复：过期回收 → 中间态退回 ready → **补推 ready** → 一致性对账。

    WP-04：恢复结束后必须重算 ready，否则「上游已 done、下游仍 planned」会卡死等下一次 done 事件。
    `recompute_ready` 同时会降级依赖未满足的假 ready，属于同一次收敛。
    """
    expired = leases.expire(conn, now=now)
    recovered: list[dict[str, str]] = [
        {"node_id": nid, "reason": "lease_expired"} for nid in expired
    ]

    for n in graph.list_nodes(conn):
        if n["status"] in ("claimed", "running"):
            _reset_to_ready(conn, n["node_id"], "crash_intermediate")
            recovered.append({"node_id": n["node_id"], "reason": "crash_intermediate"})
        elif n["status"] in ("submitted", "verifying") and not _evidence_complete(conn, n):
            _reset_to_ready(conn, n["node_id"], "incomplete_evidence")
            recovered.append({"node_id": n["node_id"], "reason": "incomplete_evidence"})

    # 补推 ready：把「依赖已全 done 的 planned」提升为 ready（幂等，无变化不写事件）
    promoted = scheduler.recompute_ready(conn, reason="recovery")

    # 事件流体检：坏事件不静默参与 replay（只留痕，不阻断恢复）
    stream = events.validate_stream(conn)
    if not stream["ok"]:
        events.append_event(
            conn, "event_stream_invalid", None,
            {"issues": stream["issues"], "at": db.now_iso()},
        )

    diff = _mismatches(conn)
    mismatch = bool(diff)
    if mismatch:
        events.append_event(conn, "recovery_mismatch", None, {"at": db.now_iso(), "diffs": diff})
    if recovered or promoted:
        events.append_event(
            conn, "recovery_completed", None,
            {"recovered": recovered, "promoted": promoted, "mismatch": mismatch, "at": db.now_iso()},
        )
    return {
        "recovered": recovered,
        "promoted": promoted,
        "stable_nodes": stable_nodes(conn),
        "last_done_event": last_done_event(conn),
        "mismatch": mismatch,
        "mismatch_detail": diff,
        "event_stream_ok": stream["ok"],
        "event_stream_issues": stream["issues"],
    }
