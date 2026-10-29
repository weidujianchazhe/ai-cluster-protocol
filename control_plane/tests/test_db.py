# -*- coding: utf-8 -*-
"""R1 单元测试：SQLite schema 与连接助手。"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from control_plane import db  # noqa: E402

EXPECTED_TABLES = {
    "meta",
    "tasks",
    "edges",
    "decisions",
    "evidence",
    "artifacts",
    "events",
    "ledger",
    "leases",
    "lease_counters",
    "stage_gates",
    "replan_events",
    "capabilities",
}


class TestSchema(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "nested" / db.DEFAULT_DB_NAME

    def tearDown(self):
        self._tmp.cleanup()

    def test_init_creates_parent_and_tables(self):
        conn = db.init_db(self.path)
        try:
            self.assertTrue(self.path.exists())
            tables = set(db.table_names(conn))
            self.assertTrue(EXPECTED_TABLES.issubset(tables), tables)
        finally:
            conn.close()

    def test_schema_version_and_idempotent(self):
        conn = db.init_db(self.path)
        before = db.table_names(conn)
        self.assertEqual(db.schema_version(conn), db.SCHEMA_VERSION)
        conn.close()
        # 二次初始化不报错、版本与表集合不变
        conn = db.init_db(self.path)
        try:
            self.assertEqual(db.schema_version(conn), db.SCHEMA_VERSION)
            self.assertEqual(before, db.table_names(conn))
        finally:
            conn.close()

    def test_task_persists_across_reopen(self):
        conn = db.init_db(self.path)
        ts = db.now_iso()
        conn.execute(
            "INSERT INTO tasks(node_id,title,spec,status,deps_json,created_at,updated_at)"
            " VALUES(?,?,?,?,?,?,?)",
            ("NODE-001", "t", "s", "planned", db.dumps([]), ts, ts),
        )
        conn.commit()
        conn.close()

        conn = db.init_db(self.path)
        try:
            row = conn.execute("SELECT * FROM tasks WHERE node_id='NODE-001'").fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row["title"], "t")
            self.assertEqual(db.loads(row["deps_json"], []), [])
        finally:
            conn.close()

    def test_events_autoincrement(self):
        conn = db.init_db(self.path)
        try:
            ts = db.now_iso()
            conn.execute(
                "INSERT INTO events(event_id,ts,kind,payload_json) VALUES(?,?,?,?)",
                ("EVT-001", ts, "graph_created", db.dumps({})),
            )
            conn.execute(
                "INSERT INTO events(event_id,ts,kind,payload_json) VALUES(?,?,?,?)",
                ("EVT-002", ts, "node_added", db.dumps({"node_id": "NODE-001"})),
            )
            conn.commit()
            rows = conn.execute("SELECT seq, event_id FROM events ORDER BY seq").fetchall()
            self.assertEqual([r["seq"] for r in rows], [1, 2])
            self.assertEqual([r["event_id"] for r in rows], ["EVT-001", "EVT-002"])
        finally:
            conn.close()

    def test_json_helpers(self):
        value = {"b": [1, 2], "a": "中文"}
        text = db.dumps(value)
        self.assertEqual(db.loads(text), value)
        self.assertIsNone(db.loads(None))
        self.assertEqual(db.loads("", {"x": 1}), {"x": 1})


if __name__ == "__main__":
    unittest.main()
