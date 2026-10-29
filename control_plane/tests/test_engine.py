# -*- coding: utf-8 -*-
"""Lane C 单元测试：engine 门面（终止闸门 / 并发门 / 计量挂点 / 单节点全流程）。"""

import hashlib
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from control_plane import db, engine as engine_mod, events, evidence, graph, ledger, stages  # noqa: E402

ART_TEXT = "artifact body\n"
WORKFLOW_VERIFIER = "verifier-ci"


def _artifact(root: Path, node_id: str) -> tuple[str, str]:
    """写盘字节 = sha 字节（避免 Windows `write_text` 的 CRLF 翻译造成 sha 假账）。"""
    p = root / ("%s.txt" % node_id)
    data = ART_TEXT.encode("utf-8")
    p.write_bytes(data)
    return str(p), hashlib.sha256(data).hexdigest()


class EngineTestBase(unittest.TestCase):
    limits = None

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.eng = engine_mod.Engine.open(
            self.root / "cp.db", owner="tester", limits=self.limits
        )
        # 验证器身份预注册（P1）：strict=1 时未注册验证器会被 finalize 拒
        evidence.register_verifier(
            self.eng.conn, WORKFLOW_VERIFIER, kind="ci", role="ROLE-AUDIT-01"
        )

    def tearDown(self):
        self.eng.close()
        self._tmp.cleanup()

    def add(self, node_id, **kwargs):
        params = dict(
            node_id=node_id,
            title=node_id,
            spec="spec",
            stage="build",
            evidence_required=["artifact"],
            verifier_ids=["verifier-ci"],
        )
        params.update(kwargs)
        return self.eng.add_node(**params)


class TestOpenAndStatus(EngineTestBase):
    def test_open_creates_schema(self):
        self.assertEqual(db.schema_version(self.eng.conn), db.SCHEMA_VERSION)
        self.assertFalse(self.eng.is_terminated())

    def test_status_counts_and_ready(self):
        self.add("NODE-A")
        self.eng.bootstrap()
        status = self.eng.status()
        self.assertEqual(status["nodes"]["NODE-A"], "ready")
        self.assertEqual(status["ready"], ["NODE-A"])
        self.assertEqual(status["counts"]["ready"], 1)
        self.assertFalse(status["terminal"])

    def test_usage_reads_real_ledger(self):
        self.add("NODE-A")
        self.eng.record_usage("NODE-A", tokens_in=10, tokens_out=5, calls=1)
        self.assertEqual(self.eng.usage("NODE-A")["tokens"], 15)
        self.assertEqual(self.eng.status()["usage"]["rows"], 1)


class TestTerminatedGate(EngineTestBase):
    def test_terminate_blocks_claim_submit_finalize_evidence(self):
        self.add("NODE-A")
        self.eng.bootstrap()
        self.eng.terminate("budget_exceeded", {"why": "test"})
        with self.assertRaises(engine_mod.Terminated):
            self.eng.claim("NODE-A")
        with self.assertRaises(engine_mod.Terminated):
            self.eng.submit("NODE-A", "tester", 1)
        with self.assertRaises(engine_mod.Terminated):
            self.eng.finalize("NODE-A")
        with self.assertRaises(engine_mod.Terminated):
            self.eng.add_evidence(
                evidence_id="E1", node_id="NODE-A", kind="artifact",
                artifact_id="A1", verifier_id="verifier-ci", verdict="pass",
            )
        denied = [e for e in events.iter_events(self.eng.conn) if e["kind"] == "action_denied"]
        self.assertEqual(len(denied), 4)

    def test_terminate_is_idempotent_first_reason_wins(self):
        first = self.eng.terminate("depth_exceeded")
        second = self.eng.terminate("total_cost_exceeded")
        self.assertEqual(first["reason"], "depth_exceeded")
        self.assertEqual(second["reason"], "depth_exceeded")
        self.assertEqual(self.eng.terminated_state()["reason"], "depth_exceeded")

    def test_termination_survives_reopen(self):
        self.eng.terminate("manual")
        db_path = self.root / "cp.db"
        other = engine_mod.Engine.open(db_path)
        try:
            self.assertTrue(other.is_terminated())
            with self.assertRaises(engine_mod.Terminated):
                other.claim("NODE-X")
        finally:
            other.close()

    def test_resume_clears_and_allows_claim(self):
        self.add("NODE-A")
        self.eng.bootstrap()
        self.eng.terminate("manual")
        self.eng.resume(note="人工确认")
        self.assertFalse(self.eng.is_terminated())
        lease = self.eng.claim("NODE-A")
        self.assertEqual(lease["owner"], "tester")

    def test_scan_persists_termination_from_global_cost(self):
        self.add("NODE-A")
        self.eng.limits["max_total_cost"] = 0.5
        ledger.append(self.eng.conn, "NODE-A", tokens_in=1, calls=1, verifier_cost=9.0)
        scan = self.eng.scan(now=1000)
        self.assertTrue(scan["terminated"])
        self.assertEqual(scan["reason"], "total_cost_exceeded")
        self.assertEqual(self.eng.terminated_state()["reason"], "total_cost_exceeded")
        with self.assertRaises(engine_mod.Terminated):
            self.eng.claim("NODE-A")


class TestConcurrencyGate(EngineTestBase):
    limits = {"max_parallel": 1}

    def test_second_claim_denied(self):
        self.add("NODE-A")
        self.add("NODE-B")
        self.eng.bootstrap()
        self.eng.claim("NODE-A")
        with self.assertRaises(engine_mod.ConcurrencyExceeded):
            self.eng.claim("NODE-B")
        self.assertEqual(self.eng.node("NODE-B")["status"], "ready")
        denied = [e for e in events.iter_events(self.eng.conn) if e["kind"] == "claim_denied"]
        self.assertEqual(denied[0]["payload"]["limit"], 1)

    def test_release_frees_slot(self):
        self.add("NODE-A")
        self.add("NODE-B")
        self.eng.bootstrap()
        lease = self.eng.claim("NODE-A")
        self.eng.release("NODE-A", "tester", lease["fencing_token"])
        self.assertEqual(self.eng.claim("NODE-B")["owner"], "tester")

    def test_renew_same_node_not_counted(self):
        self.add("NODE-A")
        self.eng.bootstrap()
        lease = self.eng.claim("NODE-A", ttl_sec=60, now=1000)
        renewed = self.eng.renew("NODE-A", "tester", lease["fencing_token"], ttl_sec=60, now=1010)
        self.assertEqual(renewed["fencing_token"], lease["fencing_token"])


class TestNodeFlow(EngineTestBase):
    def test_full_flow_reaches_done_and_unlocks_downstream(self):
        self.add("NODE-A", stage="design")
        self.add("NODE-B", stage="build", deps=["NODE-A"])
        self.eng.bootstrap()

        lease = self.eng.claim("NODE-A", ttl_sec=600, now=1000)
        with self.eng.meter("NODE-A", instance_id="inst-1") as meter:
            meter.record(tokens_in=120, tokens_out=340, calls=1)
        path, sha = _artifact(self.root, "NODE-A")
        self.eng.add_artifact(
            artifact_id="ART-A", path=path, sha256=sha, producer_node="NODE-A"
        )
        self.eng.add_evidence(
            evidence_id="EVD-A", node_id="NODE-A", kind="artifact",
            artifact_id="ART-A", verifier_id="verifier-ci", verdict="pass",
        )
        stages.pass_gate(self.eng.conn, "design", ["EVD-A"])
        self.eng.submit("NODE-A", "tester", lease["fencing_token"], now=1001)
        result = self.eng.finalize("NODE-A")

        self.assertEqual(result["status"], "done")
        self.assertEqual(graph.get_node(self.eng.conn, "NODE-B")["status"], "ready")
        self.assertEqual(self.eng.usage("NODE-A")["tokens"], 460)
        self.assertIsNone(self.eng.lease("NODE-A"))

    def test_rejected_node_returns_ready_and_counts_attempt(self):
        self.add("NODE-A", stage="build")
        self.eng.bootstrap()
        lease = self.eng.claim("NODE-A", ttl_sec=600, now=1000)
        self.eng.submit("NODE-A", "tester", lease["fencing_token"], now=1001)
        result = self.eng.finalize("NODE-A")
        self.assertEqual(result["status"], "rejected")
        node = self.eng.node("NODE-A")
        self.assertEqual(node["status"], "ready")
        self.assertEqual(node["attempts"], 1)


class TestNodeFlowStrict(EngineTestBase):
    """strict=1 回归：验证器已注册 + 写盘字节=sha 字节 → 不再 verifier_unregistered / sha_mismatch。"""

    def setUp(self):
        super().setUp()
        db.set_evidence_strict(self.eng.conn, True)

    def test_strict_flow_reaches_done_with_registered_verifier(self):
        self.add("NODE-A", stage="design")
        self.eng.bootstrap()
        lease = self.eng.claim("NODE-A", ttl_sec=600, now=1000)
        path, sha = _artifact(self.root, "NODE-A")
        self.eng.add_artifact(
            artifact_id="ART-A", path=path, sha256=sha, producer_node="NODE-A"
        )
        self.eng.add_evidence(
            evidence_id="EVD-A", node_id="NODE-A", kind="artifact",
            artifact_id="ART-A", verifier_id=WORKFLOW_VERIFIER, verdict="pass",
        )
        stages.pass_gate(self.eng.conn, "design", ["EVD-A"])
        self.eng.submit("NODE-A", "tester", lease["fencing_token"], now=1001)
        result = self.eng.finalize("NODE-A")
        self.assertEqual(result["status"], "done", result)

    def test_strict_rejects_unregistered_verifier(self):
        self.add("NODE-A", stage="build")
        self.eng.bootstrap()
        lease = self.eng.claim("NODE-A", ttl_sec=600, now=1000)
        path, sha = _artifact(self.root, "NODE-A")
        self.eng.add_artifact(
            artifact_id="ART-A", path=path, sha256=sha, producer_node="NODE-A"
        )
        # strict 的拒绝点：add_evidence 即拒（UnknownVerifier），证据不落库
        with self.assertRaises(evidence.UnknownVerifier):
            self.eng.add_evidence(
                evidence_id="EVD-X", node_id="NODE-A", kind="artifact",
                artifact_id="ART-A", verifier_id="verifier-unregistered", verdict="pass",
            )
        self.eng.submit("NODE-A", "tester", lease["fencing_token"], now=1001)
        stages.pass_gate(self.eng.conn, "build")
        result = self.eng.finalize("NODE-A")
        self.assertEqual(result["status"], "rejected")
        # 未注册验证器的证据根本没落库 → 无证据可验
        self.assertEqual(result["reason"], "no_evidence")

    def test_strict_detects_crlf_sha_mismatch(self):
        """反证：若按 CRLF 翻译后的字节登记 sha，strict 复核必须拒（artifact_invalid/sha_mismatch）。"""
        self.add("NODE-A", stage="build")
        self.eng.bootstrap()
        lease = self.eng.claim("NODE-A", ttl_sec=600, now=1000)
        p = self.root / "CRLF.txt"
        p.write_bytes(ART_TEXT.replace("\n", "\r\n").encode("utf-8"))
        wrong_sha = hashlib.sha256(ART_TEXT.encode("utf-8")).hexdigest()  # 按 \n 算
        self.eng.add_artifact(
            artifact_id="ART-CRLF", path=str(p), sha256=wrong_sha, producer_node="NODE-A"
        )
        self.eng.add_evidence(
            evidence_id="EVD-CRLF", node_id="NODE-A", kind="artifact",
            artifact_id="ART-CRLF", verifier_id=WORKFLOW_VERIFIER, verdict="pass",
        )
        stages.pass_gate(self.eng.conn, "build", ["EVD-CRLF"])
        self.eng.submit("NODE-A", "tester", lease["fencing_token"], now=1001)
        result = self.eng.finalize("NODE-A")
        self.assertEqual(result["status"], "rejected")
        # B 侧可能报 sha_mismatch（单条直接用 check reason）或 artifact_invalid（聚合）
        self.assertIn(result["reason"], ("sha_mismatch", "artifact_invalid"))
        if result.get("detail", {}).get("artifacts"):
            self.assertEqual(result["detail"]["artifacts"][0]["reason"], "sha_mismatch")


if __name__ == "__main__":
    unittest.main()
