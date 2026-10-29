# -*- coding: utf-8 -*-
"""A7 一致性夹具四态 + 实例级对账断言（TASK-20261029-10FB0A）。"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from control_plane.tests.integration import a7_conformance as a7  # noqa: E402

FIXTURES = Path(__file__).with_name("fixtures")
GOLDEN = FIXTURES / "capabilities.golden.json"


class A7FixtureCase(unittest.TestCase):
    def run_state(self, name):
        snapshot, error = a7.load_snapshot(FIXTURES / name)
        self.assertIsNone(error)
        return a7.evaluate(snapshot, a7.load_golden(GOLDEN))

    def test_pass_state(self):
        result = self.run_state("snapshot.pass.json")
        self.assertEqual(result["state"], a7.STATE_PASS)
        self.assertEqual(result["exitCode"], 0)
        self.assertEqual(result["findings"], [])

    def test_drift_state(self):
        result = self.run_state("snapshot.drift.json")
        self.assertEqual(result["state"], a7.STATE_DRIFT)
        self.assertEqual(result["exitCode"], 1)
        kinds = {f["kind"] for f in result["findings"]}
        self.assertIn("quality-drift", kinds)
        self.assertIn("drift", kinds)

    def test_failed_state(self):
        result = self.run_state("snapshot.failed.json")
        self.assertEqual(result["state"], a7.STATE_FAILED)
        self.assertEqual(result["exitCode"], 2)
        kinds = {f["kind"] for f in result["findings"]}
        self.assertIn("missing-action", kinds)
        self.assertIn("level-absent", kinds)

    def test_unknown_state(self):
        result = self.run_state("snapshot.unknown.json")
        self.assertEqual(result["state"], a7.STATE_UNKNOWN)
        self.assertEqual(result["exitCode"], 3)
        kinds = {f["kind"] for f in result["findings"]}
        # 缺 contractVersion（未知代次）+ 实例缺 usage（对账基准缺失）→ fail-closed
        self.assertIn("schema", kinds)
        self.assertIn("usage-basis-missing", kinds)

    def test_unreadable_snapshot_is_unknown(self):
        snapshot, error = a7.load_snapshot(FIXTURES / "definitely-missing.json")
        self.assertIsNone(snapshot)
        self.assertIn("不可读", error)

    def test_exit_codes_are_four_distinct_states(self):
        self.assertEqual(
            a7.EXIT_CODES,
            {"pass": 0, "drift": 1, "failed": 2, "unknown": 3},
        )

    def test_reconciliation_uses_instance_usage_only(self):
        """宿主 meter.total（24 calls）必须被忽略；对账基准是实例 usage 之和（6 calls）。"""
        result = self.run_state("snapshot.pass.json")
        recon = result["reconciliation"]
        self.assertEqual(recon["basis"], "instanceUsage")
        self.assertTrue(recon["hostTotalIgnored"])
        self.assertEqual(recon["totals"]["calls"], 6)
        self.assertEqual(recon["totals"]["inputTokens"], 15078 + 1256 + 16279)

        snapshot, _ = a7.load_snapshot(FIXTURES / "snapshot.pass.json")
        self.assertEqual(snapshot["meter"]["total"]["calls"], 24)
        # 用宿主 total 当基准的实现会对不上——这里显式断言二者不等，防止回退
        self.assertNotEqual(snapshot["meter"]["total"]["calls"], recon["totals"]["calls"])

    def test_missing_instance_usage_downgrades_to_unknown(self):
        snapshot, _ = a7.load_snapshot(FIXTURES / "snapshot.pass.json")
        snapshot["instances"] = [{"instanceId": "ROLE-CODE-01"}]
        result = a7.evaluate(snapshot, a7.load_golden(GOLDEN))
        self.assertEqual(result["state"], a7.STATE_UNKNOWN)
        self.assertEqual(result["exitCode"], 3)
        self.assertIn("usage-basis-missing", {f["kind"] for f in result["findings"]})

    def test_cli_exit_codes(self):
        self.assertEqual(a7.main(["--snapshot", str(FIXTURES / "snapshot.pass.json")]), 0)
        self.assertEqual(a7.main(["--snapshot", str(FIXTURES / "snapshot.drift.json")]), 1)
        self.assertEqual(a7.main(["--snapshot", str(FIXTURES / "snapshot.failed.json")]), 2)
        self.assertEqual(a7.main(["--snapshot", str(FIXTURES / "snapshot.unknown.json")]), 3)

    def test_cli_missing_file_is_unknown(self):
        self.assertEqual(a7.main(["--snapshot", str(FIXTURES / "nope.json")]), 3)

    def test_capability_set_is_exactly_eight_actions(self):
        snapshot, _ = a7.load_snapshot(FIXTURES / "snapshot.pass.json")
        self.assertEqual(len(a7.GOLDEN_ACTIONS), 8)
        self.assertEqual(set(snapshot["capabilities"]), set(a7.GOLDEN_ACTIONS))

    def test_snapshot_without_capabilities_is_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "empty.json"
            path.write_text(json.dumps({"instances": []}), encoding="utf-8")
            snapshot, error = a7.load_snapshot(path)
            self.assertIsNone(error)
            result = a7.evaluate(snapshot, a7.load_golden(GOLDEN))
            self.assertEqual(result["state"], a7.STATE_UNKNOWN)
            self.assertEqual(result["exitCode"], 3)


class SelftestBridgeCase(unittest.TestCase):
    """插件自检（node）→ 四态：fencing/verify 失败必须判 failed，不当 pass。"""

    @staticmethod
    def report(*rows):
        checks = [{"name": name, "ok": ok, "detail": None} for name, ok in rows]
        return {
            "ok": all(ok for _, ok in rows),
            "total": len(checks),
            "failed": sum(1 for _, ok in rows if not ok),
            "checks": checks,
        }

    def test_all_green_is_pass(self):
        result = a7.evaluate_selftest(self.report(("fencing: x", True), ("verify: y", True)))
        self.assertEqual(result["state"], a7.STATE_PASS)
        self.assertEqual(result["exitCode"], 0)

    def test_fencing_failure_is_failed(self):
        result = a7.evaluate_selftest(self.report(("fencing: 已接管时缺 token 必须拒绝", False), ("verify: y", True)))
        self.assertEqual(result["state"], a7.STATE_FAILED)
        self.assertEqual(result["exitCode"], 2)

    def test_verify_failure_is_failed(self):
        result = a7.evaluate_selftest(self.report(("verify: contains 空 expected", False)))
        self.assertEqual(result["state"], a7.STATE_FAILED)
        self.assertEqual(result["exitCode"], 2)

    def test_usage_failure_is_drift(self):
        result = a7.evaluate_selftest(self.report(("usage: 实例 totalTokens", False)))
        self.assertEqual(result["state"], a7.STATE_DRIFT)
        self.assertEqual(result["exitCode"], 1)

    def test_missing_report_is_unknown(self):
        for payload in (None, {}, {"checks": []}):
            result = a7.evaluate_selftest(payload)
            self.assertEqual(result["state"], a7.STATE_UNKNOWN)
            self.assertEqual(result["exitCode"], 3)


if __name__ == "__main__":
    unittest.main()
