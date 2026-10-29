# -*- coding: utf-8 -*-
"""执行态快照夹具：把 adapter 落盘的 `adapter-state.json` 当契约检查。

快照来自 R5 实跑（`control_plane/tests/integration/fixtures/adapter-state.captured.json`），
断言的是「强杀后能不能恢复」依赖的那些不变式：实例字段齐全、检查点可读、fencing 单调、
verify 有留痕、usage 可对账。
"""

import json
import unittest
from pathlib import Path

FIXTURE = Path(__file__).with_name("fixtures") / "adapter-state.captured.json"

REQUIRED_INSTANCE_FIELDS = ("instanceId", "role", "mode", "sessionId", "status")
REQUIRED_CHECKPOINT_FIELDS = ("checkpointId", "instanceId", "sessionId", "lastSeq", "graphRevision", "at")
VALID_VERDICTS = {"pass", "fail", "unknown"}


class AdapterStateCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.state = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def test_schema_and_version(self):
        self.assertEqual(self.state["schema"], 1)
        self.assertGreaterEqual(self.state["version"], 1)
        self.assertIn("updatedAt", self.state)
        self.assertIsNone(self.state.get("loadDiagnostic"))

    def test_every_instance_has_contract_fields(self):
        instances = self.state["instances"]
        self.assertTrue(instances)
        for iid, row in instances.items():
            with self.subTest(instance=iid):
                for field in REQUIRED_INSTANCE_FIELDS:
                    self.assertIn(field, row)
                self.assertEqual(row["instanceId"], iid)
                self.assertRegex(iid, r"^ROLE-[A-Z][A-Z0-9_]*-\d{2,}$")
                self.assertIn(row["mode"], {"session", "activation"})

    def test_closed_instances_record_closed_at(self):
        for iid, row in self.state["instances"].items():
            if row["status"] == "closed":
                with self.subTest(instance=iid):
                    self.assertTrue(row.get("closedAt"), "closed 实例必须有 closedAt，否则恢复无法判断终态")

    def test_checkpoints_are_durable_markers(self):
        checkpoints = self.state["checkpoints"]
        self.assertTrue(checkpoints, "至少要有一次 checkpoint（强杀恢复的对账点）")
        for iid, rows in checkpoints.items():
            self.assertTrue(rows)
            for row in rows:
                with self.subTest(instance=iid, checkpoint=row.get("checkpointId")):
                    for field in REQUIRED_CHECKPOINT_FIELDS:
                        self.assertIn(field, row)
                    self.assertRegex(row["checkpointId"], r"^CKPT-[0-9a-z]{8}$")
                    self.assertIsInstance(row["lastSeq"], int)
                    self.assertGreaterEqual(row["lastSeq"], 0)
                    self.assertIsInstance(row["graphRevision"], int)
                    # 非权威断点：flush 未执行必须在数据里写明，别让下游误当权威
                    self.assertIn("flush", row)

    def test_fencing_tokens_monotonic(self):
        for iid, hold in self.state["fencing"].items():
            with self.subTest(instance=iid):
                self.assertGreater(hold["token"], hold.get("previousToken", 0))
                self.assertGreaterEqual(hold["token"], 1)
                self.assertIn("expiresAt", hold)
                self.assertTrue(hold.get("owner"))

    def test_verifications_recorded_with_valid_verdict(self):
        rows = self.state["verifications"]
        self.assertTrue(rows, "verify 必须真跑并留痕（verifications 不能恒空）")
        for vid, row in rows.items():
            with self.subTest(verification=vid):
                self.assertRegex(vid, r"^VER-\d{4}$")
                self.assertIn(row["verdict"], VALID_VERDICTS)
                self.assertIn("artifactPath", row)

    def test_instance_usage_reconciles_without_host_total(self):
        usage = self.state["usage"]
        self.assertTrue(usage)
        for iid, bucket in usage.items():
            with self.subTest(instance=iid):
                self.assertIn(iid, self.state["instances"])
                for field in ("calls", "inputTokens", "outputTokens"):
                    self.assertIsInstance(bucket[field], int)
                    self.assertGreaterEqual(bucket[field], 0)
        # 状态文件里没有宿主 total，对账基准只能是实例账本
        self.assertNotIn("total", self.state)


if __name__ == "__main__":
    unittest.main()
