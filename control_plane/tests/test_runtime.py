# -*- coding: utf-8 -*-
"""Lane C 单元测试：runtime 循环（tick_l2 / expire / scan / recompute / terminated / run）。"""

import hashlib
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from control_plane import (  # noqa: E402
    db,
    decisions,
    engine as engine_mod,
    events,
    evidence,
    graph,
    ledger,
    runtime,
    stages,
)

SHA_TEXT = "artifact body\n"
WORKFLOW_VERIFIER = "verifier-ci"


def _artifact(root: Path, node_id: str) -> tuple[str, str]:
    """写盘字节 = sha 字节（避免 Windows `write_text` 的 CRLF 翻译造成 sha 假账）。"""
    p = root / ("%s.txt" % node_id)
    data = SHA_TEXT.encode("utf-8")
    p.write_bytes(data)
    return str(p), hashlib.sha256(data).hexdigest()


class RuntimeTestBase(unittest.TestCase):
    limits = None

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.eng = engine_mod.Engine.open(
            self.root / "cp.db", owner="tester", limits=self.limits
        )
        # 验证器身份预注册（P1）：strict=1 时未注册验证器会被拒
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


class TestTick(RuntimeTestBase):
    def test_tick_reports_expected_keys(self):
        report = runtime.tick(self.eng, now=1000)
        for key in (
            "at", "l2_timed_out", "expired", "blocked", "warnings", "promoted",
            "scan_terminated", "terminated", "reason", "usage", "active", "ready",
        ):
            self.assertIn(key, report)
        self.assertEqual(report["at"], 1000)

    def test_tick_writes_runtime_tick_event(self):
        runtime.tick(self.eng, now=1000)
        self.assertIn("runtime_tick", [e["kind"] for e in events.iter_events(self.eng.conn)])

    def test_tick_advances_l2_timeout(self):
        self.eng.create_decision(
            decision_id="DEC-L2", level="L2", question="q",
            options=[{"option_id": "a", "label": "A"}, {"option_id": "b", "label": "B"}],
            default_option_id="a", timeout_sec=10, now=1000,
        )
        first = runtime.tick(self.eng, now=1005)
        self.assertEqual(first["l2_timed_out"], [])
        second = runtime.tick(self.eng, now=1011)
        self.assertEqual(second["l2_timed_out"], ["DEC-L2"])
        rec = decisions.get_decision(self.eng.conn, "DEC-L2")
        self.assertEqual(rec["status"], "timed_out")
        self.assertEqual(rec["chosen_option_id"], "a")

    def test_tick_expires_lease(self):
        self.add("NODE-A")
        self.eng.bootstrap()
        self.eng.claim("NODE-A", ttl_sec=10, now=1000)
        report = runtime.tick(self.eng, now=1011)
        self.assertEqual(report["expired"], ["NODE-A"])
        node = self.eng.node("NODE-A")
        self.assertEqual(node["status"], "ready")
        self.assertEqual(node["attempts"], 1)

    def test_tick_promotes_after_dependency_done(self):
        # 合法前态：done 只能从 verifying 进入（A 的 D2 迁移白名单），不再 ready→done
        self.add("NODE-A", status="verifying")
        self.add("NODE-B", deps=["NODE-A"])
        self.add("NODE-B2", deps=["NODE-A"])
        # done 走冻结的凭证契约：done_credential() 签发 → set_status 消费
        path, sha = _artifact(self.root, "NODE-A")
        evidence.add_artifact(
            self.eng.conn, artifact_id="ART-A", path=path, sha256=sha, producer_node="NODE-A"
        )
        evidence.add_evidence(
            self.eng.conn, evidence_id="EVD-A", node_id="NODE-A", kind="artifact",
            artifact_id="ART-A", verifier_id=WORKFLOW_VERIFIER, verdict="pass",
        )
        stages.pass_gate(self.eng.conn, "build", ["EVD-A"])
        graph.set_status(
            self.eng.conn, "NODE-A", "done",
            credential=graph.done_credential(self.eng.conn, "NODE-A"),
            reason="evidence_ok", notify=False,
        )
        report = runtime.tick(self.eng, now=1000)
        self.assertIn("NODE-B", report["promoted"])
        self.assertEqual(report["ready"], ["NODE-B", "NODE-B2"])

    def test_tick_stops_promotion_when_terminated(self):
        self.add("NODE-A")
        self.eng.bootstrap()
        self.eng.limits["max_total_cost"] = 0.1
        ledger.append(self.eng.conn, "NODE-A", tokens_in=1, calls=1, verifier_cost=5.0)
        self.add("NODE-C", deps=[])
        graph.set_status(self.eng.conn, "NODE-C", "planned")
        report = runtime.tick(self.eng, now=1000)
        self.assertTrue(report["terminated"])
        self.assertEqual(report["reason"], "total_cost_exceeded")
        self.assertEqual(report["promoted"], [])

    def test_tick_accepts_bare_connection(self):
        report = runtime.tick(self.eng.conn, now=1000)
        self.assertFalse(report["terminated"])


class TestRun(RuntimeTestBase):
    def test_run_stops_when_idle(self):
        result = runtime.run(self.eng, max_ticks=5, step_sec=1, start_now=1000)
        self.assertEqual(result["stopped"], "idle")
        self.assertEqual(result["ticks"], 1)

    def test_run_stops_on_termination(self):
        self.add("NODE-A")
        self.eng.bootstrap()
        self.eng.limits["max_total_cost"] = 0.1
        ledger.append(self.eng.conn, "NODE-A", tokens_in=1, calls=1, verifier_cost=5.0)
        result = runtime.run(self.eng, max_ticks=5, step_sec=1, start_now=1000)
        self.assertEqual(result["stopped"], "terminated")
        self.assertEqual(result["reason"], "total_cost_exceeded")
        self.assertEqual(result["ticks"], 1)

    def test_run_advances_clock_and_calls_on_tick(self):
        self.add("NODE-A")
        self.eng.bootstrap()
        seen = []
        result = runtime.run(
            self.eng, max_ticks=3, step_sec=2, start_now=1000, stop_when_idle=False,
            on_tick=lambda rep: seen.append(rep["at"]),
        )
        self.assertEqual(seen, [1000, 1002, 1004])
        self.assertEqual(result["ticks"], 3)
        self.assertEqual(result["stopped"], "max_ticks")

    def test_run_keeps_ready_node_cycling(self):
        self.add("NODE-A")
        self.eng.bootstrap()
        result = runtime.run(self.eng, max_ticks=2, step_sec=1, start_now=1000)
        self.assertEqual(result["ticks"], 2)
        self.assertEqual(result["stopped"], "max_ticks")
        self.assertEqual(result["ready"], ["NODE-A"])


class TestDemo(RuntimeTestBase):
    def test_demo_completes_whole_graph(self):
        summary = runtime.demo(self.root / "demo")
        self.assertTrue(summary["ok"])
        statuses = set(summary["nodes"].values())
        self.assertEqual(statuses, {"done"})
        self.assertFalse(summary["terminated"])
        self.assertGreater(summary["usage"]["rows"], 0)
        self.assertEqual(summary["decisions"]["DEC-L2"], "timed_out")
        self.assertTrue((self.root / "demo" / "summary.json").exists())

    def test_demo_result_is_idempotent_for_second_tick(self):
        summary = runtime.demo(self.root / "demo")
        last = summary["last_tick"]
        self.assertEqual(last["promoted"], [])
        self.assertEqual(last["terminated"], False)

    def test_demo_completes_under_strict_evidence(self):
        """strict=1（证据 append-only + 验证器身份 + artifact 复核）下 demo 仍全 done。"""
        demo_root = self.root / "demo_strict"
        conn = db.init_db(demo_root / "control_plane.db")
        try:
            db.set_evidence_strict(conn, True)
        finally:
            conn.close()

        summary = runtime.demo(demo_root)
        self.assertEqual(set(summary["nodes"].values()), {"done"})

        conn = db.init_db(demo_root / "control_plane.db")
        try:
            self.assertTrue(db.evidence_strict(conn))
            rows = conn.execute("SELECT artifact_id, producer_node FROM artifacts").fetchall()
            self.assertTrue(rows)
            for row in rows:
                check = evidence.verify_artifact(
                    conn, row["artifact_id"], root=demo_root, node_id=row["producer_node"]
                )
                self.assertTrue(check["ok"], (row["artifact_id"], check["reason"]))
            rejected = [
                e for e in events.iter_events(conn) if e["kind"] == "node_rejected"
            ]
            self.assertEqual(rejected, [])
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
