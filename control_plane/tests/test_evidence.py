# -*- coding: utf-8 -*-
"""R6 单元测试：证据 / 提交 / done 事务 / 驳回回到 ready / 下游解锁。

Lane B（TASK-20261029-3406F3）追加：append-only、attempt 历史、artifact path/sha 复核、
跨节点复用拒绝、验证器身份钩子、unknown fail-closed、schema v5 迁移幂等。
"""

import hashlib
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from control_plane import db, evidence, graph, leases, scheduler  # noqa: E402

SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"


def _sha_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class TestEvidence(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")
        # 真实产物文件（P2：不写占位路径，strict 口径下也能复核通过）
        self._art_x = Path(self._tmp.name) / "x.txt"
        self._art_x.write_bytes(b"artifact-x\n")
        self._sha_x = hashlib.sha256(self._art_x.read_bytes()).hexdigest()
        self._art_y = Path(self._tmp.name) / "y.txt"
        self._art_y.write_bytes(b"artifact-y\n")
        self._sha_y = hashlib.sha256(self._art_y.read_bytes()).hexdigest()
        graph.add_node(
            self.conn,
            node_id="NODE-001",
            title="t",
            spec="s",
            status="ready",
            evidence_required=["test"],
            verifier_ids=["verifier-1"],
        )
        # 夹具验证器注册（strict 口径下不再因「未注册」误杀；不影响负例的拒绝语义）
        evidence.register_verifier(
            self.conn, "verifier-ci", kind="ci", role="ROLE-AUDIT-01", identity={"by": "fixture"}
        )
        evidence.register_verifier(
            self.conn, "verifier-1", kind="ci", identity={"by": "fixture"}
        )
        evidence.add_artifact(
            self.conn, artifact_id="ART-001", path=str(self._art_x), sha256=self._sha_x,
            producer_node="NODE-001",
        )

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def _claim_submit(self):
        lease = leases.claim(self.conn, "NODE-001", "agent-A", ttl_sec=60, now=1000)
        evidence.submit(self.conn, "NODE-001", "agent-A", lease["fencing_token"], now=1001)
        return lease

    def test_done_transaction_success(self):
        self._claim_submit()
        evidence.add_evidence(
            self.conn, evidence_id="EVD-001", node_id="NODE-001", kind="test",
            artifact_id="ART-001", verifier_id="verifier-1", verdict="pass",
        )
        result = evidence.finalize(self.conn, "NODE-001")
        self.assertEqual(result["status"], "done")
        node = graph.get_node(self.conn, "NODE-001")
        self.assertEqual(node["status"], "done")

    def test_done_unlocks_downstream(self):
        graph.add_node(
            self.conn, node_id="NODE-002", title="b", spec="s", deps=["NODE-001"]
        )
        self._claim_submit()
        evidence.add_evidence(
            self.conn, evidence_id="EVD-001", node_id="NODE-001", kind="test",
            artifact_id="ART-001", verifier_id="verifier-1", verdict="pass",
        )
        evidence.finalize(self.conn, "NODE-001")
        self.assertEqual(graph.get_node(self.conn, "NODE-002")["status"], "ready")
        self.assertEqual(scheduler.ready_set(self.conn), ["NODE-002"])

    def test_no_evidence_rejected_to_ready(self):
        self._claim_submit()
        result = evidence.finalize(self.conn, "NODE-001")
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(result["reason"], "no_evidence")
        node = graph.get_node(self.conn, "NODE-001")
        self.assertEqual(node["status"], "ready")
        self.assertEqual(node["attempts"], 1)

    def test_failed_evidence_rejected(self):
        self._claim_submit()
        evidence.add_evidence(
            self.conn, evidence_id="EVD-002", node_id="NODE-001", kind="test",
            artifact_id="ART-001", verifier_id="verifier-1", verdict="fail",
        )
        result = evidence.finalize(self.conn, "NODE-001")
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(result["reason"], "evidence_not_passed")

    def test_missing_required_kind(self):
        self._claim_submit()
        evidence.add_evidence(
            self.conn, evidence_id="EVD-003", node_id="NODE-001", kind="other",
            artifact_id="ART-001", verifier_id="verifier-1", verdict="pass",
        )
        result = evidence.finalize(self.conn, "NODE-001")
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(result["reason"], "missing_evidence")

    def test_verifier_not_allowed(self):
        """permissive：进 finalize 后被 allowlist 拒；strict：更早在写入前被拒（两种都不 done）。"""
        self._claim_submit()
        try:
            evidence.add_evidence(
                self.conn, evidence_id="EVD-004", node_id="NODE-001", kind="test",
                artifact_id="ART-001", verifier_id="intruder", verdict="pass",
            )
        except evidence.UnknownVerifier:
            result = evidence.finalize(self.conn, "NODE-001")
            self.assertEqual(result["status"], "rejected")
            self.assertEqual(result["reason"], "no_evidence")
            return
        result = evidence.finalize(self.conn, "NODE-001")
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(result["reason"], "verifier_not_allowed")

    def test_deps_not_done_rejected(self):
        graph.add_node(self.conn, node_id="NODE-003", title="c", spec="s", status="running")
        graph.add_node(
            self.conn, node_id="NODE-004", title="d", spec="s", status="ready", deps=["NODE-003"]
        )
        lease = leases.claim(self.conn, "NODE-004", "agent-B", ttl_sec=60, now=1000)
        evidence.submit(self.conn, "NODE-004", "agent-B", lease["fencing_token"], now=1001)
        evidence.add_artifact(
            self.conn, artifact_id="ART-004", path=str(self._art_y), sha256=self._sha_y,
            producer_node="NODE-004",
        )
        evidence.add_evidence(
            self.conn, evidence_id="EVD-004", node_id="NODE-004", kind="test",
            artifact_id="ART-004", verifier_id="verifier-1", verdict="pass",
        )
        result = evidence.finalize(self.conn, "NODE-004")
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(result["reason"], "deps_not_done")

    def test_submit_requires_fencing(self):
        leases.claim(self.conn, "NODE-001", "agent-A", ttl_sec=60, now=1000)
        with self.assertRaises(leases.FencingError):
            evidence.submit(self.conn, "NODE-001", "agent-A", 99, now=1001)

    def test_add_evidence_validates_artifact(self):
        with self.assertRaises(evidence.EvidenceError):
            evidence.add_evidence(
                self.conn, evidence_id="EVD-005", node_id="NODE-001", kind="test",
                artifact_id="ART-404", verifier_id="verifier-1", verdict="pass",
            )


# ---------------------------------------------------------------------------
# Lane B：append-only / attempt 历史
# ---------------------------------------------------------------------------


class _Base(unittest.TestCase):
    """共用夹具：临时库 + 可写文件产物 + 注册验证器。"""

    STRICT = False

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.conn = db.init_db(self.root / "cp.db", strict=self.STRICT)
        evidence.set_identity_hook(None)
        graph.add_node(
            self.conn,
            node_id="NODE-001",
            title="t",
            spec="s",
            status="ready",
            evidence_required=["test"],
            verifier_ids=["verifier-1"],
        )
        self.file = self.root / "out.txt"
        self.text = "artifact body\n"
        self.file.write_bytes(self.text.encode("utf-8"))  # 避免 Windows 换行转换影响 sha
        self.sha = hashlib.sha256(self.file.read_bytes()).hexdigest()
        evidence.add_artifact(
            self.conn, artifact_id="ART-001", path=str(self.file), sha256=self.sha,
            producer_node="NODE-001",
        )
        evidence.register_verifier(self.conn, "verifier-1", kind="ci", identity={"by": "test"})

    def tearDown(self):
        evidence.set_identity_hook(None)
        self.conn.close()
        self._tmp.cleanup()

    def claim_submit(self, node_id="NODE-001", owner="agent-A", now=1000):
        lease = leases.claim(self.conn, node_id, owner, ttl_sec=60, now=now)
        evidence.submit(self.conn, node_id, owner, lease["fencing_token"], now=now + 1)
        return lease

    def add_pass(self, evidence_id="EVD-001", node_id="NODE-001", artifact_id="ART-001",
                 verifier_id="verifier-1", kind="test"):
        return evidence.add_evidence(
            self.conn, evidence_id=evidence_id, node_id=node_id, kind=kind,
            artifact_id=artifact_id, verifier_id=verifier_id, verdict="pass",
        )


class TestAppendOnly(_Base):
    def test_duplicate_evidence_rejected_and_history_kept(self):
        self.claim_submit()
        first = self.add_pass()
        self.assertEqual(first["attempt_no"], 1)
        with self.assertRaises(evidence.DuplicateEvidence):
            self.add_pass()
        rows = self.conn.execute("SELECT * FROM evidence").fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["verdict"], "pass")
        attempts = evidence.list_attempts(self.conn, "NODE-001")
        self.assertEqual([a["outcome"] for a in attempts], ["accepted", "rejected_duplicate"])
        self.assertEqual(attempts[1]["reason"], "duplicate_evidence")

    def test_attempt_no_tracks_rejections(self):
        self.claim_submit()
        self.add_pass()
        # 另开一个节点，验证“被驳回一次后 attempt_no 前进”
        graph.add_node(
            self.conn, node_id="NODE-009", title="t9", spec="s", status="ready",
            evidence_required=["test"], verifier_ids=["verifier-1"],
        )
        evidence.add_artifact(
            self.conn, artifact_id="ART-009", path=str(self.file), sha256=self.sha,
            producer_node="NODE-009",
        )
        lease = leases.claim(self.conn, "NODE-009", "agent-B", ttl_sec=60, now=2000)
        evidence.submit(self.conn, "NODE-009", "agent-B", lease["fencing_token"], now=2001)
        rej = evidence.finalize(self.conn, "NODE-009")  # 无证据 → 驳回，attempts=1
        self.assertEqual(rej["status"], "rejected")
        self.assertEqual(graph.get_node(self.conn, "NODE-009")["attempts"], 1)
        lease2 = leases.claim(self.conn, "NODE-009", "agent-B", ttl_sec=60, now=2002)
        evidence.submit(self.conn, "NODE-009", "agent-B", lease2["fencing_token"], now=2003)
        rec = self.add_pass(evidence_id="EVD-009", node_id="NODE-009", artifact_id="ART-009")
        self.assertEqual(rec["attempt_no"], 2)
        outcomes = [a["outcome"] for a in evidence.list_attempts(self.conn, "NODE-009")]
        self.assertEqual(outcomes, ["finalize_rejected", "accepted"])

    def test_sql_update_and_delete_blocked(self):
        self.claim_submit()
        self.add_pass()
        with self.assertRaises(sqlite3.DatabaseError) as ctx:
            self.conn.execute("UPDATE evidence SET verdict='fail' WHERE evidence_id='EVD-001'")
        self.assertIn("append-only", str(ctx.exception))
        self.conn.rollback()
        with self.assertRaises(sqlite3.DatabaseError) as ctx2:
            self.conn.execute("DELETE FROM evidence WHERE evidence_id='EVD-001'")
        self.assertIn("append-only", str(ctx2.exception))
        self.conn.rollback()
        self.assertEqual(len(self.conn.execute("SELECT * FROM evidence").fetchall()), 1)

    def test_duplicate_artifact_rejected_and_immutable(self):
        with self.assertRaises(evidence.ArtifactImmutable):
            evidence.add_artifact(
                self.conn, artifact_id="ART-001", path=str(self.file), sha256="f" * 64,
                producer_node="NODE-001",
            )
        self.assertEqual(len(evidence.list_artifacts(self.conn, "NODE-001")), 1)
        with self.assertRaises(sqlite3.DatabaseError) as ctx:
            self.conn.execute("UPDATE artifacts SET sha256=? WHERE artifact_id='ART-001'", ("a" * 64,))
        self.assertIn("append-only", str(ctx.exception))
        self.conn.rollback()

    def test_bad_verdict_rejected_and_logged(self):
        self.claim_submit()
        with self.assertRaises(evidence.EvidenceError):
            evidence.add_evidence(
                self.conn, evidence_id="EVD-002", node_id="NODE-001", kind="test",
                artifact_id="ART-001", verifier_id="verifier-1", verdict="maybe",
            )
        attempts = evidence.list_attempts(self.conn, "NODE-001")
        self.assertEqual(attempts[-1]["outcome"], "rejected_invalid")
        self.assertEqual(attempts[-1]["reason"], "bad_verdict")


class TestArtifactIntegrity(_Base):
    def test_verify_ok(self):
        got = evidence.verify_artifact(self.conn, "ART-001", node_id="NODE-001")
        self.assertTrue(got["ok"])
        self.assertIsNone(got["reason"])
        self.assertEqual(got["actual_sha256"], self.sha)
        checks = evidence.list_artifact_checks(self.conn, "ART-001")
        self.assertEqual(len(checks), 1)
        self.assertEqual(checks[0]["ok"], 1)

    def test_verify_sha_mismatch(self):
        self.file.write_text("tampered\n", encoding="utf-8")
        got = evidence.verify_artifact(self.conn, "ART-001", node_id="NODE-001")
        self.assertFalse(got["ok"])
        self.assertEqual(got["reason"], "sha_mismatch")
        self.assertEqual(evidence.list_artifact_checks(self.conn, "ART-001")[-1]["ok"], 0)

    def test_verify_path_missing(self):
        self.file.unlink()
        got = evidence.verify_artifact(self.conn, "ART-001", node_id="NODE-001")
        self.assertEqual(got["reason"], "path_missing")

    def test_verify_path_outside_root(self):
        got = evidence.verify_artifact(
            self.conn, "ART-001", node_id="NODE-001", root=self.root / "elsewhere"
        )
        self.assertEqual(got["reason"], "path_outside_root")

    def test_verify_unknown_artifact(self):
        got = evidence.verify_artifact(self.conn, "ART-404")
        self.assertEqual(got["reason"], "artifact_missing_row")


class TestStrictDone(_Base):
    STRICT = True

    def test_strict_good_artifact_done(self):
        self.claim_submit()
        self.add_pass()
        result = evidence.finalize(self.conn, "NODE-001", root=self.root)
        self.assertEqual(result["status"], "done")
        self.assertEqual(evidence.list_artifact_checks(self.conn, "ART-001")[-1]["ok"], 1)

    def test_strict_tampered_artifact_blocks_done(self):
        self.claim_submit()
        self.add_pass()
        self.file.write_text("tampered\n", encoding="utf-8")
        result = evidence.finalize(self.conn, "NODE-001", root=self.root)
        self.assertEqual(result["status"], "rejected")
        # 契约：顶层 umbrella=artifact_invalid，具体原因在 detail
        self.assertEqual(result["reason"], "artifact_invalid")
        self.assertEqual(result["detail"]["artifacts"][0]["reason"], "sha_mismatch")
        node = graph.get_node(self.conn, "NODE-001")
        self.assertEqual(node["status"], "ready")
        self.assertEqual(node["attempts"], 1)

    def test_strict_missing_artifact_file_blocks_done(self):
        self.claim_submit()
        self.add_pass()
        self.file.unlink()
        result = evidence.finalize(self.conn, "NODE-001")
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(result["reason"], "artifact_invalid")
        self.assertEqual(result["detail"]["artifacts"][0]["reason"], "path_missing")

    def test_strict_mixed_artifact_failures_use_umbrella(self):
        graph.add_node(
            self.conn, node_id="NODE-003", title="t3", spec="s", status="ready",
            evidence_required=["test"], verifier_ids=["verifier-1"],
        )
        broken = self.root / "broken.txt"
        broken.write_bytes(b"broken\n")
        evidence.add_artifact(
            self.conn, artifact_id="ART-BROKEN", path=str(broken), sha256=self.sha,
            producer_node="NODE-003",
        )
        evidence.add_artifact(
            self.conn, artifact_id="ART-GONE", path=str(self.root / "gone.txt"), sha256=self.sha,
            producer_node="NODE-003",
        )
        lease = leases.claim(self.conn, "NODE-003", "agent-C", ttl_sec=60, now=3000)
        evidence.submit(self.conn, "NODE-003", "agent-C", lease["fencing_token"], now=3001)
        self.add_pass(evidence_id="EVD-B1", node_id="NODE-003", artifact_id="ART-BROKEN")
        self.add_pass(evidence_id="EVD-B2", node_id="NODE-003", artifact_id="ART-GONE")
        result = evidence.finalize(self.conn, "NODE-003", root=self.root)
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(result["reason"], "artifact_invalid")
        self.assertEqual(
            sorted(b["reason"] for b in result["detail"]["artifacts"]),
            ["path_missing", "sha_mismatch"],
        )

    def test_strict_rejects_evidence_after_done(self):
        self.claim_submit()
        self.add_pass()
        self.assertEqual(evidence.finalize(self.conn, "NODE-001", root=self.root)["status"], "done")
        with self.assertRaises(evidence.NodeTerminal):
            self.add_pass(evidence_id="EVD-LATE")
        attempts = evidence.list_attempts(self.conn, "NODE-001")
        self.assertEqual(attempts[-1]["outcome"], "rejected_terminal")

    def test_permissive_allows_late_evidence_but_keeps_history(self):
        self.conn.execute(
            "UPDATE meta SET value='0' WHERE key='evidence_strict'"
        )
        self.conn.commit()
        self.claim_submit()
        self.add_pass()
        self.assertEqual(evidence.finalize(self.conn, "NODE-001")["status"], "done")
        rec = self.add_pass(evidence_id="EVD-LATE")
        self.assertEqual(rec["verdict"], "pass")
        self.assertEqual(len(evidence.list_evidence(self.conn, "NODE-001")), 2)


class TestCrossNodeArtifact(_Base):
    def setUp(self):
        super().setUp()
        graph.add_node(
            self.conn, node_id="NODE-002", title="b", spec="s", status="ready",
            evidence_required=["test"], verifier_ids=["verifier-1"],
        )

    def test_cross_node_reuse_rejected(self):
        lease = leases.claim(self.conn, "NODE-002", "agent-B", ttl_sec=60, now=1000)
        evidence.submit(self.conn, "NODE-002", "agent-B", lease["fencing_token"], now=1001)
        with self.assertRaises(evidence.CrossNodeArtifact):
            self.add_pass(evidence_id="EVD-002", node_id="NODE-002")
        attempts = evidence.list_attempts(self.conn, "NODE-002")
        self.assertEqual(attempts[-1]["outcome"], "rejected_cross_node")
        self.assertEqual(evidence.list_artifact_uses(self.conn, "ART-001"), [])

    def test_a2a_reuse_allowed_and_logged(self):
        evidence.add_artifact(
            self.conn, artifact_id="ART-A2A", path=str(self.file), sha256=self.sha,
            producer_node="NODE-001", a2a_artifact_id="A2A-001",
        )
        lease = leases.claim(self.conn, "NODE-002", "agent-B", ttl_sec=60, now=1000)
        evidence.submit(self.conn, "NODE-002", "agent-B", lease["fencing_token"], now=1001)
        rec = self.add_pass(evidence_id="EVD-002", node_id="NODE-002", artifact_id="ART-A2A")
        self.assertEqual(rec["via"], "a2a:A2A-001")
        uses = evidence.list_artifact_uses(self.conn, "ART-A2A")
        self.assertEqual(len(uses), 1)
        self.assertEqual(uses[0]["node_id"], "NODE-002")
        self.assertEqual(uses[0]["via"], "a2a:A2A-001")
        result = evidence.finalize(self.conn, "NODE-002", root=self.root)
        self.assertEqual(result["status"], "done")

    def test_cross_node_without_a2a_blocks_done(self):
        self.conn.execute("UPDATE meta SET value='1' WHERE key='evidence_strict'")
        self.conn.commit()
        # 直接塞一行指向别家产物（绕过 API 的跨节点校验，模拟历史脏数据）
        self.conn.execute(
            "INSERT INTO evidence(evidence_id,node_id,kind,artifact_id,verifier_id,verdict,"
            "attempt_no,identity,at) VALUES('EVD-DIRTY','NODE-002','test','ART-001',"
            "'verifier-1','pass',1,'x',?)",
            (db.now_iso(),),
        )
        self.conn.commit()
        lease = leases.claim(self.conn, "NODE-002", "agent-B", ttl_sec=60, now=1000)
        evidence.submit(self.conn, "NODE-002", "agent-B", lease["fencing_token"], now=1001)
        result = evidence.finalize(self.conn, "NODE-002", root=self.root)
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(result["reason"], "artifact_cross_node")


class TestVerifierIdentity(_Base):
    STRICT = True

    def test_unregistered_verifier_rejected_when_strict(self):
        """strict：未注册验证器在**写入前**就被拒（不留脏证据），并留 attempt 痕迹。"""
        self.conn.execute("UPDATE tasks SET verifier_ids_json=? WHERE node_id='NODE-001'",
                          (db.dumps(["verifier-1", "ghost"]),))
        self.conn.commit()
        self.claim_submit()
        with self.assertRaises(evidence.UnknownVerifier):
            self.add_pass(verifier_id="ghost")
        attempts = evidence.list_attempts(self.conn, "NODE-001")
        self.assertEqual(attempts[-1]["outcome"], "rejected_unregistered")
        self.assertEqual(attempts[-1]["reason"], "verifier_unregistered")
        self.assertEqual(evidence.list_evidence(self.conn, "NODE-001"), [])
        # 纵深防御：即便有脏行（历史/绕过 API），finalize 仍拒绝
        self.conn.execute(
            "INSERT INTO evidence(evidence_id,node_id,kind,artifact_id,verifier_id,verdict,"
            "attempt_no,identity,at) VALUES('EVD-DIRTY','NODE-001','test','ART-001','ghost',"
            "'pass',1,'unregistered',?)",
            (db.now_iso(),),
        )
        self.conn.commit()
        result = evidence.finalize(self.conn, "NODE-001", root=self.root)
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(result["reason"], "verifier_unregistered")
        self.assertEqual(result["detail"]["verifiers"], ["ghost"])

    def test_registered_verifier_passes(self):
        evidence.register_verifier(self.conn, "verifier-2", kind="human", role="ROLE-AUDIT-01")
        self.conn.execute("UPDATE tasks SET verifier_ids_json=? WHERE node_id='NODE-001'",
                          (db.dumps(["verifier-1", "verifier-2"]),))
        self.conn.commit()
        self.claim_submit()
        self.add_pass(verifier_id="verifier-2")
        result = evidence.finalize(self.conn, "NODE-001", root=self.root)
        self.assertEqual(result["status"], "done")
        self.assertEqual(evidence.get_verifier(self.conn, "verifier-2")["role"], "ROLE-AUDIT-01")

    def test_revoked_verifier_rejected(self):
        evidence.revoke_verifier(self.conn, "verifier-1")
        self.claim_submit()
        with self.assertRaises(evidence.UnknownVerifier):
            self.add_pass()

    def test_identity_hook_resolves_and_unknown_fails_closed(self):
        evidence.set_identity_hook(
            lambda conn, vid: {"identity": "svc:%s" % vid} if vid == "hooked" else None
        )
        self.conn.execute("UPDATE tasks SET verifier_ids_json=? WHERE node_id='NODE-001'",
                          (db.dumps(["hooked"]),))
        self.conn.commit()
        self.claim_submit()
        self.add_pass(verifier_id="hooked")
        result = evidence.finalize(self.conn, "NODE-001", root=self.root)
        self.assertEqual(result["status"], "done")

    def test_identity_hook_failure_is_unresolved(self):
        def boom(conn, vid):
            raise RuntimeError("hook down")

        evidence.set_identity_hook(boom)
        self.conn.execute("UPDATE tasks SET verifier_ids_json=? WHERE node_id='NODE-001'",
                          (db.dumps(["verifier-1", "ghost"]),))
        self.conn.commit()
        self.claim_submit()
        with self.assertRaises(evidence.UnknownVerifier):
            self.add_pass(verifier_id="ghost")


class TestUnknownVerdict(_Base):
    def test_unknown_fail_closed_permissive(self):
        self.claim_submit()
        evidence.add_evidence(
            self.conn, evidence_id="EVD-U", node_id="NODE-001", kind="test",
            artifact_id="ART-001", verifier_id="verifier-1", verdict="unknown",
        )
        result = evidence.finalize(self.conn, "NODE-001")
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(result["reason"], "evidence_unknown")
        self.assertEqual(graph.get_node(self.conn, "NODE-001")["status"], "ready")


class TestUnknownVerdictStrict(_Base):
    STRICT = True

    def test_unknown_fail_closed_strict(self):
        self.claim_submit()
        evidence.add_evidence(
            self.conn, evidence_id="EVD-U", node_id="NODE-001", kind="test",
            artifact_id="ART-001", verifier_id="verifier-1", verdict="unknown",
        )
        result = evidence.finalize(self.conn, "NODE-001", root=self.root)
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(result["reason"], "evidence_unknown")


class TestExportProjection(_Base):
    def test_export_evidence_projection(self):
        self.claim_submit()
        self.add_pass()
        with self.assertRaises(evidence.DuplicateEvidence):
            self.add_pass()
        evidence.verify_artifact(self.conn, "ART-001", node_id="NODE-001")
        out = self.root / "export"
        written = evidence.export_evidence_projection(self.conn, out)
        names = {Path(p).name for p in written}
        self.assertEqual({"evidence.md", "artifacts.md", "verifiers.md"}, names)
        ev_text = (out / "evidence.md").read_text(encoding="utf-8")
        self.assertIn("EVD-001", ev_text)
        self.assertIn("rejected_duplicate", ev_text)
        art_text = (out / "artifacts.md").read_text(encoding="utf-8")
        self.assertIn("ART-001", art_text)
        self.assertIn("1/1", art_text)
        ver_text = (out / "verifiers.md").read_text(encoding="utf-8")
        self.assertIn("verifier-1", ver_text)


# ---------------------------------------------------------------------------
# schema v5 迁移
# ---------------------------------------------------------------------------

LEGACY_V4_SQL = """
CREATE TABLE evidence (
  evidence_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  artifact_id TEXT,
  verifier_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','fail','unknown')),
  at TEXT NOT NULL
);
CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  producer_node TEXT,
  verifier_ids_json TEXT NOT NULL DEFAULT '[]',
  a2a_artifact_id TEXT
);
CREATE TABLE ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  instance_id TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cache_saved INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  wall_ms INTEGER NOT NULL DEFAULT 0,
  verifier_cost REAL NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);
"""


class TestMigrationV5(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "legacy.db"
        raw = sqlite3.connect(str(self.path))
        raw.executescript(LEGACY_V4_SQL)
        raw.execute(
            "INSERT INTO evidence(evidence_id,node_id,kind,artifact_id,verifier_id,verdict,at)"
            " VALUES('EVD-OLD','NODE-OLD','test','ART-OLD','v1','pass','2026-10-01T00:00:00+08:00')"
        )
        raw.execute(
            "INSERT INTO ledger(node_id,tokens_in,tokens_out,calls,at)"
            " VALUES('NODE-OLD',10,20,1,'2026-10-01T00:00:00+08:00')"
        )
        raw.commit()
        raw.close()

    def tearDown(self):
        self._tmp.cleanup()

    def test_migration_adds_columns_and_is_idempotent(self):
        conn = db.init_db(self.path)
        try:
            self.assertEqual(db.schema_version(conn), 5)
            ev_cols = {r["name"] for r in conn.execute("PRAGMA table_info(evidence)")}
            self.assertTrue({"attempt_no", "identity"} <= ev_cols, ev_cols)
            art_cols = {r["name"] for r in conn.execute("PRAGMA table_info(artifacts)")}
            self.assertTrue({"sha_algo", "note", "created_at"} <= art_cols, art_cols)
            led_cols = {r["name"] for r in conn.execute("PRAGMA table_info(ledger)")}
            self.assertTrue({"role", "estimated"} <= led_cols, led_cols)
            tables = set(db.table_names(conn))
            self.assertTrue(
                {"verifiers", "evidence_attempts", "artifact_checks", "artifact_uses"} <= tables, tables
            )
            # 旧行保留 + 新列取默认值
            old = conn.execute("SELECT * FROM evidence WHERE evidence_id='EVD-OLD'").fetchone()
            self.assertEqual(old["verdict"], "pass")
            self.assertEqual(old["attempt_no"], 0)
            self.assertEqual(conn.execute("SELECT role, estimated FROM ledger").fetchone()["estimated"], 0)
            # 迁移痕迹
            self.assertEqual(db.get_meta(conn, "migrated_to"), "5")
            # 触发器就位
            trgs = {
                r["name"]
                for r in conn.execute("SELECT name FROM sqlite_master WHERE type='trigger'")
            }
            self.assertIn("trg_evidence_no_update", trgs)
            self.assertIn("trg_artifacts_no_delete", trgs)
        finally:
            conn.close()

        # 二次初始化：版本不变、表集合不变、无异常
        conn = db.init_db(self.path)
        try:
            self.assertEqual(db.schema_version(conn), 5)
            self.assertEqual(db._migrate(conn), [])
            self.assertEqual(len(conn.execute("SELECT * FROM evidence").fetchall()), 1)
        finally:
            conn.close()

    def test_strict_flag_follows_init_argument_and_meta(self):
        """不写死默认值：strict 开关只断言「与 init_db 入参 / meta 一致」。"""
        base = Path(self._tmp.name)

        conn_on = db.init_db(base / "strict_on.db", strict=True)
        try:
            self.assertEqual(db.schema_version(conn_on), db.SCHEMA_VERSION)
            self.assertTrue(db.evidence_strict(conn_on))
        finally:
            conn_on.close()

        conn_off = db.init_db(base / "strict_off.db", strict=False)
        try:
            self.assertEqual(db.schema_version(conn_off), db.SCHEMA_VERSION)
            self.assertFalse(db.evidence_strict(conn_off))
        finally:
            conn_off.close()

        # strict=None：沿用库内 meta（新库由 init_db 写入默认值），只校验一致性
        conn = db.init_db(base / "fresh.db")
        try:
            self.assertEqual(db.schema_version(conn), db.SCHEMA_VERSION)
            expected = db.get_meta(conn, db.META_EVIDENCE_STRICT, "0") == "1"
            self.assertEqual(db.evidence_strict(conn), expected)
            db.set_evidence_strict(conn, True)
            self.assertTrue(db.evidence_strict(conn))
            db.set_evidence_strict(conn, False)
            self.assertFalse(db.evidence_strict(conn))
            # 已存在的库再 init（strict=None）不应改写既有设置
            db.set_evidence_strict(conn, True)
        finally:
            conn.close()
        conn = db.init_db(base / "fresh.db")
        try:
            self.assertTrue(db.evidence_strict(conn))
        finally:
            conn.close()

    def test_ledger_role_estimated_writable(self):
        conn = db.init_db(self.path)
        try:
            conn.execute(
                "INSERT INTO ledger(node_id,instance_id,role,estimated,tokens_in,tokens_out,calls,at)"
                " VALUES('NODE-002','INST-1','ROLE-CODE-03',1,5,7,1,'2026-10-29T00:00:00+08:00')"
            )
            conn.commit()
            row = conn.execute("SELECT * FROM ledger WHERE node_id='NODE-002'").fetchone()
            self.assertEqual(row["role"], "ROLE-CODE-03")
            self.assertEqual(row["estimated"], 1)
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
