# -*- coding: utf-8 -*-
"""R3 单元测试：ready 计算与依赖门控（由 done 事件触发）。"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from control_plane import db, events, evidence, graph, scheduler  # noqa: E402

SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"


class TestReady(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def _events(self, kind=None):
        return [e for e in events.iter_events(self.conn) if kind is None or e["kind"] == kind]

    def _mint(self, nid):
        evidence.add_artifact(
            self.conn, artifact_id="ART-%s" % nid, path="out/%s.txt" % nid,
            sha256=SHA, producer_node=nid,
        )
        evidence.add_evidence(
            self.conn, evidence_id="EVD-%s" % nid, node_id=nid, kind="artifact",
            artifact_id="ART-%s" % nid, verifier_id="verifier-ci", verdict="pass",
        )
        return graph.done_credential(self.conn, nid)

    def _done_event(self):
        return [e for e in self._events("status_changed") if e["payload"].get("to") == "done"][-1]

    def test_root_promotes_bootstrap(self):
        graph.add_node(self.conn, node_id="NODE-001", title="root", spec="s")
        self.assertEqual(scheduler.bootstrap(self.conn), ["NODE-001"])
        self.assertEqual(scheduler.ready_set(self.conn), ["NODE-001"])

    def test_dependent_waits_until_done_event(self):
        graph.add_node(self.conn, node_id="NODE-001", title="a", spec="s", status="verifying")
        graph.add_node(self.conn, node_id="NODE-002", title="b", spec="s", deps=["NODE-001"])
        self.assertEqual(scheduler.recompute_ready(self.conn), [])
        self.assertEqual(scheduler.ready_set(self.conn), [])

        graph.set_status(
            self.conn, "NODE-001", "done", credential=self._mint("NODE-001"),
            reason="evidence_ok", notify=False,
        )
        # 不调用 on_event 时不会推进
        self.assertEqual(scheduler.ready_set(self.conn), [])
        # 只有 done 事件触发才推进
        done_event = self._done_event()
        promoted = scheduler.on_event(self.conn, done_event)
        self.assertEqual(promoted, ["NODE-002"])
        self.assertEqual(scheduler.ready_set(self.conn), ["NODE-002"])

    def test_done_single_entry_auto_promotes(self):
        """唯一入口 set_status(done) 默认 notify=True：自动解锁下游（不再依赖调用方记得 on_event）。"""
        graph.add_node(self.conn, node_id="NODE-001", title="a", spec="s", status="verifying")
        graph.add_node(self.conn, node_id="NODE-002", title="b", spec="s", deps=["NODE-001"])
        graph.set_status(
            self.conn, "NODE-001", "done", credential=self._mint("NODE-001"), reason="evidence_ok"
        )
        self.assertEqual(scheduler.ready_set(self.conn), ["NODE-002"])
        self.assertEqual(self._events("ready_recomputed")[-1]["payload"]["reason"], "dependency_done")

    def test_fake_ready_demoted(self):
        graph.add_node(self.conn, node_id="NODE-001", title="a", spec="s", status="running")
        graph.add_node(self.conn, node_id="NODE-002", title="b", spec="s", deps=["NODE-001"])
        graph.set_status(self.conn, "NODE-002", "ready")  # 绕过门控制造假 ready
        promoted = scheduler.recompute_ready(self.conn)
        self.assertEqual(promoted, [])
        self.assertEqual(graph.get_node(self.conn, "NODE-002")["status"], "planned")
        rec = self._events("ready_recomputed")[-1]
        self.assertEqual(rec["payload"]["demoted"], ["NODE-002"])

    def test_recompute_idempotent_when_no_change(self):
        graph.add_node(self.conn, node_id="NODE-001", title="root", spec="s")
        scheduler.bootstrap(self.conn)
        before = len(self._events())
        scheduler.recompute_ready(self.conn)
        self.assertEqual(len(self._events()), before)

    def test_ready_reason_recorded(self):
        graph.add_node(self.conn, node_id="NODE-001", title="a", spec="s", status="verifying")
        graph.add_node(self.conn, node_id="NODE-002", title="b", spec="s", deps=["NODE-001"])
        graph.set_status(
            self.conn, "NODE-001", "done", credential=self._mint("NODE-001"),
            reason="evidence_ok", notify=False,
        )
        done_event = self._done_event()
        scheduler.on_event(self.conn, done_event)
        rec = self._events("ready_recomputed")[-1]
        self.assertEqual(rec["payload"]["reason"], "dependency_done")

    def test_recompute_goes_through_single_entry_and_replays(self):
        """WP-01/02：ready 重算走 graph.set_status，且 from 取真实前态、snapshot==replay。"""
        graph.add_node(self.conn, node_id="NODE-001", title="a", spec="s", status="running")
        graph.add_node(self.conn, node_id="NODE-002", title="b", spec="s", deps=["NODE-001"])
        graph.set_status(self.conn, "NODE-002", "ready")  # 假 ready，等待被降级
        scheduler.recompute_ready(self.conn)
        ev = [e for e in events.iter_events(self.conn)
              if e["kind"] == "status_changed" and e["payload"]["to"] == "planned"][-1]
        self.assertEqual(ev["payload"]["from"], "ready")
        self.assertEqual(ev["payload"]["reason"], "deps_not_done")
        staged = [e for e in events.iter_events(self.conn)
                  if e["kind"] == "status_changed" and e["payload"]["to"] == "ready"]
        self.assertEqual(staged[0]["payload"]["from"], "planned")
        self.assertEqual(graph.snapshot(self.conn), graph.replay_snapshot(self.conn))
        self.assertEqual(graph.replay_mismatches(self.conn), [])

    def test_scheduler_module_has_no_direct_status_write(self):
        src = Path(scheduler.__file__).read_text(encoding="utf-8")
        self.assertNotIn("UPDATE tasks SET", src)


if __name__ == "__main__":
    unittest.main()
