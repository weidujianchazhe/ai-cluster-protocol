# -*- coding: utf-8 -*-
"""control_plane.ledger —— 计量账本：写入 API / meter / 价目表 / 预算判定

设计依据：
  - designs/_research/L0调用层-设计细化.md §10（计费与预算）
  - designs/Root编排与控制面.md（决策账本 / 止损）
  - 60轮并行分工与长任务.md Lane C（计量与预算闭环）

原则：
  - **只追加**：每次模型 / 工具 / 验证调用落一行 `ledger`，不更新旧行；
  - **列由 db.py 提供**（Lane B 统一改列）：本模块不建表、不改 schema，只写行；
  - **成本在读取时重算**：`ledger` 表没有 cost 列，`totals()` 用价目表把 tokens 折算成成本，
    因此加价目表不需要迁移；`verifier_cost` 列保持"验证器自报成本"的原义；
  - **预算判定只看真实行汇总**：`budget_check()` 不信任调用方自报，watchdog 通过它读真实账本；
  - 仅标准库；时间戳统一用 `db.now_iso()`。
"""

from __future__ import annotations

import sqlite3
import time
from typing import Any

from . import db, events

PER_MILLION = 1_000_000

# 价目表：单位是"每百万 token 的成本单位"（不绑定货币，便于本地压测与断言）。
# in=输入 token、out=输出 token、cache=命中缓存 token（按 cache 价而不是 in 价计）。
DEFAULT_PRICES: dict[str, float] = {
    "in": 0.28,
    "out": 1.10,
    "cache": 0.028,
}

PRICE_TABLE: dict[str, dict[str, float]] = {
    "default": dict(DEFAULT_PRICES),
    "deepseek-chat": {"in": 0.28, "out": 1.10, "cache": 0.028},
    "deepseek-reasoner": {"in": 0.56, "out": 2.20, "cache": 0.056},
    "local-small": {"in": 0.0, "out": 0.0, "cache": 0.0},
}


class LedgerError(Exception):
    """账本写入/读取错误。"""


# ---------------------------------------------------------------- 价目表


def resolve_prices(
    model: str | None = None,
    prices: dict[str, float] | None = None,
) -> dict[str, float]:
    """合并价目表：默认 → 模型 → 显式覆盖。返回 in/out/cache 三项。"""
    merged = dict(DEFAULT_PRICES)
    if model:
        merged.update(PRICE_TABLE.get(model, {}))
    if prices:
        for key in ("in", "out", "cache"):
            if key in prices:
                merged[key] = float(prices[key])
    for key, value in merged.items():
        if float(value) < 0:
            raise LedgerError("价目不能为负：%s=%s" % (key, value))
    return merged


def price_row(model: str | None = None) -> dict[str, Any]:
    """价目表的一行（CLI `meter price` 用）。"""
    name = model or "default"
    if model is not None and model not in PRICE_TABLE:
        raise LedgerError("未知模型价目：%s（已知：%s）" % (model, ", ".join(sorted(PRICE_TABLE))))
    return {"model": name, "prices": resolve_prices(model)}


def list_prices() -> list[dict[str, Any]]:
    return [{"model": name, "prices": dict(PRICE_TABLE[name])} for name in sorted(PRICE_TABLE)]


def estimate_cost(
    tokens_in: int = 0,
    tokens_out: int = 0,
    cache_saved: int = 0,
    *,
    model: str | None = None,
    prices: dict[str, float] | None = None,
) -> float:
    """按价目表折算成本。cache_saved 只能从 tokens_in 里抵扣（超出部分忽略）。"""
    tin = _non_negative("tokens_in", tokens_in)
    tout = _non_negative("tokens_out", tokens_out)
    cached = min(_non_negative("cache_saved", cache_saved), tin)
    p = resolve_prices(model, prices)
    cost = ((tin - cached) * p["in"] + cached * p["cache"] + tout * p["out"]) / PER_MILLION
    return round(cost, 9)


# ---------------------------------------------------------------- 写入


def _non_negative(name: str, value: Any) -> int:
    try:
        v = int(value or 0)
    except (TypeError, ValueError):
        raise LedgerError("%s 必须是整数：%r" % (name, value))
    if v < 0:
        raise LedgerError("%s 不能为负：%s" % (name, v))
    return v


def append(
    conn: sqlite3.Connection,
    node_id: str,
    *,
    instance_id: str | None = None,
    tokens_in: int = 0,
    tokens_out: int = 0,
    cache_saved: int = 0,
    calls: int = 0,
    wall_ms: int = 0,
    verifier_cost: float | None = None,
    model: str | None = None,
    prices: dict[str, float] | None = None,
    at: str | None = None,
    record_event: bool = True,
    commit: bool = True,
) -> dict[str, Any]:
    """追加一行计量。返回写入行（含折算成本 cost，cost 不落库）。"""
    if not node_id:
        raise LedgerError("node_id 不能为空")
    tin = _non_negative("tokens_in", tokens_in)
    tout = _non_negative("tokens_out", tokens_out)
    cached = _non_negative("cache_saved", cache_saved)
    n_calls = _non_negative("calls", calls)
    ms = _non_negative("wall_ms", wall_ms)
    vcost = float(verifier_cost or 0.0)
    if vcost < 0:
        raise LedgerError("verifier_cost 不能为负：%s" % vcost)
    ts = at or db.now_iso()
    cost = estimate_cost(tin, tout, cached, model=model, prices=prices)

    cur = conn.execute(
        "INSERT INTO ledger(node_id,instance_id,tokens_in,tokens_out,cache_saved,calls,wall_ms,"
        "verifier_cost,at) VALUES(?,?,?,?,?,?,?,?,?)",
        (node_id, instance_id, tin, tout, cached, n_calls, ms, vcost, ts),
    )
    row_id = int(cur.lastrowid)
    if record_event:
        events.append_event(
            conn,
            "ledger_appended",
            node_id,
            {
                "id": row_id,
                "instance_id": instance_id,
                "tokens_in": tin,
                "tokens_out": tout,
                "cache_saved": cached,
                "calls": n_calls,
                "wall_ms": ms,
                "verifier_cost": vcost,
                "cost": cost,
                "model": model or "default",
                "at": ts,
            },
            commit=False,
        )
    if commit:
        conn.commit()
    return {
        "id": row_id,
        "node_id": node_id,
        "instance_id": instance_id,
        "tokens_in": tin,
        "tokens_out": tout,
        "cache_saved": cached,
        "calls": n_calls,
        "wall_ms": ms,
        "verifier_cost": vcost,
        "cost": cost,
        "model": model or "default",
        "at": ts,
    }


def rows(
    conn: sqlite3.Connection,
    node_id: str | None = None,
    *,
    after_id: int = 0,
    limit: int | None = None,
    model: str | None = None,
    prices: dict[str, float] | None = None,
) -> list[dict[str, Any]]:
    """按 id 升序读取计量行（node_id=None 表示全局）。

    `ledger` 表没有 cost 列，行内成本在读取时折算；传入与写入时相同的
    `model` / `prices` 才能得到同一口径（默认价目表）。
    """
    sql = "SELECT * FROM ledger WHERE id > ?"
    args: list[Any] = [int(after_id)]
    if node_id is not None:
        sql += " AND node_id = ?"
        args.append(node_id)
    sql += " ORDER BY id"
    if limit is not None:
        sql += " LIMIT ?"
        args.append(int(limit))
    out: list[dict[str, Any]] = []
    for r in conn.execute(sql, args).fetchall():
        row = dict(r)
        row["cost"] = estimate_cost(
            row["tokens_in"], row["tokens_out"], row["cache_saved"],
            model=model, prices=prices,
        )
        out.append(row)
    return out


# ---------------------------------------------------------------- 汇总


def totals(
    conn: sqlite3.Connection,
    node_id: str | None = None,
    *,
    model: str | None = None,
    prices: dict[str, float] | None = None,
) -> dict[str, float]:
    """汇总真实行：tokens / calls / wall_ms / verifier_cost / 折算成本。

    `cost` = 价目表折算的模型成本 + verifier_cost；预算判定看 `cost` 与 `tokens`。
    """
    sql = (
        "SELECT COUNT(*) AS n,"
        " COALESCE(SUM(tokens_in),0) AS tokens_in,"
        " COALESCE(SUM(tokens_out),0) AS tokens_out,"
        " COALESCE(SUM(cache_saved),0) AS cache_saved,"
        " COALESCE(SUM(calls),0) AS calls,"
        " COALESCE(SUM(wall_ms),0) AS wall_ms,"
        " COALESCE(SUM(verifier_cost),0) AS verifier_cost FROM ledger"
    )
    if node_id is None:
        row = conn.execute(sql).fetchone()
    else:
        row = conn.execute(sql + " WHERE node_id=?", (node_id,)).fetchone()
    tin = int(row["tokens_in"])
    tout = int(row["tokens_out"])
    cached = int(row["cache_saved"])
    verifier = round(float(row["verifier_cost"]), 9)
    model_cost = estimate_cost(tin, tout, cached, model=model, prices=prices)
    return {
        "rows": int(row["n"]),
        "tokens_in": tin,
        "tokens_out": tout,
        "tokens": tin + tout,
        "cache_saved": cached,
        "calls": int(row["calls"]),
        "wall_ms": int(row["wall_ms"]),
        "verifier_cost": verifier,
        "model_cost": model_cost,
        "cost": round(model_cost + verifier, 9),
    }


def budget_check(
    totals_row: dict[str, Any],
    budget: dict[str, Any] | None,
) -> dict[str, Any]:
    """用真实汇总判定预算。返回 {ok, reason, detail}（reason 为 None 表示未超）。"""
    b = budget or {}
    max_tokens = b.get("max_tokens")
    max_cost = b.get("max_cost")
    tokens = float(totals_row.get("tokens", 0))
    cost = float(totals_row.get("cost", 0.0))
    if max_tokens is not None and tokens > float(max_tokens):
        return {
            "ok": False,
            "reason": "budget_exceeded",
            "detail": {"tokens": tokens, "max_tokens": float(max_tokens)},
        }
    if max_cost is not None and cost > float(max_cost):
        return {
            "ok": False,
            "reason": "budget_exceeded",
            "detail": {"cost": round(cost, 9), "max_cost": float(max_cost)},
        }
    return {
        "ok": True,
        "reason": None,
        "detail": {
            "tokens": tokens,
            "max_tokens": None if max_tokens is None else float(max_tokens),
            "cost": round(cost, 9),
            "max_cost": None if max_cost is None else float(max_cost),
        },
    }


def node_totals(conn: sqlite3.Connection, node_id: str) -> dict[str, float]:
    return totals(conn, node_id)


# ---------------------------------------------------------------- meter 接口


class Meter:
    """一次调用/一段工作的计量器：缓冲 → flush 落行。

    用法：
        with ledger.Meter(conn, "NODE-A", model="deepseek-chat") as m:
            m.record(tokens_in=120, tokens_out=340, calls=1)
        # 退出时按实测墙钟补齐 wall_ms 并落一行

    meter 只负责缓冲与落行；预算判定走 budget_check()/watchdog，不在 meter 里做。
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        node_id: str,
        *,
        instance_id: str | None = None,
        model: str | None = None,
        prices: dict[str, float] | None = None,
        record_event: bool = True,
        clock=time.monotonic,
    ) -> None:
        if not node_id:
            raise LedgerError("node_id 不能为空")
        self.conn = conn
        self.node_id = node_id
        self.instance_id = instance_id
        self.model = model
        self.prices = prices
        self.record_event = record_event
        self._clock = clock
        self._started_at: float | None = None
        self._buffer: dict[str, float] = {
            "tokens_in": 0,
            "tokens_out": 0,
            "cache_saved": 0,
            "calls": 0,
            "wall_ms": 0,
            "verifier_cost": 0.0,
        }

    # -- 生命周期 --------------------------------------------------
    def start(self) -> "Meter":
        self._started_at = self._clock()
        return self

    def stop(self) -> "Meter":
        if self._started_at is not None:
            self._buffer["wall_ms"] += int(max(0.0, self._clock() - self._started_at) * 1000)
            self._started_at = None
        return self

    def __enter__(self) -> "Meter":
        return self.start()

    def __exit__(self, exc_type, exc, tb) -> bool:
        self.stop()
        if exc_type is None:
            self.flush()
        return False

    # -- 记录 ------------------------------------------------------
    def record(
        self,
        *,
        tokens_in: int = 0,
        tokens_out: int = 0,
        cache_saved: int = 0,
        calls: int = 1,
        wall_ms: int = 0,
        verifier_cost: float = 0.0,
    ) -> "Meter":
        self._buffer["tokens_in"] += _non_negative("tokens_in", tokens_in)
        self._buffer["tokens_out"] += _non_negative("tokens_out", tokens_out)
        self._buffer["cache_saved"] += _non_negative("cache_saved", cache_saved)
        self._buffer["calls"] += _non_negative("calls", calls)
        self._buffer["wall_ms"] += _non_negative("wall_ms", wall_ms)
        self._buffer["verifier_cost"] = round(
            self._buffer["verifier_cost"] + float(verifier_cost or 0.0), 9
        )
        return self

    @property
    def buffered(self) -> dict[str, float]:
        return dict(self._buffer)

    def flush(self, *, commit: bool = True) -> dict[str, Any] | None:
        """把缓冲落成一行；无任何用量时不落行（空行会污染预算曲线）。"""
        b = self._buffer
        if not any(
            (
                b["tokens_in"],
                b["tokens_out"],
                b["cache_saved"],
                b["calls"],
                b["wall_ms"],
                b["verifier_cost"],
            )
        ):
            return None
        row = append(
            self.conn,
            self.node_id,
            instance_id=self.instance_id,
            tokens_in=int(b["tokens_in"]),
            tokens_out=int(b["tokens_out"]),
            cache_saved=int(b["cache_saved"]),
            calls=int(b["calls"]),
            wall_ms=int(b["wall_ms"]),
            verifier_cost=float(b["verifier_cost"]),
            model=self.model,
            prices=self.prices,
            record_event=self.record_event,
            commit=commit,
        )
        self._buffer = {
            "tokens_in": 0,
            "tokens_out": 0,
            "cache_saved": 0,
            "calls": 0,
            "wall_ms": 0,
            "verifier_cost": 0.0,
        }
        return row


def meter(
    conn: sqlite3.Connection,
    node_id: str,
    *,
    instance_id: str | None = None,
    model: str | None = None,
    prices: dict[str, float] | None = None,
    record_event: bool = True,
) -> Meter:
    """语法糖：ledger.meter(conn, "NODE-A", model=...) 返回一个 Meter。"""
    return Meter(
        conn,
        node_id,
        instance_id=instance_id,
        model=model,
        prices=prices,
        record_event=record_event,
    )
