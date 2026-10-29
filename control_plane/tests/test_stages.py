# -*- coding: utf-8 -*-
"""R7 单元测试：阶段闸门 + replan 版本。"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from control_plane import db, evidence, graph, leases, stages  # noqa: E402

SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"


class TestStages(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")
        # strict 模式（meta evidence_strict=1）下验证器必须可解析；显式注册，不改默认值。
        evidence.register_verifier(self.conn, "verifier-1", kind="ci", role="ROLE-AUDIT-01")

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def test_set_pass_fail_and_validation(self):
        self.assertIsNone(stages.get_gate(self.conn, "build"))
        gate = stages.pass_gate(self.conn, "build", ["EVD-001"])
        self.assertEqual(gate["status"], "passed")
        self.assertEqual(gate["evidence_refs"], ["EVD-001"])
        self.assertEqual(stages.fail_gate(self.conn, "audit")["status"], "failed")
        self.assertEqual(len(stages.list_gates(self.conn)), 2)
        with self.assertRaises(stages.StageError):
            stages.set_gate(self.conn, "unknown", "passed")
        with self.assertRaises(stages.StageError):
            stages.set_gate(self.conn, "build", "done")

    def test_gate_allows_done(self):
        self.assertTrue(stages.gate_allows_done(self.conn, None))
        self.assertFalse(stages.gate_allows_done(self.conn, "build"))
        stages.pass_gate(self.conn, "build")
        self.assertTrue(stages.gate_allows_done(self.conn, "build"))

    def test_done_blocked_until_gate_passes(self):
        graph.add_node(
            self.conn, node_id="NODE-001", title="t", spec="s", status="ready",
            stage="build", evidence_required=["test"], verifier_ids=["verifier-1"],
        )
        evidence.add_artifact(
            self.conn, artifact_id="ART-001", path="out/x", sha256=SHA, producer_node="NODE-001"
        )
        lease = leases.claim(self.conn, "NODE-001", "agent-A", ttl_sec=60, now=1000)
        evidence.submit(self.conn, "NODE-001", "agent-A", lease["fencing_token"], now=1001)
        evidence.add_evidence(
            self.conn, evidence_id="EVD-001", node_id="NODE-001", kind="test",
            artifact_id="ART-001", verifier_id="verifier-1", verdict="pass",
        )
        result = evidence.finalize(self.conn, "NODE-001")
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(result["reason"], "gate_not_passed")
        self.assertEqual(graph.get_node(self.conn, "NODE-001")["status"], "ready")

        stages.pass_gate(self.conn, "build", ["EVD-001"])
        lease2 = leases.claim(self.conn, "NODE-001", "agent-A", ttl_sec=60, now=1002)
        evidence.submit(self.conn, "NODE-001", "agent-A", lease2["fencing_token"], now=1003)
        result2 = evidence.finalize(self.conn, "NODE-001")
        self.assertEqual(result2["status"], "done")

    def test_version_and_record_replan(self):
        self.assertEqual(stages.current_version(self.conn), 1)
        rec = stages.record_replan(
            self.conn, reason="scope_change", added_nodes=["NODE-009"], removed_nodes=[], note="加一个节点"
        )
        self.assertEqual(rec["graph_version"], 2)
        self.assertEqual(stages.current_version(self.conn), 2)
        row = self.conn.execute("SELECT * FROM replan_events WHERE event_id=?", (rec["event_id"],)).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["reason"], "scope_change")
        with self.assertRaises(stages.StageError):
            stages.record_replan(self.conn, reason="nonsense")

    def test_apply_replan(self):
        rec = stages.apply_replan(
            self.conn,
            reason="failure_retry",
            add=[{"node_id": "NODE-001", "title": "new", "spec": "s"}],
            note="补充节点",
        )
        self.assertEqual(rec["graph_version"], 2)
        self.assertEqual(graph.get_node(self.conn, "NODE-001")["title"], "new")
        rec2 = stages.apply_replan(self.conn, reason="scope_change", remove=["NODE-001"])
        self.assertEqual(rec2["graph_version"], 3)
        self.assertIsNone(graph.get_node(self.conn, "NODE-001"))


if __name__ == "__main__":
    unittest.main()
