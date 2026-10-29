# -*- coding: utf-8 -*-
"""R11 单元测试：崩溃恢复 / 从稳定点续 / 重放一致性。"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from control_plane import db, events, evidence, graph, leases, recovery  # noqa: E402

SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"


class TestRecovery(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def _add(self, nid, status="ready"):
        graph.add_node(
            self.conn, node_id=nid, title=nid, spec="s", status=status,
            evidence_required=["artifact"], verifier_ids=["verifier-ci"],
        )

    def _mint(self, nid, kind="artifact"):
        """按库内证据铸造 done 凭证（WP-01：无凭证不得 done）。"""
        evidence.add_artifact(
            self.conn, artifact_id="ART-%s" % nid, path="out/%s.txt" % nid,
            sha256=SHA, producer_node=nid, verifier_ids=["verifier-ci"],
        )
        evidence.add_evidence(
            self.conn, evidence_id="EVD-%s" % nid, node_id=nid, kind=kind,
            artifact_id="ART-%s" % nid, verifier_id="verifier-ci", verdict="pass",
        )
        cred = graph.done_credential(self.conn, nid)
        self.assertIsNotNone(cred, "凭证铸造失败：%s" % nid)
        return cred

    def _lease_row(self, nid, owner="agent-A", expires_at=100000.0):
        """直接落一行租约（D2 白名单里没有 claimed→running，模拟运行中崩溃时用构造+租约行）。"""
        self.conn.execute(
            "INSERT OR REPLACE INTO leases(node_id,owner,fencing_token,expires_at,heartbeat_at)"
            " VALUES(?,?,1,?,1000.0)",
            (nid, owner, expires_at),
        )
        self.conn.commit()

    def test_snapshot_matches_replay_after_done(self):
        self._add("NODE-001", status="verifying")
        graph.set_status(
            self.conn, "NODE-001", "done", credential=self._mint("NODE-001"), reason="evidence_ok"
        )
        self.assertEqual(graph.snapshot(self.conn), graph.replay_snapshot(self.conn))
        result = recovery.recover(self.conn, now=1000)
        self.assertFalse(result["mismatch"])
        self.assertIn("NODE-001", result["stable_nodes"])
        self.assertIsNotNone(result["last_done_event"])

    def test_running_node_reset_to_ready(self):
        self._add("NODE-001", status="running")   # 运行中崩溃：节点已 running、租约还在
        self._lease_row("NODE-001")
        result = recovery.recover(self.conn, now=2000)
        self.assertEqual(result["recovered"][0]["reason"], "crash_intermediate")
        node = graph.get_node(self.conn, "NODE-001")
        self.assertEqual(node["status"], "ready")
        self.assertEqual(node["attempts"], 1)
        self.assertIsNone(leases.current_lease(self.conn, "NODE-001"))

    def test_submitted_without_evidence_reset(self):
        self._add("NODE-001")
        lease = leases.claim(self.conn, "NODE-001", "agent-A", ttl_sec=100000, now=1000)
        self.conn.execute("UPDATE tasks SET status='submitted' WHERE node_id='NODE-001'")
        self.conn.commit()
        result = recovery.recover(self.conn, now=2000)
        self.assertEqual(result["recovered"][0]["reason"], "incomplete_evidence")
        self.assertEqual(graph.get_node(self.conn, "NODE-001")["status"], "ready")

    def test_submitted_with_complete_evidence_kept(self):
        self._add("NODE-001")
        leases.claim(self.conn, "NODE-001", "agent-A", ttl_sec=100000, now=1000)
        self.conn.execute("UPDATE tasks SET status='submitted' WHERE node_id='NODE-001'")
        self.conn.execute(
            "INSERT INTO artifacts(artifact_id,path,sha256,producer_node) VALUES('ART-001','p',?, 'NODE-001')",
            (SHA,),
        )
        self.conn.execute(
            "INSERT INTO evidence(evidence_id,node_id,kind,artifact_id,verifier_id,verdict,at)"
            " VALUES('EVD-001','NODE-001','artifact','ART-001','verifier-ci','pass',?)",
            (db.now_iso(),),
        )
        self.conn.commit()
        result = recovery.recover(self.conn, now=2000)
        self.assertEqual(result["recovered"], [])
        self.assertEqual(graph.get_node(self.conn, "NODE-001")["status"], "submitted")

    def test_done_nodes_preserved(self):
        self._add("NODE-001", status="verifying")
        graph.set_status(
            self.conn, "NODE-001", "done", credential=self._mint("NODE-001"), reason="evidence_ok"
        )
        self._add("NODE-002")
        leases.claim(self.conn, "NODE-002", "agent-B", ttl_sec=10, now=1000)
        recovery.recover(self.conn, now=1011)
        self.assertEqual(graph.get_node(self.conn, "NODE-001")["status"], "done")
        self.assertEqual(graph.get_node(self.conn, "NODE-002")["status"], "ready")

    def test_recover_idempotent(self):
        self._add("NODE-001", status="running")
        recovery.recover(self.conn, now=1000)
        before = len(events.iter_events(self.conn))
        result = recovery.recover(self.conn, now=1001)
        self.assertEqual(result["recovered"], [])
        self.assertEqual(len(events.iter_events(self.conn)), before)

    def test_reopen_after_crash(self):
        self._add("NODE-001", status="running")
        self._lease_row("NODE-001")
        path = self.conn.execute("PRAGMA database_list").fetchone()["file"]
        self.conn.commit()
        self.conn.close()
        self.conn = db.init_db(path)
        result = recovery.recover(self.conn, now=2000)
        self.assertEqual(graph.get_node(self.conn, "NODE-001")["status"], "ready")
        self.assertFalse(result["mismatch"])

    # ---- WP-01/02：recover 走唯一入口 + 全量 replay 对齐 ----

    def _status_events(self):
        return [e for e in events.iter_events(self.conn) if e["kind"] == "status_changed"]

    def test_recover_uses_real_prev_status(self):
        """恢复事件的 from 必须是真实前态，不能是字面量 "intermediate"。"""
        self._add("NODE-001", status="running")
        self._lease_row("NODE-001")
        recovery.recover(self.conn, now=2000)
        ev = self._status_events()[-1]
        self.assertEqual((ev["payload"]["from"], ev["payload"]["to"]), ("running", "ready"))
        self.assertEqual(ev["payload"]["attempts"], 1)
        self.assertEqual(ev["payload"]["reason"], "recovered:crash_intermediate")
        self.assertIsNone(ev["payload"]["assignee"])

    def test_recover_replay_aligned(self):
        self._add("NODE-001")
        leases.claim(self.conn, "NODE-001", "agent-A", ttl_sec=10, now=1000)
        self._add("NODE-002", status="running")
        self._lease_row("NODE-002", owner="agent-B")
        result = recovery.recover(self.conn, now=1011)
        self.assertFalse(result["mismatch"], result["mismatch_detail"])
        self.assertEqual(result["mismatch_detail"], [])
        self.assertEqual(graph.snapshot(self.conn), graph.replay_snapshot(self.conn))

    def test_recover_detects_and_reports_mismatch(self):
        """物化视图被外部改动：恢复要留痕并给出逐字段差异，不静默。"""
        self._add("NODE-001", status="verifying")
        graph.set_status(
            self.conn, "NODE-001", "done", credential=self._mint("NODE-001"), reason="evidence_ok"
        )
        self.conn.execute("UPDATE tasks SET attempts=99 WHERE node_id='NODE-001'")
        self.conn.commit()
        result = recovery.recover(self.conn, now=2000)
        self.assertTrue(result["mismatch"])
        self.assertTrue(any(d["field"] == "attempts" for d in result["mismatch_detail"]))
        kinds = [e["kind"] for e in events.iter_events(self.conn)]
        self.assertIn("recovery_mismatch", kinds)

    def test_recovery_module_has_no_direct_status_write(self):
        src = Path(recovery.__file__).read_text(encoding="utf-8")
        self.assertNotIn("UPDATE tasks SET", src)

    # ---- WP-04：recover 补推 ready ----

    def test_recover_promotes_downstream_ready(self):
        """上游已 done、下游还停在 planned（done 事件在崩溃前丢失）→ 恢复必须补推 ready。"""
        self._add("NODE-A", status="verifying")
        graph.set_status(
            self.conn, "NODE-A", "done", credential=self._mint("NODE-A"), reason="evidence_ok"
        )
        graph.add_node(self.conn, node_id="NODE-B", title="b", spec="s", deps=["NODE-A"])
        self.assertEqual(graph.get_node(self.conn, "NODE-B")["status"], "planned")
        result = recovery.recover(self.conn, now=2000)
        self.assertEqual(result["promoted"], ["NODE-B"])
        self.assertEqual(graph.get_node(self.conn, "NODE-B")["status"], "ready")
        rec = [e for e in events.iter_events(self.conn) if e["kind"] == "ready_recomputed"][-1]
        self.assertEqual(rec["payload"]["reason"], "recovery")
        self.assertEqual(graph.snapshot(self.conn), graph.replay_snapshot(self.conn))

    def test_recover_keeps_downstream_blocked_when_dep_pending(self):
        graph.add_node(self.conn, node_id="NODE-A", title="a", spec="s", status="running")
        graph.add_node(self.conn, node_id="NODE-B", title="b", spec="s", deps=["NODE-A"])
        result = recovery.recover(self.conn, now=2000)
        self.assertNotIn("NODE-B", result["promoted"])
        self.assertEqual(graph.get_node(self.conn, "NODE-B")["status"], "planned")

    def test_recover_twice_is_idempotent_with_promoted(self):
        self._add("NODE-A", status="verifying")
        graph.set_status(
            self.conn, "NODE-A", "done", credential=self._mint("NODE-A"), reason="evidence_ok"
        )
        graph.add_node(self.conn, node_id="NODE-B", title="b", spec="s", deps=["NODE-A"])
        recovery.recover(self.conn, now=2000)
        before = len(events.iter_events(self.conn))
        second = recovery.recover(self.conn, now=2001)
        self.assertEqual(second["promoted"], [])
        self.assertEqual(second["recovered"], [])
        self.assertEqual(len(events.iter_events(self.conn)), before)


if __name__ == "__main__":
    unittest.main()
