# -*- coding: utf-8 -*-
"""Lane C 单元测试：CLI（退出码 / JSON 输出 / 终止闸门 / 并发门 / 计量）。"""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from control_plane import cli, db, events, evidence, graph  # noqa: E402


class CliTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.db = str(self.root / "cp.db")
        # 预建库 + 注册验证器身份（P1）：strict=1 时 CLI 流程不得因未注册被拒
        conn = db.init_db(self.db)
        try:
            evidence.register_verifier(
                conn, "verifier-ci", kind="ci", role="ROLE-AUDIT-01"
            )
        finally:
            conn.close()

    def tearDown(self):
        self._tmp.cleanup()

    def run_cli(self, *argv):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = cli.main(["--db", self.db] + list(argv))
        text = buf.getvalue().strip()
        payload = json.loads(text) if text else None
        return code, payload

    def node(self, node_id, *extra):
        return ("node-add", "--node-id", node_id, "--title", node_id, "--spec", "s",
                "--stage", "design", "--evidence-required", "artifact",
                "--verifier-ids", "verifier-ci") + tuple(extra)


class TestCliBasics(CliTestBase):
    def test_init_returns_schema_version(self):
        code, payload = self.run_cli("init")
        self.assertEqual(code, 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["schema_version"], db.SCHEMA_VERSION)

    def test_status_empty(self):
        self.run_cli("init")
        code, payload = self.run_cli("status")
        self.assertEqual(code, 0)
        self.assertIsNone(payload["status"]["terminated"])
        self.assertFalse(payload["status"]["terminal"])

    def test_node_add_and_bootstrap(self):
        code, payload = self.run_cli(*self.node("NODE-A"), "--bootstrap")
        self.assertEqual(code, 0)
        self.assertEqual(payload["node"]["status"], "ready")
        self.assertEqual(payload["promoted"], ["NODE-A"])

    def test_price_lists_table(self):
        code, payload = self.run_cli("price")
        self.assertEqual(code, 0)
        self.assertIn("default", [row["model"] for row in payload["prices"]])

    def test_price_unknown_model_is_business_error(self):
        code, payload = self.run_cli("price", "--model", "nope")
        self.assertEqual(code, cli.EXIT_ERROR)
        self.assertFalse(payload["ok"])


class TestCliGates(CliTestBase):
    def test_terminated_claim_exits_3(self):
        self.run_cli(*self.node("NODE-A"))
        self.run_cli("terminate", "--reason", "test")
        code, payload = self.run_cli("claim", "--node-id", "NODE-A", "--ttl", "60")
        self.assertEqual(code, cli.EXIT_TERMINATED)
        self.assertEqual(payload["code"], "terminated")

    def test_concurrency_denied_exits_4(self):
        self.run_cli("--max-parallel", "1", *self.node("NODE-A"), "--bootstrap")
        self.run_cli("--max-parallel", "1", *self.node("NODE-B"), "--bootstrap")
        code, _ = self.run_cli("--max-parallel", "1", "claim", "--node-id", "NODE-A")
        self.assertEqual(code, 0)
        code, payload = self.run_cli("--max-parallel", "1", "claim", "--node-id", "NODE-B")
        self.assertEqual(code, cli.EXIT_CONCURRENCY)
        self.assertEqual(payload["code"], "concurrency_exceeded")

    def test_resume_after_terminate(self):
        self.run_cli(*self.node("NODE-A"), "--bootstrap")
        self.run_cli("terminate", "--reason", "test")
        code, _ = self.run_cli("resume", "--note", "ok")
        self.assertEqual(code, 0)
        code, payload = self.run_cli("claim", "--node-id", "NODE-A", "--ttl", "60")
        self.assertEqual(code, 0)
        self.assertEqual(payload["lease"]["node_id"], "NODE-A")


class TestCliCredential(CliTestBase):
    def test_credential_missing_until_evidence_and_gate(self):
        self.run_cli(*self.node("NODE-A"), "--bootstrap")
        code, payload = self.run_cli("credential", "--node-id", "NODE-A")
        self.assertEqual(code, 0)
        self.assertFalse(payload["ready_for_done"])

        art = self.root / "NODE-A.txt"
        art.write_text("body\n", encoding="utf-8")
        self.run_cli("artifact-add", "--node-id", "NODE-A", "--artifact-id", "ART-A",
                     "--path", str(art))
        self.run_cli("evidence-add", "--node-id", "NODE-A", "--evidence-id", "EVD-A",
                     "--artifact-id", "ART-A")
        _, payload = self.run_cli("credential", "--node-id", "NODE-A")
        self.assertFalse(payload["ready_for_done"])  # 阶段闸门未过

        self.run_cli("gate", "--stage", "design", "--status", "passed", "--evidence", "EVD-A")
        _, payload = self.run_cli("credential", "--node-id", "NODE-A")
        self.assertTrue(payload["ready_for_done"])
        self.assertEqual(payload["credential"]["node_id"], "NODE-A")


class TestCliUnblock(CliTestBase):
    def _block(self, node_id: str) -> None:
        conn = db.init_db(self.db)
        try:
            graph.set_status(conn, node_id, "blocked", reason="test_blocked", assignee=None)
        finally:
            conn.close()

    def test_unblock_success(self):
        self.run_cli(*self.node("NODE-A"), "--bootstrap")
        self._block("NODE-A")
        code, payload = self.run_cli(
            "unblock", "--node-id", "NODE-A", "--reason", "预算已调整", "--note", "人工复核"
        )
        self.assertEqual(code, 0)
        self.assertEqual(payload["node"]["status"], "ready")
        self.assertEqual(payload["reason"], "预算已调整")

        conn = db.init_db(self.db)
        try:
            reasons = [
                e["payload"].get("reason")
                for e in events.iter_events(conn)
                if e["kind"] == "status_changed" and e["node_id"] == "NODE-A"
            ]
            node = graph.get_node(conn, "NODE-A")
        finally:
            conn.close()
        self.assertIn("unblocked:预算已调整", reasons)
        self.assertIsNone(node["assignee"])

    def test_unblock_empty_reason_rejected(self):
        self.run_cli(*self.node("NODE-A"), "--bootstrap")
        self._block("NODE-A")
        code, payload = self.run_cli("unblock", "--node-id", "NODE-A", "--reason", "   ")
        self.assertEqual(code, cli.EXIT_ERROR)
        self.assertFalse(payload["ok"])

        conn = db.init_db(self.db)
        try:
            self.assertEqual(graph.get_node(conn, "NODE-A")["status"], "blocked")
        finally:
            conn.close()

    def test_unblock_denied_when_terminated(self):
        self.run_cli(*self.node("NODE-A"), "--bootstrap")
        self._block("NODE-A")
        self.run_cli("terminate", "--reason", "test")
        code, payload = self.run_cli("unblock", "--node-id", "NODE-A", "--reason", "x")
        self.assertEqual(code, cli.EXIT_TERMINATED)
        self.assertEqual(payload["code"], "terminated")


class TestCliExportProjection(CliTestBase):
    def test_export_writes_evidence_artifacts_verifiers(self):
        self.run_cli(*self.node("NODE-A"), "--bootstrap")
        art = self.root / "NODE-A.txt"
        art.write_text("body\n", encoding="utf-8")
        self.run_cli("artifact-add", "--node-id", "NODE-A", "--artifact-id", "ART-A",
                     "--path", str(art))

        conn = db.init_db(self.db)
        try:
            evidence.register_verifier(conn, "verifier-ci", kind="ci")
            evidence.add_evidence(
                conn, evidence_id="EVD-A", node_id="NODE-A", kind="artifact",
                artifact_id="ART-A", verifier_id="verifier-ci", verdict="pass",
            )
        finally:
            conn.close()

        out = self.root / "export"
        code, payload = self.run_cli("export", "--root", str(out))
        self.assertEqual(code, 0)
        self.assertEqual(payload["projection"]["status"], "ok")
        for name in ("STATE.md", "INDEX.md", "evidence.md", "artifacts.md", "verifiers.md"):
            self.assertTrue((out / name).exists(), name)
        self.assertIn("EVD-A", (out / "evidence.md").read_text(encoding="utf-8"))
        self.assertIn("ART-A", (out / "artifacts.md").read_text(encoding="utf-8"))
        self.assertIn("verifier-ci", (out / "verifiers.md").read_text(encoding="utf-8"))

    def test_export_accepts_out_alias(self):
        out = self.root / "export2"
        code, payload = self.run_cli("export", "--out", str(out))
        self.assertEqual(code, 0)
        self.assertEqual(payload["projection"]["status"], "ok")


class TestCliMeterAndRun(CliTestBase):
    def test_meter_append_and_ledger(self):
        self.run_cli(*self.node("NODE-A"))
        code, payload = self.run_cli(
            "meter-append", "--node-id", "NODE-A", "--tokens-in", "1000",
            "--tokens-out", "1000", "--calls", "2",
        )
        self.assertEqual(code, 0)
        self.assertEqual(payload["totals"]["tokens"], 2000)
        code, payload = self.run_cli("ledger", "--node-id", "NODE-A")
        self.assertEqual(code, 0)
        self.assertEqual(len(payload["rows"]), 1)

    def test_tick_and_run(self):
        self.run_cli(*self.node("NODE-A"))
        code, payload = self.run_cli("tick", "--now", "1000")
        self.assertEqual(code, 0)
        self.assertEqual(payload["tick"]["ready"], ["NODE-A"])
        code, payload = self.run_cli("run", "--max-ticks", "2", "--step", "1", "--now", "1000")
        self.assertEqual(code, 0)
        self.assertEqual(payload["run"]["ticks"], 2)

    def test_run_reports_termination_as_failure(self):
        self.run_cli(*self.node("NODE-A"))
        self.run_cli("meter-append", "--node-id", "NODE-A", "--verifier-cost", "9")
        code, payload = self.run_cli("--max-total-cost", "1", "run", "--max-ticks", "3",
                                     "--now", "1000")
        self.assertIn(code, (0, cli.EXIT_ERROR))
        self.assertTrue(payload["run"]["terminated"])
        self.assertEqual(payload["run"]["reason"], "total_cost_exceeded")

    def test_demo_command_completes_graph(self):
        code, payload = self.run_cli("demo", "--root", str(self.root / "demo"))
        self.assertEqual(code, 0)
        self.assertEqual(set(payload["demo"]["nodes"].values()), {"done"})


if __name__ == "__main__":
    unittest.main()
