# -*- coding: utf-8 -*-
"""R9 单元测试：能力注册表 / A2A Agent Card / 人读导出。"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from control_plane import capabilities, db, decisions, events, graph  # noqa: E402

OPTIONS = [{"option_id": "a", "label": "A"}, {"option_id": "b", "label": "B"}]


class TestCapabilities(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def test_register_get_list(self):
        cap = capabilities.register_capability(
            self.conn,
            name="code_fullstack",
            description="全栈实现",
            input_contract={"type": "object"},
            output_contract={"type": "object"},
            tools=["fs", "shell"],
            acceptance_template={"tests": "pass"},
            cost_profile={"tokens": 10000},
        )
        self.assertEqual(cap["name"], "code_fullstack")
        self.assertEqual(cap["tools"], ["fs", "shell"])
        self.assertEqual(capabilities.get_capability(self.conn, "code_fullstack")["description"], "全栈实现")
        self.assertEqual([c["name"] for c in capabilities.list_capabilities(self.conn)], ["code_fullstack"])

    def test_register_updates_and_events(self):
        capabilities.register_capability(self.conn, name="audit_test", tools=["pytest"])
        capabilities.register_capability(self.conn, name="audit_test", tools=["pytest", "diff"])
        kinds = [e["kind"] for e in events.iter_events(self.conn)]
        self.assertIn("capability_registered", kinds)
        self.assertIn("capability_updated", kinds)
        self.assertEqual(capabilities.get_capability(self.conn, "audit_test")["tools"], ["pytest", "diff"])

    def test_invalid_name(self):
        with self.assertRaises(capabilities.CapabilityError):
            capabilities.register_capability(self.conn, name="Bad Name!")

    def test_agent_card(self):
        capabilities.register_capability(self.conn, name="research", tools=["web"])
        card = capabilities.agent_card(self.conn)
        self.assertEqual(card["name"], "ai-cluster-control-plane")
        self.assertEqual(card["skills"][0]["id"], "research")
        self.assertEqual(card["skills"][0]["tags"], ["web"])
        one = capabilities.agent_card(self.conn, "research")
        self.assertEqual(len(one["skills"]), 1)
        with self.assertRaises(capabilities.CapabilityError):
            capabilities.agent_card(self.conn, "missing")

    def test_export_skill_format(self):
        graph.add_node(
            self.conn, node_id="NODE-001", title="写 PRD", spec="产出 PRD",
            capability="design_spec", stage="design", status="done",
        )
        decisions.create_decision(
            self.conn, decision_id="DEC-001", level="L0", question="q",
            options=OPTIONS, chosen_option_id="a", node_id="NODE-001",
        )
        capabilities.register_capability(self.conn, name="design_spec", tools=["fs"])
        out = Path(self._tmp.name) / "export"
        written = capabilities.export_skill_format(self.conn, out)
        self.assertTrue((out / "STATE.md").exists())
        self.assertTrue((out / "INDEX.md").exists())
        self.assertTrue((out / "decisions.md").exists())
        self.assertTrue((out / "capabilities.md").exists())
        task_file = out / "tasks" / "NODE-001.md"
        self.assertTrue(task_file.exists())
        self.assertIn("NODE-001", task_file.read_text(encoding="utf-8"))
        self.assertIn("DEC-001", (out / "decisions.md").read_text(encoding="utf-8"))
        self.assertIn("design_spec", (out / "capabilities.md").read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(written), 5)


if __name__ == "__main__":
    unittest.main()
