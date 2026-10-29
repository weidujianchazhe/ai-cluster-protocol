# -*- coding: utf-8 -*-
"""control_plane.runtime —— 运行时循环：tick_l2 / expire / scan / recompute_ready

一轮 tick = 一次"世界推进"：
  1. `decisions.tick_l2`：L2 决策到期按默认值推进；
  2. `watchdog.scan`：回收过期租约、attempts/墙钟/预算阻断、深度/全局止损（内部先 expire）；
  3. 汇总真实账本（ledger.totals）并在全局超限时把 terminated 落到 engine（后续动作全拒）；
  4. `scheduler.recompute_ready`：把依赖已 done 的 planned 升到 ready（终态后不再晋升）。

`run()` 是薄循环：按固定步长推进模拟时钟，直到终止 / 空闲（ready 与 active 皆空）/ 轮数上限。
循环本身不做业务：所有推进动作由调用方（CLI 或上层 agent）经 Engine 完成。
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any, Callable

from . import (
    capabilities,
    db,
    decisions,
    events,
    evidence,
    graph,
    ledger,
    scheduler,
    stages,
    watchdog,
)

DEFAULT_STEP_SEC = 1.0
DEFAULT_MAX_TICKS = 100


def _as_engine(target: Any) -> Any:
    """接受 Engine 或 sqlite 连接；连接会被包成临时 Engine。"""
    if hasattr(target, "conn") and hasattr(target, "limits") and hasattr(target, "is_terminated"):
        return target
    from .engine import Engine

    return Engine(target)


def _now(now: float | None) -> float:
    return time.time() if now is None else float(now)


def tick(target: Any, *, now: float | None = None) -> dict[str, Any]:
    """推进一轮世界状态。返回本轮报告（可序列化）。"""
    engine = _as_engine(target)
    conn = engine.conn
    t = _now(now)

    l2_timed_out = engine.tick_l2(now=t)
    scan = engine.scan(now=t)  # 内部先 leases.expire
    terminated = engine.is_terminated()
    promoted: list[str] = []
    if not terminated:
        promoted = scheduler.recompute_ready(conn, reason="runtime_tick")

    usage = engine.usage()  # 走 Engine 的价目口径（model/prices），与 meter 写入一致
    report = {
        "at": t,
        "l2_timed_out": l2_timed_out,
        "expired": list(scan.get("expired") or []),
        "blocked": list(scan.get("blocked") or []),
        "warnings": list(scan.get("warnings") or []),
        "promoted": promoted,
        "scan_terminated": bool(scan.get("terminated")),
        "terminated": bool(terminated),
        "reason": (engine.terminated_state() or {}).get("reason"),
        "usage": {"tokens": usage["tokens"], "cost": usage["cost"], "rows": usage["rows"]},
        "active": len(engine.active_nodes()),
        "ready": [n["node_id"] for n in engine.nodes() if n["status"] == "ready"],
    }
    events.append_event(conn, "runtime_tick", None, report)
    return report


def run(
    target: Any,
    *,
    max_ticks: int = DEFAULT_MAX_TICKS,
    step_sec: float = DEFAULT_STEP_SEC,
    start_now: float | None = None,
    clock: Callable[[], float] | None = None,
    stop_when_idle: bool = True,
    on_tick: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """按固定步长推进模拟时钟，直到终止 / 空闲 / 轮数上限。"""
    engine = _as_engine(target)
    t0 = float(start_now) if start_now is not None else (clock() if clock else time.time())
    reports: list[dict[str, Any]] = []
    stopped = "max_ticks"
    for i in range(max(0, int(max_ticks))):
        report = tick(engine, now=t0 + i * float(step_sec))
        reports.append(report)
        if on_tick is not None:
            on_tick(report)
        if report["terminated"]:
            stopped = "terminated"
            break
        state = engine.status()
        if stop_when_idle and not state["ready"] and not state["active"]:
            stopped = "idle"
            break
    state = engine.status()
    terminated = engine.terminated_state() or {}
    return {
        "ticks": len(reports),
        "stopped": stopped,
        "terminated": bool(state["terminated"]),
        "reason": terminated.get("reason"),
        "ready": state["ready"],
        "active": state["active"],
        "counts": state["counts"],
        "usage": state["usage"],
        "reports": reports,
    }


# ---------------------------------------------------------------- 单进程演示


DEMO_NODES = [
    # node_id, title, stage, capability, deps
    ("NODE-PLAN", "愿望拆解与方案", "design", "research", []),
    ("NODE-BUILD", "实现与自测", "build", "code_fullstack", ["NODE-PLAN"]),
    ("NODE-VERIFY", "独立验证", "audit", "audit_test", ["NODE-BUILD"]),
    ("NODE-SHIP", "打包交付", "deliver", "audit_test", ["NODE-VERIFY"]),
]


def _write_artifact(root: Path, node_id: str) -> tuple[str, str]:
    art_dir = root / "artifacts"
    art_dir.mkdir(parents=True, exist_ok=True)
    path = art_dir / ("%s.txt" % node_id)
    # 关键：写盘字节 = 计算 sha 的字节。write_text 在 Windows 会把 \n 翻成 \r\n，
    # 导致登记 sha 与文件实际字节不一致（B 的 strict 复核会报 sha_mismatch）。
    data = ("artifact for %s\n" % node_id).encode("utf-8")
    path.write_bytes(data)
    return str(path), hashlib.sha256(data).hexdigest()


def _complete(
    engine: Any,
    root: Path,
    node_id: str,
    owner: str,
    stage: str,
    *,
    now: float,
    tokens_in: int = 120,
    tokens_out: int = 340,
) -> None:
    """一次完整节点生命周期：claim → 计量 → 产物/证据 → 闸门 → submit → finalize。"""
    lease = engine.claim(node_id, owner=owner, ttl_sec=600, now=now)
    with engine.meter(node_id, instance_id="%s-%s" % (owner, node_id)) as m:
        m.record(tokens_in=tokens_in, tokens_out=tokens_out, calls=1)
    path, sha = _write_artifact(root, node_id)
    engine.add_artifact(
        artifact_id="ART-%s" % node_id, path=path, sha256=sha, producer_node=node_id
    )
    engine.add_evidence(
        evidence_id="EVD-%s" % node_id,
        node_id=node_id,
        kind="artifact",
        artifact_id="ART-%s" % node_id,
        verifier_id="verifier-ci",
        verdict="pass",
    )
    stages.pass_gate(engine.conn, stage, ["EVD-%s" % node_id])
    engine.submit(node_id, owner, lease["fencing_token"], now=now)
    result = engine.finalize(node_id)
    if result.get("status") != "done":
        raise RuntimeError("节点未完成：%s -> %s" % (node_id, result))


def demo(
    root: str | Path,
    *,
    limits: dict[str, Any] | None = None,
    max_ticks: int = 20,
) -> dict[str, Any]:
    """单进程 engine 跑完一张小图（demo_crud 的引擎版，不依赖 demo_crud 模块）。"""
    from .engine import Engine

    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    engine = Engine.open(
        root / "control_plane.db",
        owner="engine",
        limits=limits
        or {"max_depth": 20, "max_parallel": 10, "max_wall_sec": 100000},
    )
    try:
        # 验证器身份：先注册再产生证据，strict=1 时 demo 也能自洽跑完（不切默认值）
        evidence.register_verifier(
            engine.conn, "verifier-ci", kind="ci", role="ROLE-AUDIT-01"
        )
        for name, tools in (
            ("research", ["web"]),
            ("code_fullstack", ["fs", "shell"]),
            ("audit_test", ["fs", "shell"]),
        ):
            capabilities.register_capability(engine.conn, name=name, description=name, tools=tools)

        engine.create_decision(
            decision_id="DEC-L2", level="L2", question="构建工具链？",
            options=[{"option_id": "a", "label": "A"}, {"option_id": "b", "label": "B"}],
            default_option_id="a", timeout_sec=2, now=1000, note="默认 A",
        )
        for node_id, title, stage, cap, deps in DEMO_NODES:
            engine.add_node(
                node_id=node_id,
                title=title,
                spec="产出 %s" % title,
                capability=cap,
                stage=stage,
                deps=deps,
                evidence_required=["artifact"],
                verifier_ids=["verifier-ci"],
                budget={"max_tokens": 100000, "max_cost": 5},
            )
        engine.bootstrap()

        now = 1000.0
        ticks: list[dict[str, Any]] = []
        for node_id, _title, stage, _cap, _deps in DEMO_NODES:
            ticks.append(tick(engine, now=now))  # L2 到期 tick + 依赖晋升
            now += 1.0
            _complete(engine, root, node_id, "agent-%s" % node_id.lower(), stage, now=now)
            now += 1.0
        ticks.append(tick(engine, now=now))

        summary = {
            "ok": True,
            "engine": "control_plane.engine",
            "nodes": {n["node_id"]: n["status"] for n in engine.nodes()},
            "usage": engine.usage(),
            "terminated": engine.is_terminated(),
            "decisions": {
                d["decision_id"]: d["status"]
                for d in decisions.list_decisions(engine.conn)
            },
            "ticks": len(ticks),
            "last_tick": ticks[-1],
            "events": len(events.iter_events(engine.conn)),
            "db": str(root / "control_plane.db"),
        }
        (root / "summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return summary
    finally:
        engine.close()
