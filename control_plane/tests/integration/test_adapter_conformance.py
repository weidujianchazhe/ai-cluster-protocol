# -*- coding: utf-8 -*-
"""适配器一致性夹具：跑 `plugins/dsh-l0-adapter/lib/selftest.mjs`，把 fencing / verify /
usage / 恢复视图 / 四态映射的红绿结果纳入 Python 门禁。

为什么用 node 子进程：这些是插件侧（JS）的纯逻辑与轻 IO，Python 不重写实现，
只消费插件自己的自检报告 —— 避免"两份实现互相验证"的假绿。
"""

import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from control_plane.tests.integration import a7_conformance as a7  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]
PLUGIN_DIR = REPO_ROOT / "plugins" / "dsh-l0-adapter"
NODE = shutil.which("node")


def run_selftest() -> dict:
    result = subprocess.run(
        [NODE, str(PLUGIN_DIR / "lib" / "selftest.mjs"), "--json"],
        cwd=str(PLUGIN_DIR),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
    )
    try:
        report = json.loads(result.stdout)
    except ValueError as exc:  # pragma: no cover - 诊断用
        raise AssertionError("selftest 输出不是 JSON：%s\nstdout=%s\nstderr=%s"
                             % (exc, result.stdout[-2000:], result.stderr[-2000:]))
    report["_returncode"] = result.returncode
    report["_stderr"] = result.stderr
    return report


@unittest.skipIf(NODE is None, "node 不可用，跳过插件自检")
class AdapterSelftestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.report = run_selftest()
        cls.by_name = {row["name"]: row for row in cls.report["checks"]}

    def assert_check(self, needle: str):
        hits = [row for name, row in self.by_name.items() if needle in name]
        self.assertTrue(hits, "自检里找不到用例：%s（已有：%s）" % (needle, list(self.by_name)))
        for row in hits:
            self.assertTrue(row["ok"], "%s 失败：%s" % (row["name"], row["detail"]))

    def test_selftest_exits_zero(self):
        self.assertEqual(self.report["_returncode"], 0, self.report.get("checks"))
        self.assertTrue(self.report["ok"])
        self.assertEqual(self.report["failed"], 0)

    def test_fencing_fail_closed(self):
        """P0-1：存在接管时缺 token 必须 fenced；无 fencing 的初始写放行。"""
        self.assert_check("fencing: 已接管时缺 token 必须拒绝")
        self.assert_check("fencing: 未接管且无 fencing 时缺 token 放行")
        self.assert_check("fencing: 旧 token 被 fenced-out")
        self.assert_check("fencing: 当前 token 放行")

    def test_verify_three_states(self):
        """P0-2：pass / fail / unknown 三态，空 expected 不得假 pass。"""
        self.assert_check("verify: contains 命中")
        self.assert_check("verify: contains 不命中")
        self.assert_check("verify: contains 空 expected")
        self.assert_check("verify: contains 缺 expected")
        self.assert_check("verify: 产物缺失")

    def test_verify_is_recorded(self):
        """verify 必须真跑并落记录（verifications 不能恒空）。"""
        self.assert_check("verify: 判定落盘")

    def test_usage_total_tokens(self):
        self.assert_check("usage: 实例 totalTokens")

    def test_budget_gate(self):
        self.assert_check("budget: 超预算")

    def test_recover_plan(self):
        self.assert_check("recover: 孤儿实例")

    def test_restart_recovery(self):
        """强杀恢复：新代次读同一份状态 + 恢复后必须新 token 才能写。"""
        self.assert_check("restart: 新代次读到同一份状态与检查点")
        self.assert_check("restart: 恢复后必须用新 fencing token")

    def test_conformance_mapping_matches_fixture(self):
        """适配器声明的四态退出码必须与 A7 夹具一致（单一事实源）。"""
        self.assert_check("conformance: 四态退出码映射")
        rows = [row for name, row in self.by_name.items() if "conformance: 四态退出码映射" in name]
        mapping = rows[0]["detail"]["map"]
        self.assertEqual(mapping, a7.EXIT_CODES)
        self.assertEqual(rows[0]["detail"]["basis"], "instanceUsage")


class AdapterReportMappingCase(unittest.TestCase):
    def test_conformance_block_present_in_extracted_mapping(self):
        """自检报告的 mapping 与 a7.EXIT_CODES 同为 {pass:0,drift:1,failed:2,unknown:3}。"""
        self.assertEqual(
            a7.EXIT_CODES,
            {"pass": 0, "drift": 1, "failed": 2, "unknown": 3},
        )


if __name__ == "__main__":
    unittest.main()
