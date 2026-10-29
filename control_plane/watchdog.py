# -*- coding: utf-8 -*-
"""control_plane.watchdog —— 有界运行时控制（预算 / 深度 / 并发 / 墙钟 / 尝试 / 终止）

规则（Root 卡 / L0 细化 §3）：
  - 租约过期 → 回收（leases.expire）；
  - attempts 超限 / 墙钟超时 / 预算超限 → 节点 blocked（留事件）；
  - 图深度超限 / 全局预算超限 → terminate（整轮止损）；
  - 并发超限 → warning（暂停新认领，不强制改状态；硬拒在 engine 的并发门）。

预算口径（Lane C 计量闭环）：一律走 `ledger.totals()`（真实行汇总 + 价目表折算），
不读调用方自报，也不重复写 SQL 汇总逻辑。
"""

from __future__ import annotations

import sqlite3
import time
from typing import Any

from . import db, events, graph, ledger, leases

DEFAULT_LIMITS = {
    "max_attempts": 3,
    "max_wall_sec": 3600,
    "max_depth": 3,
    "max_parallel": 5,
    "max_total_tokens": None,
    "max_total_cost": None,
}


def _now(now: float | None) -> float:
    return time.time() if now is None else float(now)


def graph_depth(conn: sqlite3.Connection) -> int:
    """最长依赖链节点数（DAG）。发现环返回 -1。"""
    nodes = {n["node_id"]: n for n in graph.list_nodes(conn)}
    memo: dict[str, int] = {}
    visiting: set[str] = set()

    def depth(nid: str) -> int:
        if nid in memo:
            return memo[nid]
        if nid in visiting:
            raise ValueError("cycle")
        visiting.add(nid)
        deps = [d for d in nodes[nid]["deps"] if d in nodes]
        val = 1 + (max((depth(d) for d in deps), default=0))
        visiting.discard(nid)
        memo[nid] = val
        return val

    try:
        return max((depth(nid) for nid in nodes), default=0)
    except ValueError:
        return -1


def _block(conn: sqlite3.Connection, node_id: str, reason: str, detail: dict[str, Any] | None = None) -> None:
    """阻断节点：状态迁移走 graph.set_status 唯一入口（不自拼 status_changed / 不手删租约）。"""
    node = graph.get_node(conn, node_id)
    if node is None:
        return
    ts = db.now_iso()
    with conn:
        events.append_event(
            conn,
            "node_blocked",
            node_id,
            {"reason": reason, "detail": detail or {}, "at": ts},
            commit=False,
        )
        graph.set_status(
            conn,
            node_id,
            "blocked",
            reason=reason,
            assignee=None,
            at=ts,
            drop_lease=True,
            notify=False,
            commit=False,
        )


def _node_totals(
    conn: sqlite3.Connection,
    node_id: str,
    *,
    model: str | None = None,
    prices: dict[str, float] | None = None,
) -> dict[str, float]:
    """节点真实用量（ledger 行汇总 + 价目表折算成本）。"""
    return ledger.totals(conn, node_id, model=model, prices=prices)


def scan(
    conn: sqlite3.Connection,
    *,
    now: float | None = None,
    limits: dict[str, Any] | None = None,
) -> dict[str, Any]:
    t = _now(now)
    lim = dict(DEFAULT_LIMITS)
    lim.update(limits or {})
    # 价目口径：limits 可带 model / prices，让预算与写入时的价目一致（不改变 schema）
    price_model = lim.get("model")
    price_table = lim.get("prices")
    actions: list[str] = []
    warnings: list[str] = []

    expired = leases.expire(conn, now=t)
    if expired:
        actions.append("expired:%s" % ",".join(expired))

    depth = graph_depth(conn)
    if depth == -1:
        terminated, reason = True, "dependency_cycle"
    elif depth > lim["max_depth"]:
        terminated, reason = True, "depth_exceeded"
    else:
        terminated, reason = False, None

    active = [n for n in graph.list_nodes(conn) if n["status"] in ("claimed", "running")]
    if len(active) > lim["max_parallel"]:
        warnings.append("concurrency_exceeded:%d>%d" % (len(active), lim["max_parallel"]))

    blocked: list[dict[str, Any]] = []
    for n in graph.list_nodes(conn):
        nid = n["node_id"]
        if n["status"] not in ("ready", "claimed", "running"):
            continue
        if n["attempts"] >= lim["max_attempts"]:
            _block(conn, nid, "attempts_exceeded", {"attempts": n["attempts"]})
            blocked.append({"node_id": nid, "reason": "attempts_exceeded"})
            continue

        lease = leases.current_lease(conn, nid)
        if lease is not None and t - lease["heartbeat_at"] > lim["max_wall_sec"]:
            _block(conn, nid, "wall_clock_exceeded",
                   {"idle_sec": t - lease["heartbeat_at"]})
            blocked.append({"node_id": nid, "reason": "wall_clock_exceeded"})
            continue

        totals = _node_totals(conn, nid, model=price_model, prices=price_table)
        check = ledger.budget_check(totals, n.get("budget"))
        if not check["ok"]:
            _block(conn, nid, "budget_exceeded", check["detail"])
            blocked.append({"node_id": nid, "reason": "budget_exceeded", "detail": check["detail"]})

    totals_all = ledger.totals(conn, model=price_model, prices=price_table)
    total_tokens, total_cost = float(totals_all["tokens"]), float(totals_all["cost"])
    if lim["max_total_tokens"] is not None and total_tokens > float(lim["max_total_tokens"]):
        terminated, reason = True, "total_tokens_exceeded"
    if lim["max_total_cost"] is not None and total_cost > float(lim["max_total_cost"]):
        terminated, reason = True, "total_cost_exceeded"

    result = {
        "terminated": terminated,
        "reason": reason,
        "expired": expired,
        "blocked": blocked,
        "warnings": warnings,
        "depth": depth,
        "active": len(active),
        "total_tokens": total_tokens,
        "total_cost": total_cost,
        "usage": totals_all,
        "actions": actions,
    }
    events.append_event(conn, "watchdog_scan", None, result)
    return result
