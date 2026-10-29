# -*- coding: utf-8 -*-
"""R4 单元测试：租约 / 续租 / 过期 / 接管 / fencing。"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from control_plane import db, events, graph, leases  # noqa: E402


class TestLeases(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")
        graph.add_node(self.conn, node_id="NODE-001", title="t", spec="s", status="ready")

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def test_claim_and_double_claim(self):
        lease = leases.claim(self.conn, "NODE-001", "agent-A", ttl_sec=60, now=1000)
        self.assertEqual(lease["fencing_token"], 1)
        node = graph.get_node(self.conn, "NODE-001")
        self.assertEqual(node["status"], "claimed")
        self.assertEqual(node["assignee"], "agent-A")
        with self.assertRaises(leases.LeaseHeld):
            leases.claim(self.conn, "NODE-001", "agent-B", ttl_sec=60, now=1001)

    def test_claim_requires_ready(self):
        graph.add_node(self.conn, node_id="NODE-002", title="t", spec="s", status="planned")
        with self.assertRaises(leases.LeaseError):
            leases.claim(self.conn, "NODE-002", "agent-A")

    def test_renew_and_fencing(self):
        leases.claim(self.conn, "NODE-001", "agent-A", ttl_sec=10, now=1000)
        renewed = leases.renew(self.conn, "NODE-001", "agent-A", 1, ttl_sec=20, now=1005)
        self.assertEqual(renewed["expires_at"], 1025)
        with self.assertRaises(leases.FencingError):
            leases.renew(self.conn, "NODE-001", "agent-A", 99, now=1006)
        with self.assertRaises(leases.FencingError):
            leases.renew(self.conn, "NODE-001", "agent-B", 1, now=1006)

    def test_renew_expired(self):
        leases.claim(self.conn, "NODE-001", "agent-A", ttl_sec=10, now=1000)
        with self.assertRaises(leases.LeaseExpired):
            leases.renew(self.conn, "NODE-001", "agent-A", 1, now=1011)

    def test_expire_and_token_monotonic(self):
        leases.claim(self.conn, "NODE-001", "agent-A", ttl_sec=10, now=1000)
        expired = leases.expire(self.conn, now=1011)
        self.assertEqual(expired, ["NODE-001"])
        node = graph.get_node(self.conn, "NODE-001")
        self.assertEqual(node["status"], "ready")
        self.assertEqual(node["attempts"], 1)
        second = leases.claim(self.conn, "NODE-001", "agent-B", ttl_sec=10, now=1012)
        self.assertEqual(second["fencing_token"], 2)

    def test_takeover(self):
        leases.claim(self.conn, "NODE-001", "agent-A", ttl_sec=10, now=1000)
        with self.assertRaises(leases.LeaseHeld):
            leases.takeover(self.conn, "NODE-001", "agent-B", now=1005)
        lease = leases.takeover(self.conn, "NODE-001", "agent-B", ttl_sec=30, now=1011)
        self.assertEqual(lease["owner"], "agent-B")
        self.assertEqual(lease["fencing_token"], 2)
        with self.assertRaises(leases.FencingError):
            leases.renew(self.conn, "NODE-001", "agent-A", 1, now=1012)

    def test_release(self):
        leases.claim(self.conn, "NODE-001", "agent-A", ttl_sec=10, now=1000)
        leases.release(self.conn, "NODE-001", "agent-A", 1)
        self.assertIsNone(leases.current_lease(self.conn, "NODE-001"))
        node = graph.get_node(self.conn, "NODE-001")
        self.assertEqual(node["status"], "ready")
        self.assertIsNone(node["assignee"])
        again = leases.claim(self.conn, "NODE-001", "agent-B", ttl_sec=10, now=1001)
        self.assertEqual(again["fencing_token"], 2)

    def test_assert_fencing_expired(self):
        leases.claim(self.conn, "NODE-001", "agent-A", ttl_sec=10, now=1000)
        leases.assert_fencing(self.conn, "NODE-001", "agent-A", 1, now=1005)
        with self.assertRaises(leases.LeaseExpired):
            leases.assert_fencing(self.conn, "NODE-001", "agent-A", 1, now=1011)

    # ---- WP-01/02：租约操作全部走 graph.set_status，且 snapshot == replay ----

    def _assert_replay_aligned(self):
        self.assertEqual(graph.snapshot(self.conn), graph.replay_snapshot(self.conn))
        self.assertEqual(graph.replay_mismatches(self.conn), [])

    def _status_events(self):
        return [e for e in events.iter_events(self.conn) if e["kind"] == "status_changed"]

    def test_claim_replay_aligned_and_real_from(self):
        leases.claim(self.conn, "NODE-001", "agent-A", ttl_sec=60, now=1000)
        ev = self._status_events()[-1]
        self.assertEqual((ev["payload"]["from"], ev["payload"]["to"]), ("ready", "claimed"))
        self.assertEqual(ev["payload"]["assignee"], "agent-A")
        self.assertEqual(ev["payload"]["reason"], "lease_claimed")
        self._assert_replay_aligned()

    def test_renew_does_not_disturb_state(self):
        leases.claim(self.conn, "NODE-001", "agent-A", ttl_sec=10, now=1000)
        before = len(self._status_events())
        leases.renew(self.conn, "NODE-001", "agent-A", 1, ttl_sec=20, now=1005)
        self.assertEqual(len(self._status_events()), before)
        self._assert_replay_aligned()

    def test_release_replay_aligned(self):
        leases.claim(self.conn, "NODE-001", "agent-A", ttl_sec=10, now=1000)
        leases.release(self.conn, "NODE-001", "agent-A", 1)
        ev = self._status_events()[-1]
        self.assertEqual((ev["payload"]["from"], ev["payload"]["to"]), ("claimed", "ready"))
        self.assertIsNone(ev["payload"]["assignee"])
        self._assert_replay_aligned()

    def test_expire_from_running_is_real_prev_status(self):
        """过期回收时 from 必须是真实前态（running），不是写死的 claimed。

        D2 白名单里没有 claimed→running（`running` 属 reserved），这里用「建图期构造 running +
        直接落一行租约」复现运行中崩溃，而不是为测试放宽白名单。
        """
        graph.add_node(self.conn, node_id="NODE-RUN", title="r", spec="s", status="running")
        self.conn.execute(
            "INSERT INTO leases(node_id,owner,fencing_token,expires_at,heartbeat_at)"
            " VALUES('NODE-RUN','agent-A',1,1000.0,900.0)"
        )
        self.conn.commit()
        leases.expire(self.conn, now=1011)
        ev = self._status_events()[-1]
        self.assertEqual((ev["payload"]["from"], ev["payload"]["to"]), ("running", "ready"))
        self.assertEqual(ev["payload"]["attempts"], 1)
        self.assertIsNone(ev["payload"]["assignee"])
        self._assert_replay_aligned()

    def test_takeover_replay_aligned(self):
        leases.claim(self.conn, "NODE-001", "agent-A", ttl_sec=10, now=1000)
        leases.takeover(self.conn, "NODE-001", "agent-B", ttl_sec=30, now=1011)
        ev = self._status_events()[-1]
        self.assertEqual(ev["payload"]["to"], "claimed")
        self.assertEqual(ev["payload"]["assignee"], "agent-B")
        self.assertEqual(ev["payload"]["reason"], "takeover")
        node = graph.get_node(self.conn, "NODE-001")
        self.assertEqual(node["assignee"], "agent-B")
        self._assert_replay_aligned()

    def test_no_direct_status_write_in_leases(self):
        """收敛护栏：leases 模块不得再出现直写 tasks.status 的 SQL。"""
        src = Path(leases.__file__).read_text(encoding="utf-8")
        self.assertNotIn("UPDATE tasks SET status", src)
        self.assertNotIn("UPDATE tasks SET", src)


if __name__ == "__main__":
    unittest.main()
