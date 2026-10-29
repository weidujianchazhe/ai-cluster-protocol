# -*- coding: utf-8 -*-
"""R10 单元测试：端到端 CRUD Web 模拟 fixture（含 strict=1 自洽）。"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from control_plane import db, demo_crud, events, evidence  # noqa: E402


class TestDemoCrud(unittest.TestCase):
    def test_end_to_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            summary = demo_crud.run_demo(tmp)
            self.assertTrue(summary["ok"])
            self.assertTrue(all(s == "done" for s in summary["nodes"].values()), summary["nodes"])
            self.assertIn("NODE-DOCS", summary["nodes"])
            self.assertEqual(set(summary["nodes"].values()), {"done"})
            self.assertTrue(all(g == "passed" for g in summary["gates"].values()), summary["gates"])
            self.assertEqual(summary["decisions"]["DEC-003"], "timed_out")
            self.assertEqual(summary["decisions"]["DEC-004"], "confirmed")
            self.assertGreaterEqual(summary["graph_version"], 2)
            self.assertFalse(summary["watchdog"]["terminated"])
            self.assertEqual(summary["watchdog"]["blocked"], [])
            self.assertGreater(summary["events"], 30)

            root = Path(tmp)
            self.assertTrue((root / "summary.json").exists())
            self.assertTrue((root / "export" / "STATE.md").exists())
            self.assertTrue((root / "export" / "tasks" / "NODE-PRD.md").exists())
            saved = json.loads((root / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(saved["nodes"], summary["nodes"])

    def test_strict_end_to_end_self_consistent(self):
        """strict=1（append-only 证据 / 验证器身份 / artifact sha 复核）下 demo 自行注册验证器即可全 done。"""
        with tempfile.TemporaryDirectory() as tmp:
            conn = db.init_db(Path(tmp) / "control_plane.db")
            try:
                db.set_evidence_strict(conn, True)
            finally:
                conn.close()

            summary = demo_crud.run_demo(tmp)  # demo 内部 register_verifier("verifier-ci")
            self.assertEqual(set(summary["nodes"].values()), {"done"})
            self.assertFalse(summary["watchdog"]["terminated"])

            root = Path(tmp)
            conn = db.init_db(root / "control_plane.db")
            try:
                self.assertTrue(db.evidence_strict(conn))
                rejected = [e for e in events.iter_events(conn) if e["kind"] == "node_rejected"]
                self.assertEqual(rejected, [])
                rows = conn.execute("SELECT artifact_id, producer_node FROM artifacts").fetchall()
                self.assertEqual(len(rows), 10)
                for row in rows:
                    check = evidence.verify_artifact(
                        conn, row["artifact_id"], root=root, node_id=row["producer_node"]
                    )
                    self.assertTrue(check["ok"], (row["artifact_id"], check["reason"]))
            finally:
                conn.close()


if __name__ == "__main__":
    unittest.main()
