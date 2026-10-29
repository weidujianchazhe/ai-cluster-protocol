# -*- coding: utf-8 -*-
"""R2 单元测试：事件日志 append / replay / 唯一性。"""

import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from control_plane import db, events, evidence, graph, leases, recovery  # noqa: E402

SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"


class TestEvents(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def test_append_auto_ids_and_order(self):
        e1 = events.append_event(self.conn, "graph_created", payload={"goal": "x"})
        e2 = events.append_event(self.conn, "node_added", "NODE-001", {"node": {"node_id": "NODE-001"}})
        self.assertEqual(e1["event_id"], "EVT-000001")
        self.assertEqual(e2["event_id"], "EVT-000002")
        self.assertEqual([e["seq"] for e in events.iter_events(self.conn)], [1, 2])
        self.assertEqual(events.count(self.conn), 2)

    def test_custom_event_id_and_ts(self):
        ev = events.append_event(
            self.conn, "custom", ts="2026-10-29T00:00:00+08:00", event_id="EVT-CUSTOM-1"
        )
        self.assertEqual(ev["event_id"], "EVT-CUSTOM-1")
        row = events.iter_events(self.conn)[0]
        self.assertEqual(row["ts"], "2026-10-29T00:00:00+08:00")
        self.assertEqual(row["payload"], {})

    def test_duplicate_event_id_rejected(self):
        events.append_event(self.conn, "a", event_id="EVT-DUP")
        with self.assertRaises(sqlite3.IntegrityError):
            events.append_event(self.conn, "b", event_id="EVT-DUP")

    def test_after_seq_filter(self):
        for _ in range(3):
            events.append_event(self.conn, "tick")
        rest = events.iter_events(self.conn, after_seq=1)
        self.assertEqual([e["seq"] for e in rest], [2, 3])

    def test_empty_kind_rejected(self):
        with self.assertRaises(ValueError):
            events.append_event(self.conn, "")


class TestValidateStream(unittest.TestCase):
    """WP-02：事件流体检 —— 坏事件要被检出，不能静默进入 replay。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def test_clean_stream_ok(self):
        events.append_event(self.conn, "graph_created", payload={"goal": "x"})
        events.append_event(self.conn, "status_changed", "N1", {"from": "planned", "to": "ready", "at": "t"})
        report = events.validate_stream(self.conn)
        self.assertTrue(report["ok"])
        self.assertEqual(report["events"], 2)
        self.assertEqual(report["issues"], [])

    def test_bad_status_event_detected(self):
        self.conn.execute(
            "INSERT INTO events(event_id,ts,kind,node_id,payload_json)"
            " VALUES('EVT-BAD','2026-10-29T00:00:00+08:00','status_changed','N1','{}')"
        )
        self.conn.commit()
        report = events.validate_stream(self.conn)
        self.assertFalse(report["ok"])
        issue = report["issues"][0]
        self.assertEqual(issue["problem"], "missing_payload_fields")
        self.assertEqual(issue["fields"], ["from", "to", "at"])

    def test_missing_ts_detected(self):
        self.conn.execute(
            "INSERT INTO events(event_id,ts,kind,node_id,payload_json) VALUES('EVT-X','','tick','N1','{}')"
        )
        self.conn.commit()
        report = events.validate_stream(self.conn)
        self.assertFalse(report["ok"])
        self.assertTrue(any(i["problem"] == "missing_ts" for i in report["issues"]))


class TestLifecycleReplayAlignment(unittest.TestCase):
    """WP-02：claim → renew → expire → recover → reject → done → replan 全程 snapshot == replay。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")
        # strict 模式（meta evidence_strict=1）下验证器必须可解析，否则 add_evidence/finalize 会被拒。
        # 显式注册让本夹具在两种模式下同语义；不改默认值。
        evidence.register_verifier(self.conn, "verifier-ci", kind="ci", role="ROLE-AUDIT-01")

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def _assert_aligned(self, step):
        snap = graph.snapshot(self.conn)
        rep = graph.replay_snapshot(self.conn)
        self.assertEqual(snap, rep, "replay 不一致 @ %s：%s" % (step, graph.replay_mismatches(self.conn)))
        self.assertEqual(graph.replay_mismatches(self.conn), [], "mismatch @ %s" % step)
        self.assertTrue(events.validate_stream(self.conn)["ok"], "坏事件 @ %s" % step)

    def test_full_lifecycle_stays_aligned(self):
        graph.add_node(
            self.conn, node_id="NODE-A", title="a", spec="s", status="ready",
            evidence_required=["artifact"], verifier_ids=["verifier-ci"],
        )
        graph.add_node(self.conn, node_id="NODE-B", title="b", spec="s", deps=["NODE-A"])
        graph.add_node(self.conn, node_id="NODE-C", title="c", spec="s", deps=["NODE-A"])
        self._assert_aligned("add_nodes")

        lease = leases.claim(self.conn, "NODE-A", "agent-A", ttl_sec=10, now=1000)
        self._assert_aligned("claim")
        leases.renew(self.conn, "NODE-A", "agent-A", lease["fencing_token"], ttl_sec=10, now=1005)
        self._assert_aligned("renew")
        recovery.recover(self.conn, now=1020)          # 租约过期 → ready + attempts 1 + 补推
        self._assert_aligned("recover_expired")

        lease = leases.claim(self.conn, "NODE-A", "agent-B", ttl_sec=100000, now=1030)
        evidence.submit(self.conn, "NODE-A", "agent-B", lease["fencing_token"], now=1031)
        self._assert_aligned("submit")
        rejected = evidence.finalize(self.conn, "NODE-A")   # 无证据 → 驳回回 ready + attempts 2
        self.assertEqual(rejected["status"], "rejected")
        self._assert_aligned("reject")

        evidence.add_artifact(
            self.conn, artifact_id="ART-A", path="out/a.txt", sha256=SHA, producer_node="NODE-A",
        )
        evidence.add_evidence(
            self.conn, evidence_id="EVD-A", node_id="NODE-A", kind="artifact",
            artifact_id="ART-A", verifier_id="verifier-ci", verdict="pass",
        )
        lease = leases.claim(self.conn, "NODE-A", "agent-B", ttl_sec=100000, now=1040)
        evidence.submit(self.conn, "NODE-A", "agent-B", lease["fencing_token"], now=1041)
        done = evidence.finalize(self.conn, "NODE-A")
        self.assertEqual(done["status"], "done")
        self._assert_aligned("done")
        self.assertEqual(graph.get_node(self.conn, "NODE-B")["status"], "ready")
        self.assertEqual(graph.get_node(self.conn, "NODE-C")["status"], "ready")

        rec = graph.replan(
            self.conn, reason="scope_change",
            add=[{"node_id": "NODE-D", "title": "d", "spec": "s", "deps": ["NODE-A"]}],
            note="补文档",
        )
        self.assertEqual(rec["promoted"], ["NODE-D"])
        self._assert_aligned("replan")

        final = recovery.recover(self.conn, now=2000)
        self.assertFalse(final["mismatch"], final["mismatch_detail"])
        self.assertTrue(final["event_stream_ok"])
        self._assert_aligned("final_recover")

    def test_verifier_is_registered_for_strict_mode(self):
        """注册后 strict=1 的拒绝理由不得再是 `verifier_unregistered`（验证器身份已可解析）。"""
        self.assertEqual(evidence.resolve_verifier(self.conn, "verifier-ci")["resolved"], True)
        db.set_evidence_strict(self.conn, True)
        graph.add_node(
            self.conn, node_id="NODE-S", title="s", spec="s", status="ready",
            evidence_required=["artifact"], verifier_ids=["verifier-ci"],
        )
        evidence.add_artifact(self.conn, artifact_id="ART-S", path="out/s.txt", sha256=SHA,
                              producer_node="NODE-S")
        # strict 下 add_evidence 不再因身份不可解析而抛错
        evidence.add_evidence(self.conn, evidence_id="EVD-S", node_id="NODE-S", kind="artifact",
                              artifact_id="ART-S", verifier_id="verifier-ci", verdict="pass")
        lease = leases.claim(self.conn, "NODE-S", "agent-S", ttl_sec=100, now=1000)
        evidence.submit(self.conn, "NODE-S", "agent-S", lease["fencing_token"], now=1001)
        result = evidence.finalize(self.conn, "NODE-S")
        self.assertNotEqual(result.get("reason"), "verifier_unregistered", result)
        self.assertNotEqual(graph.get_node(self.conn, "NODE-S")["status"], "done")
        db.set_evidence_strict(self.conn, False)


if __name__ == "__main__":
    unittest.main()
