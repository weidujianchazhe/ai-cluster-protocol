# -*- coding: utf-8 -*-
"""Lane C 单元测试：计量账本（价目表 / 写入 API / meter / 预算判定）。"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from control_plane import db, events, ledger  # noqa: E402


class TestPrices(unittest.TestCase):
    def test_default_prices(self):
        p = ledger.resolve_prices()
        self.assertEqual(p["in"], ledger.DEFAULT_PRICES["in"])
        self.assertEqual(p["cache"], ledger.DEFAULT_PRICES["cache"])

    def test_model_overrides_default(self):
        p = ledger.resolve_prices("deepseek-reasoner")
        self.assertEqual(p["in"], 0.56)
        self.assertEqual(p["out"], 2.20)

    def test_explicit_prices_win(self):
        p = ledger.resolve_prices("deepseek-chat", {"in": 9.0})
        self.assertEqual(p["in"], 9.0)
        self.assertEqual(p["out"], 1.10)

    def test_negative_price_rejected(self):
        with self.assertRaises(ledger.LedgerError):
            ledger.resolve_prices(None, {"in": -1})

    def test_unknown_model_rejected_by_price_row(self):
        with self.assertRaises(ledger.LedgerError):
            ledger.price_row("no-such-model")

    def test_list_prices_contains_default(self):
        names = [row["model"] for row in ledger.list_prices()]
        self.assertIn("default", names)
        self.assertIn("deepseek-chat", names)

    def test_estimate_cost_math(self):
        self.assertAlmostEqual(ledger.estimate_cost(1_000_000, 0), 0.28, places=9)
        self.assertAlmostEqual(ledger.estimate_cost(0, 1_000_000), 1.10, places=9)

    def test_cache_tokens_billed_at_cache_price(self):
        cost = ledger.estimate_cost(1_000_000, 0, 1_000_000)
        self.assertAlmostEqual(cost, 0.028, places=9)

    def test_cache_saved_beyond_input_is_clamped(self):
        cost = ledger.estimate_cost(1_000, 0, 10_000_000)
        self.assertAlmostEqual(cost, 1000 * 0.028 / 1_000_000, places=9)


class TestLedgerWrite(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def test_append_returns_row_and_cost(self):
        row = ledger.append(self.conn, "NODE-A", tokens_in=1000, tokens_out=1000, calls=1)
        self.assertGreater(row["id"], 0)
        self.assertAlmostEqual(row["cost"], ledger.estimate_cost(1000, 1000), places=9)
        self.assertEqual(ledger.totals(self.conn, "NODE-A")["rows"], 1)

    def test_append_writes_event(self):
        ledger.append(self.conn, "NODE-A", tokens_in=5, tokens_out=7, calls=1)
        kinds = [e["kind"] for e in events.iter_events(self.conn)]
        self.assertIn("ledger_appended", kinds)

    def test_append_rejects_negative_and_empty(self):
        with self.assertRaises(ledger.LedgerError):
            ledger.append(self.conn, "NODE-A", tokens_in=-1)
        with self.assertRaises(ledger.LedgerError):
            ledger.append(self.conn, "", tokens_in=1)
        with self.assertRaises(ledger.LedgerError):
            ledger.append(self.conn, "NODE-A", verifier_cost=-0.1)

    def test_append_can_skip_event(self):
        ledger.append(self.conn, "NODE-A", tokens_in=1, calls=1, record_event=False)
        self.assertNotIn("ledger_appended", [e["kind"] for e in events.iter_events(self.conn)])

    def test_rows_filter_and_after_id(self):
        r1 = ledger.append(self.conn, "NODE-A", tokens_in=1, calls=1)
        ledger.append(self.conn, "NODE-B", tokens_in=2, calls=1)
        ledger.append(self.conn, "NODE-A", tokens_in=3, calls=1)
        self.assertEqual(len(ledger.rows(self.conn, "NODE-A")), 2)
        after = ledger.rows(self.conn, "NODE-A", after_id=r1["id"])
        self.assertEqual(len(after), 1)
        self.assertEqual(after[0]["tokens_in"], 3)

    def test_totals_sums_rows_and_verifier_cost(self):
        ledger.append(self.conn, "NODE-A", tokens_in=100, tokens_out=50, calls=2, verifier_cost=1.5)
        ledger.append(self.conn, "NODE-A", tokens_in=10, tokens_out=5, calls=1)
        t = ledger.totals(self.conn, "NODE-A")
        self.assertEqual(t["tokens"], 165)
        self.assertEqual(t["calls"], 3)
        self.assertAlmostEqual(t["verifier_cost"], 1.5, places=9)
        self.assertAlmostEqual(
            t["cost"], ledger.estimate_cost(110, 55) + 1.5, places=9
        )

    def test_global_totals_cover_all_nodes(self):
        ledger.append(self.conn, "NODE-A", tokens_in=10, calls=1)
        ledger.append(self.conn, "NODE-B", tokens_in=20, calls=1)
        self.assertEqual(ledger.totals(self.conn)["tokens"], 30)


class TestBudget(unittest.TestCase):
    def test_budget_tokens_exceeded(self):
        check = ledger.budget_check({"tokens": 101, "cost": 0.0}, {"max_tokens": 100})
        self.assertFalse(check["ok"])
        self.assertEqual(check["reason"], "budget_exceeded")
        self.assertEqual(check["detail"]["max_tokens"], 100)

    def test_budget_cost_exceeded(self):
        check = ledger.budget_check({"tokens": 1, "cost": 2.5}, {"max_cost": 2})
        self.assertFalse(check["ok"])
        self.assertEqual(check["detail"]["max_cost"], 2)

    def test_budget_within_limits(self):
        check = ledger.budget_check({"tokens": 10, "cost": 0.1}, {"max_tokens": 100, "max_cost": 1})
        self.assertTrue(check["ok"])
        self.assertIsNone(check["reason"])

    def test_budget_absent_allows_everything(self):
        self.assertTrue(ledger.budget_check({"tokens": 10**9, "cost": 10**9}, None)["ok"])


class TestMeter(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def test_record_accumulates(self):
        m = ledger.meter(self.conn, "NODE-A")
        m.record(tokens_in=10, tokens_out=20)
        m.record(tokens_in=5, tokens_out=5, calls=2)
        self.assertEqual(m.buffered["tokens_in"], 15)
        self.assertEqual(m.buffered["tokens_out"], 25)
        self.assertEqual(m.buffered["calls"], 3)
        self.assertEqual(ledger.totals(self.conn, "NODE-A")["rows"], 0)

    def test_flush_writes_single_row_and_resets(self):
        m = ledger.meter(self.conn, "NODE-A", instance_id="inst-1")
        m.record(tokens_in=10, tokens_out=20)
        row = m.flush()
        self.assertIsNotNone(row)
        self.assertEqual(row["instance_id"], "inst-1")
        self.assertEqual(ledger.totals(self.conn, "NODE-A")["tokens"], 30)
        self.assertEqual(m.buffered["tokens_in"], 0)

    def test_empty_flush_writes_nothing(self):
        m = ledger.meter(self.conn, "NODE-A")
        self.assertIsNone(m.flush())
        self.assertEqual(ledger.totals(self.conn, "NODE-A")["rows"], 0)

    def test_context_manager_records_wall_ms(self):
        ticks = iter([10.0, 10.25])
        m = ledger.Meter(self.conn, "NODE-A", clock=lambda: next(ticks))
        with m as meter:
            meter.record(tokens_in=1, calls=1)
        row = ledger.rows(self.conn, "NODE-A")[0]
        self.assertEqual(row["wall_ms"], 250)

    def test_context_manager_skips_flush_on_exception(self):
        with self.assertRaises(RuntimeError):
            with ledger.meter(self.conn, "NODE-A") as m:
                m.record(tokens_in=1, calls=1)
                raise RuntimeError("boom")
        self.assertEqual(ledger.totals(self.conn, "NODE-A")["rows"], 0)

    def test_meter_price_override_changes_cost(self):
        m = ledger.meter(self.conn, "NODE-A", prices={"in": 1000.0})
        m.record(tokens_in=1_000_000)
        row = m.flush()
        # 写入时按 meter 的价目表折算
        self.assertAlmostEqual(row["cost"], 1000.0, places=9)
        # 默认价目表读回 = 0.28；带同一覆盖读回才等于写入口径
        self.assertAlmostEqual(ledger.rows(self.conn, "NODE-A")[0]["cost"], 0.28, places=9)
        override = ledger.rows(self.conn, "NODE-A", prices={"in": 1000.0})[0]
        self.assertAlmostEqual(override["cost"], 1000.0, places=9)

    def test_totals_price_override_matches_rows(self):
        ledger.append(self.conn, "NODE-A", tokens_in=1_000_000, calls=1)
        default_cost = ledger.totals(self.conn, "NODE-A")["cost"]
        self.assertAlmostEqual(default_cost, 0.28, places=9)
        model_cost = ledger.totals(self.conn, "NODE-A", model="deepseek-reasoner")["cost"]
        self.assertAlmostEqual(model_cost, 0.56, places=9)


if __name__ == "__main__":
    unittest.main()
