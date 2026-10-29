# -*- coding: utf-8 -*-
"""control_plane.scheduler —— ready 计算与依赖门控

规则（与 Root 卡 / L0 细化一致）：
  - `ready` 只能由「依赖全部 done」推出；不是轮询，而是由 done 事件触发 `on_event()`。
  - 不满足依赖的 ready 会被降回 `planned`（防"假 ready"）。
  - 根节点（无依赖）在 bootstrap / 首次重算时进入 ready。
"""

from __future__ import annotations

import sqlite3
from typing import Any

from . import db, events, graph


def _deps_done(conn: sqlite3.Connection, deps: list[str]) -> bool:
    for dep in deps:
        node = graph.get_node(conn, dep)
        if node is None or node["status"] != "done":
            return False
    return True


def ready_set(conn: sqlite3.Connection) -> list[str]:
    return [n["node_id"] for n in graph.list_nodes(conn) if n["status"] == "ready"]


def recompute_ready(conn: sqlite3.Connection, *, reason: str = "recompute") -> list[str]:
    """重算 ready：先降级非法 ready，再晋升依赖已满足的 planned。返回晋升列表。"""
    nodes = graph.list_nodes(conn)
    status = {n["node_id"]: n["status"] for n in nodes}
    promoted: list[str] = []
    demoted: list[str] = []
    ts = db.now_iso()

    with conn:
        # 1) 降级：ready 但依赖未全 done
        for n in nodes:
            if n["status"] != "ready":
                continue
            if not _deps_done(conn, n["deps"]):
                graph.set_status(
                    conn, n["node_id"], "planned",
                    reason="deps_not_done", at=ts, notify=False, commit=False,
                )
                status[n["node_id"]] = "planned"
                demoted.append(n["node_id"])
        # 2) 晋升：planned 且依赖全 done
        for n in nodes:
            if status.get(n["node_id"]) != "planned":
                continue
            if _deps_done(conn, n["deps"]):
                graph.set_status(
                    conn, n["node_id"], "ready",
                    reason=reason, at=ts, notify=False, commit=False,
                )
                status[n["node_id"]] = "ready"
                promoted.append(n["node_id"])
        if promoted or demoted:
            events.append_event(
                conn,
                "ready_recomputed",
                None,
                {"promoted": promoted, "demoted": demoted, "reason": reason, "at": ts},
                commit=False,
            )
    return promoted


def on_event(conn: sqlite3.Connection, event: dict[str, Any]) -> list[str]:
    """事件驱动入口：只有节点 done 才触发 ready 重算（不轮询）。"""
    if event.get("kind") == "status_changed" and event.get("payload", {}).get("to") == "done":
        return recompute_ready(conn, reason="dependency_done")
    return []


def bootstrap(conn: sqlite3.Connection) -> list[str]:
    """建图后调用一次：让根节点（无依赖）进入 ready。"""
    return recompute_ready(conn, reason="bootstrap")
