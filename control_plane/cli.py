# -*- coding: utf-8 -*-
"""control_plane.cli —— 单进程控制面 CLI（argparse，输出 JSON）

用法：
    python -m control_plane.cli --db out/cli/control_plane.db init
    python -m control_plane.cli --db out/cli/control_plane.db node-add \
        --node-id NODE-A --title A --spec s --stage design
    python -m control_plane.cli --db ... claim --node-id NODE-A --owner me --ttl 60
    python -m control_plane.cli --db ... finalize --node-id NODE-A
    python -m control_plane.cli --db ... tick --now 1000
    python -m control_plane.cli --db ... run --max-ticks 10
    python -m control_plane.cli demo --root out/engine_demo

退出码：
    0 成功 / 2 参数或业务错误 / 3 运行已终止（terminated）/ 4 并发超限
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

from . import capabilities, db, engine as engine_mod, evidence, graph, ledger, runtime, stages

DEFAULT_DB = "out/cli/control_plane.db"

EXIT_OK = 0
EXIT_ERROR = 2
EXIT_TERMINATED = 3
EXIT_CONCURRENCY = 4


def _limits(args: argparse.Namespace) -> dict[str, Any]:
    limits: dict[str, Any] = {}
    for key, attr in (
        ("max_parallel", "max_parallel"),
        ("max_depth", "max_depth"),
        ("max_attempts", "max_attempts"),
        ("max_wall_sec", "max_wall_sec"),
        ("max_total_tokens", "max_total_tokens"),
        ("max_total_cost", "max_total_cost"),
    ):
        value = getattr(args, attr, None)
        if value is not None:
            limits[key] = value
    return limits


def _open(args: argparse.Namespace) -> engine_mod.Engine:
    return engine_mod.Engine.open(
        args.db,
        owner=getattr(args, "owner", None) or "cli",
        limits=_limits(args),
        model=getattr(args, "model", None),
    )


def _split(text: str | None) -> list[str]:
    if not text:
        return []
    return [item.strip() for item in text.split(",") if item.strip()]


# ---------------------------------------------------------------- 命令实现


def cmd_init(args: argparse.Namespace) -> dict[str, Any]:
    eng = _open(args)
    try:
        return {
            "ok": True,
            "db": str(Path(args.db)),
            "schema_version": db.schema_version(eng.conn),
            "terminated": eng.terminated_state(),
        }
    finally:
        eng.close()


def cmd_status(args: argparse.Namespace) -> dict[str, Any]:
    eng = _open(args)
    try:
        return {"ok": True, "status": eng.status()}
    finally:
        eng.close()


def cmd_node_add(args: argparse.Namespace) -> dict[str, Any]:
    eng = _open(args)
    try:
        budget: dict[str, Any] = {}
        if args.max_tokens is not None:
            budget["max_tokens"] = args.max_tokens
        if args.max_cost is not None:
            budget["max_cost"] = args.max_cost
        eng.add_node(
            node_id=args.node_id,
            title=args.title,
            spec=args.spec,
            capability=args.capability,
            stage=args.stage,
            status=args.status,
            deps=_split(args.deps),
            evidence_required=_split(args.evidence_required),
            verifier_ids=_split(args.verifier_ids),
            budget=budget,
        )
        promoted = eng.recompute_ready(reason="cli_node_add") if args.bootstrap else []
        return {"ok": True, "node": eng.node(args.node_id), "promoted": promoted}
    finally:
        eng.close()


def cmd_node_list(args: argparse.Namespace) -> dict[str, Any]:
    eng = _open(args)
    try:
        return {"ok": True, "nodes": eng.nodes()}
    finally:
        eng.close()


def cmd_bootstrap(args: argparse.Namespace) -> dict[str, Any]:
    eng = _open(args)
    try:
        return {"ok": True, "promoted": eng.bootstrap()}
    finally:
        eng.close()


def cmd_claim(args: argparse.Namespace) -> dict[str, Any]:
    eng = _open(args)
    try:
        lease = eng.claim(args.node_id, owner=args.owner, ttl_sec=args.ttl, now=args.now)
        return {"ok": True, "lease": lease}
    finally:
        eng.close()


def cmd_renew(args: argparse.Namespace) -> dict[str, Any]:
    eng = _open(args)
    try:
        lease = eng.renew(args.node_id, args.owner, args.token, ttl_sec=args.ttl, now=args.now)
        return {"ok": True, "lease": lease}
    finally:
        eng.close()


def cmd_release(args: argparse.Namespace) -> dict[str, Any]:
    eng = _open(args)
    try:
        eng.release(args.node_id, args.owner, args.token)
        return {"ok": True, "released": args.node_id}
    finally:
        eng.close()


def cmd_submit(args: argparse.Namespace) -> dict[str, Any]:
    eng = _open(args)
    try:
        return {"ok": True, "node": eng.submit(args.node_id, args.owner, args.token, now=args.now)}
    finally:
        eng.close()


def cmd_artifact_add(args: argparse.Namespace) -> dict[str, Any]:
    eng = _open(args)
    try:
        sha = args.sha256
        if not sha:
            data = Path(args.path).read_bytes()
            sha = hashlib.sha256(data).hexdigest()
        eng.add_artifact(
            artifact_id=args.artifact_id, path=args.path, sha256=sha, producer_node=args.node_id
        )
        return {"ok": True, "artifact_id": args.artifact_id, "sha256": sha}
    finally:
        eng.close()


def cmd_evidence_add(args: argparse.Namespace) -> dict[str, Any]:
    eng = _open(args)
    try:
        ev = eng.add_evidence(
            evidence_id=args.evidence_id,
            node_id=args.node_id,
            kind=args.kind,
            artifact_id=args.artifact_id,
            verifier_id=args.verifier,
            verdict=args.verdict,
        )
        return {"ok": True, "evidence": ev}
    finally:
        eng.close()


def cmd_finalize(args: argparse.Namespace) -> dict[str, Any]:
    eng = _open(args)
    try:
        result = eng.finalize(args.node_id)
        return {"ok": result.get("status") == "done", "result": result}
    finally:
        eng.close()


def cmd_gate(args: argparse.Namespace) -> dict[str, Any]:
    eng = _open(args)
    try:
        gate = stages.set_gate(eng.conn, args.stage, args.status, _split(args.evidence))
        return {"ok": True, "gate": gate}
    finally:
        eng.close()


def cmd_decision_l2(args: argparse.Namespace) -> dict[str, Any]:
    eng = _open(args)
    try:
        rec = eng.create_decision(
            decision_id=args.decision_id,
            level="L2",
            question=args.question,
            options=[{"option_id": "a", "label": "A"}, {"option_id": "b", "label": "B"}],
            default_option_id=args.default,
            timeout_sec=args.timeout,
            node_id=args.node_id,
            note=args.note,
            now=args.now,
        )
        return {"ok": True, "decision": rec}
    finally:
        eng.close()


def cmd_tick(args: argparse.Namespace) -> dict[str, Any]:
    eng = _open(args)
    try:
        return {"ok": True, "tick": runtime.tick(eng, now=args.now)}
    finally:
        eng.close()


def cmd_run(args: argparse.Namespace) -> dict[str, Any]:
    eng = _open(args)
    try:
        result = runtime.run(
            eng,
            max_ticks=args.max_ticks,
            step_sec=args.step,
            start_now=args.now,
            stop_when_idle=not args.no_idle_stop,
        )
        return {"ok": not result["terminated"], "run": result}
    finally:
        eng.close()


def cmd_scan(args: argparse.Namespace) -> dict[str, Any]:
    eng = _open(args)
    try:
        return {"ok": True, "scan": eng.scan(now=args.now)}
    finally:
        eng.close()


def cmd_ledger(args: argparse.Namespace) -> dict[str, Any]:
    eng = _open(args)
    try:
        return {
            "ok": True,
            "totals": eng.usage(args.node_id),
            "rows": ledger.rows(eng.conn, args.node_id, limit=args.limit),
        }
    finally:
        eng.close()


def cmd_meter(args: argparse.Namespace) -> dict[str, Any]:
    eng = _open(args)
    try:
        row = eng.record_usage(
            args.node_id,
            instance_id=args.instance_id,
            tokens_in=args.tokens_in,
            tokens_out=args.tokens_out,
            cache_saved=args.cache_saved,
            calls=args.calls,
            wall_ms=args.wall_ms,
            verifier_cost=args.verifier_cost,
            model=args.model,
        )
        return {"ok": True, "row": row, "totals": eng.usage(args.node_id)}
    finally:
        eng.close()


def cmd_price(args: argparse.Namespace) -> dict[str, Any]:
    if args.model:
        return {"ok": True, "price": ledger.price_row(args.model)}
    return {"ok": True, "prices": ledger.list_prices(), "default": ledger.price_row()}


def cmd_credential(args: argparse.Namespace) -> dict[str, Any]:
    """只读：查看节点当前能否进入 done（凭证由 graph.done_credential 签发）。"""
    eng = _open(args)
    try:
        cred = eng.done_credential(args.node_id)
        return {"ok": True, "node_id": args.node_id, "ready_for_done": cred is not None, "credential": cred}
    finally:
        eng.close()


def cmd_terminate(args: argparse.Namespace) -> dict[str, Any]:
    eng = _open(args)
    try:
        return {"ok": True, "terminated": eng.terminate(args.reason, {"source": "cli"})}
    finally:
        eng.close()


def cmd_resume(args: argparse.Namespace) -> dict[str, Any]:
    eng = _open(args)
    try:
        return {"ok": True, "resume": eng.resume(note=args.note)}
    finally:
        eng.close()


def cmd_unblock(args: argparse.Namespace) -> dict[str, Any]:
    """解除阻断：`blocked → ready`，reason 必填（空 reason 由 graph.unblock 拒绝）。

    终止态下不允许解除阻断（止损优先），走 Engine 的终止闸门并留 `action_denied` 事件。
    """
    eng = _open(args)
    try:
        reason = (args.reason or "").strip()
        if not reason:
            raise ValueError("解除阻断必须给出非空原因（--reason）")
        eng._gate("unblock")
        node = graph.unblock(eng.conn, args.node_id, reason, note=args.note)
        return {"ok": True, "node": node, "reason": reason}
    finally:
        eng.close()


def _export_evidence_projection(conn: Any, out_dir: str | Path) -> dict[str, Any]:
    """只读适配 B 的 `evidence.export_evidence_projection()`；签名不匹配时降级为跳过。

    不改 evidence.py：只做 hasattr / TypeError 的读取侧兼容。
    """
    fn = getattr(evidence, "export_evidence_projection", None)
    if fn is None:
        return {"status": "unavailable", "files": []}
    for caller in (lambda: fn(conn, out_dir), lambda: fn(conn, out_dir=out_dir)):
        try:
            return {"status": "ok", "files": [str(p) for p in (caller() or [])]}
        except TypeError:
            continue
        except Exception as exc:  # 投影失败不应让导出整体失败
            return {"status": "error", "files": [], "error": "%s: %s" % (type(exc).__name__, exc)}
    return {"status": "signature_mismatch", "files": []}


def cmd_export(args: argparse.Namespace) -> dict[str, Any]:
    eng = _open(args)
    try:
        root = Path(args.out)
        files = list(eng.export(root))  # capabilities.export_skill_format
        projection = _export_evidence_projection(eng.conn, root)
        return {
            "ok": True,
            "root": str(root),
            "files": files + projection["files"],
            "projection": projection,
        }
    finally:
        eng.close()


def cmd_demo(args: argparse.Namespace) -> dict[str, Any]:
    summary = runtime.demo(args.root, limits=_limits(args))
    return {"ok": True, "demo": summary}


# ---------------------------------------------------------------- argparse


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="control_plane.cli",
        description="许愿式生产集群控制面 · 单进程 CLI",
    )
    parser.add_argument("--db", default=DEFAULT_DB, help="SQLite 路径（默认 %s）" % DEFAULT_DB)
    parser.add_argument("--owner", default="cli", help="claim 默认 owner")
    parser.add_argument("--model", default=None, help="价目表模型名（ledger 折算用）")
    parser.add_argument("--max-parallel", type=int, default=None, dest="max_parallel")
    parser.add_argument("--max-depth", type=int, default=None, dest="max_depth")
    parser.add_argument("--max-attempts", type=int, default=None, dest="max_attempts")
    parser.add_argument("--max-wall-sec", type=float, default=None, dest="max_wall_sec")
    parser.add_argument("--max-total-tokens", type=int, default=None, dest="max_total_tokens")
    parser.add_argument("--max-total-cost", type=float, default=None, dest="max_total_cost")
    parser.add_argument("--now", type=float, default=None, help="覆盖当前时间戳（可复现）")

    sub = parser.add_subparsers(dest="cmd", required=True)

    def add(name: str, func, help_text: str, *, with_now: bool = False) -> argparse.ArgumentParser:
        p = sub.add_parser(name, help=help_text)
        p.set_defaults(func=func)
        if with_now:
            # SUPPRESS：不覆盖全局 --now 的取值
            p.add_argument("--now", type=float, default=argparse.SUPPRESS, help="覆盖时间戳")
        return p

    add("init", cmd_init, "初始化数据库")
    add("status", cmd_status, "查看运行状态/终止状态/用量")

    p = add("node-add", cmd_node_add, "添加节点")
    p.add_argument("--node-id", required=True)
    p.add_argument("--title", required=True)
    p.add_argument("--spec", required=True)
    p.add_argument("--stage", default=None)
    p.add_argument("--capability", default=None)
    p.add_argument("--status", default="planned")
    p.add_argument("--deps", default=None, help="逗号分隔的依赖节点")
    p.add_argument("--evidence-required", default=None, help="逗号分隔，如 artifact")
    p.add_argument("--verifier-ids", default=None, help="逗号分隔，如 verifier-ci")
    p.add_argument("--max-tokens", type=int, default=None)
    p.add_argument("--max-cost", type=float, default=None)
    p.add_argument("--bootstrap", action="store_true", help="添加后重算 ready")

    add("node-list", cmd_node_list, "列出节点")
    add("bootstrap", cmd_bootstrap, "根节点进入 ready")

    p = add("claim", cmd_claim, "认领节点（含终止闸门与并发门）", with_now=True)
    p.add_argument("--node-id", required=True)
    p.add_argument("--ttl", type=float, default=600.0)

    p = add("renew", cmd_renew, "续租", with_now=True)
    p.add_argument("--node-id", required=True)
    p.add_argument("--token", type=int, required=True)
    p.add_argument("--ttl", type=float, default=600.0)

    p = add("release", cmd_release, "释放租约")
    p.add_argument("--node-id", required=True)
    p.add_argument("--token", type=int, required=True)

    p = add("submit", cmd_submit, "提交（claimed→submitted）", with_now=True)
    p.add_argument("--node-id", required=True)
    p.add_argument("--token", type=int, required=True)

    p = add("artifact-add", cmd_artifact_add, "登记产物（sha256 省略则现算）")
    p.add_argument("--node-id", required=True)
    p.add_argument("--artifact-id", required=True)
    p.add_argument("--path", required=True)
    p.add_argument("--sha256", default=None)

    p = add("evidence-add", cmd_evidence_add, "登记证据")
    p.add_argument("--node-id", required=True)
    p.add_argument("--evidence-id", required=True)
    p.add_argument("--artifact-id", required=True)
    p.add_argument("--kind", default="artifact")
    p.add_argument("--verifier", default="verifier-ci")
    p.add_argument("--verdict", default="pass", choices=["pass", "fail", "unknown"])

    p = add("finalize", cmd_finalize, "验证并推进 done")
    p.add_argument("--node-id", required=True)

    p = add("gate", cmd_gate, "设置阶段闸门")
    p.add_argument("--stage", required=True)
    p.add_argument("--status", required=True, choices=["pending", "passed", "failed"])
    p.add_argument("--evidence", default=None, help="逗号分隔的 evidence_id")

    p = add("decision-l2", cmd_decision_l2, "创建 L2 决策（带默认值与超时）", with_now=True)
    p.add_argument("--decision-id", required=True)
    p.add_argument("--question", required=True)
    p.add_argument("--default", default="a")
    p.add_argument("--timeout", type=int, default=60)
    p.add_argument("--node-id", default=None)
    p.add_argument("--note", default=None)

    add("tick", cmd_tick, "推进一轮（tick_l2/expire/scan/recompute）", with_now=True)
    add("scan", cmd_scan, "只跑看门狗扫描", with_now=True)

    p = add("run", cmd_run, "运行时循环", with_now=True)
    p.add_argument("--max-ticks", type=int, default=runtime.DEFAULT_MAX_TICKS)
    p.add_argument("--step", type=float, default=runtime.DEFAULT_STEP_SEC)
    p.add_argument("--no-idle-stop", action="store_true")

    p = add("ledger", cmd_ledger, "查看计量账本与汇总")
    p.add_argument("--node-id", default=None)
    p.add_argument("--limit", type=int, default=50)

    p = add("meter-append", cmd_meter, "写一行计量（meter 接口）")
    p.add_argument("--node-id", required=True)
    p.add_argument("--instance-id", default=None)
    p.add_argument("--tokens-in", type=int, default=0)
    p.add_argument("--tokens-out", type=int, default=0)
    p.add_argument("--cache-saved", type=int, default=0)
    p.add_argument("--calls", type=int, default=1)
    p.add_argument("--wall-ms", type=int, default=0)
    p.add_argument("--verifier-cost", type=float, default=0.0)

    p = add("price", cmd_price, "查看价目表")
    p.add_argument("--model", default=None)

    p = add("terminate", cmd_terminate, "人工终止（写 meta + 事件）")
    p.add_argument("--reason", default="manual_terminate")

    p = add("credential", cmd_credential, "只读：查看节点能否进入 done（A 冻结凭证契约）")
    p.add_argument("--node-id", required=True)

    p = add("unblock", cmd_unblock, "解除阻断（blocked→ready，reason 必填）")
    p.add_argument("--node-id", required=True)
    p.add_argument("--reason", default="", help="必填：解除阻断的原因")
    p.add_argument("--note", default=None)

    p = add("resume", cmd_resume, "解除终止（留痕）")
    p.add_argument("--note", default=None)

    p = add("export", cmd_export, "导出人读投影（含证据/产物/验证器）")
    p.add_argument("--root", "--out", dest="out", required=True, help="导出目录")

    p = add("demo", cmd_demo, "单进程 engine 跑完小图")
    p.add_argument("--root", default="out/engine_demo")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        payload = args.func(args)
    except engine_mod.Terminated as exc:
        print(json.dumps({"ok": False, "code": "terminated", "error": str(exc)}, ensure_ascii=False))
        return EXIT_TERMINATED
    except engine_mod.ConcurrencyExceeded as exc:
        print(
            json.dumps({"ok": False, "code": "concurrency_exceeded", "error": str(exc)}, ensure_ascii=False)
        )
        return EXIT_CONCURRENCY
    except Exception as exc:  # 业务错误统一 JSON 输出，便于脚本消费
        print(
            json.dumps(
                {"ok": False, "code": "error", "error": "%s: %s" % (type(exc).__name__, exc)},
                ensure_ascii=False,
            )
        )
        return EXIT_ERROR
    print(json.dumps(payload, ensure_ascii=False, indent=2, default=str))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
