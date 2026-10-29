# -*- coding: utf-8 -*-
"""WP-10 D6：A2A Agent Card 的职务维度（skills[].roles）。

约束：
* `roles` 只来自 `ROLE_CATALOG` 按 `capability` 精确映射；匹配不到 → `[]` + `roleMapping='unmapped'`；
* **不加 `role_count`**：数量是 planner 决策，`role_count_default` 只是可覆盖默认值；
* 不新造硬配额：卡里没有数量字段的断言本身就是防线。
"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from control_plane import capabilities, db  # noqa: E402


class AgentCardRolesCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")
        for name in ("code", "test", "evidence", "audit", "mystery_cap"):
            capabilities.register_capability(self.conn, name=name, description=name, tools=[name + "_tool"])

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def skill(self, card, skill_id):
        for row in card["skills"]:
            if row["id"] == skill_id:
                return row
        self.fail("skill 不存在：%s" % skill_id)

    def test_every_skill_has_roles_fields(self):
        card = capabilities.agent_card(self.conn)
        self.assertTrue(card["skills"])
        for row in card["skills"]:
            with self.subTest(skill=row["id"]):
                self.assertIn("roles", row)
                self.assertIsInstance(row["roles"], list)
                self.assertIn("roleKinds", row)
                self.assertIn(row["roleMapping"], {"capability", "unmapped"})

    def test_roles_come_from_catalog_by_capability(self):
        card = capabilities.agent_card(self.conn)
        self.assertEqual(self.skill(card, "code")["roles"], ["CODE"])
        self.assertEqual(self.skill(card, "test")["roles"], ["TEST"])
        self.assertEqual(self.skill(card, "evidence")["roles"], ["EVIDENCE"])
        # 三个审计职务都挂在 audit 能力上
        self.assertEqual(
            self.skill(card, "audit")["roles"], ["AUDIT_CODE", "AUDIT_DESIGN", "AUDIT_EVIDENCE"]
        )
        self.assertEqual(self.skill(card, "audit")["roleKinds"], ["auditor"])
        self.assertEqual(self.skill(card, "code")["roleKinds"], ["producer"])

    def test_roles_are_subset_of_catalog(self):
        card = capabilities.agent_card(self.conn)
        for row in card["skills"]:
            with self.subTest(skill=row["id"]):
                for role in row["roles"]:
                    self.assertIn(role, capabilities.ROLE_CATALOG)

    def test_unmapped_capability_is_explicit_not_guessed(self):
        row = self.skill(capabilities.agent_card(self.conn), "mystery_cap")
        self.assertEqual(row["roles"], [])
        self.assertEqual(row["roleKinds"], [])
        self.assertEqual(row["roleMapping"], "unmapped")

    def test_single_capability_card_keeps_shape(self):
        card = capabilities.agent_card(self.conn, "code")
        self.assertEqual(len(card["skills"]), 1)
        self.assertEqual(card["skills"][0]["roles"], ["CODE"])
        with self.assertRaises(capabilities.CapabilityError):
            capabilities.agent_card(self.conn, "missing")

    def test_card_does_not_carry_role_count(self):
        """卡里不得出现 role_count / role_count_default：数量归 planner，不写进卡。"""
        card = capabilities.agent_card(self.conn)
        blob = repr(card)
        self.assertNotIn("role_count", blob)
        self.assertNotIn("roleCount", blob)
        for row in card["skills"]:
            self.assertNotIn("count", row)

    def test_role_count_default_still_overridable(self):
        """D6 不得把 role_count_default 变成硬配额。"""
        plan = capabilities.plan_formation(task_units=9, roles=["CODE"], role_count_default=1)
        self.assertGreater(plan["plan"][0]["count"], 1)
        self.assertEqual(plan["role_count_default"], 1)
        plan2 = capabilities.plan_formation(task_units=2, roles=["CODE"], role_count_default=3)
        self.assertEqual(plan2["plan"][0]["count"], 3)

    def test_roles_helpers(self):
        self.assertEqual(capabilities.roles_for_capability("CODE"), ["CODE"])
        self.assertEqual(capabilities.roles_for_capability("  "), [])
        self.assertEqual(capabilities.roles_for_capability("nope"), [])
        self.assertEqual(capabilities.role_kinds_of(["CODE", "AUDIT_CODE"]), ["auditor", "producer"])
        self.assertEqual(capabilities.role_kinds_of(["NOPE"]), [])


if __name__ == "__main__":
    unittest.main()
