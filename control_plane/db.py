# -*- coding: utf-8 -*-
"""control_plane.db —— SQLite 状态库（v1）

设计依据：
  - designs/_research/L0调用层-设计细化.md §1–§10（工作图 / 状态机 / 租约 / 验证器 / 计费）
  - designs/Root编排与控制面.md（SQLite 事件日志 + 幂等 activity + 决策账本）

原则：
  - 状态在库，Agent/planner 无状态；
  - 事件只追加（events 表）；
  - done 只能由证据事务推进（由 engine 实现，schema 只留约束）；
  - 仅标准库：sqlite3 / json。
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 5
DEFAULT_DB_NAME = "control_plane.db"

# meta 键：证据严格模式（'1' = 复核 artifact path/sha、拒未注册验证器、拒 done 后追加）
META_EVIDENCE_STRICT = "evidence_strict"

SCHEMA_SQL = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  node_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  spec TEXT NOT NULL,
  capability TEXT,
  stage TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  deps_json TEXT NOT NULL DEFAULT '[]',
  evidence_required_json TEXT NOT NULL DEFAULT '[]',
  decision_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  assignee TEXT,
  verifier_ids_json TEXT NOT NULL DEFAULT '[]',
  budget_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('blocks', 'artifact', 'review')),
  PRIMARY KEY (from_id, to_id, kind)
);

CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  node_id TEXT,
  level TEXT NOT NULL CHECK (level IN ('L0', 'L1', 'L2', 'L3')),
  question TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  default_option_id TEXT,
  chosen_option_id TEXT,
  reversible INTEGER NOT NULL DEFAULT 1,
  impact TEXT NOT NULL DEFAULT 'low',
  status TEXT NOT NULL,
  timeout_sec INTEGER NOT NULL DEFAULT 0,
  decided_at TEXT,
  note TEXT,
  created_at TEXT,
  deadline_at REAL
);

CREATE TABLE IF NOT EXISTS evidence (
  evidence_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  artifact_id TEXT,
  verifier_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'unknown')),
  attempt_no INTEGER NOT NULL DEFAULT 0,
  identity TEXT,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  producer_node TEXT,
  verifier_ids_json TEXT NOT NULL DEFAULT '[]',
  a2a_artifact_id TEXT,
  sha_algo TEXT NOT NULL DEFAULT 'sha256',
  note TEXT,
  created_at TEXT
);

-- append-only 兜底：证据/产物行不可改、不可删（覆盖只能在 API 层被拒并留痕）
CREATE TRIGGER IF NOT EXISTS trg_evidence_no_update
BEFORE UPDATE ON evidence
BEGIN
  SELECT RAISE(ABORT, 'evidence is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_evidence_no_delete
BEFORE DELETE ON evidence
BEGIN
  SELECT RAISE(ABORT, 'evidence is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_artifacts_no_update
BEFORE UPDATE ON artifacts
BEGIN
  SELECT RAISE(ABORT, 'artifacts is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_artifacts_no_delete
BEFORE DELETE ON artifacts
BEGIN
  SELECT RAISE(ABORT, 'artifacts is append-only');
END;

-- 验证器身份注册（身份钩子的默认解析源；D 的职务编队按 role 注册）
CREATE TABLE IF NOT EXISTS verifiers (
  verifier_id TEXT PRIMARY KEY,
  kind TEXT,
  role TEXT,
  identity_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

-- 每次提交/被拒都留痕，attempt 历史不可丢
CREATE TABLE IF NOT EXISTS evidence_attempts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_id TEXT NOT NULL,
  node_id TEXT,
  kind TEXT,
  artifact_id TEXT,
  verifier_id TEXT,
  verdict TEXT,
  attempt_no INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT 'accepted',
  reason TEXT,
  at TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TRIGGER IF NOT EXISTS trg_evidence_attempts_no_update
BEFORE UPDATE ON evidence_attempts
BEGIN
  SELECT RAISE(ABORT, 'evidence_attempts is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_evidence_attempts_no_delete
BEFORE DELETE ON evidence_attempts
BEGIN
  SELECT RAISE(ABORT, 'evidence_attempts is append-only');
END;

-- artifact path/sha 复核历史
CREATE TABLE IF NOT EXISTS artifact_checks (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id TEXT NOT NULL,
  node_id TEXT,
  ok INTEGER NOT NULL,
  actual_path TEXT,
  actual_sha256 TEXT,
  reason TEXT,
  at TEXT NOT NULL
);

-- 跨节点复用留痕（A2A 交接后才允许）
CREATE TABLE IF NOT EXISTS artifact_uses (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  evidence_id TEXT,
  via TEXT NOT NULL DEFAULT 'local',
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  node_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  instance_id TEXT,
  role TEXT,
  estimated INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cache_saved INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  wall_ms INTEGER NOT NULL DEFAULT 0,
  verifier_cost REAL NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leases (
  node_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  expires_at REAL NOT NULL,
  heartbeat_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS lease_counters (
  node_id TEXT PRIMARY KEY,
  last_token INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stage_gates (
  stage TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'passed', 'failed')),
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS replan_events (
  event_id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  reason TEXT NOT NULL,
  graph_version INTEGER NOT NULL,
  added_json TEXT NOT NULL DEFAULT '[]',
  removed_json TEXT NOT NULL DEFAULT '[]',
  note TEXT
);

CREATE TABLE IF NOT EXISTS capabilities (
  name TEXT PRIMARY KEY,
  description TEXT,
  input_contract_json TEXT NOT NULL DEFAULT '{}',
  output_contract_json TEXT NOT NULL DEFAULT '{}',
  tools_json TEXT NOT NULL DEFAULT '[]',
  acceptance_template_json TEXT NOT NULL DEFAULT '{}',
  cost_profile_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS idx_evidence_node ON evidence(node_id);
CREATE INDEX IF NOT EXISTS idx_evidence_attempts_node ON evidence_attempts(node_id, seq);
CREATE INDEX IF NOT EXISTS idx_artifact_checks_art ON artifact_checks(artifact_id, seq);
CREATE INDEX IF NOT EXISTS idx_artifact_uses_art ON artifact_uses(artifact_id, seq);
CREATE INDEX IF NOT EXISTS idx_ledger_node ON ledger(node_id, id);
"""


def now_iso() -> str:
    """本地时区的 ISO 时间戳（秒精度）。"""
    return datetime.now(timezone.utc).astimezone().replace(microsecond=0).isoformat()


def dumps(value: Any) -> str:
    """稳定 JSON 序列化（便于断言与哈希）。"""
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def loads(text: str | None, default: Any = None) -> Any:
    if text is None or text == "":
        return default
    return json.loads(text)


def connect(path: str | Path) -> sqlite3.Connection:
    """打开（必要时创建）数据库；父目录自动创建；设置 row_factory 与外键。"""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _add_columns(conn: sqlite3.Connection, table: str, columns: dict[str, str]) -> list[str]:
    """给既有表补列（幂等）。返回实际新增的列名，便于迁移测试断言。"""
    existing = {r["name"] for r in conn.execute("PRAGMA table_info(%s)" % table)}
    added: list[str] = []
    for name, ddl in columns.items():
        if name not in existing:
            conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, name, ddl))
            added.append(name)
    return added


def _migrate(conn: sqlite3.Connection) -> list[str]:
    """轻量迁移：给既有库补新列（幂等）。返回本次新增的列（空表示无需迁移）。"""
    added: list[str] = []
    added += _add_columns(
        conn,
        "decisions",
        {"created_at": "TEXT", "deadline_at": "REAL"},
    )
    added += _add_columns(conn, "capabilities", {"description": "TEXT"})
    added += _add_columns(
        conn,
        "evidence",
        {"attempt_no": "INTEGER NOT NULL DEFAULT 0", "identity": "TEXT"},
    )
    added += _add_columns(
        conn,
        "artifacts",
        {"sha_algo": "TEXT NOT NULL DEFAULT 'sha256'", "note": "TEXT", "created_at": "TEXT"},
    )
    added += _add_columns(
        conn,
        "ledger",
        {"role": "TEXT", "estimated": "INTEGER NOT NULL DEFAULT 0"},
    )
    if added:
        conn.execute(
            "INSERT INTO meta(key, value) VALUES('migrated_at', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (now_iso(),),
        )
        conn.execute(
            "INSERT INTO meta(key, value) VALUES('migrated_to', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (str(SCHEMA_VERSION),),
        )
    return added


def init_db(path: str | Path, *, strict: bool | None = None) -> sqlite3.Connection:
    """初始化 schema（幂等）。返回已就绪的连接。

    strict=True 打开证据严格模式（finalize 复核 artifact path/sha、拒未注册验证器、
    拒 done 后追加证据）；strict=None 保留库里既有设置（新库默认 '0'）。
    """
    conn = connect(path)
    conn.executescript(SCHEMA_SQL)
    _migrate(conn)
    conn.execute(
        "INSERT INTO meta(key, value) VALUES('schema_version', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (str(SCHEMA_VERSION),),
    )
    conn.execute(
        "INSERT INTO meta(key, value) VALUES('created_at', ?) "
        "ON CONFLICT(key) DO NOTHING",
        (now_iso(),),
    )
    conn.execute(
        "INSERT INTO meta(key, value) VALUES('graph_version', '1') "
        "ON CONFLICT(key) DO NOTHING"
    )
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, '0') ON CONFLICT(key) DO NOTHING",
        (META_EVIDENCE_STRICT,),
    )
    if strict is not None:
        conn.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (META_EVIDENCE_STRICT, "1" if strict else "0"),
        )
    conn.commit()
    return conn


def get_meta(conn: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )
    conn.commit()


def evidence_strict(conn: sqlite3.Connection) -> bool:
    """证据严格模式开关（默认关闭，保证既有夹具/演示路径不变）。"""
    return (get_meta(conn, META_EVIDENCE_STRICT, "0") or "0") == "1"


def set_evidence_strict(conn: sqlite3.Connection, enabled: bool = True) -> None:
    set_meta(conn, META_EVIDENCE_STRICT, "1" if enabled else "0")


def table_names(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    return [r["name"] for r in rows]


def schema_version(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    return int(row["value"]) if row else 0
