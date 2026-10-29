# -*- coding: utf-8 -*-
"""control_plane.events —— 只追加事件日志（append + replay）

设计依据：Root 卡「SQLite 事件日志 + 幂等 activity」；L0 细化 §2 / §9。
事件只追加；seq 单调递增；payload 为 JSON。
"""

from __future__ import annotations

import sqlite3
from typing import Any

from . import db


def _next_event_id(conn: sqlite3.Connection) -> str:
    row = conn.execute("SELECT COALESCE(MAX(seq), 0) AS m FROM events").fetchone()
    return "EVT-%06d" % (int(row["m"]) + 1)


def append_event(
    conn: sqlite3.Connection,
    kind: str,
    node_id: str | None = None,
    payload: dict[str, Any] | None = None,
    *,
    event_id: str | None = None,
    ts: str | None = None,
    commit: bool = True,
) -> dict[str, Any]:
    """追加一条事件。返回写入的事件（含 seq）。"""
    if not kind:
        raise ValueError("event kind 不能为空")
    ts = ts or db.now_iso()
    event_id = event_id or _next_event_id(conn)
    cur = conn.execute(
        "INSERT INTO events(event_id, ts, kind, node_id, payload_json) VALUES(?,?,?,?,?)",
        (event_id, ts, kind, node_id, db.dumps(payload or {})),
    )
    if commit:
        conn.commit()
    return {
        "seq": int(cur.lastrowid),
        "event_id": event_id,
        "ts": ts,
        "kind": kind,
        "node_id": node_id,
        "payload": payload or {},
    }


def iter_events(conn: sqlite3.Connection, after_seq: int = 0) -> list[dict[str, Any]]:
    """按 seq 升序读取事件（after_seq 为严格大于）。"""
    rows = conn.execute(
        "SELECT seq, event_id, ts, kind, node_id, payload_json FROM events WHERE seq > ? ORDER BY seq",
        (after_seq,),
    ).fetchall()
    return [
        {
            "seq": int(r["seq"]),
            "event_id": r["event_id"],
            "ts": r["ts"],
            "kind": r["kind"],
            "node_id": r["node_id"],
            "payload": db.loads(r["payload_json"], {}),
        }
        for r in rows
    ]


def count(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT COUNT(*) AS n FROM events").fetchone()
    return int(row["n"])


#: 每个关键事件必须带的 payload 字段（WP-02：replay 只认这些字段）
REQUIRED_FIELDS: dict[str, tuple[str, ...]] = {
    "status_changed": ("from", "to", "at"),
    "node_added": ("node",),
    "node_removed": ("node",),
    "edge_added": ("from", "to", "kind"),
    "edge_removed": ("from", "to", "kind"),
    "assignee_changed": ("to",),
    "attempts_changed": ("to",),
}


def validate_stream(conn: sqlite3.Connection) -> dict[str, Any]:
    """事件流体检：seq 单调、event_id/ts 完整、关键事件字段齐全。

    返回 `{"ok": bool, "events": n, "issues": [...]}`；问题不抛异常，交调用方决定留痕/阻断
    （recovery 用它做恢复前的自检，坏事件不会被静默当成正常 replay 输入）。
    """
    issues: list[dict[str, Any]] = []
    prev_seq = 0
    total = 0
    for ev in iter_events(conn):
        total += 1
        seq = ev["seq"]
        if seq <= prev_seq:
            issues.append({"seq": seq, "problem": "seq_not_monotonic", "prev": prev_seq})
        prev_seq = seq
        if not ev["event_id"]:
            issues.append({"seq": seq, "problem": "missing_event_id"})
        if not ev["ts"]:
            issues.append({"seq": seq, "problem": "missing_ts"})
        if kind_required := REQUIRED_FIELDS.get(ev["kind"]):
            missing = [f for f in kind_required if f not in ev["payload"]]
            if missing:
                issues.append(
                    {"seq": seq, "event_id": ev["event_id"], "kind": ev["kind"],
                     "problem": "missing_payload_fields", "fields": missing}
                )
    return {"ok": not issues, "events": total, "issues": issues}
