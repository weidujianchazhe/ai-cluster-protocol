# -*- coding: utf-8 -*-
"""control_plane.demo_crud —— 端到端 CRUD Web 模拟 fixture

流程：愿望 → 研究 → PRD → 契约 → DB / 后端 / 前端 → 集成 → 独立审计 →（L3 确认）→ 交付。
目的：用控制面 API 串联 决策 / 租约 / 提交 / 证据 / done 事务 / 阶段闸门 / replan / 看门狗 / 导出。
仅模拟，不真的生成 Web 应用；产物是占位文件。
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from . import capabilities, db, decisions, events, evidence, graph, leases, scheduler, stages, watchdog

OPTIONS = [{"option_id": "a", "label": "A"}, {"option_id": "b", "label": "B"}]

NODES = [
    # node_id, title, stage, capability, deps
    ("NODE-RESEARCH", "愿望解析与调研", "research", "research", []),
    ("NODE-PRD", "产品规格 PRD", "design", "design_spec", ["NODE-RESEARCH"]),
    ("NODE-CONTRACT", "接口与数据契约", "design", "design_spec", ["NODE-PRD"]),
    ("NODE-DB", "数据库 schema 与迁移", "build", "code_fullstack", ["NODE-CONTRACT"]),
    ("NODE-BACKEND", "后端 API", "build", "code_fullstack", ["NODE-DB"]),
    ("NODE-FRONTEND", "前端页面", "build", "code_fullstack", ["NODE-DB"]),
    ("NODE-INTEGRATION", "集成与构建", "build", "code_fullstack", ["NODE-BACKEND", "NODE-FRONTEND"]),
    ("NODE-AUDIT", "独立审计", "audit", "audit_test", ["NODE-INTEGRATION"]),
    ("NODE-DELIVER", "交付打包", "deliver", "audit_test", ["NODE-AUDIT"]),
]


def _write_artifact(root: Path, node_id: str, text: str) -> tuple[str, str]:
    art_dir = root / "artifacts"
    art_dir.mkdir(parents=True, exist_ok=True)
    p = art_dir / ("%s.txt" % node_id)
    # 写盘字节 = 计算 sha 的字节（write_text 在 Windows 会把 \n 翻成 \r\n → sha 假账）
    data = text.encode("utf-8")
    p.write_bytes(data)
    sha = hashlib.sha256(data).hexdigest()
    return str(p), sha


def _complete(conn, root: Path, node_id: str, owner: str, gate_stage: str) -> None:
    lease = leases.claim(conn, node_id, owner, ttl_sec=600, now=1000)
    evidence.submit(conn, node_id, owner, lease["fencing_token"], now=1001)
    path, sha = _write_artifact(root, node_id, "artifact for %s\n" % node_id)
    evidence.add_artifact(
        conn, artifact_id="ART-%s" % node_id, path=path, sha256=sha, producer_node=node_id
    )
    evidence.add_evidence(
        conn,
        evidence_id="EVD-%s" % node_id,
        node_id=node_id,
        kind="artifact",
        artifact_id="ART-%s" % node_id,
        verifier_id="verifier-ci",
        verdict="pass",
    )
    stages.pass_gate(conn, gate_stage, ["EVD-%s" % node_id])
    result = evidence.finalize(conn, node_id)
    if result["status"] != "done":
        raise RuntimeError("节点未完成：%s -> %s" % (node_id, result))


def run_demo(root: str | Path) -> dict[str, Any]:
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    conn = db.init_db(root / "control_plane.db")
    try:
        # 验证器身份：先注册再产生证据，strict=1 时 demo 也能自洽跑完（不切默认值）
        evidence.register_verifier(
            conn, "verifier-ci", kind="ci", role="ROLE-AUDIT-01"
        )

        # 能力注册
        for name, tools in (
            ("research", ["web"]),
            ("design_spec", ["fs"]),
            ("code_fullstack", ["fs", "shell"]),
            ("audit_test", ["fs", "shell"]),
        ):
            capabilities.register_capability(conn, name=name, description=name, tools=tools)

        # 决策
        decisions.create_decision(
            conn, decision_id="DEC-001", level="L0", question="技术栈？",
            options=OPTIONS, chosen_option_id="a", note="Python + SQLite",
        )
        decisions.create_decision(
            conn, decision_id="DEC-002", level="L1", question="UI 风格？",
            options=OPTIONS, chosen_option_id="a", note="现代简约",
        )
        decisions.create_decision(
            conn, decision_id="DEC-003", level="L2", question="数据库选型？",
            options=OPTIONS, default_option_id="a", timeout_sec=60, now=1000,
            note="默认 SQLite",
        )
        decisions.tick_l2(conn, now=1061)

        # 任务图
        for nid, title, stage, cap, deps in NODES:
            graph.add_node(
                conn,
                node_id=nid,
                title=title,
                spec="产出 %s" % title,
                capability=cap,
                stage=stage,
                deps=deps,
                evidence_required=["artifact"],
                verifier_ids=["verifier-ci"],
                budget={"max_tokens": 100000, "max_cost": 5},
            )
        decisions.create_decision(
            conn, decision_id="DEC-004", level="L3", question="是否发布到外部？",
            options=OPTIONS, impact="high", reversible=False, node_id="NODE-DELIVER",
        )
        scheduler.bootstrap(conn)

        _complete(conn, root, "NODE-RESEARCH", "agent-research", "research")
        _complete(conn, root, "NODE-PRD", "agent-pm", "design")
        _complete(conn, root, "NODE-CONTRACT", "agent-arch", "design")
        _complete(conn, root, "NODE-DB", "agent-db", "build")
        _complete(conn, root, "NODE-BACKEND", "agent-backend", "build")
        _complete(conn, root, "NODE-FRONTEND", "agent-frontend", "build")
        _complete(conn, root, "NODE-INTEGRATION", "agent-integrator", "build")

        # replan：范围变化，补一份文档节点
        stages.apply_replan(
            conn,
            reason="scope_change",
            add=[{
                "node_id": "NODE-DOCS",
                "title": "使用文档",
                "spec": "产出使用文档",
                "capability": "design_spec",
                "stage": "deliver",
                "deps": ["NODE-INTEGRATION"],
                "evidence_required": ["artifact"],
                "verifier_ids": ["verifier-ci"],
            }],
            note="范围变化：补文档",
        )
        scheduler.recompute_ready(conn, reason="replan")

        _complete(conn, root, "NODE-AUDIT", "agent-auditor", "audit")
        decisions.confirm_l3(conn, "DEC-004", "a", note="用户确认发布")
        _complete(conn, root, "NODE-DOCS", "agent-writer", "deliver")
        _complete(conn, root, "NODE-DELIVER", "agent-ops", "deliver")

        scan = watchdog.scan(
            conn, now=2000, limits={"max_depth": 20, "max_parallel": 10, "max_wall_sec": 100000}
        )
        export_dir = root / "export"
        written = capabilities.export_skill_format(conn, export_dir)

        summary = {
            "ok": True,
            "nodes": {n["node_id"]: n["status"] for n in graph.list_nodes(conn)},
            "gates": {g["stage"]: g["status"] for g in stages.list_gates(conn)},
            "decisions": {d["decision_id"]: d["status"] for d in decisions.list_decisions(conn)},
            "graph_version": stages.current_version(conn),
            "events": len(events.iter_events(conn)),
            "watchdog": {"terminated": scan["terminated"], "blocked": scan["blocked"]},
            "export_files": written,
        }
        (root / "summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return summary
    finally:
        conn.close()


if __name__ == "__main__":
    import sys

    out = run_demo(sys.argv[1] if len(sys.argv) > 1 else "out/demo_crud")
    print(json.dumps(out, ensure_ascii=False, indent=2))
