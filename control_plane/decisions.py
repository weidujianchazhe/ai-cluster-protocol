# -*- coding: utf-8 -*-
"""control_plane.decisions —— 决策节点 L0–L3 + 决策账本

规则（Root 卡 / 控制面对齐 A4）：
  - L0 / L1：AI 自动定，落账（auto），不阻塞；
  - L2：必须带默认值 + 超时；超时后按默认推进（timed_out，chosen == default）；
  - L3：硬闸门；创建时无 chosen 则 blocked，必须显式 confirm 才能继续；
  - 所有决策可查、可推翻（overridden 留痕）。
"""

from __future__ import annotations

import sqlite3
import time
from typing import Any

from . import db, events, graph

LEVELS = {"L0", "L1", "L2", "L3"}
IMPACTS = {"low", "medium", "high"}


class DecisionError(Exception):
    pass


def _now(now: float | None) -> float:
    return time.time() if now is None else float(now)


def _option_ids(options: list[dict[str, str]]) -> list[str]:
    return [o["option_id"] for o in options]


def _record(conn: sqlite3.Connection, decision_id: str) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM decisions WHERE decision_id=?", (decision_id,)).fetchone()
    if row is None:
        raise DecisionError("决策不存在：%s" % decision_id)
    return {
        "decision_id": row["decision_id"],
        "node_id": row["node_id"],
        "level": row["level"],
        "question": row["question"],
        "options": db.loads(row["options_json"], []),
        "default_option_id": row["default_option_id"],
        "chosen_option_id": row["chosen_option_id"],
        "reversible": bool(row["reversible"]),
        "impact": row["impact"],
        "status": row["status"],
        "timeout_sec": int(row["timeout_sec"]),
        "decided_at": row["decided_at"],
        "note": row["note"],
        "created_at": row["created_at"],
        "deadline_at": row["deadline_at"],
    }


def get_decision(conn: sqlite3.Connection, decision_id: str) -> dict[str, Any] | None:
    try:
        return _record(conn, decision_id)
    except DecisionError:
        return None


def list_decisions(conn: sqlite3.Connection, *, node_id: str | None = None) -> list[dict[str, Any]]:
    if node_id is None:
        rows = conn.execute("SELECT decision_id FROM decisions ORDER BY created_at, decision_id").fetchall()
    else:
        rows = conn.execute(
            "SELECT decision_id FROM decisions WHERE node_id=? ORDER BY created_at, decision_id", (node_id,)
        ).fetchall()
    return [_record(conn, r["decision_id"]) for r in rows]


def create_decision(
    conn: sqlite3.Connection,
    *,
    decision_id: str,
    level: str,
    question: str,
    options: list[dict[str, str]],
    node_id: str | None = None,
    default_option_id: str | None = None,
    chosen_option_id: str | None = None,
    reversible: bool = True,
    impact: str = "low",
    timeout_sec: int = 0,
    note: str | None = None,
    now: float | None = None,
) -> dict[str, Any]:
    if level not in LEVELS:
        raise DecisionError("非法决策层级：%s" % level)
    if impact not in IMPACTS:
        raise DecisionError("非法 impact：%s" % impact)
    if not question:
        raise DecisionError("question 不能为空")
    if not decision_id:
        raise DecisionError("decision_id 不能为空")
    if get_decision(conn, decision_id) is not None:
        raise DecisionError("决策已存在：%s" % decision_id)
    ids = _option_ids(options)
    if len(ids) < 2 or len(set(ids)) != len(ids):
        raise DecisionError("options 至少两项且 option_id 唯一")
    for key, value in (("default_option_id", default_option_id), ("chosen_option_id", chosen_option_id)):
        if value is not None and value not in ids:
            raise DecisionError("%s 不在 options 中：%s" % (key, value))
    if node_id is not None and graph.get_node(conn, node_id) is None:
        raise DecisionError("node_id 不存在：%s" % node_id)

    t = _now(now)
    created = db.now_iso()
    if level == "L2":
        if not default_option_id:
            raise DecisionError("L2 必须提供 default_option_id")
        if timeout_sec <= 0:
            raise DecisionError("L2 必须提供 > 0 的 timeout_sec")
        status = "proposed"
        chosen = None
        deadline = t + timeout_sec
    elif level == "L3":
        status = "confirmed" if chosen_option_id else "blocked"
        chosen = chosen_option_id
        deadline = None
    else:  # L0 / L1
        if not chosen_option_id:
            raise DecisionError("%s 必须提供 chosen_option_id" % level)
        status = "auto"
        chosen = chosen_option_id
        deadline = None

    with conn:
        conn.execute(
            "INSERT INTO decisions(decision_id,node_id,level,question,options_json,default_option_id,"
            "chosen_option_id,reversible,impact,status,timeout_sec,decided_at,note,created_at,deadline_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                decision_id,
                node_id,
                level,
                question,
                db.dumps(options),
                default_option_id,
                chosen,
                1 if reversible else 0,
                impact,
                status,
                int(timeout_sec),
                db.now_iso() if status in ("auto", "confirmed") else None,
                note,
                created,
                deadline,
            ),
        )
        events.append_event(
            conn,
            "decision_created",
            node_id,
            {"decision_id": decision_id, "level": level, "status": status},
            commit=False,
        )
        if status in ("auto", "confirmed"):
            events.append_event(
                conn,
                "decision_decided",
                node_id,
                {"decision_id": decision_id, "chosen": chosen, "level": level, "status": status},
                commit=False,
            )
        elif status == "blocked":
            events.append_event(
                conn,
                "decision_blocked",
                node_id,
                {"decision_id": decision_id, "level": level},
                commit=False,
            )
    return _record(conn, decision_id)


def tick_l2(conn: sqlite3.Connection, *, now: float | None = None) -> list[str]:
    """推进超时的 L2：status=timed_out 且 chosen=default。"""
    t = _now(now)
    rows = conn.execute(
        "SELECT decision_id FROM decisions WHERE level='L2' AND status='proposed'"
        " AND deadline_at IS NOT NULL AND deadline_at <= ? ORDER BY decision_id",
        (t,),
    ).fetchall()
    out: list[str] = []
    with conn:
        for r in rows:
            did = r["decision_id"]
            rec = _record(conn, did)
            conn.execute(
                "UPDATE decisions SET status='timed_out', chosen_option_id=?, decided_at=? WHERE decision_id=?",
                (rec["default_option_id"], db.now_iso(), did),
            )
            events.append_event(
                conn,
                "decision_timed_out",
                rec["node_id"],
                {
                    "decision_id": did,
                    "level": "L2",
                    "default": rec["default_option_id"],
                    "chosen": rec["default_option_id"],
                    "timeout_sec": rec["timeout_sec"],
                },
                commit=False,
            )
            out.append(did)
    return out


def confirm_l3(
    conn: sqlite3.Connection, decision_id: str, chosen_option_id: str, *, note: str | None = None
) -> dict[str, Any]:
    rec = _record(conn, decision_id)
    if rec["level"] != "L3":
        raise DecisionError("只有 L3 需要 confirm：%s" % decision_id)
    if rec["status"] not in ("blocked", "proposed"):
        raise DecisionError("L3 当前状态不可 confirm：%s" % rec["status"])
    if chosen_option_id not in _option_ids(rec["options"]):
        raise DecisionError("chosen 不在 options 中：%s" % chosen_option_id)
    with conn:
        conn.execute(
            "UPDATE decisions SET status='confirmed', chosen_option_id=?, decided_at=?, note=COALESCE(?, note)"
            " WHERE decision_id=?",
            (chosen_option_id, db.now_iso(), note, decision_id),
        )
        events.append_event(
            conn,
            "decision_confirmed",
            rec["node_id"],
            {"decision_id": decision_id, "chosen": chosen_option_id, "level": "L3"},
            commit=False,
        )
    return _record(conn, decision_id)


def override(
    conn: sqlite3.Connection, decision_id: str, chosen_option_id: str, *, note: str | None = None
) -> dict[str, Any]:
    """用户推翻已定决策（L0–L3 均可，留痕）。"""
    rec = _record(conn, decision_id)
    if chosen_option_id not in _option_ids(rec["options"]):
        raise DecisionError("chosen 不在 options 中：%s" % chosen_option_id)
    with conn:
        conn.execute(
            "UPDATE decisions SET status='overridden', chosen_option_id=?, decided_at=?, note=COALESCE(?, note)"
            " WHERE decision_id=?",
            (chosen_option_id, db.now_iso(), note, decision_id),
        )
        events.append_event(
            conn,
            "decision_overridden",
            rec["node_id"],
            {"decision_id": decision_id, "from": rec["chosen_option_id"], "to": chosen_option_id},
            commit=False,
        )
    return _record(conn, decision_id)
