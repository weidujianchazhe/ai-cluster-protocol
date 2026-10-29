# -*- coding: utf-8 -*-
"""R2 单元测试：工作图 CRUD + 事件同步 + replay 重建。"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from control_plane import db, events, evidence, graph  # noqa: E402

SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"


class TestGraph(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def test_add_get_and_duplicate(self):
        node = graph.add_node(
            self.conn,
            node_id="NODE-001",
            title="t",
            spec="s",
            capability="research",
            stage="research",
            evidence_required=["note"],
        )
        self.assertEqual(node["status"], "planned")
        self.assertEqual(node["capability"], "research")
        self.assertEqual(graph.get_node(self.conn, "NODE-001")["spec"], "s")
        with self.assertRaises(ValueError):
            graph.add_node(self.conn, node_id="NODE-001", title="t2", spec="s2")

    def test_dependency_and_edges(self):
        graph.add_node(self.conn, node_id="NODE-001", title="a", spec="s")
        graph.add_node(self.conn, node_id="NODE-002", title="b", spec="s", deps=["NODE-001"])
        self.assertEqual(graph.dependencies(self.conn, "NODE-002"), ["NODE-001"])
        kinds = {(e["from"], e["to"], e["kind"]) for e in graph.edges(self.conn)}
        self.assertIn(("NODE-001", "NODE-002", "blocks"), kinds)
        with self.assertRaises(ValueError):
            graph.add_node(self.conn, node_id="NODE-003", title="c", spec="s", deps=["NODE-404"])

    def test_status_change_and_event(self):
        graph.add_node(self.conn, node_id="NODE-001", title="t", spec="s")
        graph.set_status(self.conn, "NODE-001", "ready")  # D2 白名单：planned → ready
        self.assertEqual(graph.get_node(self.conn, "NODE-001")["status"], "ready")
        kinds = [e["kind"] for e in events.iter_events(self.conn)]
        self.assertIn("status_changed", kinds)
        with self.assertRaises(ValueError):
            graph.set_status(self.conn, "NODE-001", "finished")

    def test_snapshot_matches_replay(self):
        graph.add_node(self.conn, node_id="NODE-001", title="a", spec="s", stage="build")
        graph.add_node(self.conn, node_id="NODE-002", title="b", spec="s", deps=["NODE-001"])
        graph.add_edge(self.conn, "NODE-001", "NODE-002", "artifact")
        graph.set_status(self.conn, "NODE-001", "ready")  # D2 白名单：planned → ready
        self.assertEqual(graph.snapshot(self.conn), graph.replay_snapshot(self.conn))

    def test_remove_node_rebuilds(self):
        graph.add_node(self.conn, node_id="NODE-001", title="a", spec="s")
        graph.add_node(self.conn, node_id="NODE-002", title="b", spec="s", deps=["NODE-001"])
        graph.remove_node(self.conn, "NODE-002")
        self.assertIsNone(graph.get_node(self.conn, "NODE-002"))
        self.assertEqual(graph.dependencies(self.conn, "NODE-001"), [])
        self.assertEqual(graph.snapshot(self.conn), graph.replay_snapshot(self.conn))

    def test_replay_after_reopen(self):
        graph.add_node(self.conn, node_id="NODE-001", title="a", spec="s")
        graph.set_status(self.conn, "NODE-001", "ready")
        self.conn.commit()
        path = self.conn.execute("PRAGMA database_list").fetchone()["file"]
        self.conn.close()
        self.conn = db.init_db(path)
        self.assertEqual(graph.replay_snapshot(self.conn)["nodes"]["NODE-001"]["status"], "ready")
        self.assertEqual(graph.snapshot(self.conn), graph.replay_snapshot(self.conn))


class TestStatusMachine(unittest.TestCase):
    """WP-01：状态机唯一入口 —— 凭证闸门 / 真实前态 / 事件化 assignee+attempts / 写期环检测。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def _add(self, nid, *, status="ready", deps=None, required=None, verifiers=None, stage=None):
        return graph.add_node(
            self.conn, node_id=nid, title=nid, spec="s", status=status, deps=deps or [],
            evidence_required=required if required is not None else ["artifact"],
            verifier_ids=verifiers if verifiers is not None else ["verifier-ci"], stage=stage,
        )

    def _mint(self, nid, kind="artifact", verdict="pass", verifier="verifier-ci"):
        evidence.add_artifact(
            self.conn, artifact_id="ART-%s" % nid, path="out/%s.txt" % nid,
            sha256=SHA, producer_node=nid, verifier_ids=[verifier],
        )
        evidence.add_evidence(
            self.conn, evidence_id="EVD-%s" % nid, node_id=nid, kind=kind,
            artifact_id="ART-%s" % nid, verifier_id=verifier, verdict=verdict,
        )
        return "EVD-%s" % nid

    # ---- done 凭证 -----------------------------------------------------

    def test_done_without_credential_rejected(self):
        self._add("NODE-001", status="verifying")  # D2：done 的合法前态是 verifying
        with self.assertRaises(graph.CredentialError):
            graph.set_status(self.conn, "NODE-001", "done")
        self.assertEqual(graph.get_node(self.conn, "NODE-001")["status"], "verifying")

    def test_done_with_credential_accepted(self):
        self._add("NODE-001", status="verifying")
        self._mint("NODE-001")
        cred = graph.done_credential(self.conn, "NODE-001")
        node = graph.set_status(self.conn, "NODE-001", "done", credential=cred, reason="evidence_ok")
        self.assertEqual(node["status"], "done")
        self.assertIsNone(node["assignee"])
        ev = [e for e in events.iter_events(self.conn) if e["kind"] == "status_changed"][-1]
        self.assertEqual(ev["payload"]["from"], "verifying")  # 真实前态，不是字面量
        self.assertEqual(ev["payload"]["to"], "done")
        self.assertEqual(ev["payload"]["evidence"], ["EVD-NODE-001"])

    def test_done_credential_rejects_failed_evidence(self):
        self._add("NODE-001", status="verifying")
        self._mint("NODE-001", verdict="fail")
        self.assertIsNone(graph.done_credential(self.conn, "NODE-001"))
        with self.assertRaises(graph.CredentialError):
            graph.set_status(
                self.conn, "NODE-001", "done", credential={"evidence": ["EVD-NODE-001"]}
            )

    def test_done_credential_rejects_missing_kind_and_foreign_verifier(self):
        self._add("NODE-001", status="verifying", required=["artifact", "test"])
        self._mint("NODE-001", kind="artifact")
        with self.assertRaises(graph.CredentialError):
            graph.set_status(self.conn, "NODE-001", "done", credential={"evidence": ["EVD-NODE-001"]})

        self._add("NODE-002", status="verifying", required=["artifact"])
        self._mint("NODE-002", verifier="intruder")
        with self.assertRaises(graph.CredentialError):
            graph.set_status(self.conn, "NODE-002", "done", credential={"evidence": ["EVD-NODE-002"]})

    def test_done_credential_rejects_unfinished_deps(self):
        self._add("NODE-001", status="running")
        self._add("NODE-002", status="verifying", deps=["NODE-001"])
        self._mint("NODE-002")
        with self.assertRaises(graph.CredentialError):
            graph.set_status(self.conn, "NODE-002", "done", credential={"evidence": ["EVD-NODE-002"]})

    def test_done_credential_rejects_empty_or_foreign(self):
        self._add("NODE-001", status="verifying")
        self._mint("NODE-001")
        for cred in ({}, {"evidence": []}, {"evidence": ["EVD-404"]}, {"evidence": ["EVD-NODE-001"], "node_id": "NODE-404"}):
            with self.assertRaises(graph.CredentialError):
                graph.set_status(self.conn, "NODE-001", "done", credential=cred)
        self.assertEqual(graph.get_node(self.conn, "NODE-001")["status"], "verifying")

    # ---- 真实前态 / 后像 / replay 对齐 ---------------------------------

    def test_status_event_carries_post_image_and_replays(self):
        self._add("NODE-001")
        graph.set_status(self.conn, "NODE-001", "claimed", assignee="agent-A", reason="lease_claimed")
        graph.set_status(
            self.conn, "NODE-001", "ready", assignee=None, attempts_delta=1, reason="lease_expired"
        )
        evs = [e for e in events.iter_events(self.conn) if e["kind"] == "status_changed"]
        self.assertEqual([(e["payload"]["from"], e["payload"]["to"]) for e in evs],
                         [("ready", "claimed"), ("claimed", "ready")])
        self.assertEqual(evs[-1]["payload"]["attempts"], 1)
        self.assertIsNone(evs[-1]["payload"]["assignee"])
        node = graph.get_node(self.conn, "NODE-001")
        self.assertEqual(node["attempts"], 1)
        self.assertIsNone(node["assignee"])
        self.assertEqual(graph.snapshot(self.conn), graph.replay_snapshot(self.conn))
        self.assertEqual(graph.replay_mismatches(self.conn), [])
        kinds = [e["kind"] for e in events.iter_events(self.conn)]
        self.assertIn("assignee_changed", kinds)
        self.assertIn("attempts_changed", kinds)

    def test_noop_same_status_writes_no_event(self):
        self._add("NODE-001")
        before = len(events.iter_events(self.conn))
        graph.set_status(self.conn, "NODE-001", "ready")
        self.assertEqual(len(events.iter_events(self.conn)), before)

    def test_illegal_status_and_missing_node(self):
        self._add("NODE-001")
        with self.assertRaises(graph.GraphError):
            graph.set_status(self.conn, "NODE-001", "finished")
        with self.assertRaises(graph.GraphError):
            graph.set_status(self.conn, "NODE-404", "ready")

    # ---- 写期环检测 ---------------------------------------------------

    def test_edge_cycle_rejected_at_write_time(self):
        self._add("NODE-A")
        self._add("NODE-B", deps=["NODE-A"])
        self._add("NODE-C", deps=["NODE-B"])
        with self.assertRaises(graph.CycleError):
            graph.add_edge(self.conn, "NODE-C", "NODE-A", "blocks")
        with self.assertRaises(graph.CycleError):
            graph.add_edge(self.conn, "NODE-A", "NODE-A", "blocks")
        # 非 blocks 边不受影响
        graph.add_edge(self.conn, "NODE-C", "NODE-A", "artifact")
        self.assertEqual(graph.detect_cycles(self.conn), [])
        self.assertEqual(graph.snapshot(self.conn), graph.replay_snapshot(self.conn))

    def test_set_edges_rejects_cycle_and_keeps_graph(self):
        self._add("NODE-A")
        self._add("NODE-B", deps=["NODE-A"])
        with self.assertRaises(graph.CycleError):
            graph.set_edges(self.conn, "NODE-A", ["NODE-B"])
        self.assertEqual(graph.dependencies(self.conn, "NODE-A"), [])
        with self.assertRaises(graph.GraphError):
            graph.set_edges(self.conn, "NODE-404", [])

    def test_set_edges_roundtrip_replay_aligned(self):
        self._add("NODE-A")
        self._add("NODE-B")
        self._add("NODE-C", deps=["NODE-A"])
        graph.set_edges(self.conn, "NODE-C", ["NODE-B"])
        self.assertEqual(graph.dependencies(self.conn, "NODE-C"), ["NODE-B"])
        self.assertEqual(graph.snapshot(self.conn), graph.replay_snapshot(self.conn))


class TestReplanAtomic(unittest.TestCase):
    """WP-04：`graph.replan()` 单事务 —— 增删 + 版本 + replan_events + 事件，全成或全不成。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")
        graph.add_node(
            self.conn, node_id="NODE-A", title="a", spec="s", status="verifying",
            evidence_required=["artifact"], verifier_ids=["verifier-ci"],
        )

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

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

    def _done(self, nid):
        # D2 白名单：verifying → done（唯一合法入边）
        graph.set_status(self.conn, nid, "done", credential=self._mint(nid), reason="evidence_ok")

    def test_replan_success_records_version_and_promotes(self):
        self._done("NODE-A")
        version_before = graph.current_graph_version(self.conn)
        rec = graph.replan(
            self.conn, reason="scope_change",
            add=[{"node_id": "NODE-B", "title": "b", "spec": "s", "deps": ["NODE-A"]}],
            note="补文档",
        )
        self.assertEqual(rec["graph_version"], version_before + 1)
        self.assertEqual(rec["event_id"], "EVT-R%04d" % rec["graph_version"])
        self.assertEqual(rec["added"], ["NODE-B"])
        self.assertIn("NODE-B", rec["promoted"])
        self.assertEqual(graph.get_node(self.conn, "NODE-B")["status"], "ready")
        row = self.conn.execute(
            "SELECT * FROM replan_events WHERE event_id=?", (rec["event_id"],)
        ).fetchone()
        self.assertEqual(row["reason"], "scope_change")
        self.assertEqual(db.loads(row["added_json"]), ["NODE-B"])
        self.assertEqual(graph.snapshot(self.conn), graph.replay_snapshot(self.conn))

    def test_replan_rolls_back_midway_failure(self):
        """第二笔 add 非法 → 第一笔也不落库（图 / 版本 / 事件全回滚）。"""
        version_before = graph.current_graph_version(self.conn)
        events_before = len(events.iter_events(self.conn))
        with self.assertRaises(ValueError):
            graph.replan(
                self.conn, reason="scope_change",
                add=[
                    {"node_id": "NODE-B", "title": "b", "spec": "s"},
                    {"node_id": "NODE-C", "title": "c", "spec": "s", "deps": ["NODE-404"]},
                ],
            )
        self.assertIsNone(graph.get_node(self.conn, "NODE-B"))
        self.assertEqual(graph.current_graph_version(self.conn), version_before)
        self.assertIsNone(
            self.conn.execute("SELECT 1 FROM replan_events WHERE removed_json='[]'").fetchone()
        )
        self.assertEqual(len(events.iter_events(self.conn)), events_before)
        self.assertEqual(graph.snapshot(self.conn), graph.replay_snapshot(self.conn))

    def test_replan_rollback_on_remove_failure_keeps_added(self):
        """先 add 再 remove 失败 → 两者都回滚（remove 校验失败时 add 不残留）。"""
        with self.assertRaises(graph.GraphError):
            graph.replan(
                self.conn, reason="scope_change",
                add=[{"node_id": "NODE-B", "title": "b", "spec": "s"}],
                remove=["NODE-404"],
            )
        self.assertIsNone(graph.get_node(self.conn, "NODE-B"))
        self.assertEqual(graph.current_graph_version(self.conn), 1)

    def test_replan_remove_replays(self):
        graph.add_node(self.conn, node_id="NODE-B", title="b", spec="s", deps=["NODE-A"])
        rec = graph.replan(self.conn, reason="failure_retry", remove=["NODE-B"])
        self.assertEqual(rec["removed"], ["NODE-B"])
        self.assertIsNone(graph.get_node(self.conn, "NODE-B"))
        self.assertEqual(graph.dependencies(self.conn, "NODE-A"), [])
        self.assertEqual(graph.snapshot(self.conn), graph.replay_snapshot(self.conn))

    def test_replan_rejects_illegal_reason_and_existing_node(self):
        with self.assertRaises(graph.GraphError):
            graph.replan(self.conn, reason="nonsense")
        with self.assertRaises(graph.GraphError):
            graph.replan(
                self.conn, reason="scope_change",
                add=[{"node_id": "NODE-A", "title": "dup", "spec": "s"}],
            )
        self.assertEqual(graph.current_graph_version(self.conn), 1)


class TestTerminalGuard(unittest.TestCase):
    """P0（E M4 探针）：`done` 是运行时终态 —— 只能由凭证进入，不能再出。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")
        graph.add_node(
            self.conn, node_id="NODE-A", title="a", spec="s", status="verifying",
            evidence_required=["artifact"], verifier_ids=["verifier-ci"],
        )
        evidence.add_artifact(self.conn, artifact_id="ART-A", path="out/a.txt", sha256=SHA,
                              producer_node="NODE-A")
        evidence.add_evidence(self.conn, evidence_id="EVD-A", node_id="NODE-A", kind="artifact",
                              artifact_id="ART-A", verifier_id="verifier-ci", verdict="pass")
        graph.set_status(
            self.conn, "NODE-A", "done",
            credential=graph.done_credential(self.conn, "NODE-A"), reason="evidence_ok",
        )

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def _count(self):
        return len(events.iter_events(self.conn))

    def test_probe_done_to_planned_rejected(self):
        """复刻 E 的探针：done → planned 曾被接受，现在必须拒绝且不写事件。"""
        before = self._count()
        with self.assertRaises(graph.GraphError):
            graph.set_status(self.conn, "NODE-A", "planned")
        self.assertEqual(graph.get_node(self.conn, "NODE-A")["status"], "done")
        self.assertEqual(self._count(), before, "拒绝时不得写任何事件")

    def test_all_exits_from_done_rejected(self):
        before = self._count()
        for target in ("planned", "ready", "claimed", "running", "submitted", "verifying",
                       "rejected", "accepted", "blocked"):
            with self.assertRaises(graph.GraphError, msg="done → %s 应被拒绝" % target):
                graph.set_status(self.conn, "NODE-A", target, reason="probe")
        self.assertEqual(graph.get_node(self.conn, "NODE-A")["status"], "done")
        self.assertEqual(self._count(), before)
        self.assertEqual(graph.snapshot(self.conn), graph.replay_snapshot(self.conn))

    def test_exit_rejected_even_with_side_effects_requested(self):
        """带 attempts_delta / assignee / drop_lease 的“退出”同样被拒（不能绕过守卫）。"""
        before = self._count()
        with self.assertRaises(graph.GraphError):
            graph.set_status(self.conn, "NODE-A", "ready", assignee="agent-X",
                             attempts_delta=1, drop_lease=True, reason="probe")
        node = graph.get_node(self.conn, "NODE-A")
        self.assertEqual((node["status"], node["attempts"], node["assignee"]), ("done", 0, None))
        self.assertEqual(self._count(), before)

    def test_done_to_done_is_idempotent(self):
        before = self._count()
        node = graph.set_status(self.conn, "NODE-A", "done")
        self.assertEqual(node["status"], "done")
        self.assertEqual(self._count(), before, "done → done 幂等且不写事件")

    def test_remove_node_rejects_terminal(self):
        with self.assertRaises(graph.GraphError):
            graph.remove_node(self.conn, "NODE-A")
        self.assertIsNotNone(graph.get_node(self.conn, "NODE-A"))
        graph.remove_node(self.conn, "NODE-A", allow_terminal=True)  # 显式逃生口
        self.assertIsNone(graph.get_node(self.conn, "NODE-A"))

    def test_replan_cannot_remove_terminal(self):
        version_before = graph.current_graph_version(self.conn)
        before = self._count()
        with self.assertRaises(graph.GraphError):
            graph.replan(self.conn, reason="scope_change",
                         add=[{"node_id": "NODE-C", "title": "c", "spec": "s"}],
                         remove=["NODE-A"])
        self.assertIsNotNone(graph.get_node(self.conn, "NODE-A"))
        self.assertIsNone(graph.get_node(self.conn, "NODE-C"), "前置拒绝：add 也不得落库")
        self.assertEqual(graph.current_graph_version(self.conn), version_before)
        self.assertEqual(self._count(), before)
        self.assertEqual(graph.snapshot(self.conn), graph.replay_snapshot(self.conn))


if __name__ == "__main__":
    unittest.main()