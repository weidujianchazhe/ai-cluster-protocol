# -*- coding: utf-8 -*-
"""control_plane.evidence —— 证据、提交、done 事务、驳回回到 ready

规则（Root 卡 / L0 细化 §2 / §7 / §10；任务卡 TASK-20261029-3406F3）：
  - **append-only**：同 `evidence_id` / `artifact_id` 再写一次直接报错（不覆盖、不先删后插）；
    `evidence` / `artifacts` / `evidence_attempts` 上另有 SQLite 触发器兜底，UPDATE/DELETE 一律
    `RAISE(ABORT)`；
  - **attempt 历史保留**：每次证据提交（含被拒重复、非法 verdict、跨节点复用被拒）与每次
    finalize 结果都追加一行 `evidence_attempts`，`attempt_no` 取节点当前 attempts+1；
  - **artifact 归属**：`producer_node` 必须等于引用节点；跨节点引用只允许在 artifact 带
    `a2a_artifact_id`（显式 A2A 交接）时发生，并写 `artifact_uses` 留痕；
  - **path/sha 复核**：`verify_artifact()` 重算文件 sha256 并与登记值比对，结果落
    `artifact_checks`；strict 模式下 finalize 会复核，坏 artifact 不得 done；
  - **验证器身份钩子**：`register_verifier()` / `set_identity_hook()` 决定 verifier 是否可解析；
    解析不出身份的 verifier 在 strict 模式下被拒（`verifier_unregistered`），permissive 模式
    只记 `identity='unregistered'`；
  - **unknown fail-closed**：`verdict='unknown'` 在两种模式下都不能完成节点，finalize 报
    `evidence_unknown`；
  - `done` 只能由证据事务触发：证据非空、全部 pass、覆盖 evidence_required、
    artifact 存在且（strict）复核通过、验证器在允许清单内、依赖全部 done；
  - 生产 Agent 的 finish 最多到 submitted；验证由 finalize 完成；
  - 驳回 → `ready`（attempts+1），原因留痕；
  - done 后由 scheduler 的 done 事件解锁下游。
"""

from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path
from typing import Any, Callable

from . import db, events, graph, leases, scheduler, stages

VERDICTS = ("pass", "fail", "unknown")

#: 身份钩子签名：hook(conn, verifier_id) -> dict | None
#: 返回 dict 视为已解析（至少含 'identity'），返回 None 视为解析不出身份。
IdentityHook = Callable[[sqlite3.Connection, str], "dict[str, Any] | None"]

_IDENTITY_HOOK: IdentityHook | None = None


class EvidenceError(Exception):
    """证据/产物相关错误基类。"""


class ArtifactError(EvidenceError):
    pass


class ArtifactImmutable(EvidenceError):
    """同 ID 产物已登记且不可覆盖。"""


class DuplicateEvidence(EvidenceError):
    """同 ID 证据已存在且不可覆盖。"""


class CrossNodeArtifact(EvidenceError):
    """产物属于别的节点，且没有 A2A 交接声明。"""


class NodeTerminal(EvidenceError):
    """节点已终态（done），strict 模式下不再接受新证据。"""


class UnknownVerifier(EvidenceError):
    """验证器身份解析不出（未注册 / 已撤销 / 钩子失败）：strict 模式在写入前拒绝。"""


# ---------------------------------------------------------------------------
# 身份钩子 / 验证器注册
# ---------------------------------------------------------------------------


def set_identity_hook(hook: IdentityHook | None) -> None:
    """安装全局身份解析钩子（进程级；None 表示只用 `verifiers` 注册表）。"""
    global _IDENTITY_HOOK
    _IDENTITY_HOOK = hook


def get_identity_hook() -> IdentityHook | None:
    return _IDENTITY_HOOK


def register_verifier(
    conn: sqlite3.Connection,
    verifier_id: str,
    *,
    kind: str | None = None,
    role: str | None = None,
    identity: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """注册验证器身份（幂等）。

    留给 `capabilities.py` 的最小钩子：D 的职务编队按 `role`（如 ROLE-CODE-03）注册验证器后，
    这里的 `resolve_verifier()` 就能解析出身份，`finalize()` 在 strict 模式下才放行。
    本 lane 不改 `capabilities.py` 本体，D 侧直接调用：

        evidence.register_verifier(conn, "verifier-role-code-03", kind="role", role="ROLE-CODE-03")
    """
    if not verifier_id:
        raise EvidenceError("verifier_id 不能为空")
    ts = db.now_iso()
    row = conn.execute("SELECT * FROM verifiers WHERE verifier_id=?", (verifier_id,)).fetchone()
    with conn:
        if row is None:
            conn.execute(
                "INSERT INTO verifiers(verifier_id,kind,role,identity_json,active,created_at)"
                " VALUES(?,?,?,?,1,?)",
                (verifier_id, kind, role, db.dumps(identity or {}), ts),
            )
            events.append_event(
                conn, "verifier_registered", None,
                {"verifier_id": verifier_id, "kind": kind, "role": role, "at": ts}, commit=False,
            )
        else:
            conn.execute(
                "UPDATE verifiers SET kind=COALESCE(?, kind), role=COALESCE(?, role),"
                " identity_json=?, active=1, revoked_at=NULL WHERE verifier_id=?",
                (kind, role, db.dumps(identity or db.loads(row["identity_json"], {})), verifier_id),
            )
    return get_verifier(conn, verifier_id)


def revoke_verifier(conn: sqlite3.Connection, verifier_id: str) -> None:
    ts = db.now_iso()
    with conn:
        conn.execute(
            "UPDATE verifiers SET active=0, revoked_at=? WHERE verifier_id=?", (ts, verifier_id)
        )
        events.append_event(
            conn, "verifier_revoked", None, {"verifier_id": verifier_id, "at": ts}, commit=False
        )


def get_verifier(conn: sqlite3.Connection, verifier_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM verifiers WHERE verifier_id=?", (verifier_id,)).fetchone()
    if row is None:
        return None
    return {
        "verifier_id": row["verifier_id"],
        "kind": row["kind"],
        "role": row["role"],
        "identity": db.loads(row["identity_json"], {}),
        "active": bool(row["active"]),
        "created_at": row["created_at"],
        "revoked_at": row["revoked_at"],
    }


def resolve_verifier(conn: sqlite3.Connection, verifier_id: str) -> dict[str, Any]:
    """解析验证器身份（钩子 → 注册表）。

    返回 {verifier_id, resolved, identity, source, active, role}
      - source='hook'   ：身份钩子解析成功
      - source='table'  ：注册表里有 active=1 的行
      - source=None     ：解析不出（strict 模式下 finalize 拒绝）
    """
    result: dict[str, Any] = {
        "verifier_id": verifier_id,
        "resolved": False,
        "identity": None,
        "source": None,
        "active": None,
        "role": None,
    }
    hook = _IDENTITY_HOOK
    if hook is not None:
        try:
            got = hook(conn, verifier_id)
        except Exception:  # 钩子故障 → 视为解析不出（fail-closed）
            got = None
        if got:
            result.update(
                resolved=True,
                identity=got.get("identity", verifier_id),
                source="hook",
                active=bool(got.get("active", True)),
                role=got.get("role"),
            )
            if not result["active"]:
                result["resolved"] = False
            return result
    row = get_verifier(conn, verifier_id)
    if row is not None and row["active"]:
        result.update(
            resolved=True,
            identity=row["identity"] or {"verifier_id": verifier_id},
            source="table",
            active=True,
            role=row["role"],
        )
    return result


# ---------------------------------------------------------------------------
# 产物
# ---------------------------------------------------------------------------


def sha256_file(path: str | Path, *, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def get_artifact(conn: sqlite3.Connection, artifact_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM artifacts WHERE artifact_id=?", (artifact_id,)).fetchone()
    if row is None:
        return None
    return {
        "artifact_id": row["artifact_id"],
        "path": row["path"],
        "sha256": row["sha256"],
        "producer_node": row["producer_node"],
        "verifier_ids": db.loads(row["verifier_ids_json"], []),
        "a2a_artifact_id": row["a2a_artifact_id"],
        "sha_algo": row["sha_algo"],
        "note": row["note"],
        "created_at": row["created_at"],
    }


def list_artifacts(conn: sqlite3.Connection, node_id: str | None = None) -> list[dict[str, Any]]:
    if node_id is None:
        rows = conn.execute("SELECT artifact_id FROM artifacts ORDER BY created_at, artifact_id").fetchall()
    else:
        rows = conn.execute(
            "SELECT artifact_id FROM artifacts WHERE producer_node=? ORDER BY created_at, artifact_id",
            (node_id,),
        ).fetchall()
    return [get_artifact(conn, r["artifact_id"]) for r in rows]  # type: ignore[misc]


def add_artifact(
    conn: sqlite3.Connection,
    *,
    artifact_id: str,
    path: str,
    sha256: str,
    producer_node: str,
    verifier_ids: list[str] | None = None,
    a2a_artifact_id: str | None = None,
    sha_algo: str = "sha256",
    note: str | None = None,
) -> dict[str, Any]:
    """登记产物（append-only）。同 ID 再登记直接报错，不覆盖。"""
    if len(sha256) != 64:
        raise ArtifactError("sha256 必须是 64 位十六进制：%s" % artifact_id)
    existing = get_artifact(conn, artifact_id)
    if existing is not None:
        raise ArtifactImmutable(
            "产物已登记且不可覆盖：%s（既有 sha=%s path=%s）"
            % (artifact_id, existing["sha256"], existing["path"])
        )
    if graph.get_node(conn, producer_node) is None:
        raise ArtifactError("producer 节点不存在：%s" % producer_node)
    if sha_algo != "sha256":
        raise ArtifactError("暂只支持 sha256：%s" % sha_algo)
    ts = db.now_iso()
    with conn:
        conn.execute(
            "INSERT INTO artifacts(artifact_id,path,sha256,producer_node,verifier_ids_json,"
            "a2a_artifact_id,sha_algo,note,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            (
                artifact_id,
                path,
                sha256,
                producer_node,
                db.dumps(verifier_ids or []),
                a2a_artifact_id,
                sha_algo,
                note,
                ts,
            ),
        )
        events.append_event(
            conn, "artifact_added", producer_node,
            {
                "artifact_id": artifact_id,
                "path": path,
                "sha256": sha256,
                "a2a_artifact_id": a2a_artifact_id,
            },
            commit=False,
        )
    return get_artifact(conn, artifact_id)  # type: ignore[return-value]


def verify_artifact(
    conn: sqlite3.Connection,
    artifact_id: str,
    *,
    root: str | Path | None = None,
    node_id: str | None = None,
) -> dict[str, Any]:
    """复核 artifact 的 path 与 sha256，结果追加到 `artifact_checks`。

    返回 {ok, reason, artifact_id, expected_sha256, actual_sha256, actual_path, owned}
      reason ∈ {None,'artifact_missing_row','unsupported_algo','path_outside_root',
                'path_missing','not_a_file','sha_mismatch','cross_node'}
    """
    art = get_artifact(conn, artifact_id)
    result: dict[str, Any] = {
        "artifact_id": artifact_id,
        "ok": False,
        "reason": None,
        "expected_sha256": None,
        "actual_sha256": None,
        "actual_path": None,
        "owned": False,
    }
    if art is None:
        result["reason"] = "artifact_missing_row"
        _record_check(conn, result, node_id=node_id)
        return result

    result["expected_sha256"] = art["sha256"]
    result["owned"] = node_id is None or art["producer_node"] == node_id
    raw_path = Path(art["path"])
    actual = raw_path

    if art["sha_algo"] != "sha256":
        result["reason"] = "unsupported_algo"
        _record_check(conn, result, node_id=node_id)
        return result

    if root is not None:
        try:
            base = Path(root).resolve(strict=False)
            resolved = raw_path.resolve(strict=False)
        except OSError:
            result["reason"] = "path_outside_root"
            _record_check(conn, result, node_id=node_id)
            return result
        if not _is_within(resolved, base):
            result["reason"] = "path_outside_root"
            _record_check(conn, result, node_id=node_id)
            return result
        actual = resolved

    result["actual_path"] = str(actual)

    if not actual.exists():
        result["reason"] = "path_missing"
        _record_check(conn, result, node_id=node_id)
        return result
    if not actual.is_file():
        result["reason"] = "not_a_file"
        _record_check(conn, result, node_id=node_id)
        return result

    try:
        digest = sha256_file(actual)
    except OSError:
        result["reason"] = "path_missing"
        _record_check(conn, result, node_id=node_id)
        return result

    result["actual_sha256"] = digest
    if digest.lower() != art["sha256"].lower():
        result["reason"] = "sha_mismatch"
        _record_check(conn, result, node_id=node_id)
        return result

    if not result["owned"] and not art["a2a_artifact_id"]:
        result["reason"] = "cross_node"
        _record_check(conn, result, node_id=node_id)
        return result

    result["ok"] = True
    _record_check(conn, result, node_id=node_id)
    return result


def _is_within(path: Path, base: Path) -> bool:
    try:
        path.relative_to(base)
        return True
    except ValueError:
        return False


def _record_check(
    conn: sqlite3.Connection, result: dict[str, Any], *, node_id: str | None
) -> None:
    ts = db.now_iso()
    with conn:
        conn.execute(
            "INSERT INTO artifact_checks(artifact_id,node_id,ok,actual_path,actual_sha256,reason,at)"
            " VALUES(?,?,?,?,?,?,?)",
            (
                result["artifact_id"],
                node_id,
                1 if result["ok"] else 0,
                result.get("actual_path"),
                result.get("actual_sha256"),
                result.get("reason"),
                ts,
            ),
        )


def list_artifact_checks(
    conn: sqlite3.Connection, artifact_id: str
) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM artifact_checks WHERE artifact_id=? ORDER BY seq", (artifact_id,)
    ).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# 证据
# ---------------------------------------------------------------------------


def _attempt_no(conn: sqlite3.Connection, node_id: str) -> int:
    row = conn.execute("SELECT attempts FROM tasks WHERE node_id=?", (node_id,)).fetchone()
    return int(row["attempts"]) + 1 if row else 1


def _record_attempt(
    conn: sqlite3.Connection,
    *,
    evidence_id: str,
    node_id: str | None,
    kind: str | None,
    artifact_id: str | None,
    verifier_id: str | None,
    verdict: str | None,
    outcome: str,
    reason: str | None = None,
    detail: dict[str, Any] | None = None,
    attempt_no: int = 0,
    at: str | None = None,
) -> None:
    """追加一条 attempt 历史（append-only；被拒的提交同样留痕）。"""
    conn.execute(
        "INSERT INTO evidence_attempts(evidence_id,node_id,kind,artifact_id,verifier_id,verdict,"
        "attempt_no,outcome,reason,at,detail_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (
            evidence_id,
            node_id,
            kind,
            artifact_id,
            verifier_id,
            verdict,
            attempt_no,
            outcome,
            reason,
            at or db.now_iso(),
            db.dumps(detail or {}),
        ),
    )


def add_evidence(
    conn: sqlite3.Connection,
    *,
    evidence_id: str,
    node_id: str,
    kind: str,
    artifact_id: str,
    verifier_id: str,
    verdict: str,
    at: str | None = None,
    identity: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """登记一条证据（append-only）。同 ID 覆盖 → DuplicateEvidence；跨节点复用 → CrossNodeArtifact。"""
    at = at or db.now_iso()
    attempt_no = _attempt_no(conn, node_id)

    def _reject(exc: Exception, *, outcome: str, reason: str) -> None:
        with conn:
            _record_attempt(
                conn,
                evidence_id=evidence_id,
                node_id=node_id,
                kind=kind,
                artifact_id=artifact_id,
                verifier_id=verifier_id,
                verdict=verdict if verdict in VERDICTS else None,
                outcome=outcome,
                reason=reason,
                attempt_no=attempt_no,
                at=at,
            )
        raise exc

    if verdict not in VERDICTS:
        _reject(EvidenceError("非法 verdict：%s" % verdict), outcome="rejected_invalid", reason="bad_verdict")

    node = graph.get_node(conn, node_id)
    if node is None:
        _reject(EvidenceError("节点不存在：%s" % node_id), outcome="rejected_invalid", reason="no_node")
    if db.evidence_strict(conn) and node["status"] == "done":
        _reject(
            NodeTerminal("节点已 done，strict 模式拒绝追加证据：%s" % node_id),
            outcome="rejected_terminal",
            reason="node_terminal",
        )

    if conn.execute("SELECT 1 FROM evidence WHERE evidence_id=?", (evidence_id,)).fetchone():
        _reject(
            DuplicateEvidence("证据已存在且不可覆盖：%s" % evidence_id),
            outcome="rejected_duplicate",
            reason="duplicate_evidence",
        )

    art = get_artifact(conn, artifact_id)
    if art is None:
        _reject(
            EvidenceError("artifact 不存在：%s" % artifact_id),
            outcome="rejected_invalid",
            reason="no_artifact",
        )

    via = "local"
    if art["producer_node"] != node_id:
        # 跨节点复用：只有显式 A2A 交接（artifact 带 a2a_artifact_id）才放行
        if not art["a2a_artifact_id"]:
            _reject(
                CrossNodeArtifact(
                    "产物 %s 属于 %s，不是 %s，且没有 A2A 交接声明"
                    % (artifact_id, art["producer_node"], node_id)
                ),
                outcome="rejected_cross_node",
                reason="cross_node_artifact",
            )
        via = "a2a:%s" % art["a2a_artifact_id"]

    resolved = resolve_verifier(conn, verifier_id)
    # strict：身份解析不出 → **写入前**拒绝，不留脏证据（permissive 只记 identity=unregistered）
    if db.evidence_strict(conn) and not resolved["resolved"]:
        _reject(
            UnknownVerifier(
                "验证器身份不可解析（未注册 / 已撤销 / 钩子失败）：%s" % verifier_id
            ),
            outcome="rejected_unregistered",
            reason="verifier_unregistered",
        )
    recorded_identity = db.dumps(identity) if identity else (
        db.dumps(resolved["identity"]) if resolved["resolved"] else "unregistered"
    )
    with conn:
        conn.execute(
            "INSERT INTO evidence(evidence_id,node_id,kind,artifact_id,verifier_id,verdict,"
            "attempt_no,identity,at) VALUES(?,?,?,?,?,?,?,?,?)",
            (
                evidence_id,
                node_id,
                kind,
                artifact_id,
                verifier_id,
                verdict,
                attempt_no,
                recorded_identity,
                at,
            ),
        )
        if via != "local":
            conn.execute(
                "INSERT INTO artifact_uses(artifact_id,node_id,evidence_id,via,at) VALUES(?,?,?,?,?)",
                (artifact_id, node_id, evidence_id, via, at),
            )
        _record_attempt(
            conn,
            evidence_id=evidence_id,
            node_id=node_id,
            kind=kind,
            artifact_id=artifact_id,
            verifier_id=verifier_id,
            verdict=verdict,
            outcome="accepted",
            reason=None,
            attempt_no=attempt_no,
            at=at,
            detail={"identity": recorded_identity, "via": via},
        )
        events.append_event(
            conn, "evidence_added", node_id,
            {
                "evidence_id": evidence_id,
                "kind": kind,
                "verdict": verdict,
                "verifier_id": verifier_id,
                "attempt_no": attempt_no,
            },
            commit=False,
        )
    return {
        "evidence_id": evidence_id,
        "node_id": node_id,
        "kind": kind,
        "artifact_id": artifact_id,
        "verifier_id": verifier_id,
        "verdict": verdict,
        "attempt_no": attempt_no,
        "identity": recorded_identity,
        "via": via,
        "at": at,
    }


def list_evidence(conn: sqlite3.Connection, node_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM evidence WHERE node_id=? ORDER BY at, evidence_id", (node_id,)
    ).fetchall()
    return [dict(r) for r in rows]


def list_attempts(conn: sqlite3.Connection, node_id: str) -> list[dict[str, Any]]:
    """attempt 历史（含被拒提交与 finalize 结果），按写入顺序。"""
    rows = conn.execute(
        "SELECT * FROM evidence_attempts WHERE node_id=? ORDER BY seq", (node_id,)
    ).fetchall()
    return [dict(r) for r in rows]


def list_artifact_uses(conn: sqlite3.Connection, artifact_id: str | None = None) -> list[dict[str, Any]]:
    if artifact_id is None:
        rows = conn.execute("SELECT * FROM artifact_uses ORDER BY seq").fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM artifact_uses WHERE artifact_id=? ORDER BY seq", (artifact_id,)
        ).fetchall()
    return [dict(r) for r in rows]


def list_verifiers(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT verifier_id FROM verifiers ORDER BY verifier_id").fetchall()
    return [get_verifier(conn, r["verifier_id"]) for r in rows]  # type: ignore[misc]


def export_evidence_projection(conn: sqlite3.Connection, out_dir: str | Path) -> list[str]:
    """导出证据/产物/验证器的人读投影（**投影，不是第二事实源**；权威仍在 DB）。

    补齐 `capabilities.export_skill_format()` 缺口：那边只导 STATE / INDEX / tasks /
    decisions / capabilities，证据链（evidence / artifact / verifier / attempt）没有落点。
    本函数只读 DB、只写 Markdown；D 侧接线时把返回值并进导出清单即可。
    """
    root = Path(out_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    written: list[str] = []
    ts = db.now_iso()

    ev_rows = conn.execute(
        "SELECT * FROM evidence ORDER BY node_id, at, evidence_id"
    ).fetchall()
    ev_lines = [
        "# 证据链（导出）",
        "",
        "- 生成时间：%s" % ts,
        "- 证据条数：%d" % len(ev_rows),
        "- 说明：append-only；同 ID 覆盖会被拒，attempt 历史另见下表。",
        "",
        "| 证据 | 节点 | 类型 | 判定 | 验证器 | 尝试 | 身份 | 时间 |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in ev_rows:
        ev_lines.append(
            "| %s | %s | %s | %s | %s | %s | %s | %s |"
            % (
                r["evidence_id"], r["node_id"], r["kind"], r["verdict"], r["verifier_id"],
                r["attempt_no"], r["identity"] or "-", r["at"],
            )
        )
    attempt_rows = conn.execute(
        "SELECT * FROM evidence_attempts ORDER BY seq"
    ).fetchall()
    ev_lines += ["", "## attempt 历史（含被拒提交与 finalize 结果）", ""]
    if attempt_rows:
        ev_lines += ["| # | 节点 | 证据 | 结果 | 原因 | 尝试 | 时间 |", "|---|---|---|---|---|---|---|"]
        for r in attempt_rows:
            ev_lines.append(
                "| %s | %s | %s | %s | %s | %s | %s |"
                % (r["seq"], r["node_id"] or "-", r["evidence_id"], r["outcome"],
                   r["reason"] or "-", r["attempt_no"], r["at"])
            )
    else:
        ev_lines.append("- （无）")
    (root / "evidence.md").write_text("\n".join(ev_lines) + "\n", encoding="utf-8")
    written.append(str(root / "evidence.md"))

    art_rows = conn.execute("SELECT artifact_id FROM artifacts ORDER BY created_at, artifact_id").fetchall()
    art_lines = [
        "# 产物清单（导出）",
        "",
        "- 生成时间：%s" % ts,
        "- 产物数：%d" % len(art_rows),
        "",
        "| 产物 | 生产者 | path | sha256 | a2a | 复核(ok/总) |",
        "|---|---|---|---|---|---|",
    ]
    for r in art_rows:
        art = get_artifact(conn, r["artifact_id"])
        assert art is not None
        checks = list_artifact_checks(conn, art["artifact_id"])
        ok = sum(1 for c in checks if c["ok"])
        art_lines.append(
            "| %s | %s | %s | %s… | %s | %d/%d |"
            % (
                art["artifact_id"], art["producer_node"] or "-", art["path"],
                (art["sha256"] or "")[:12], art["a2a_artifact_id"] or "-", ok, len(checks),
            )
        )
    reuse = list_artifact_uses(conn)
    art_lines += ["", "## 跨节点复用（A2A 交接）", ""]
    if reuse:
        art_lines += ["| # | 产物 | 引用节点 | via | 时间 |", "|---|---|---|---|---|"]
        for u in reuse:
            art_lines.append("| %s | %s | %s | %s | %s |"
                             % (u["seq"], u["artifact_id"], u["node_id"], u["via"], u["at"]))
    else:
        art_lines.append("- （无）")
    (root / "artifacts.md").write_text("\n".join(art_lines) + "\n", encoding="utf-8")
    written.append(str(root / "artifacts.md"))

    ver_rows = list_verifiers(conn)
    ver_lines = [
        "# 验证器注册表（导出）",
        "",
        "- 生成时间：%s" % ts,
        "- 验证器数：%d" % len(ver_rows),
        "",
        "| 验证器 | kind | role | active | 注册时间 | 撤销时间 |",
        "|---|---|---|---|---|---|",
    ]
    for v in ver_rows:
        ver_lines.append(
            "| %s | %s | %s | %s | %s | %s |"
            % (v["verifier_id"], v["kind"] or "-", v["role"] or "-",
               "是" if v["active"] else "否", v["created_at"] or "-", v["revoked_at"] or "-")
        )
    (root / "verifiers.md").write_text("\n".join(ver_lines) + "\n", encoding="utf-8")
    written.append(str(root / "verifiers.md"))
    return written


# ---------------------------------------------------------------------------
# 提交 / 验证
# ---------------------------------------------------------------------------


def submit(
    conn: sqlite3.Connection,
    node_id: str,
    owner: str,
    fencing_token: int,
    *,
    now: float | None = None,
) -> dict[str, Any]:
    """生产方提交（需有效租约）；状态 claimed/running → submitted。"""
    leases.assert_fencing(conn, node_id, owner, fencing_token, now=now)
    node = graph.get_node(conn, node_id)
    if node is None:
        raise EvidenceError("节点不存在：%s" % node_id)
    if node["status"] not in ("claimed", "running"):
        raise EvidenceError("节点状态不可提交：%s (%s)" % (node_id, node["status"]))
    # 状态机唯一入口：graph.set_status（唯一写 status 的地方）
    return graph.set_status(conn, node_id, "submitted", reason="submitted")


def _reject(
    conn: sqlite3.Connection,
    node_id: str,
    *,
    reason: str,
    detail: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """驳回：verifying → ready（attempts+1）、清租约、留痕。整段在一个事务里。"""
    ts = db.now_iso()
    attempt_no = _attempt_no(conn, node_id)
    with conn:
        _record_attempt(
            conn,
            evidence_id="(finalize)",
            node_id=node_id,
            kind="finalize",
            artifact_id=None,
            verifier_id=None,
            verdict=None,
            outcome="finalize_rejected",
            reason=reason,
            detail=detail or {},
            attempt_no=attempt_no,
            at=ts,
        )
        events.append_event(
            conn, "node_rejected", node_id,
            {"reason": reason, "detail": detail or {}, "at": ts}, commit=False,
        )
        # 状态机唯一入口（commit=False：并入本事务）
        graph.set_status(
            conn,
            node_id,
            "ready",
            reason="rejected:" + reason,
            assignee=None,
            attempts_delta=1,
            drop_lease=True,
            notify=False,
            commit=False,
        )
    return {"status": "rejected", "reason": reason, "detail": detail or {}}


def finalize(
    conn: sqlite3.Connection,
    node_id: str,
    *,
    verify_artifacts: bool | None = None,
    root: str | Path | None = None,
) -> dict[str, Any]:
    """验证 + done 事务。返回 {status: done|rejected, ...}；done 时解锁下游。

    verify_artifacts=None → 跟随 `meta['evidence_strict']`；True 强制复核 artifact path/sha。
    """
    node = graph.get_node(conn, node_id)
    if node is None:
        raise EvidenceError("节点不存在：%s" % node_id)
    if node["status"] not in ("submitted", "verifying"):
        raise EvidenceError("节点状态不可验证：%s (%s)" % (node_id, node["status"]))

    strict = db.evidence_strict(conn)
    reverify = strict if verify_artifacts is None else bool(verify_artifacts)

    # verifying 迁移也走状态机唯一入口
    if node["status"] != "verifying":
        graph.set_status(conn, node_id, "verifying", reason="verify_started")

    # 依赖必须 done
    for dep in node["deps"]:
        d = graph.get_node(conn, dep)
        if d is None or d["status"] != "done":
            return _reject(conn, node_id, reason="deps_not_done", detail={"dep": dep})

    # 证据非空（节点级最小前提，先于阶段闸门：无证据时"缺证据"比"闸门未过"更能解释失败）
    ev = list_evidence(conn, node_id)
    if not ev:
        return _reject(conn, node_id, reason="no_evidence")

    # 阶段闸门必须 passed
    if not stages.gate_allows_done(conn, node.get("stage")):
        return _reject(conn, node_id, reason="gate_not_passed", detail={"stage": node.get("stage")})

    # 验证器允许清单（先于 verdict 判定，保证「冒名验证器」优先按 allowlist 报错）
    allowed = set(node["verifier_ids"])
    if allowed:
        bad = sorted({e["verifier_id"] for e in ev if e["verifier_id"] not in allowed})
        if bad:
            return _reject(conn, node_id, reason="verifier_not_allowed", detail={"verifiers": bad})

    # 验证器身份（strict：解析不出身份 = 未注册 → 拒绝）
    if strict:
        unresolved = sorted(
            {e["verifier_id"] for e in ev if not resolve_verifier(conn, e["verifier_id"])["resolved"]}
        )
        if unresolved:
            return _reject(
                conn, node_id, reason="verifier_unregistered", detail={"verifiers": unresolved}
            )

    # unknown 永远 fail-closed（与 fail 分开报，便于定位）
    unknown = [e["evidence_id"] for e in ev if e["verdict"] == "unknown"]
    if unknown:
        return _reject(conn, node_id, reason="evidence_unknown", detail={"unknown": unknown})

    failed = [e["evidence_id"] for e in ev if e["verdict"] != "pass"]
    if failed:
        return _reject(conn, node_id, reason="evidence_not_passed", detail={"failed": failed})

    required = set(node["evidence_required"])
    got = {e["kind"] for e in ev if e["verdict"] == "pass"}
    missing = sorted(required - got)
    if missing:
        return _reject(conn, node_id, reason="missing_evidence", detail={"missing": missing})

    # artifact 复核（strict / 显式要求）：坏 artifact 不得 done
    if reverify:
        broken: list[dict[str, Any]] = []
        for e in ev:
            art_id = e.get("artifact_id")
            if not art_id:
                broken.append({"evidence_id": e["evidence_id"], "reason": "no_artifact"})
                continue
            check = verify_artifact(conn, art_id, root=root, node_id=node_id)
            if not check["ok"]:
                broken.append(
                    {"evidence_id": e["evidence_id"], "artifact_id": art_id, "reason": check["reason"]}
                )
        if broken:
            # 契约（与 C 的 engine strict 用例一致）：顶层 umbrella=artifact_invalid，
            # 具体原因（sha_mismatch / path_missing / cross_node）放在 detail.artifacts[]；
            # 纯跨节点场景保留 artifact_cross_node 便于与「坏文件」区分。
            reasons = {b.get("reason") for b in broken}
            reason = (
                "artifact_cross_node"
                if reasons == {"cross_node"}
                else "artifact_invalid"
            )
            return _reject(conn, node_id, reason=reason, detail={"artifacts": broken})

    # done 凭证：由 graph.done_credential() 唯一签发，finalize 只负责校验后再消费
    credential = graph.done_credential(conn, node_id)
    if credential is None:
        return _reject(
            conn, node_id, reason="credential_unavailable",
            detail={"evidence": [e["evidence_id"] for e in ev]},
        )

    # 证据事务：全部通过才 done（状态迁移走 graph.set_status 唯一入口）
    ts = db.now_iso()
    attempt_no = _attempt_no(conn, node_id)
    with conn:
        _record_attempt(
            conn,
            evidence_id="(finalize)",
            node_id=node_id,
            kind="finalize",
            artifact_id=None,
            verifier_id=None,
            verdict=None,
            outcome="finalize_done",
            reason="evidence_ok",
            detail={"evidence": [e["evidence_id"] for e in ev]},
            attempt_no=attempt_no,
            at=ts,
        )
        events.append_event(
            conn, "node_done", node_id,
            {
                "evidence": [e["evidence_id"] for e in ev],
                "verifiers": credential.get("verifier_ids", []),
                "at": ts,
            },
            commit=False,
        )
        graph.set_status(
            conn,
            node_id,
            "done",
            reason="evidence_ok",
            credential=credential,
            drop_lease=True,
            notify=False,
            commit=False,
        )
    # 状态变更已落库；这里触发依赖解锁（等价于 set_status(commit=True) 的 notify 分支）
    scheduler.on_event(
        conn, {"kind": "status_changed", "node_id": node_id, "payload": {"to": "done"}}
    )
    return {"status": "done", "evidence": [e["evidence_id"] for e in ev], "credential": credential}
