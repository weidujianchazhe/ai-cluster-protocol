# -*- coding: utf-8 -*-
"""R5 单元测试：决策 L0–L3 / L2 超时默认 / L3 硬闸门 / 推翻留痕。"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from control_plane import db, decisions, events, graph  # noqa: E402

OPTIONS = [
    {"option_id": "opt-a", "label": "A"},
    {"option_id": "opt-b", "label": "B"},
]


class TestDecisions(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")
        graph.add_node(self.conn, node_id="NODE-001", title="t", spec="s")

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def _kinds(self):
        return [e["kind"] for e in events.iter_events(self.conn)]

    def test_l0_auto(self):
        rec = decisions.create_decision(
            self.conn, decision_id="DEC-001", level="L0", question="q",
            options=OPTIONS, node_id="NODE-001", chosen_option_id="opt-a",
        )
        self.assertEqual(rec["status"], "auto")
        self.assertEqual(rec["chosen_option_id"], "opt-a")
        self.assertIsNotNone(rec["decided_at"])
        self.assertIn("decision_decided", self._kinds())

    def test_l1_auto(self):
        rec = decisions.create_decision(
            self.conn, decision_id="DEC-002", level="L1", question="q",
            options=OPTIONS, chosen_option_id="opt-b",
        )
        self.assertEqual(rec["status"], "auto")

    def test_l2_requires_default_and_timeout(self):
        with self.assertRaises(decisions.DecisionError):
            decisions.create_decision(
                self.conn, decision_id="DEC-003", level="L2", question="q",
                options=OPTIONS, timeout_sec=60,
            )
        with self.assertRaises(decisions.DecisionError):
            decisions.create_decision(
                self.conn, decision_id="DEC-003", level="L2", question="q",
                options=OPTIONS, default_option_id="opt-a", timeout_sec=0,
            )

    def test_l2_tick_uses_default(self):
        decisions.create_decision(
            self.conn, decision_id="DEC-004", level="L2", question="q",
            options=OPTIONS, default_option_id="opt-a", timeout_sec=60, now=1000,
        )
        self.assertEqual(decisions.tick_l2(self.conn, now=1059), [])
        self.assertEqual(decisions.tick_l2(self.conn, now=1060), ["DEC-004"])
        rec = decisions.get_decision(self.conn, "DEC-004")
        self.assertEqual(rec["status"], "timed_out")
        self.assertEqual(rec["chosen_option_id"], "opt-a")
        self.assertIn("decision_timed_out", self._kinds())

    def test_l3_blocked_then_confirm(self):
        rec = decisions.create_decision(
            self.conn, decision_id="DEC-005", level="L3", question="发布吗？",
            options=OPTIONS, impact="high", reversible=False,
        )
        self.assertEqual(rec["status"], "blocked")
        confirmed = decisions.confirm_l3(self.conn, "DEC-005", "opt-b")
        self.assertEqual(confirmed["status"], "confirmed")
        self.assertEqual(confirmed["chosen_option_id"], "opt-b")
        with self.assertRaises(decisions.DecisionError):
            decisions.confirm_l3(self.conn, "DEC-005", "opt-b")  # 已确认不可重复
        self.assertIn("decision_confirmed", self._kinds())

    def test_confirm_rejects_non_l3(self):
        decisions.create_decision(
            self.conn, decision_id="DEC-006", level="L0", question="q",
            options=OPTIONS, chosen_option_id="opt-a",
        )
        with self.assertRaises(decisions.DecisionError):
            decisions.confirm_l3(self.conn, "DEC-006", "opt-b")

    def test_override_ledger(self):
        decisions.create_decision(
            self.conn, decision_id="DEC-007", level="L2", question="q",
            options=OPTIONS, default_option_id="opt-a", timeout_sec=60, now=1000,
        )
        decisions.tick_l2(self.conn, now=1060)
        rec = decisions.override(self.conn, "DEC-007", "opt-b", note="用户改了")
        self.assertEqual(rec["status"], "overridden")
        self.assertEqual(rec["chosen_option_id"], "opt-b")
        self.assertIn("decision_overridden", self._kinds())

    def test_option_and_node_validation(self):
        with self.assertRaises(decisions.DecisionError):
            decisions.create_decision(
                self.conn, decision_id="DEC-008", level="L0", question="q",
                options=[{"option_id": "x", "label": "X"}, {"option_id": "x", "label": "X2"}],
                chosen_option_id="x",
            )
        with self.assertRaises(decisions.DecisionError):
            decisions.create_decision(
                self.conn, decision_id="DEC-009", level="L0", question="q",
                options=OPTIONS, chosen_option_id="opt-z",
            )
        with self.assertRaises(decisions.DecisionError):
            decisions.create_decision(
                self.conn, decision_id="DEC-010", level="L0", question="q",
                options=OPTIONS, chosen_option_id="opt-a", node_id="NODE-404",
            )

    def test_list_filter(self):
        decisions.create_decision(
            self.conn, decision_id="DEC-011", level="L0", question="q",
            options=OPTIONS, chosen_option_id="opt-a", node_id="NODE-001",
        )
        decisions.create_decision(
            self.conn, decision_id="DEC-012", level="L0", question="q",
            options=OPTIONS, chosen_option_id="opt-b",
        )
        self.assertEqual([d["decision_id"] for d in decisions.list_decisions(self.conn, node_id="NODE-001")], ["DEC-011"])
        self.assertEqual(len(decisions.list_decisions(self.conn)), 2)


if __name__ == "__main__":
    unittest.main()
