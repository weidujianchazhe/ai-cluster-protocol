# -*- coding: utf-8 -*-
"""control_plane.graph —— 工作图 CRUD（节点 / 边 / 状态），每次变更同步写事件。

设计依据：L0 细化 §1–§2；schema v2 字段（capability / stage / evidence_required / decision_id）。
原则：
  - 所有写操作在同一事务内完成「状态变更 + 事件追加」；
  - **状态机唯一入口** `set_status()`：任何状态变更（含 assignee / attempts）必须经过这里，
    禁止在别的模块里直接 `UPDATE tasks SET status=...`（见 tests/test_graph.py 的直写护栏）；
  - `done` 需要证据凭证（`done_credential()` 铸造 / `credential=` 传入），无凭证直接拒绝；
  - `status_changed` 事件写入**真实前态** `from` 与**后像**（assignee / attempts / at），
    保证 replay 能完整重建（WP-02）；
  - 写期环检测：`add_node(deps=...)` 与 `add_edge(kind="blocks")` 在写入前拒绝成环。
"""

from __future__ import annotations

import copy
import os
import sqlite3
from collections.abc import Mapping
from typing import Any

from . import db, events

STATUSES = {
    "planned",
    "ready",
    "claimed",
    "running",
    "submitted",
    "verifying",
    "accepted",
    "rejected",
    "blocked",
    "done",
}
EDGE_KINDS = {"blocks", "artifact", "review"}
# 唯一需要凭证（证据）的状态
GATED_STATUSES = {"done"}
#: 终态：不可退出（`done` 只能由凭证据进入，不能再出）
TERMINAL_STATUSES = frozenset({"done"})
#: 解除 `blocked` 必须带此前缀 reason（R8：阻断不能无声解除）
UNBLOCK_REASON_PREFIX = "unblocked:"

#: `set_status(assignee=...)` 的“不修改”哨兵
UNSET = object()

_STATUS_EVENTS = "status_changed"
_ASSIGNEE_EVENT = "assignee_changed"
_ATTEMPTS_EVENT = "attempts_changed"

#: D2 运行时白名单：唯一合法的**跨状态**迁移边（同状态幂等路径不受限）。
#: 与 `control_plane/tests/test_transitions.py` 的 20 行表一一对应；改这里必须同步改那边（测试互相校验）。
TRANSITIONS: frozenset[tuple[str, str]] = frozenset({
    ("planned", "ready"),          # scheduler 晋升
    ("ready", "planned"),          # 假 ready 降级
    ("ready", "claimed"),          # leases.claim
    ("claimed", "ready"),          # release / expire / 恢复
    ("claimed", "claimed"),        # takeover（换 owner）
    ("running", "ready"),          # expire / 恢复
    ("claimed", "submitted"),      # evidence.submit
    ("running", "submitted"),      # evidence.submit
    ("submitted", "verifying"),    # evidence.finalize 开始验证
    ("submitted", "ready"),        # 恢复：证据不完整
    ("verifying", "ready"),        # 驳回 / 恢复
    ("verifying", "done"),         # 凭证事务（唯一入口）
    ("ready", "blocked"),          # watchdog
    ("claimed", "blocked"),        # watchdog
    ("running", "blocked"),        # watchdog
    ("blocked", "ready"),          # unblock（必须带 unblocked:<原因>）
})

#: 运行时白名单开关。默认**开启**（R10 收口：全量用例已合法化）。
#: 回滚：`CP_TRANSITIONS_ENFORCE=0` 或运行期 `set_transition_enforcement(False)`；
#: 关闭后仍生效的硬约束是终态守卫（P0）与 done 凭证，只有跨状态白名单不生效。
_ENFORCE_TRANSITIONS = os.environ.get("CP_TRANSITIONS_ENFORCE", "1") == "1"


def set_transition_enforcement(enabled: bool) -> None:
    """打开/关闭迁移白名单强制（回滚点）。生产路径不应关闭。"""
    global _ENFORCE_TRANSITIONS
    _ENFORCE_TRANSITIONS = bool(enabled)


def transition_enforcement() -> bool:
    return _ENFORCE_TRANSITIONS


def allowed_transitions() -> dict[str, set[str]]:
    """白名单的邻接表形式（只读，供测试/CLI/文档复用）。"""
    out: dict[str, set[str]] = {}
    for frm, to in TRANSITIONS:
        out.setdefault(frm, set()).add(to)
    return out



class GraphError(ValueError):
    """工作图写入错误基类。"""


class CycleError(GraphError):
    """写期环检测失败（deps / blocks 边会成环）。"""


class CredentialError(GraphError):
    """done 缺少有效证据凭证。"""


def _now() -> str:
    return db.now_iso()


def get_node(conn: sqlite3.Connection, node_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM tasks WHERE node_id=?", (node_id,)).fetchone()
    if row is None:
        return None
    return {
        "node_id": row["node_id"],
        "title": row["title"],
        "spec": row["spec"],
        "capability": row["capability"],
        "stage": row["stage"],
        "status": row["status"],
        "deps": db.loads(row["deps_json"], []),
        "evidence_required": db.loads(row["evidence_required_json"], []),
        "decision_id": row["decision_id"],
        "attempts": int(row["attempts"]),
        "assignee": row["assignee"],
        "verifier_ids": db.loads(row["verifier_ids_json"], []),
        "budget": db.loads(row["budget_json"], {}),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_nodes(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT node_id FROM tasks ORDER BY created_at, node_id").fetchall()
    return [get_node(conn, r["node_id"]) for r in rows]  # type: ignore[misc]


# ---------------------------------------------------------------------------
# 写期环检测
# ---------------------------------------------------------------------------


def _reachable(conn: sqlite3.Connection, start: str, target: str) -> bool:
    """沿 blocks 边（from=前置 → to=后继）判断 start 能否到达 target。"""
    if start == target:
        return True
    seen = {start}
    frontier = [start]
    while frontier:
        cur = frontier.pop()
        rows = conn.execute(
            "SELECT to_id FROM edges WHERE from_id=? AND kind='blocks'", (cur,)
        ).fetchall()
        for r in rows:
            nxt = r["to_id"]
            if nxt == target:
                return True
            if nxt not in seen:
                seen.add(nxt)
                frontier.append(nxt)
    return False


def _assert_no_cycle(conn: sqlite3.Connection, prerequisite: str, dependent: str) -> None:
    """加入边 prerequisite → dependent 之前检测是否会成环。"""
    if prerequisite == dependent:
        raise CycleError("依赖成环（自依赖）：%s" % prerequisite)
    # 若 dependent 已经（传递地）是 prerequisite 的前置，再加这条边就成环
    if _reachable(conn, dependent, prerequisite):
        raise CycleError("依赖成环：%s → %s 会形成环（%s 已依赖 %s）"
                         % (prerequisite, dependent, dependent, prerequisite))


def detect_cycles(conn: sqlite3.Connection) -> list[list[str]]:
    """对当前 blocks 边做一次完整环检测，返回成环路径列表（用于体检/恢复自检）。"""
    rows = conn.execute("SELECT from_id, to_id FROM edges WHERE kind='blocks'").fetchall()
    adjacency: dict[str, list[str]] = {}
    for r in rows:
        adjacency.setdefault(r["from_id"], []).append(r["to_id"])
    cycles: list[list[str]] = []
    colour: dict[str, int] = {}  # 0=未访问 1=栈上 2=完成
    stack: list[str] = []

    def visit(node: str) -> None:
        colour[node] = 1
        stack.append(node)
        for nxt in adjacency.get(node, []):
            if colour.get(nxt, 0) == 0:
                visit(nxt)
            elif colour.get(nxt, 0) == 1:
                idx = stack.index(nxt)
                cycles.append(stack[idx:] + [nxt])
        stack.pop()
        colour[node] = 2

    for node in sorted(adjacency):
        if colour.get(node, 0) == 0:
            visit(node)
    return cycles


# ---------------------------------------------------------------------------
# 证据凭证
# ---------------------------------------------------------------------------


def _pass_evidence(conn: sqlite3.Connection, node_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM evidence WHERE node_id=? AND verdict='pass' ORDER BY at, evidence_id",
        (node_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def _validate_done_credential(
    conn: sqlite3.Connection, node: dict[str, Any], credential: Any
) -> list[str]:
    """校验 done 凭证；返回认可的 evidence_id 列表，任何不满足都抛 CredentialError。"""
    if credential is None:
        raise CredentialError(
            "节点 %s 拒绝进入 done：缺少证据凭证（用 done_credential() 铸造后传入）"
            % node["node_id"]
        )
    if not isinstance(credential, Mapping):
        raise CredentialError("证据凭证必须是 mapping，收到：%r" % type(credential).__name__)
    ids = list(credential.get("evidence") or [])
    if not ids:
        raise CredentialError("证据凭证为空：%s" % node["node_id"])
    if credential.get("node_id") not in (None, node["node_id"]):
        raise CredentialError(
            "证据凭证归属不符：%s != %s" % (credential.get("node_id"), node["node_id"])
        )

    rows: list[dict[str, Any]] = []
    for eid in ids:
        row = conn.execute("SELECT * FROM evidence WHERE evidence_id=?", (eid,)).fetchone()
        if row is None:
            raise CredentialError("凭证引用不存在的证据：%s" % eid)
        rec = dict(row)
        if rec["node_id"] != node["node_id"]:
            raise CredentialError("证据 %s 不属于节点 %s" % (eid, node["node_id"]))
        if rec["verdict"] != "pass":
            raise CredentialError("证据 %s 未通过（verdict=%s）" % (eid, rec["verdict"]))
        rows.append(rec)

    required = set(node["evidence_required"])
    got = {r["kind"] for r in rows}
    missing = sorted(required - got)
    if missing:
        raise CredentialError("证据未覆盖必需类型：%s" % missing)

    allowed = set(node["verifier_ids"])
    if allowed:
        bad = sorted({r["verifier_id"] for r in rows if r["verifier_id"] not in allowed})
        if bad:
            raise CredentialError("验证器不在允许清单：%s" % bad)

    for dep in node["deps"]:
        dep_node = get_node(conn, dep)
        if dep_node is None or dep_node["status"] != "done":
            raise CredentialError("依赖未完成：%s" % dep)

    if node.get("stage"):
        from . import stages  # 延迟导入：避免 graph ↔ stages 循环

        if not stages.gate_allows_done(conn, node["stage"]):
            raise CredentialError("阶段闸门未通过：%s" % node["stage"])
    return ids


def done_credential(conn: sqlite3.Connection, node_id: str) -> dict[str, Any] | None:
    """按当前库内证据铸造 done 凭证；不满足条件时返回 None（不抛异常）。"""
    node = get_node(conn, node_id)
    if node is None:
        return None
    rows = _pass_evidence(conn, node_id)
    candidate = {
        "node_id": node_id,
        "evidence": [r["evidence_id"] for r in rows],
        "verifier_ids": sorted({r["verifier_id"] for r in rows}),
        "minted_at": _now(),
    }
    try:
        _validate_done_credential(conn, node, candidate)
    except CredentialError:
        return None
    return candidate


# ---------------------------------------------------------------------------
# 状态机唯一入口
# ---------------------------------------------------------------------------


def _write_transition(
    conn: sqlite3.Connection,
    node_id: str,
    *,
    prev: dict[str, Any],
    status: str,
    assignee: str | None,
    attempts: int,
    ts: str,
    reason: str | None,
    evidence_ids: list[str],
    drop_lease: bool,
    extra: dict[str, Any] | None,
) -> dict[str, Any]:
    """单条状态迁移的落库 + 事件（不做事务控制，由调用方决定 commit）。"""
    conn.execute(
        "UPDATE tasks SET status=?, assignee=?, attempts=?, updated_at=? WHERE node_id=?",
        (status, assignee, attempts, ts, node_id),
    )
    payload: dict[str, Any] = {
        "from": prev["status"],
        "to": status,
        "at": ts,
        "assignee": assignee,
        "attempts": attempts,
    }
    if reason:
        payload["reason"] = reason
    if evidence_ids:
        payload["evidence"] = list(evidence_ids)
    if extra:
        payload.update(extra)
    event = events.append_event(conn, _STATUS_EVENTS, node_id, payload, commit=False)
    if assignee != prev["assignee"]:
        events.append_event(
            conn, _ASSIGNEE_EVENT, node_id,
            {"from": prev["assignee"], "to": assignee, "reason": reason, "at": ts},
            commit=False,
        )
    if attempts != prev["attempts"]:
        events.append_event(
            conn, _ATTEMPTS_EVENT, node_id,
            {"from": prev["attempts"], "to": attempts, "reason": reason, "at": ts},
            commit=False,
        )
    if drop_lease:
        conn.execute("DELETE FROM leases WHERE node_id=?", (node_id,))
    return event


def set_status(
    conn: sqlite3.Connection,
    node_id: str,
    status: str,
    *,
    reason: str | None = None,
    assignee: Any = UNSET,
    attempts_delta: int = 0,
    credential: Mapping[str, Any] | None = None,
    at: str | None = None,
    drop_lease: bool = False,
    notify: bool = True,
    commit: bool = True,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """**状态机唯一入口**：变更 status（可同时变更 assignee / attempts），并写事件。

    参数：
      reason         迁移原因（写入 status_changed.payload.reason，审计用）
      assignee       传入则覆盖 assignee（传 None 表示清空）；不传则保持原值
      attempts_delta 尝试次数增量（过期/驳回/恢复各 +1）
      credential     `status="done"` 必需，来自 `done_credential(conn, node_id)`
      drop_lease     同一事务内删除该节点租约（终态/回退时用）
      notify         为 True 且 commit=True 且进入 done 时，触发 scheduler 解锁下游
      commit         False 表示加入调用方事务（不自行提交，也不触发 notify）
    """
    if status not in STATUSES:
        raise GraphError("非法状态：%s" % status)
    node = get_node(conn, node_id)
    if node is None:
        raise GraphError("节点不存在：%s" % node_id)

    # 终态守卫（P0）：done 只能由凭证进入，不能再出；任何 done → 非 done 一律拒绝。
    if node["status"] in TERMINAL_STATUSES and status != node["status"]:
        raise GraphError(
            "终态不可退出：%s 已是 %s，拒绝 %s → %s（done 只能由凭证据进入，不能再出）"
            % (node_id, node["status"], node["status"], status)
        )

    # D2 运行时白名单：跨状态迁移必须在 TRANSITIONS 内（同状态不动白名单，走幂等/后像更新）。
    if (
        _ENFORCE_TRANSITIONS
        and node["status"] != status
        and (node["status"], status) not in TRANSITIONS
    ):
        raise GraphError(
            "非法状态迁移：%s %s → %s 不在运行时白名单内（见 graph.TRANSITIONS）"
            % (node_id, node["status"], status)
        )

    if (
        node["status"] == status
        and assignee is UNSET
        and not attempts_delta
        and not drop_lease
    ):
        return node  # 幂等：无变化不写事件

    evidence_ids: list[str] = []
    if status in GATED_STATUSES:
        evidence_ids = _validate_done_credential(conn, node, credential)

    # 阻断解除必须留痕（R8）：blocked → ready 只接受 reason="unblocked:<非空原因>"
    if node["status"] == "blocked" and status == "ready":
        if not reason or not str(reason).startswith(UNBLOCK_REASON_PREFIX):
            raise GraphError(
                '解除 blocked 必须带 reason="%s<原因>"：%s（当前 reason=%r）'
                % (UNBLOCK_REASON_PREFIX, node_id, reason)
            )
        if len(str(reason)) <= len(UNBLOCK_REASON_PREFIX):
            raise GraphError("解除 blocked 的原因不能为空：%s" % node_id)

    new_assignee = node["assignee"] if assignee is UNSET else assignee
    new_attempts = int(node["attempts"]) + int(attempts_delta)
    if new_attempts < 0:
        raise GraphError("attempts 不能为负：%s" % node_id)
    ts = at or _now()

    if commit:
        with conn:
            event = _write_transition(
                conn,
                node_id,
                prev=node,
                status=status,
                assignee=new_assignee,
                attempts=new_attempts,
                ts=ts,
                reason=reason,
                evidence_ids=evidence_ids,
                drop_lease=drop_lease,
                extra=extra,
            )
    else:
        event = _write_transition(
            conn,
            node_id,
            prev=node,
            status=status,
            assignee=new_assignee,
            attempts=new_attempts,
            ts=ts,
            reason=reason,
            evidence_ids=evidence_ids,
            drop_lease=drop_lease,
            extra=extra,
        )

    updated = get_node(conn, node_id)
    if notify and commit and status == "done":
        from . import scheduler  # 延迟导入：scheduler 依赖 graph

        scheduler.on_event(conn, event)
    return updated  # type: ignore[return-value]


def unblock(
    conn: sqlite3.Connection,
    node_id: str,
    reason: str,
    *,
    note: str | None = None,
    at: str | None = None,
    notify: bool = True,
) -> dict[str, Any]:
    """解除阻断：`blocked → ready`，强制留痕 `unblocked:<reason>`。

    调用方（CLI/策略）只需给原因；前缀与事件由唯一入口统一生成。
    """
    if not reason:
        raise GraphError("解除 blocked 必须给出原因：%s" % node_id)
    return set_status(
        conn,
        node_id,
        "ready",
        reason=UNBLOCK_REASON_PREFIX + str(reason),
        assignee=None,
        at=at,
        notify=notify,
        extra={"unblock_note": note} if note else None,
    )


# ---------------------------------------------------------------------------
# 节点 / 边 CRUD
# ---------------------------------------------------------------------------


def add_node(
    conn: sqlite3.Connection,
    *,
    node_id: str,
    title: str,
    spec: str,
    capability: str | None = None,
    stage: str | None = None,
    status: str = "planned",
    deps: list[str] | None = None,
    evidence_required: list[str] | None = None,
    decision_id: str | None = None,
    verifier_ids: list[str] | None = None,
    budget: dict[str, Any] | None = None,
    commit: bool = True,
) -> dict[str, Any]:
    if not node_id or not title or not spec:
        raise ValueError("node_id / title / spec 必填")
    if status not in STATUSES:
        raise ValueError("非法状态：%s" % status)
    if get_node(conn, node_id) is not None:
        raise ValueError("节点已存在：%s" % node_id)
    ts = _now()
    deps = list(deps or [])
    for dep in deps:
        if get_node(conn, dep) is None:
            raise ValueError("依赖节点不存在：%s" % dep)
    # 写期环检测：新节点自己（尚无入边）若出现在某个 dep 的前置闭包里，就会成环
    for dep in deps:
        _assert_no_cycle(conn, node_id, dep)

    def _apply() -> dict[str, Any]:
        conn.execute(
            "INSERT INTO tasks(node_id,title,spec,capability,stage,status,deps_json,"
            "evidence_required_json,decision_id,verifier_ids_json,budget_json,created_at,updated_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                node_id,
                title,
                spec,
                capability,
                stage,
                status,
                db.dumps(deps),
                db.dumps(list(evidence_required or [])),
                decision_id,
                db.dumps(list(verifier_ids or [])),
                db.dumps(budget or {}),
                ts,
                ts,
            ),
        )
        for dep in deps:
            conn.execute(
                "INSERT OR IGNORE INTO edges(from_id,to_id,kind) VALUES(?,?, 'blocks')",
                (dep, node_id),
            )
            events.append_event(
                conn,
                "edge_added",
                node_id,
                {"from": dep, "to": node_id, "kind": "blocks"},
                commit=False,
            )
        node = get_node(conn, node_id)
        events.append_event(conn, "node_added", node_id, {"node": node}, commit=False)
        return node  # type: ignore[return-value]

    if commit:
        with conn:
            return _apply()
    return _apply()


def set_edges(
    conn: sqlite3.Connection,
    node_id: str,
    deps: list[str],
    *,
    commit: bool = True,
) -> list[str]:
    """重设节点依赖（replan 用）。同事务内增删 blocks 边并写事件。"""
    node = get_node(conn, node_id)
    if node is None:
        raise GraphError("节点不存在：%s" % node_id)
    new_deps = list(dict.fromkeys(deps))
    for dep in new_deps:
        if get_node(conn, dep) is None:
            raise GraphError("依赖节点不存在：%s" % dep)
        _assert_no_cycle(conn, dep, node_id)
    ts = _now()
    removed = [d for d in node["deps"] if d not in new_deps]

    def _apply() -> None:
        for dep in removed:
            conn.execute(
                "DELETE FROM edges WHERE from_id=? AND to_id=? AND kind='blocks'", (dep, node_id)
            )
            events.append_event(
                conn, "edge_removed", node_id, {"from": dep, "to": node_id, "kind": "blocks"},
                commit=False,
            )
        for dep in new_deps:
            cur = conn.execute(
                "INSERT OR IGNORE INTO edges(from_id,to_id,kind) VALUES(?,?,'blocks')", (dep, node_id)
            )
            if cur.rowcount:
                events.append_event(
                    conn, "edge_added", node_id, {"from": dep, "to": node_id, "kind": "blocks"},
                    commit=False,
                )
        conn.execute(
            "UPDATE tasks SET deps_json=?, updated_at=? WHERE node_id=?",
            (db.dumps(new_deps), ts, node_id),
        )

    if commit:
        with conn:
            _apply()
    else:
        _apply()
    return new_deps


def add_edge(conn: sqlite3.Connection, from_id: str, to_id: str, kind: str) -> None:
    if kind not in EDGE_KINDS:
        raise ValueError("非法边类型：%s" % kind)
    for nid in (from_id, to_id):
        if get_node(conn, nid) is None:
            raise ValueError("节点不存在：%s" % nid)
    if kind == "blocks":
        _assert_no_cycle(conn, from_id, to_id)
    exists = conn.execute(
        "SELECT 1 FROM edges WHERE from_id=? AND to_id=? AND kind=?", (from_id, to_id, kind)
    ).fetchone()
    if exists:
        return
    with conn:
        conn.execute("INSERT INTO edges(from_id,to_id,kind) VALUES(?,?,?)", (from_id, to_id, kind))
        events.append_event(
            conn, "edge_added", to_id, {"from": from_id, "to": to_id, "kind": kind}, commit=False
        )


def remove_node(
    conn: sqlite3.Connection,
    node_id: str,
    *,
    commit: bool = True,
    allow_terminal: bool = False,
) -> dict[str, Any]:
    """删除节点。终态（done）默认不可删（`allow_terminal=True` 只留给导入/夹具迁移脚本）。"""
    node = get_node(conn, node_id)
    if node is None:
        raise ValueError("节点不存在：%s" % node_id)
    if node["status"] in TERMINAL_STATUSES and not allow_terminal:
        raise GraphError(
            "终态节点不可删除：%s（status=%s）；如确需清理，显式传 allow_terminal=True"
            % (node_id, node["status"])
        )
    edges = conn.execute(
        "SELECT from_id, to_id, kind FROM edges WHERE from_id=? OR to_id=?", (node_id, node_id)
    ).fetchall()

    def _apply() -> None:
        conn.execute("DELETE FROM edges WHERE from_id=? OR to_id=?", (node_id, node_id))
        conn.execute("DELETE FROM tasks WHERE node_id=?", (node_id,))
        events.append_event(
            conn,
            "node_removed",
            node_id,
            {"node": node, "removed_edges": [dict(e) for e in edges]},
            commit=False,
        )

    if commit:
        with conn:
            _apply()
    else:
        _apply()
    return node


def edges(conn: sqlite3.Connection) -> list[dict[str, str]]:
    rows = conn.execute("SELECT from_id, to_id, kind FROM edges ORDER BY from_id, to_id, kind").fetchall()
    return [{"from": r["from_id"], "to": r["to_id"], "kind": r["kind"]} for r in rows]


def dependencies(conn: sqlite3.Connection, node_id: str) -> list[str]:
    rows = conn.execute(
        "SELECT from_id FROM edges WHERE to_id=? AND kind='blocks' ORDER BY from_id", (node_id,)
    ).fetchall()
    return [r["from_id"] for r in rows]


# ---------------------------------------------------------------------------
# 快照 / 重放
# ---------------------------------------------------------------------------


def _normalize_deps(nodes: dict[str, dict[str, Any]], edge_list: list[dict[str, str]]) -> None:
    """把节点 deps 规范化为 blocks 边推出的有序前置集合，保证 snapshot / replay 同口径。"""
    preds: dict[str, list[str]] = {nid: [] for nid in nodes}
    for e in edge_list:
        if e.get("kind") == "blocks" and e.get("to") in preds:
            preds[e["to"]].append(e["from"])
    for nid, node in nodes.items():
        node["deps"] = sorted(preds.get(nid, []))


def snapshot(conn: sqlite3.Connection) -> dict[str, Any]:
    """当前图的物化视图（用于与 replay 结果对比）。"""
    edge_list = edges(conn)
    nodes = {n["node_id"]: n for n in list_nodes(conn)}
    _normalize_deps(nodes, edge_list)
    return {"nodes": nodes, "edges": edge_list}


def replay_snapshot(conn: sqlite3.Connection) -> dict[str, Any]:
    """只靠事件日志重建图（崩溃恢复的最小验证）。

    对齐口径（WP-02）：`status_changed` 携带后像（status / assignee / attempts / at），
    另有 `assignee_changed` / `attempts_changed` 审计事件；三者任一都可重建，且互为幂等。
    """
    state: dict[str, Any] = {"nodes": {}, "edges": []}
    for ev in events.iter_events(conn):
        kind, payload, nid = ev["kind"], ev["payload"], ev["node_id"]
        if kind == "node_added":
            node = payload.get("node")
            if node:
                state["nodes"][node["node_id"]] = copy.deepcopy(node)
        elif kind == "node_removed":
            node = payload.get("node") or {}
            removed_id = node.get("node_id") or nid
            state["nodes"].pop(removed_id, None)
            state["edges"] = [
                e for e in state["edges"] if e["from"] != removed_id and e["to"] != removed_id
            ]
        elif kind == "edge_added":
            edge = {"from": payload.get("from"), "to": payload.get("to"), "kind": payload.get("kind")}
            if edge not in state["edges"]:
                state["edges"].append(edge)
        elif kind == "edge_removed":
            edge = {"from": payload.get("from"), "to": payload.get("to"), "kind": payload.get("kind")}
            state["edges"] = [e for e in state["edges"] if e != edge]
        elif kind == _STATUS_EVENTS:
            node = state["nodes"].get(nid)
            if node is None:
                continue
            node["status"] = payload.get("to")
            if payload.get("at"):
                node["updated_at"] = payload["at"]
            if "assignee" in payload:
                node["assignee"] = payload["assignee"]
            if "attempts" in payload:
                node["attempts"] = int(payload["attempts"])
        elif kind == _ASSIGNEE_EVENT:
            node = state["nodes"].get(nid)
            if node is not None:
                node["assignee"] = payload.get("to")
        elif kind == _ATTEMPTS_EVENT:
            node = state["nodes"].get(nid)
            if node is not None and "to" in payload:
                node["attempts"] = int(payload["to"])
    state["edges"].sort(key=lambda e: (e["from"], e["to"], e["kind"]))
    _normalize_deps(state["nodes"], state["edges"])
    return state


def replay_mismatches(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """逐字段对比 snapshot / replay，返回差异明细（空列表表示完全一致）。"""
    snap = snapshot(conn)
    rep = replay_snapshot(conn)
    diffs: list[dict[str, Any]] = []
    for nid in sorted(set(snap["nodes"]) | set(rep["nodes"])):
        a = snap["nodes"].get(nid)
        b = rep["nodes"].get(nid)
        if a is None or b is None:
            diffs.append({"node_id": nid, "field": "node", "snapshot": a, "replay": b})
            continue
        for field in sorted(set(a) | set(b)):
            if a.get(field) != b.get(field):
                diffs.append(
                    {"node_id": nid, "field": field, "snapshot": a.get(field), "replay": b.get(field)}
                )
    if snap["edges"] != rep["edges"]:
        diffs.append({"node_id": None, "field": "edges",
                      "snapshot": snap["edges"], "replay": rep["edges"]})
    return diffs


# ---------------------------------------------------------------------------
# replan（WP-04：单事务）
# ---------------------------------------------------------------------------

REPLAN_REASONS = (
    "gate_failed",
    "evidence_insufficient",
    "scope_change",
    "decision_override",
    "failure_retry",
)


def current_graph_version(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT value FROM meta WHERE key='graph_version'").fetchone()
    return int(row["value"]) if row else 1


def _bump_graph_version(conn: sqlite3.Connection) -> int:
    conn.execute(
        "INSERT INTO meta(key,value) VALUES('graph_version','1') ON CONFLICT(key) DO NOTHING"
    )
    conn.execute("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='graph_version'")
    return current_graph_version(conn)


def replan(
    conn: sqlite3.Connection,
    *,
    reason: str,
    add: list[dict[str, Any]] | None = None,
    remove: list[str] | None = None,
    note: str | None = None,
    recompute: bool = True,
) -> dict[str, Any]:
    """**单事务 replan**：增删节点 + 版本递增 + `replan_events` + 事件，全成或全不成。

    与 `stages.apply_replan()`（先改图再记录，两次提交）不同：这里所有写操作在同一个
    `with conn:` 内完成，任何一步抛错 → 整笔回滚（图/版本/事件均不变）。
    """
    if reason not in REPLAN_REASONS:
        raise GraphError("非法 replan 原因：%s" % reason)
    add_specs = [dict(spec) for spec in (add or [])]
    remove_ids = list(remove or [])
    for spec in add_specs:
        if not spec.get("node_id"):
            raise GraphError("replan add 缺少 node_id：%r" % (spec,))
        if get_node(conn, spec["node_id"]) is not None:
            raise GraphError("replan add 节点已存在：%s" % spec["node_id"])
    for node_id in remove_ids:
        target = get_node(conn, node_id)
        if target is None:
            raise GraphError("replan remove 节点不存在：%s" % node_id)
        if target["status"] in TERMINAL_STATUSES:
            # 前置拒绝：绝不通过 replan 绕过终态（写入前抛出，图/版本/事件都不动）
            raise GraphError(
                "replan 不得删除终态节点：%s（status=%s）" % (node_id, target["status"])
            )

    added_ids: list[str] = []
    removed_ids: list[str] = []
    ts = _now()

    with conn:  # 单事务：异常自动回滚
        for spec in add_specs:
            add_node(conn, commit=False, **spec)
            added_ids.append(spec["node_id"])
        for node_id in remove_ids:
            remove_node(conn, node_id, commit=False)
            removed_ids.append(node_id)
        version = _bump_graph_version(conn)
        event_id = "EVT-R%04d" % version
        conn.execute(
            "INSERT INTO replan_events(event_id,at,reason,graph_version,added_json,removed_json,note)"
            " VALUES(?,?,?,?,?,?,?)",
            (event_id, ts, reason, version, db.dumps(added_ids), db.dumps(removed_ids), note),
        )
        events.append_event(
            conn, "graph_replanned", None,
            {"reason": reason, "graph_version": version, "added": added_ids,
             "removed": removed_ids, "note": note},
            commit=False,
        )

    promoted: list[str] = []
    if recompute:
        from . import scheduler  # 延迟导入：scheduler 依赖 graph

        promoted = scheduler.recompute_ready(conn, reason="replan")

    return {
        "event_id": event_id,
        "at": ts,
        "reason": reason,
        "graph_version": version,
        "added": added_ids,
        "removed": removed_ids,
        "note": note,
        "promoted": promoted,
    }

