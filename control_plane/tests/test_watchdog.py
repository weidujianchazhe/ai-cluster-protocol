# -*- coding: utf-8 -*-
"""R8 单元测试：看门狗（尝试/墙钟/预算/深度/并发/全局止损）。"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from control_plane import db, events, graph, leases, ledger, watchdog  # noqa: E402


class TestWatchdog(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def _add(self, nid, **kw):
        return graph.add_node(self.conn, node_id=nid, title=nid, spec="s", **kw)

    def test_attempts_exceeded_blocks(self):
        self._add("NODE-001", status="ready")
        self.conn.execute("UPDATE tasks SET attempts=3 WHERE node_id='NODE-001'")
        self.conn.commit()
        result = watchdog.scan(self.conn, now=1000)
        self.assertEqual(result["blocked"][0]["reason"], "attempts_exceeded")
        self.assertEqual(graph.get_node(self.conn, "NODE-001")["status"], "blocked")

    def test_wall_clock_blocks(self):
        self._add("NODE-001", status="ready")
        leases.claim(self.conn, "NODE-001", "agent-A", ttl_sec=100000, now=1000)
        result = watchdog.scan(self.conn, now=5000, limits={"max_wall_sec": 3600})
        self.assertEqual(result["blocked"][0]["reason"], "wall_clock_exceeded")
        self.assertIsNone(leases.current_lease(self.conn, "NODE-001"))

    def test_expired_lease_recycled(self):
        self._add("NODE-001", status="ready")
        leases.claim(self.conn, "NODE-001", "agent-A", ttl_sec=10, now=1000)
        result = watchdog.scan(self.conn, now=1011)
        self.assertEqual(result["expired"], ["NODE-001"])
        node = graph.get_node(self.conn, "NODE-001")
        self.assertEqual(node["status"], "ready")
        self.assertEqual(node["attempts"], 1)

    def test_depth_terminates(self):
        self._add("NODE-001")
        self._add("NODE-002", deps=["NODE-001"])
        self._add("NODE-003", deps=["NODE-002"])
        self._add("NODE-004", deps=["NODE-003"])
        result = watchdog.scan(self.conn, now=1000, limits={"max_depth": 3})
        self.assertTrue(result["terminated"])
        self.assertEqual(result["reason"], "depth_exceeded")

    def test_parallel_warning(self):
        self._add("NODE-001", status="ready")
        self._add("NODE-002", status="ready")
        leases.claim(self.conn, "NODE-001", "a", ttl_sec=100000, now=1000)
        leases.claim(self.conn, "NODE-002", "b", ttl_sec=100000, now=1000)
        result = watchdog.scan(self.conn, now=1001, limits={"max_parallel": 1})
        self.assertTrue(result["warnings"])
        self.assertIn("concurrency_exceeded", result["warnings"][0])

    def test_node_budget_blocks(self):
        self._add("NODE-001", status="ready", budget={"max_tokens": 100})
        self.conn.execute(
            "INSERT INTO ledger(node_id,tokens_in,tokens_out,calls,at) VALUES('NODE-001',120,30,1,?)",
            (db.now_iso(),),
        )
        self.conn.commit()
        result = watchdog.scan(self.conn, now=1000)
        self.assertEqual(result["blocked"][0]["reason"], "budget_exceeded")

    def test_global_cost_terminates(self):
        self._add("NODE-001")
        self.conn.execute(
            "INSERT INTO ledger(node_id,tokens_in,tokens_out,calls,verifier_cost,at)"
            " VALUES('NODE-001',1,1,1,9.0,?)",
            (db.now_iso(),),
        )
        self.conn.commit()
        result = watchdog.scan(self.conn, now=1000, limits={"max_total_cost": 5})
        self.assertTrue(result["terminated"])
        self.assertEqual(result["reason"], "total_cost_exceeded")

    def test_scan_event_recorded(self):
        watchdog.scan(self.conn, now=1000)
        kinds = [e["kind"] for e in events.iter_events(self.conn)]
        self.assertIn("watchdog_scan", kinds)


class TestWatchdogRealLedger(unittest.TestCase):
    """预算判定必须读真实 ledger 行（Lane C 计量闭环）。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def _add(self, nid, **kw):
        return graph.add_node(self.conn, node_id=nid, title=nid, spec="s", **kw)

    def test_ledger_append_triggers_token_budget(self):
        self._add("NODE-001", status="ready", budget={"max_tokens": 100})
        ledger.append(self.conn, "NODE-001", tokens_in=60, tokens_out=60, calls=1)
        result = watchdog.scan(self.conn, now=1000)
        self.assertEqual(result["blocked"][0]["reason"], "budget_exceeded")
        self.assertEqual(result["blocked"][0]["detail"]["max_tokens"], 100.0)
        self.assertEqual(graph.get_node(self.conn, "NODE-001")["status"], "blocked")

    def test_meter_row_triggers_cost_budget(self):
        self._add("NODE-001", status="ready", budget={"max_cost": 0.01})
        with ledger.meter(self.conn, "NODE-001") as m:
            m.record(tokens_in=1_000_000, calls=1)  # 0.28 > 0.01
        result = watchdog.scan(self.conn, now=1000)
        self.assertEqual(result["blocked"][0]["reason"], "budget_exceeded")
        self.assertGreater(result["blocked"][0]["detail"]["cost"], 0.01)

    def test_scan_usage_matches_ledger_totals(self):
        self._add("NODE-001", status="ready")
        ledger.append(self.conn, "NODE-001", tokens_in=30, tokens_out=20, calls=1, verifier_cost=0.5)
        result = watchdog.scan(self.conn, now=1000)
        totals = ledger.totals(self.conn)
        self.assertEqual(result["total_tokens"], totals["tokens"])
        self.assertAlmostEqual(result["total_cost"], totals["cost"], places=9)
        self.assertAlmostEqual(result["usage"]["verifier_cost"], 0.5, places=9)

    def test_meter_rows_accumulate_across_calls(self):
        self._add("NODE-001", status="ready", budget={"max_tokens": 250})
        with ledger.meter(self.conn, "NODE-001") as m:
            m.record(tokens_in=100, tokens_out=20)
        self.assertEqual(watchdog.scan(self.conn, now=1000)["blocked"], [])
        with ledger.meter(self.conn, "NODE-001") as m:
            m.record(tokens_in=100, tokens_out=40)
        result = watchdog.scan(self.conn, now=1001)
        self.assertEqual(result["blocked"][0]["reason"], "budget_exceeded")

    def test_price_table_in_limits_moves_budget_line(self):
        """limits 带 prices/model 时，预算折算与写入价目一致（不需要 schema 加列）。"""
        self._add("NODE-001", status="ready", budget={"max_cost": 1.0})
        ledger.append(self.conn, "NODE-001", tokens_in=1_000_000, calls=1)  # 默认价 0.28
        self.assertEqual(watchdog.scan(self.conn, now=1000)["blocked"], [])
        expensive = watchdog.scan(self.conn, now=1001, limits={"prices": {"in": 10.0}})
        self.assertEqual(expensive["blocked"][0]["reason"], "budget_exceeded")
        self.assertAlmostEqual(expensive["blocked"][0]["detail"]["cost"], 10.0, places=6)

    def test_model_price_in_limits_is_honored(self):
        self._add("NODE-001", status="ready", budget={"max_cost": 0.5})
        ledger.append(self.conn, "NODE-001", tokens_in=1_000_000, calls=1)
        default_scan = watchdog.scan(self.conn, now=1000)
        self.assertEqual(default_scan["blocked"], [])  # 0.28 < 0.5
        reasoner = watchdog.scan(self.conn, now=1001, limits={"model": "deepseek-reasoner"})
        self.assertEqual(reasoner["blocked"][0]["reason"], "budget_exceeded")  # 0.56 > 0.5


if __name__ == "__main__":
    unittest.main()
