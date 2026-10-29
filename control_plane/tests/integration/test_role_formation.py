# -*- coding: utf-8 -*-
"""职务目录 / 编队计划 / 审计独立 / 编队变更留痕（TASK-20261029-65B648）。"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from control_plane import capabilities, db, events, graph  # noqa: E402


class RoleCatalogCase(unittest.TestCase):
    def test_eight_producers_three_auditors(self):
        self.assertEqual(len(capabilities.PRODUCER_ROLES), 8)
        self.assertEqual(len(capabilities.AUDITOR_ROLES), 3)
        self.assertEqual(set(capabilities.PRODUCER_ROLES) | set(capabilities.AUDITOR_ROLES),
                         set(capabilities.ROLE_CATALOG))
        for role in capabilities.PRODUCER_ROLES:
            self.assertEqual(capabilities.role_kind(role), capabilities.ROLE_KIND_PRODUCER)
        for role in capabilities.AUDITOR_ROLES:
            self.assertEqual(capabilities.role_kind(role), capabilities.ROLE_KIND_AUDITOR)

    def test_list_roles_filter(self):
        self.assertEqual(len(capabilities.list_roles(capabilities.ROLE_KIND_PRODUCER)), 8)
        self.assertEqual(len(capabilities.list_roles(capabilities.ROLE_KIND_AUDITOR)), 3)
        self.assertEqual(len(capabilities.list_roles()), 11)

    def test_instance_id_format_and_parse(self):
        self.assertEqual(capabilities.instance_id("CODE", 1), "ROLE-CODE-01")
        self.assertEqual(capabilities.instance_id("CODE", 12), "ROLE-CODE-12")
        self.assertEqual(capabilities.parse_instance_id("ROLE-AUDIT_CODE-02"), ("AUDIT_CODE", 2))
        for bad in ("code-01", "ROLE-CODE-1", "ROLE-NOPE-01", "ROLE-CODE-00"):
            with self.assertRaises(capabilities.CapabilityError):
                capabilities.parse_instance_id(bad) if bad != "ROLE-CODE-00" else capabilities.instance_id("CODE", 0)

    def test_composite_templates_enumerable(self):
        self.assertIn("REVIEWER", capabilities.COMPOSITE_TEMPLATES)
        for template, members in capabilities.COMPOSITE_TEMPLATES.items():
            for member in members:
                capabilities.role_kind(member)  # 全部是合法职务

        instance = {"instance_id": "ROLE-REVIEWER-01", "roles": ["AUDIT_CODE", "AUDIT_EVIDENCE"]}
        self.assertTrue(capabilities.is_auditor_instance(instance))
        snapshot = capabilities.formation_snapshot([instance, {"instance_id": "ROLE-CODE-01", "role": "CODE"}])
        self.assertEqual(snapshot["count"], 2)
        self.assertEqual(snapshot["composite"], ["ROLE-REVIEWER-01"])


class FormationPlanCase(unittest.TestCase):
    def test_plan_is_valid_and_eight_code_instances_unique(self):
        plan = capabilities.plan_formation(
            task_units=8, roles=["CODE"], role_count_default=8, max_parallel=8
        )
        self.assertEqual(capabilities.validate_formation(plan), [])
        ids = plan["plan"][0]["instance_ids"]
        self.assertEqual(len(ids), 8)
        self.assertEqual(len(set(ids)), 8)
        self.assertEqual(ids[0], "ROLE-CODE-01")
        self.assertEqual(ids[-1], "ROLE-CODE-08")

    def test_role_count_default_is_overridable_not_quota(self):
        """默认值可被 planner 上调（任务量 9 > 默认 1）。"""
        plan = capabilities.plan_formation(task_units=9, roles=["CODE"], role_count_default=1)
        self.assertGreater(plan["plan"][0]["count"], 1)
        self.assertEqual(plan["role_count_default"], 1)

    def test_parallel_cap_cuts_producers_not_auditors(self):
        plan = capabilities.plan_formation(
            task_units=12,
            roles=["CODE", "TEST", "AUDIT_CODE"],
            role_count_default=4,
            max_parallel=5,
        )
        self.assertLessEqual(plan["total_instances"], 5)
        auditors = [row for row in plan["plan"] if row["kind"] == capabilities.ROLE_KIND_AUDITOR]
        self.assertEqual([row["count"] for row in auditors], [1])
        self.assertEqual(capabilities.validate_formation(plan), [])

    def test_budget_cut_keeps_audit(self):
        plan = capabilities.plan_formation(
            task_units=6,
            roles=["CODE", "AUDIT_CODE"],
            role_count_default=4,
            budget_tokens=1000,
            tokens_per_unit=20000,
        )
        counts = {row["role"]: row["count"] for row in plan["plan"]}
        self.assertEqual(counts["CODE"], 1)
        self.assertEqual(counts["AUDIT_CODE"], 1)
        self.assertEqual(capabilities.validate_formation(plan), [])

    def test_unknown_role_rejected(self):
        with self.assertRaises(capabilities.CapabilityError):
            capabilities.plan_formation(task_units=1, roles=["NOPE"])


class AuditIndependenceCase(unittest.TestCase):
    def test_same_instance_rejected(self):
        assignments = [{"node_id": "N1", "producer": "ROLE-CODE-01", "auditors": ["ROLE-CODE-01"]}]
        issues = capabilities.audit_independence_violations(assignments)
        self.assertTrue(any("同实例" in issue for issue in issues))
        with self.assertRaises(capabilities.CapabilityError):
            capabilities.assert_audit_independent(assignments)

    def test_separate_instances_pass(self):
        assignments = [{"node_id": "N1", "producer": "ROLE-CODE-01", "auditors": ["ROLE-AUDIT_CODE-02"]}]
        self.assertEqual(capabilities.audit_independence_violations(assignments), [])
        capabilities.assert_audit_independent(assignments)

    def test_composite_auditor_cannot_produce(self):
        assignments = [{"node_id": "N2", "producer": "ROLE-REVIEWER-01", "auditors": ["ROLE-AUDIT_CODE-01"]}]
        roles = {"ROLE-REVIEWER-01": ("AUDIT_CODE", "AUDIT_EVIDENCE")}
        issues = capabilities.audit_independence_violations(assignments, roles)
        self.assertTrue(any("复合实例" in issue for issue in issues))

    def test_missing_auditor_rejected(self):
        assignments = [{"node_id": "N3", "producer": "ROLE-CODE-01", "auditors": []}]
        issues = capabilities.audit_independence_violations(assignments)
        self.assertTrue(any("缺 auditor" in issue for issue in issues))


class FormationLedgerCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def test_formation_change_is_recorded_and_replayable(self):
        before = [{"instance_id": "ROLE-CODE-01", "role": "CODE", "status": "running"}]
        after = [
            {"instance_id": "ROLE-CODE-01", "role": "CODE", "status": "running"},
            {"instance_id": "ROLE-CODE-02", "role": "CODE", "status": "running"},
            {"instance_id": "ROLE-AUDIT_CODE-01", "role": "AUDIT_CODE", "status": "running"},
        ]
        version_before = graph.current_graph_version(self.conn)
        record = capabilities.record_formation_change(self.conn, before, after, note="扩编到 2 生产 + 1 审计")
        self.assertEqual(record["added"], ["ROLE-AUDIT_CODE-01", "ROLE-CODE-02"])
        self.assertEqual(record["removed"], [])
        self.assertEqual(record["event_id"], "EVT-F0001")
        # 编队不是图变更 → 图版本不动（图版本归 A 的写域）
        self.assertEqual(graph.current_graph_version(self.conn), version_before)

        row = self.conn.execute("SELECT * FROM replan_events WHERE event_id=?", ("EVT-F0001",)).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["reason"], "formation")
        self.assertEqual(record["snapshot"], capabilities.formation_snapshot(after))

        kinds = [event["kind"] for event in events.iter_events(self.conn)]
        self.assertIn("formation_changed", kinds)

    def test_second_formation_change_increments_sequence(self):
        before = [{"instance_id": "ROLE-CODE-01", "role": "CODE"}]
        after = [{"instance_id": "ROLE-CODE-01", "role": "CODE"}, {"instance_id": "ROLE-CODE-02", "role": "CODE"}]
        capabilities.record_formation_change(self.conn, before, after)
        second = capabilities.record_formation_change(self.conn, after, [after[0]])
        self.assertEqual(second["event_id"], "EVT-F0002")
        self.assertEqual(second["removed"], ["ROLE-CODE-02"])


if __name__ == "__main__":
    unittest.main()
