# -*- coding: utf-8 -*-
"""control_plane.engine —— 运行时门面（单进程驱动面 / 终止闸门 / 并发门 / 计量挂点）

职责：
  - **门面**：把 graph / leases / evidence / decisions / stages / scheduler / watchdog / ledger
    收成一个对象，CLI 与 runtime 只跟 Engine 打交道；
  - **终止闸门（terminated）**：一旦 watchdog 判定全局止损，Engine 在 claim / submit /
    finalize / add_evidence 入口**硬拒**，并把 terminated 落到 `meta`（跨进程可见），
    不依赖内存标志；
  - **并发门**：claim 前检查在跑（claimed/running）数量，超过 `max_parallel` 直接拒绝，
    而不是只发 warning；
  - **计量挂点**：`engine.meter(node_id, model=...)` 返回 ledger.Meter；claim/submit/finalize
    自带 `instance_id` 便于对账。

写域约束（Lane C）：不改 graph.py / evidence.py / db.py；状态迁移一律走现有模块函数，
本文件只做**包装 + 闸门 + 事件**。

done 凭证契约（Lane A R1 冻结，B/C/D 共用）：
  - 唯一签发 `graph.done_credential(conn, node_id)`（不满足条件返回 None）；
  - 唯一消费 `graph.set_status(conn, node_id, "done", credential=cred, reason="evidence_ok",
    assignee=None, drop_lease=True)`；
  - engine **不自拼 done 事件、不绕开凭证**：`Engine.finalize()` 只做「终止闸门 → 委派
    `evidence.finalize()`」。done 事务的内部实现归 Lane B，B 改成凭证路径后 C 侧零改动；
  - `Engine.done_credential()` 是只读透出（CLI/调试用），不产生副作用。
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from . import (
    capabilities,
    db,
    decisions,
    events,
    evidence,
    graph,
    leases,
    ledger,
    scheduler,
    stages,
    watchdog,
)

TERMINATED_KEY = "run_terminated"

# 终止闸门覆盖的动作：这些入口在 terminated 后必须拒。
GATED_ACTIONS = ("claim", "renew", "takeover", "submit", "add_evidence", "finalize", "replan")


class EngineError(Exception):
    """门面层错误基类。"""


class Terminated(EngineError):
    """全局已终止（watchdog 止损）；任何推进动作都被拒。"""

    def __init__(self, action: str, state: dict[str, Any] | None) -> None:
        self.action = action
        self.state = state or {}
        super().__init__(
            "运行已终止（reason=%s），拒绝 %s" % (self.state.get("reason"), action)
        )


class ConcurrencyExceeded(EngineError):
    """并发超限：在跑租约数已达 max_parallel。"""

    def __init__(self, active: int, limit: int) -> None:
        self.active = active
        self.limit = limit
        super().__init__("并发超限：active=%d >= max_parallel=%d" % (active, limit))


class Engine:
    """控制面运行时门面。"""

    def __init__(
        self,
        conn: Any,
        *,
        owner: str = "engine",
        limits: dict[str, Any] | None = None,
        prices: dict[str, float] | None = None,
        model: str | None = None,
    ) -> None:
        self.conn = conn
        self.owner = owner
        self.limits = dict(watchdog.DEFAULT_LIMITS)
        self.limits.update(limits or {})
        self.prices = prices
        self.model = model

    # ------------------------------------------------------------ 构造
    @classmethod
    def open(
        cls,
        path: str | Path,
        *,
        owner: str = "engine",
        limits: dict[str, Any] | None = None,
        prices: dict[str, float] | None = None,
        model: str | None = None,
    ) -> "Engine":
        return cls(
            db.init_db(path), owner=owner, limits=limits, prices=prices, model=model
        )

    def close(self) -> None:
        self.conn.close()

    # ------------------------------------------------------------ 终止状态
    def terminated_state(self) -> dict[str, Any] | None:
        """读 meta 里的终止记录（跨进程；不依赖内存）。"""
        row = self.conn.execute(
            "SELECT value FROM meta WHERE key=?", (TERMINATED_KEY,)
        ).fetchone()
        if row is None:
            return None
        try:
            state = json.loads(row["value"])
        except (TypeError, ValueError):
            return {"reason": "unknown", "detail": row["value"], "at": None}
        return state if isinstance(state, dict) else {"reason": str(state)}

    def is_terminated(self) -> bool:
        return self.terminated_state() is not None

    def terminate(self, reason: str, detail: dict[str, Any] | None = None) -> dict[str, Any]:
        """写终止状态（幂等：首个原因保留），并留事件。"""
        existing = self.terminated_state()
        if existing is not None:
            return existing
        state = {"reason": reason, "detail": detail or {}, "at": db.now_iso()}
        with self.conn:
            self.conn.execute(
                "INSERT INTO meta(key,value) VALUES(?,?)"
                " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (TERMINATED_KEY, db.dumps(state)),
            )
            events.append_event(
                self.conn, "run_terminated", None, state, commit=False
            )
        return state

    def resume(self, note: str | None = None) -> dict[str, Any]:
        """人工解除终止（可逆默认 D0：留痕后继续）。"""
        state = self.terminated_state()
        with self.conn:
            self.conn.execute("DELETE FROM meta WHERE key=?", (TERMINATED_KEY,))
            events.append_event(
                self.conn,
                "run_termination_cleared",
                None,
                {"prev": state, "note": note, "at": db.now_iso()},
                commit=False,
            )
        return {"cleared": state, "note": note}

    def _gate(self, action: str) -> None:
        state = self.terminated_state()
        if state is not None:
            events.append_event(
                self.conn,
                "action_denied",
                None,
                {"action": action, "reason": "terminated", "state": state},
            )
            raise Terminated(action, state)

    # ------------------------------------------------------------ 图
    def add_node(self, **kwargs: Any) -> dict[str, Any]:
        return graph.add_node(self.conn, **kwargs)

    def add_edge(self, from_id: str, to_id: str, kind: str = "blocks") -> None:
        graph.add_edge(self.conn, from_id, to_id, kind)

    def node(self, node_id: str) -> dict[str, Any] | None:
        return graph.get_node(self.conn, node_id)

    def nodes(self) -> list[dict[str, Any]]:
        return graph.list_nodes(self.conn)

    def bootstrap(self) -> list[str]:
        return scheduler.bootstrap(self.conn)

    def recompute_ready(self, *, reason: str = "engine_recompute") -> list[str]:
        return scheduler.recompute_ready(self.conn, reason=reason)

    # ------------------------------------------------------------ 并发门
    def active_nodes(self) -> list[dict[str, Any]]:
        return [
            n for n in graph.list_nodes(self.conn) if n["status"] in ("claimed", "running")
        ]

    def max_parallel(self) -> int:
        return int(self.limits.get("max_parallel") or 0)

    def _check_concurrency(self, node_id: str) -> None:
        limit = self.max_parallel()
        # 已持有同一节点租约时 renew 路径不重复计数；claim 时该节点必然不在 active 里。
        active = [n["node_id"] for n in self.active_nodes() if n["node_id"] != node_id]
        if limit > 0 and len(active) >= limit:
            events.append_event(
                self.conn,
                "claim_denied",
                node_id,
                {"reason": "concurrency_exceeded", "active": len(active), "limit": limit},
            )
            raise ConcurrencyExceeded(len(active), limit)

    # ------------------------------------------------------------ 租约
    def claim(
        self,
        node_id: str,
        owner: str | None = None,
        ttl_sec: float = 600.0,
        *,
        now: float | None = None,
    ) -> dict[str, Any]:
        self._gate("claim")
        self._check_concurrency(node_id)
        return leases.claim(
            self.conn, node_id, owner or self.owner, ttl_sec=ttl_sec, now=now
        )

    def renew(
        self,
        node_id: str,
        owner: str,
        fencing_token: int,
        ttl_sec: float = 600.0,
        *,
        now: float | None = None,
    ) -> dict[str, Any]:
        self._gate("renew")
        return leases.renew(
            self.conn, node_id, owner, fencing_token, ttl_sec=ttl_sec, now=now
        )

    def release(self, node_id: str, owner: str, fencing_token: int) -> None:
        leases.release(self.conn, node_id, owner, fencing_token)

    def takeover(
        self,
        node_id: str,
        new_owner: str,
        ttl_sec: float = 600.0,
        *,
        now: float | None = None,
    ) -> dict[str, Any]:
        self._gate("takeover")
        return leases.takeover(
            self.conn, node_id, new_owner, ttl_sec=ttl_sec, now=now
        )

    def lease(self, node_id: str) -> dict[str, Any] | None:
        return leases.current_lease(self.conn, node_id)

    # ------------------------------------------------------------ 证据 / 提交 / done
    def submit(
        self,
        node_id: str,
        owner: str,
        fencing_token: int,
        *,
        now: float | None = None,
    ) -> dict[str, Any]:
        self._gate("submit")
        return evidence.submit(
            self.conn, node_id, owner, fencing_token, now=now
        )

    def add_artifact(self, **kwargs: Any) -> None:
        evidence.add_artifact(self.conn, **kwargs)

    def add_evidence(self, **kwargs: Any) -> dict[str, Any]:
        self._gate("add_evidence")
        return evidence.add_evidence(self.conn, **kwargs)

    def finalize(self, node_id: str) -> dict[str, Any]:
        """验证 + done 事务（委派 evidence.finalize；done 凭证由 graph 签发/消费）。

        本方法只做终止闸门 + 委派，不自拼 `done` 事件：凭证路径的唯一事实源是
        `graph.done_credential()` / `graph.set_status(..., credential=...)`。
        """
        self._gate("finalize")
        return evidence.finalize(self.conn, node_id)

    def done_credential(self, node_id: str) -> dict[str, Any] | None:
        """只读透出：该节点当前能否进入 done（不满足条件返回 None，不抛、不写库）。"""
        return graph.done_credential(self.conn, node_id)

    def replan(self, *, reason: str, add: list[dict[str, Any]] | None = None,
               remove: list[str] | None = None, note: str | None = None) -> dict[str, Any]:
        self._gate("replan")
        result = stages.apply_replan(
            self.conn, reason=reason, add=add, remove=remove, note=note
        )
        scheduler.recompute_ready(self.conn, reason="replan")
        return result

    # ------------------------------------------------------------ 决策
    def create_decision(self, **kwargs: Any) -> dict[str, Any]:
        return decisions.create_decision(self.conn, **kwargs)

    def confirm_l3(self, decision_id: str, chosen: str, *, note: str | None = None) -> dict[str, Any]:
        return decisions.confirm_l3(self.conn, decision_id, chosen, note=note)

    def tick_l2(self, *, now: float | None = None) -> list[str]:
        return decisions.tick_l2(self.conn, now=now)

    # ------------------------------------------------------------ 计量
    def meter(
        self,
        node_id: str,
        *,
        instance_id: str | None = None,
        model: str | None = None,
        prices: dict[str, float] | None = None,
    ) -> ledger.Meter:
        return ledger.meter(
            self.conn,
            node_id,
            instance_id=instance_id,
            model=model or self.model,
            prices=prices or self.prices,
        )

    def record_usage(self, node_id: str, **kwargs: Any) -> dict[str, Any]:
        kwargs.setdefault("model", self.model)
        kwargs.setdefault("prices", self.prices)
        return ledger.append(self.conn, node_id, **kwargs)

    def usage(self, node_id: str | None = None) -> dict[str, float]:
        return ledger.totals(self.conn, node_id, model=self.model, prices=self.prices)

    # ------------------------------------------------------------ 运行时
    def scan(self, *, now: float | None = None) -> dict[str, Any]:
        """看门狗扫描；若判定终止，则把终止落到 meta（后续推进全部被拒）。

        价目口径：把 Engine 的 model/prices 透给 watchdog，让预算折算与 meter 写入时一致。
        """
        limits = dict(self.limits)
        if self.model:
            limits.setdefault("model", self.model)
        if self.prices:
            limits.setdefault("prices", self.prices)
        result = watchdog.scan(self.conn, now=now, limits=limits)
        if result.get("terminated"):
            self.terminate(str(result.get("reason") or "unknown"), {"scan": result})
        return result

    def tick(self, *, now: float | None = None) -> dict[str, Any]:
        from . import runtime  # 局部导入，避免 engine <-> runtime 循环

        return runtime.tick(self, now=now)

    def run(self, **kwargs: Any) -> dict[str, Any]:
        from . import runtime

        return runtime.run(self, **kwargs)

    # ------------------------------------------------------------ 视图
    def status(self) -> dict[str, Any]:
        nodes = graph.list_nodes(self.conn)
        counts: dict[str, int] = {}
        for n in nodes:
            counts[n["status"]] = counts.get(n["status"], 0) + 1
        return {
            "terminated": self.terminated_state(),
            "graph_version": stages.current_version(self.conn),
            "nodes": {n["node_id"]: n["status"] for n in nodes},
            "counts": counts,
            "ready": [n["node_id"] for n in nodes if n["status"] == "ready"],
            "active": [n["node_id"] for n in nodes if n["status"] in ("claimed", "running")],
            "max_parallel": self.max_parallel(),
            "usage": self.usage(),
            "events": len(events.iter_events(self.conn)),
            "terminal": all(n["status"] == "done" for n in nodes) if nodes else False,
        }

    def export(self, out_dir: str | Path) -> list[str]:
        return capabilities.export_skill_format(self.conn, out_dir)


def now() -> float:
    return time.time()


def open_engine(path: str | Path, **kwargs: Any) -> Engine:
    """便捷函数：control_plane.engine.open_engine("out/x.db")。"""
    return Engine.open(path, **kwargs)
