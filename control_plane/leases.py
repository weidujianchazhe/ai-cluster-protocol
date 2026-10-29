# -*- coding: utf-8 -*-
"""control_plane.leases —— 租约 / 心跳 / 过期接管 / fencing token

规则（L0 细化 §3）：
  - 只有 `ready` 节点可被 claim；同一时刻只有一个 owner；
  - fencing token 每个节点单调递增（release 后也不回退）；
  - 过期租约必须先 expire 或 takeover，不能直接覆盖；
  - 所有状态变更与事件在同一事务内完成。

WP-01 收敛：本模块**不再直接写 tasks.status**。所有状态/assignee/attempts 变更都经
`graph.set_status(..., commit=False)` 加入调用方事务；`status_changed` 事件由唯一入口发出，
payload 带真实前态 `from` 与后像（assignee / attempts），因此 lease 操作后
`graph.snapshot(conn) == graph.replay_snapshot(conn)`（WP-02）。
"""

from __future__ import annotations

import sqlite3
import time
from typing import Any

from . import db, events, graph


class LeaseError(Exception):
    """租约相关错误基类。"""


class LeaseHeld(LeaseError):
    pass


class LeaseExpired(LeaseError):
    pass


class FencingError(LeaseError):
    pass


def _now(now: float | None) -> float:
    return time.time() if now is None else float(now)


def current_lease(conn: sqlite3.Connection, node_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM leases WHERE node_id=?", (node_id,)).fetchone()
    if row is None:
        return None
    return {
        "node_id": row["node_id"],
        "owner": row["owner"],
        "fencing_token": int(row["fencing_token"]),
        "expires_at": float(row["expires_at"]),
        "heartbeat_at": float(row["heartbeat_at"]),
    }


def _next_token(conn: sqlite3.Connection, node_id: str) -> int:
    conn.execute(
        "INSERT INTO lease_counters(node_id, last_token) VALUES(?, 0)"
        " ON CONFLICT(node_id) DO NOTHING",
        (node_id,),
    )
    conn.execute("UPDATE lease_counters SET last_token=last_token+1 WHERE node_id=?", (node_id,))
    row = conn.execute("SELECT last_token FROM lease_counters WHERE node_id=?", (node_id,)).fetchone()
    return int(row["last_token"])


def claim(
    conn: sqlite3.Connection,
    node_id: str,
    owner: str,
    ttl_sec: float = 60.0,
    *,
    now: float | None = None,
) -> dict[str, Any]:
    if not owner:
        raise LeaseError("owner 不能为空")
    node = graph.get_node(conn, node_id)
    if node is None:
        raise LeaseError("节点不存在：%s" % node_id)
    t = _now(now)
    existing = current_lease(conn, node_id)
    if existing is not None:
        if existing["expires_at"] > t:
            raise LeaseHeld("节点已被持有：%s by %s（token=%s）"
                            % (node_id, existing["owner"], existing["fencing_token"]))
        raise LeaseExpired("存在过期租约，请先 expire 或 takeover：%s" % node_id)
    if node["status"] != "ready":
        raise LeaseError("节点不在 ready，不能 claim：%s (%s)" % (node_id, node["status"]))

    ts = db.now_iso()
    with conn:
        token = _next_token(conn, node_id)
        conn.execute(
            "INSERT INTO leases(node_id,owner,fencing_token,expires_at,heartbeat_at) VALUES(?,?,?,?,?)",
            (node_id, owner, token, t + ttl_sec, t),
        )
        events.append_event(
            conn, "lease_claimed", node_id,
            {"owner": owner, "fencing_token": token, "ttl_sec": ttl_sec, "expires_at": t + ttl_sec},
            commit=False,
        )
        graph.set_status(
            conn, node_id, "claimed",
            reason="lease_claimed", assignee=owner, at=ts,
            notify=False, commit=False,
        )
    return current_lease(conn, node_id)  # type: ignore[return-value]


def renew(
    conn: sqlite3.Connection,
    node_id: str,
    owner: str,
    fencing_token: int,
    ttl_sec: float = 60.0,
    *,
    now: float | None = None,
) -> dict[str, Any]:
    lease = current_lease(conn, node_id)
    if lease is None:
        raise LeaseExpired("租约不存在：%s" % node_id)
    if lease["owner"] != owner or lease["fencing_token"] != int(fencing_token):
        raise FencingError("fencing 不匹配：%s owner=%s token=%s"
                           % (node_id, owner, fencing_token))
    t = _now(now)
    if lease["expires_at"] <= t:
        raise LeaseExpired("租约已过期：%s（expires_at=%s）" % (node_id, lease["expires_at"]))
    with conn:
        conn.execute(
            "UPDATE leases SET expires_at=?, heartbeat_at=? WHERE node_id=?",
            (t + ttl_sec, t, node_id),
        )
        events.append_event(
            conn, "lease_renewed", node_id,
            {"owner": owner, "fencing_token": int(fencing_token), "expires_at": t + ttl_sec},
            commit=False,
        )
    return current_lease(conn, node_id)  # type: ignore[return-value]


def release(
    conn: sqlite3.Connection,
    node_id: str,
    owner: str,
    fencing_token: int,
) -> None:
    lease = current_lease(conn, node_id)
    if lease is None:
        raise LeaseExpired("租约不存在：%s" % node_id)
    if lease["owner"] != owner or lease["fencing_token"] != int(fencing_token):
        raise FencingError("fencing 不匹配：%s" % node_id)
    node = graph.get_node(conn, node_id)
    if node is None:
        raise LeaseError("节点不存在：%s" % node_id)
    ts = db.now_iso()
    with conn:
        conn.execute("DELETE FROM leases WHERE node_id=?", (node_id,))
        events.append_event(
            conn, "lease_released", node_id,
            {"owner": owner, "fencing_token": int(fencing_token)},
            commit=False,
        )
        graph.set_status(
            conn, node_id, "ready",
            reason="lease_released", assignee=None, at=ts,
            notify=False, commit=False,
        )


def expire(conn: sqlite3.Connection, *, now: float | None = None) -> list[str]:
    t = _now(now)
    rows = conn.execute("SELECT * FROM leases WHERE expires_at <= ? ORDER BY node_id", (t,)).fetchall()
    expired: list[str] = []
    ts = db.now_iso()
    with conn:
        for r in rows:
            nid = r["node_id"]
            conn.execute("DELETE FROM leases WHERE node_id=?", (nid,))
            node = graph.get_node(conn, nid)
            events.append_event(
                conn, "lease_expired", nid,
                {"owner": r["owner"], "fencing_token": int(r["fencing_token"]), "at": t},
                commit=False,
            )
            if node is not None and node["status"] in ("claimed", "running"):
                graph.set_status(
                    conn, nid, "ready",
                    reason="lease_expired", assignee=None, attempts_delta=1, at=ts,
                    notify=False, commit=False,
                )
            expired.append(nid)
    return expired


def takeover(
    conn: sqlite3.Connection,
    node_id: str,
    new_owner: str,
    ttl_sec: float = 60.0,
    *,
    now: float | None = None,
) -> dict[str, Any]:
    lease = current_lease(conn, node_id)
    if lease is None:
        raise LeaseExpired("租约不存在，无法接管：%s" % node_id)
    t = _now(now)
    if lease["expires_at"] > t:
        raise LeaseHeld("租约未过期，不能接管：%s（owner=%s）" % (node_id, lease["owner"]))
    ts = db.now_iso()
    with conn:
        token = _next_token(conn, node_id)
        conn.execute(
            "UPDATE leases SET owner=?, fencing_token=?, expires_at=?, heartbeat_at=? WHERE node_id=?",
            (new_owner, token, t + ttl_sec, t, node_id),
        )
        events.append_event(
            conn, "lease_taken_over", node_id,
            {
                "from_owner": lease["owner"],
                "to_owner": new_owner,
                "from_token": lease["fencing_token"],
                "fencing_token": token,
                "expires_at": t + ttl_sec,
            },
            commit=False,
        )
        graph.set_status(
            conn, node_id, "claimed",
            reason="takeover", assignee=new_owner, at=ts,
            notify=False, commit=False,
        )
    return current_lease(conn, node_id)  # type: ignore[return-value]


def assert_fencing(
    conn: sqlite3.Connection, node_id: str, owner: str, fencing_token: int, *, now: float | None = None
) -> None:
    lease = current_lease(conn, node_id)
    if lease is None:
        raise LeaseExpired("租约不存在：%s" % node_id)
    if lease["owner"] != owner or lease["fencing_token"] != int(fencing_token):
        raise FencingError("fencing 不匹配：%s" % node_id)
    if lease["expires_at"] <= _now(now):
        raise LeaseExpired("租约已过期：%s" % node_id)
