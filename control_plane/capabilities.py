# -*- coding: utf-8 -*-
"""control_plane.capabilities —— 能力注册表 / A2A Agent Card / 人读导出

规则（控制面对齐 A5 / 复用调研）：
  - 注册的是「能力契约」，不是常驻角色；
  - 能力条目 ≈ A2A Agent Card 的 skill；
  - 可把运行时状态导出为管理区风格的人读投影（不是第二事实源）。
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path
from typing import Any

from . import db, decisions, events, graph, stages

NAME_RE = re.compile(r"^[a-z][a-z0-9_]{1,63}$")
SAFE_ID = re.compile(r"[^A-Za-z0-9_-]")


class CapabilityError(Exception):
    pass


def _row(conn: sqlite3.Connection, name: str) -> dict[str, Any] | None:
    r = conn.execute("SELECT * FROM capabilities WHERE name=?", (name,)).fetchone()
    if r is None:
        return None
    return {
        "name": r["name"],
        "description": r["description"],
        "input_contract": db.loads(r["input_contract_json"], {}),
        "output_contract": db.loads(r["output_contract_json"], {}),
        "tools": db.loads(r["tools_json"], []),
        "acceptance_template": db.loads(r["acceptance_template_json"], {}),
        "cost_profile": db.loads(r["cost_profile_json"], {}),
    }


def register_capability(
    conn: sqlite3.Connection,
    *,
    name: str,
    description: str = "",
    input_contract: dict[str, Any] | None = None,
    output_contract: dict[str, Any] | None = None,
    tools: list[str] | None = None,
    acceptance_template: dict[str, Any] | None = None,
    cost_profile: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not NAME_RE.match(name or ""):
        raise CapabilityError("能力名必须匹配 %s：%r" % (NAME_RE.pattern, name))
    existed = _row(conn, name) is not None
    with conn:
        conn.execute(
            "INSERT INTO capabilities(name,description,input_contract_json,output_contract_json,"
            "tools_json,acceptance_template_json,cost_profile_json)"
            " VALUES(?,?,?,?,?,?,?)"
            " ON CONFLICT(name) DO UPDATE SET description=excluded.description,"
            " input_contract_json=excluded.input_contract_json,"
            " output_contract_json=excluded.output_contract_json,"
            " tools_json=excluded.tools_json,"
            " acceptance_template_json=excluded.acceptance_template_json,"
            " cost_profile_json=excluded.cost_profile_json",
            (
                name,
                description,
                db.dumps(input_contract or {}),
                db.dumps(output_contract or {}),
                db.dumps(tools or []),
                db.dumps(acceptance_template or {}),
                db.dumps(cost_profile or {}),
            ),
        )
        events.append_event(
            conn,
            "capability_updated" if existed else "capability_registered",
            None,
            {"name": name, "tools": tools or []},
            commit=False,
        )
    return _row(conn, name)  # type: ignore[return-value]


def get_capability(conn: sqlite3.Connection, name: str) -> dict[str, Any] | None:
    return _row(conn, name)


def list_capabilities(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT name FROM capabilities ORDER BY name").fetchall()
    return [_row(conn, r["name"]) for r in rows]  # type: ignore[misc]


def agent_card(conn: sqlite3.Connection, name: str | None = None) -> dict[str, Any]:
    """生成 A2A 风格的 Agent Card（技能来自能力注册表）。

    每个 skill 额外带职务维度（WP-10 D6）：
      - `roles`：承担该能力的能力职务（来自 `ROLE_CATALOG`，按 `capability` 映射）；
      - `roleKinds`：这些职务的类别（producer / auditor）；
      - `roleMapping`：`capability` = 按能力名命中，`unmapped` = 该能力暂无职务（不猜）。
    刻意**不**输出 `role_count`：数量是 planner 的决策（`plan_formation` 的
    `role_count_default` 只是可覆盖默认值），写进卡就变成硬配额，等 WP-10 定契约。
    """
    caps = [get_capability(conn, name)] if name else list_capabilities(conn)
    caps = [c for c in caps if c]
    if name and not caps:
        raise CapabilityError("能力不存在：%s" % name)
    skills = []
    for c in caps:
        roles = roles_for_capability(c["name"])
        skills.append(
            {
                "id": c["name"],
                "name": c["name"],
                "description": c["description"] or "",
                "tags": list(c["tools"]),
                "roles": roles,
                "roleKinds": role_kinds_of(roles),
                "roleMapping": "capability" if roles else "unmapped",
                "inputModes": ["text/plain"],
                "outputModes": ["application/json"],
                "examples": [],
            }
        )
    return {
        "name": "ai-cluster-control-plane",
        "description": "Wish-driven multi-agent production control plane",
        "version": "0.1.0",
        "capabilities": {"streaming": False, "pushNotifications": False},
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["application/json"],
        "skills": skills,
    }


def _safe(name: str) -> str:
    return SAFE_ID.sub("_", name)


def export_skill_format(conn: sqlite3.Connection, out_dir: str | Path) -> list[str]:
    """导出人读投影：STATE / tasks / INDEX / decisions / capabilities。"""
    root = Path(out_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    tasks_dir = root / "tasks"
    tasks_dir.mkdir(exist_ok=True)
    written: list[str] = []

    nodes = graph.list_nodes(conn)
    gates = stages.list_gates(conn)
    decs = decisions.list_decisions(conn)
    caps = list_capabilities(conn)

    state_lines = [
        "# 控制面快照（导出）",
        "",
        "- 生成时间：%s" % db.now_iso(),
        "- 图版本：%d" % stages.current_version(conn),
        "- 节点数：%d（done=%d / blocked=%d / ready=%d）"
        % (
            len(nodes),
            sum(1 for n in nodes if n["status"] == "done"),
            sum(1 for n in nodes if n["status"] == "blocked"),
            sum(1 for n in nodes if n["status"] == "ready"),
        ),
        "",
        "## 阶段闸门",
        "",
    ]
    state_lines += ["- %s：%s" % (g["stage"], g["status"]) for g in gates] or ["- （无）"]
    (root / "STATE.md").write_text("\n".join(state_lines) + "\n", encoding="utf-8")
    written.append(str(root / "STATE.md"))

    index_lines = [
        "# 节点索引（导出）",
        "",
        "| 编号 | 主题 | 状态 | 阶段 | 能力 |",
        "|---|---|---|---|---|",
    ]
    for n in nodes:
        index_lines.append(
            "| %s | %s | %s | %s | %s |"
            % (n["node_id"], n["title"], n["status"], n["stage"] or "-", n["capability"] or "-")
        )
    (root / "INDEX.md").write_text("\n".join(index_lines) + "\n", encoding="utf-8")
    written.append(str(root / "INDEX.md"))

    for n in nodes:
        card = [
            "# %s 任务卡（导出）" % n["title"],
            "",
            "- 编号：%s" % n["node_id"],
            "- 状态：%s" % n["status"],
            "- 阶段：%s" % (n["stage"] or "-"),
            "- 能力：%s" % (n["capability"] or "-"),
            "- 依赖：%s" % (", ".join(n["deps"]) or "-"),
            "- 承接：%s" % (n["assignee"] or "-"),
            "- 尝试次数：%d" % n["attempts"],
            "- 决策：%s" % (n["decision_id"] or "-"),
            "",
            "## 描述",
            "",
            n["spec"],
            "",
        ]
        p = tasks_dir / ("%s.md" % _safe(n["node_id"]))
        p.write_text("\n".join(card), encoding="utf-8")
        written.append(str(p))

    dec_lines = ["# 决策账本（导出）", "", "| 决策 | 层级 | 状态 | 默认 | 选择 | 可逆 |", "|---|---|---|---|---|---|"]
    for d in decs:
        dec_lines.append(
            "| %s | %s | %s | %s | %s | %s |"
            % (d["decision_id"], d["level"], d["status"], d["default_option_id"] or "-",
               d["chosen_option_id"] or "-", "是" if d["reversible"] else "否")
        )
    (root / "decisions.md").write_text("\n".join(dec_lines) + "\n", encoding="utf-8")
    written.append(str(root / "decisions.md"))

    cap_lines = ["# 能力注册表（导出）", "", "| 能力 | 描述 | 工具 |", "|---|---|---|"]
    for c in caps:
        cap_lines.append("| %s | %s | %s |" % (c["name"], c["description"] or "-", ", ".join(c["tools"]) or "-"))
    (root / "capabilities.md").write_text("\n".join(cap_lines) + "\n", encoding="utf-8")
    written.append(str(root / "capabilities.md"))

    return written


# ═══════════════════════════════════════════════════════════════════════════
# 职务目录 / 编队 / 审计独立（TASK-20261029-65B648，Root R8）
#
# 口径（用户 2026-10-29 拍板 + 设计卡 Root编排与控制面 §6）：
#   - 派发的是**能力职务**，不是具体 Agent；职务可重复、可复合；
#   - 实例 ID 固定 `ROLE-<职务>-<序号>`（两位起，如 ROLE-CODE-03）；
#   - 任务图节点声明所需职务与数量：`capability` + 可选 `role_count`；
#   - `role_count_default` 是 planner 可覆盖的**默认值**，不是硬配额；
#   - 同一产物的生产职务与审计职务不得由同一实例承担（复合实例含审计职务时同样禁止）。
#
# 本段只加函数与常量：不改 db.py 表结构、不改 graph.py 状态机，
# 编队变更以 replan_events 行 + `formation_changed` 事件留痕，可回放。
# ═══════════════════════════════════════════════════════════════════════════

ROLE_ID_RE = re.compile(r"^ROLE-([A-Z][A-Z0-9_]*)-(\d{2,})$")

ROLE_KIND_PRODUCER = "producer"
ROLE_KIND_AUDITOR = "auditor"

#: 8 个生产（编码）职务
PRODUCER_ROLES: tuple[str, ...] = (
    "CODE",
    "TEST",
    "DESIGN",
    "EVIDENCE",
    "RUNTIME",
    "DOC",
    "INTEGRATION",
    "RESEARCH",
)

#: 3 个审计职务
AUDITOR_ROLES: tuple[str, ...] = ("AUDIT_CODE", "AUDIT_EVIDENCE", "AUDIT_DESIGN")

#: 职务目录：kind / title / capability / audits（审计职务覆盖哪些生产职务）/ 默认权重
ROLE_CATALOG: dict[str, dict[str, Any]] = {
    "CODE": {"kind": ROLE_KIND_PRODUCER, "title": "实现", "capability": "code", "audits": (), "weight": 1.0},
    "TEST": {"kind": ROLE_KIND_PRODUCER, "title": "测试", "capability": "test", "audits": (), "weight": 1.0},
    "DESIGN": {"kind": ROLE_KIND_PRODUCER, "title": "设计契约", "capability": "design", "audits": (), "weight": 1.0},
    "EVIDENCE": {"kind": ROLE_KIND_PRODUCER, "title": "证据与产物", "capability": "evidence", "audits": (), "weight": 1.0},
    "RUNTIME": {"kind": ROLE_KIND_PRODUCER, "title": "运行时驱动", "capability": "runtime", "audits": (), "weight": 1.0},
    "DOC": {"kind": ROLE_KIND_PRODUCER, "title": "文档与导出", "capability": "doc", "audits": (), "weight": 0.8},
    "INTEGRATION": {"kind": ROLE_KIND_PRODUCER, "title": "集成", "capability": "integration", "audits": (), "weight": 1.2},
    "RESEARCH": {"kind": ROLE_KIND_PRODUCER, "title": "调研", "capability": "research", "audits": (), "weight": 0.8},
    "AUDIT_CODE": {
        "kind": ROLE_KIND_AUDITOR,
        "title": "代码审计",
        "capability": "audit",
        "audits": ("CODE", "TEST", "RUNTIME", "INTEGRATION"),
        "weight": 0.5,
    },
    "AUDIT_EVIDENCE": {
        "kind": ROLE_KIND_AUDITOR,
        "title": "证据审计",
        "capability": "audit",
        "audits": ("EVIDENCE", "TEST", "DOC"),
        "weight": 0.5,
    },
    "AUDIT_DESIGN": {
        "kind": ROLE_KIND_AUDITOR,
        "title": "设计审计",
        "capability": "audit",
        "audits": ("DESIGN", "EVIDENCE", "DOC", "RESEARCH"),
        "weight": 0.5,
    },
}

#: 复合模板：一个实例可承担的职务集合（可再叠加，planner 决定是否使用）
COMPOSITE_TEMPLATES: dict[str, tuple[str, ...]] = {
    "FULLSTACK": ("CODE", "TEST"),
    "WRITER": ("CODE", "DOC"),
    "REVIEWER": ("AUDIT_CODE", "AUDIT_EVIDENCE"),
    "TRIAD": ("CODE", "TEST", "EVIDENCE"),
}


def role_kind(role: str) -> str:
    info = ROLE_CATALOG.get(role)
    if info is None:
        raise CapabilityError("未知职务：%s" % role)
    return info["kind"]


def list_roles(kind: str | None = None) -> list[dict[str, Any]]:
    """列职务目录（可按 producer / auditor 过滤）。"""
    out = []
    for name, info in ROLE_CATALOG.items():
        if kind is not None and info["kind"] != kind:
            continue
        out.append({"role": name, **info})
    return sorted(out, key=lambda row: row["role"])


def roles_for_capability(capability: str) -> list[str]:
    """按能力名映射到承担它的职务集（Agent Card 的 `roles` 字段用）。

    只按 `ROLE_CATALOG[*]['capability']` 精确匹配；匹配不到返回空列表，
    **不做模糊猜测**——宁可标 `unmapped`，也不给卡塞一个错的职务。
    """
    target = str(capability or "").strip().lower()
    if not target:
        return []
    return sorted(name for name, info in ROLE_CATALOG.items() if info["capability"] == target)


def role_kinds_of(roles: list[str] | tuple[str, ...]) -> list[str]:
    """一组职务的类别集（排序去重）。未知职务忽略。"""
    kinds = {ROLE_CATALOG[r]["kind"] for r in roles if r in ROLE_CATALOG}
    return sorted(kinds)


def instance_id(role: str, index: int) -> str:
    """`ROLE-<职务>-<序号>`，序号两位起。"""
    role_kind(role)  # 校验存在
    if int(index) < 1:
        raise CapabilityError("实例序号从 1 起：%r" % index)
    return "ROLE-%s-%02d" % (role.upper(), int(index))


def parse_instance_id(value: str) -> tuple[str, int]:
    m = ROLE_ID_RE.match(value or "")
    if not m:
        raise CapabilityError("实例 ID 非法：%r（应形如 ROLE-CODE-01）" % value)
    role, index = m.group(1), int(m.group(2))
    if role not in ROLE_CATALOG:
        raise CapabilityError("未知职务：%s" % role)
    return role, index


def roles_of_instance(instance: dict[str, Any]) -> tuple[str, ...]:
    """实例的角色集：单职务用 `role`，复合用 `roles`（两者可并存）。"""
    roles: list[str] = []
    if instance.get("role"):
        roles.append(str(instance["role"]).upper())
    for role in instance.get("roles") or ():
        role = str(role).upper()
        if role not in roles:
            roles.append(role)
    return tuple(roles)


def is_auditor_instance(instance: dict[str, Any]) -> bool:
    return any(role_kind(role) == ROLE_KIND_AUDITOR for role in roles_of_instance(instance))


def plan_formation(
    *,
    task_units: int,
    roles: list[str] | tuple[str, ...] | None = None,
    role_count_default: int = 1,
    budget_tokens: int = 0,
    max_parallel: int = 0,
    tokens_per_unit: int = 20000,
    composite: list[str] | None = None,
) -> dict[str, Any]:
    """planner 编队决策：按任务量 / 预算 / 并发决定每个职务的实例数。

    - `role_count_default` 只是默认值，可被本函数上调/下调（不是硬配额）；
    - 生产职务按任务量与权重分配实例，总实例数受 `max_parallel` 限制；
    - 审计职务默认每职务 1 个（与生产实例严格分离，见 `audit_independence_violations`）；
    - 预算不足时优先砍生产实例数到 1，审计实例保持（fail-closed：宁慢不可省审计）。
    """
    if task_units < 1:
        raise CapabilityError("task_units 至少 1：%r" % task_units)
    wanted = list(roles or PRODUCER_ROLES[:1])
    composites = list(composite or [])
    for name in wanted + composites:
        if name in COMPOSITE_TEMPLATES:
            for member in COMPOSITE_TEMPLATES[name]:
                role_kind(member)
        elif name not in ROLE_CATALOG:
            raise CapabilityError("未知职务或模板：%s" % name)

    default = max(1, int(role_count_default))
    producer_names = [r for r in wanted if r in ROLE_CATALOG and role_kind(r) == ROLE_KIND_PRODUCER]
    auditor_names = [r for r in wanted if r in ROLE_CATALOG and role_kind(r) == ROLE_KIND_AUDITOR]
    template_names = [r for r in wanted if r in COMPOSITE_TEMPLATES]

    parallel_cap = int(max_parallel) if max_parallel else 0
    budget_left = int(budget_tokens or 0)
    rationale: list[str] = []

    # 生产职务：默认值 × 任务量/权重，受并发上限约束
    plan: list[dict[str, Any]] = []
    for role in producer_names:
        weight = float(ROLE_CATALOG[role]["weight"])
        desired = default
        if task_units > default:
            desired = max(default, int(round(task_units * weight / 4.0)))
        rationale.append("%s：task_units=%d weight=%.1f default=%d → 期望 %d" % (role, task_units, weight, default, desired))
        plan.append({"role": role, "kind": ROLE_KIND_PRODUCER, "desired": desired, "count": desired})

    # 复合模板：一个实例承担多职务，算 1 个实例
    for template in template_names:
        plan.append(
            {
                "role": template,
                "kind": "composite",
                "roles": list(COMPOSITE_TEMPLATES[template]),
                "desired": default,
                "count": default,
            }
        )
        rationale.append("%s：复合模板 %s，按默认 %d" % (template, ",".join(COMPOSITE_TEMPLATES[template]), default))

    # 审计职务：默认每职务 1 个
    for role in auditor_names:
        plan.append({"role": role, "kind": ROLE_KIND_AUDITOR, "desired": 1, "count": 1})
        rationale.append("%s：审计职务固定 1（不随任务量放大，避免自我审计）" % role)

    total = sum(item["count"] for item in plan)

    # 并发约束：超出则按比例下调生产/复合实例（审计不砍）
    if parallel_cap and total > parallel_cap:
        reducible = [item for item in plan if item["kind"] != ROLE_KIND_AUDITOR]
        overflow = total - parallel_cap
        for item in sorted(reducible, key=lambda row: row["count"], reverse=True):
            if overflow <= 0:
                break
            cut = min(overflow, item["count"] - 1)
            if cut > 0:
                item["count"] -= cut
                overflow -= cut
                rationale.append("%s：并发上限 %d，削减 %d 个实例" % (item["role"], parallel_cap, cut))
        total = sum(item["count"] for item in plan)

    # 预算约束：估算成本超预算则把生产实例压到 1，审计保持
    estimated = total * int(tokens_per_unit) * max(1, task_units)
    if budget_left and estimated > budget_left:
        before = total
        for item in plan:
            if item["kind"] != ROLE_KIND_AUDITOR and item["count"] > 1:
                item["count"] = 1
        total = sum(item["count"] for item in plan)
        estimated = total * int(tokens_per_unit) * max(1, task_units)
        rationale.append("预算 %d < 估算 %d：生产实例压到 1（审计保留），%d → %d" % (budget_left, estimated, before, total))

    for item in plan:
        item["instance_ids"] = [instance_id(item["role"], i + 1) for i in range(item["count"])]

    return {
        "plan": plan,
        "total_instances": total,
        "parallel_cap": parallel_cap,
        "budget_tokens": budget_left,
        "estimated_tokens": estimated,
        "role_count_default": default,
        "producers": [item["role"] for item in plan if item["kind"] == ROLE_KIND_PRODUCER],
        "auditors": [item["role"] for item in plan if item["kind"] == ROLE_KIND_AUDITOR],
        "composites": template_names,
        "rationale": rationale,
    }


def validate_formation(plan: dict[str, Any]) -> list[str]:
    """校验编队计划：ID 唯一、序号连续、审计职务可枚举。返回问题列表（空=通过）。"""
    issues: list[str] = []
    seen: dict[str, str] = {}
    for item in plan.get("plan", []):
        ids = item.get("instance_ids") or []
        if item.get("kind") == ROLE_KIND_AUDITOR and len(ids) != 1:
            issues.append("审计职务 %s 必须恰好 1 个实例，实际 %d" % (item["role"], len(ids)))
        for i, value in enumerate(ids, start=1):
            if value in seen:
                issues.append("实例 ID 重复：%s（%s 与 %s）" % (value, seen[value], item["role"]))
            seen[value] = item["role"]
            expected = instance_id(item["role"], i) if item["role"] in ROLE_CATALOG else None
            if expected and value != expected:
                issues.append("实例 ID 与序号不符：%s ≠ %s" % (value, expected))
    if plan.get("total_instances") != len(seen):
        issues.append("total_instances=%r 与实际实例数 %d 不一致" % (plan.get("total_instances"), len(seen)))
    return issues


def audit_independence_violations(
    assignments: list[dict[str, Any]],
    roles_by_instance: dict[str, tuple[str, ...] | list[str]] | None = None,
) -> list[str]:
    """机检审计独立。

    `assignments` 每项：`{"node_id", "producer": <instance_id>, "auditors": [<instance_id>, ...]}`。
    规则（任一违反即返回问题；调用方按 fail-closed 拒绝）：
      1. 同一节点的 producer 不得出现在 auditors 中（同实例自审）；
      2. `roles_by_instance` 存在时，含审计职务的实例不得同时是该节点 producer（复合实例也算）。
    """
    issues: list[str] = []
    roles_by_instance = roles_by_instance or {}
    for row in assignments:
        node = row.get("node_id") or "?"
        producer = row.get("producer")
        auditors = list(row.get("auditors") or [])
        if not producer:
            issues.append("%s：缺 producer" % node)
        if not auditors:
            issues.append("%s：缺 auditor（不得免审计）" % node)
        for auditor in auditors:
            if producer and auditor == producer:
                issues.append("%s：生产与审计同实例 %s" % (node, producer))
        producer_roles = [str(r).upper() for r in (roles_by_instance.get(producer) or ())] if producer else []
        if any(ROLE_CATALOG.get(r, {}).get("kind") == ROLE_KIND_AUDITOR for r in producer_roles):
            issues.append(
                "%s：复合实例 %s 含审计职务（%s），不得同时充当该节点生产者"
                % (node, producer, ",".join(producer_roles))
            )
    return issues


def assert_audit_independent(
    assignments: list[dict[str, Any]],
    roles_by_instance: dict[str, Any] | None = None,
) -> None:
    issues = audit_independence_violations(assignments, roles_by_instance)
    if issues:
        raise CapabilityError("审计独立被违反：" + "；".join(issues))


def formation_snapshot(instances: list[dict[str, Any]]) -> dict[str, Any]:
    """编队快照（可回放）：按 instance_id 排序，含角色集与职务类别。"""
    rows = []
    for item in sorted(instances, key=lambda row: str(row.get("instance_id"))):
        iid = str(item.get("instance_id"))
        roles = roles_of_instance(item)
        rows.append(
            {
                "instance_id": iid,
                "roles": list(roles),
                "kinds": sorted({ROLE_CATALOG[r]["kind"] for r in roles if r in ROLE_CATALOG}),
                "status": item.get("status"),
                "session_id": item.get("session_id"),
            }
        )
    return {"count": len(rows), "instances": rows, "composite": [r["instance_id"] for r in rows if len(r["roles"]) > 1]}


def record_formation_change(
    conn: sqlite3.Connection,
    before: list[dict[str, Any]],
    after: list[dict[str, Any]],
    *,
    note: str = "",
) -> dict[str, Any]:
    """编队变更留痕：写 `replan_events` 行 + `formation_changed` 事件（可回放）。

    约定：reason 固定 `formation`；`added_json` / `removed_json` 存实例 ID；
    `graph_version` 取当前图版本（**不 bump**：编队不是图变更，图版本归 A 的写域）。
    """
    before_ids = {str(row.get("instance_id")) for row in before}
    after_ids = {str(row.get("instance_id")) for row in after}
    added = sorted(after_ids - before_ids)
    removed = sorted(before_ids - after_ids)
    version = graph.current_graph_version(conn)
    row = conn.execute("SELECT COUNT(*) AS c FROM replan_events WHERE event_id LIKE 'EVT-F%'").fetchone()
    seq = int(row["c"]) + 1
    event_id = "EVT-F%04d" % seq
    ts = db.now_iso()
    with conn:
        conn.execute(
            "INSERT INTO replan_events(event_id,at,reason,graph_version,added_json,removed_json,note)"
            " VALUES(?,?,?,?,?,?,?)",
            (event_id, ts, "formation", version, db.dumps(added), db.dumps(removed), note),
        )
        events.append_event(
            conn,
            "formation_changed",
            None,
            {"event_id": event_id, "added": added, "removed": removed, "note": note},
            commit=False,
        )
    return {
        "event_id": event_id,
        "at": ts,
        "reason": "formation",
        "graph_version": version,
        "added": added,
        "removed": removed,
        "note": note,
        "snapshot": formation_snapshot(after),
    }
