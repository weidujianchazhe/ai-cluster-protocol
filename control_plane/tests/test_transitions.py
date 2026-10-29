# -*- coding: utf-8 -*-
"""R8 / WP-10：节点状态迁移表（可执行契约）+ blocked 解除语义。

本文件把「状态迁移表」从文档变成门禁：三层检查
  A 静态：表内状态 ⊆ graph.STATUSES；每个 site 里确实存在该 status / reason 字面量；终态无出边。
  B 覆盖：凡出现 `graph.set_status(` 的模块必须在表里有条目（新代码加了迁移却没登记会被抓出来）。
  C 语义：临时库里真跑三条代表路径（过期回收 / done 凭证闸门 / recover 补推）。
另加：
  D 保留态：`running` / `accepted` / `rejected` 目前无生产写入口（Lead 裁决：标 reserved/warning，不阻塞；
    一旦有人让它们可达，这里的断言会提醒把表一起更新）。
  E blocked 解除：`blocked → ready` 必须带 `reason="unblocked:<原因>"`（正反向用例）。
"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from control_plane import db, events, evidence, graph, leases, recovery  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]  # 仓库根（本文件在 control_plane/tests/ 下）
SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

# ── 迁移表（20 行）──────────────────────────────────────────────────
# frm/to     状态对
# reason     `a|b` = 或集；以 `<` 开头的段是占位符（跳过字面量检查）；reason_mode="any" 表示任一段出现即可
# site       触发点 `模块:函数`
# guards     前置条件（文档用，同时在语义测试里被验证）
# effects    副作用（assignee / attempts / 租约）
# events     产出事件
TABLE = [
    dict(frm="planned", to="ready", reason="bootstrap|dependency_done|replan|recovery|recompute",
         site="scheduler:recompute_ready", guards=["依赖全 done"], effects=[],
         events=["status_changed", "ready_recomputed"], reason_mode="any"),
    dict(frm="ready", to="planned", reason="deps_not_done",
         site="scheduler:recompute_ready", guards=["依赖未全 done"], effects=[],
         events=["status_changed", "ready_recomputed"]),
    dict(frm="ready", to="claimed", reason="lease_claimed",
         site="leases:claim", guards=["status==ready", "无活跃租约"],
         effects=["assignee=owner", "写 leases 行", "fencing+1"],
         events=["lease_claimed", "status_changed", "assignee_changed"]),
    dict(frm="claimed", to="ready", reason="lease_released",
         site="leases:release", guards=["fencing 匹配"],
         effects=["assignee=None", "删租约"],
         events=["lease_released", "status_changed", "assignee_changed"]),
    dict(frm="claimed", to="ready", reason="lease_expired",
         site="leases:expire", guards=["expires_at<=now"],
         effects=["assignee=None", "attempts+1", "删租约"],
         events=["lease_expired", "status_changed", "attempts_changed"]),
    dict(frm="running", to="ready", reason="lease_expired",
         site="leases:expire", guards=["expires_at<=now"],
         effects=["assignee=None", "attempts+1", "删租约"],
         events=["lease_expired", "status_changed", "attempts_changed"]),
    dict(frm="claimed", to="claimed", reason="takeover",
         site="leases:takeover", guards=["租约已过期"],
         effects=["assignee=新owner", "fencing+1"],
         events=["lease_taken_over", "status_changed", "assignee_changed"]),
    dict(frm="claimed", to="submitted", reason="submitted",
         site="evidence:submit", guards=["fencing 有效"], effects=[],
         events=["status_changed"]),
    dict(frm="running", to="submitted", reason="submitted",
         site="evidence:submit", guards=["fencing 有效"], effects=[],
         events=["status_changed"]),
    dict(frm="submitted", to="verifying", reason="verify_started",
         site="evidence:finalize", guards=["status in (submitted,verifying)"], effects=[],
         events=["status_changed"]),
    dict(frm="verifying", to="ready", reason="rejected:",
         site="evidence:_reject", guards=["依赖/闸门/证据任一不满足"],
         effects=["assignee=None", "attempts+1", "删租约"],
         events=["node_rejected", "status_changed", "attempts_changed"]),
    dict(frm="verifying", to="done", reason="evidence_ok",
         site="evidence:finalize",
         guards=["credential 有效", "证据全 pass 且覆盖 evidence_required",
                 "verifier 白名单", "deps 全 done", "阶段闸门 passed"],
         effects=["assignee=None", "删租约", "解锁下游 ready"],
         events=["status_changed", "node_done", "ready_recomputed"]),
    dict(frm="claimed", to="ready", reason="recovered:|crash_intermediate",
         site="recovery:_reset_to_ready", guards=["中间态且租约已清"],
         effects=["assignee=None", "attempts+1", "删租约"],
         events=["node_recovered", "status_changed", "attempts_changed"]),
    dict(frm="running", to="ready", reason="recovered:|crash_intermediate",
         site="recovery:_reset_to_ready", guards=["同上"],
         effects=["assignee=None", "attempts+1", "删租约"],
         events=["node_recovered", "status_changed", "attempts_changed"]),
    dict(frm="submitted", to="ready", reason="recovered:|incomplete_evidence",
         site="recovery:_reset_to_ready", guards=["证据不完整"],
         effects=["assignee=None", "attempts+1", "删租约"],
         events=["node_recovered", "status_changed", "attempts_changed"]),
    dict(frm="verifying", to="ready", reason="recovered:|incomplete_evidence",
         site="recovery:_reset_to_ready", guards=["证据不完整"],
         effects=["assignee=None", "attempts+1", "删租约"],
         events=["node_recovered", "status_changed", "attempts_changed"]),
    dict(frm="ready", to="blocked", reason="<watchdog_reason>",
         site="watchdog:_block", guards=["深度/并发/时长/预算越界"],
         effects=["assignee=None", "删租约"], events=["node_blocked", "status_changed"]),
    dict(frm="claimed", to="blocked", reason="<watchdog_reason>",
         site="watchdog:_block", guards=["越界判定"],
         effects=["assignee=None", "删租约"], events=["node_blocked", "status_changed"]),
    dict(frm="running", to="blocked", reason="<watchdog_reason>",
         site="watchdog:_block", guards=["越界判定"],
         effects=["assignee=None", "删租约"], events=["node_blocked", "status_changed"]),
    # R8：阻断解除必须留痕
    dict(frm="blocked", to="ready", reason="unblocked:|<原因>",
         site="graph:unblock", guards=["reason 以 unblocked: 开头且非空"],
         effects=["assignee=None"], events=["status_changed", "assignee_changed"]),
]

#: 声明了但生产代码里没有写入口的状态（Lead 裁决：reserved/warning，不阻塞）
RESERVED_UNREACHABLE = ["accepted", "rejected", "running"]
#: 终态：不允许出边
TERMINAL = ["done"]
#: 只是委派/文档引用的模块（不构成独立迁移入口）
PASSTHROUGH = {"engine": "Engine.finalize() 委派 evidence.finalize()，自身不调 set_status"}


def _sources():
    return {p.stem: p.read_text(encoding="utf-8") for p in (ROOT / "control_plane").glob("*.py")}


def _reason_parts(reason: str) -> list[str]:
    """`a|b` 拆或集；`<...>` 是占位符段，返回空列表表示跳过字面量检查。"""
    return [r for r in reason.split("|") if r and not r.startswith("<")]


def _reachable() -> set[str]:
    out = {}
    for row in TABLE:
        out.setdefault(row["frm"], set()).add(row["to"])
    seen, frontier = {"planned"}, ["planned"]
    while frontier:
        cur = frontier.pop()
        for nxt in out.get(cur, ()):
            if nxt not in seen:
                seen.add(nxt)
                frontier.append(nxt)
    return seen


class TestTransitionTableStatic(unittest.TestCase):
    """A 静态一致性。"""

    def setUp(self):
        self.src = _sources()

    def test_states_are_declared(self):
        for row in TABLE:
            self.assertIn(row["frm"], graph.STATUSES, "表外状态：%s" % row["frm"])
            self.assertIn(row["to"], graph.STATUSES, "表外状态：%s" % row["to"])

    def test_sites_and_literals_exist(self):
        for row in TABLE:
            mod, func = row["site"].split(":")
            text = self.src.get(mod)
            self.assertIsNotNone(text, "site 模块不存在：%s" % mod)
            self.assertIn(func, text, "site 函数不存在：%s" % row["site"])
            self.assertIn('"%s"' % row["to"], text,
                          "site %s 里找不到目标状态 %s" % (row["site"], row["to"]))
            parts = _reason_parts(row["reason"])
            if not parts:
                continue  # 全占位符（如 watchdog 的参数化 reason）
            hits = ['"%s"' % p in text for p in parts]
            if row.get("reason_mode") == "any":
                self.assertTrue(any(hits), "site %s 里没有任何 reason 候选：%s"
                                % (row["site"], row["reason"]))
            else:
                self.assertTrue(all(hits), "site %s 里缺少 reason 片段：%s"
                                % (row["site"], row["reason"]))

    def test_terminal_has_no_outgoing(self):
        for row in TABLE:
            self.assertNotIn(row["frm"], TERMINAL, "终态 %s 有出边 -> %s" % (row["frm"], row["to"]))

    def test_every_writer_is_in_table(self):
        """B 覆盖：出现 set_status 的模块必须登记（防止绕过表新增迁移）。"""
        writers = {name for name, text in self.src.items() if "graph.set_status(" in text}
        covered = {row["site"].split(":")[0] for row in TABLE}
        unregistered = sorted(writers - covered - {"graph"} - set(PASSTHROUGH))
        self.assertEqual(unregistered, [], "有 set_status 调用但未进迁移表：%s" % unregistered)


class TestReachability(unittest.TestCase):
    """D 保留态：不可达集合必须与「已知 reserved」完全一致（漂移即提醒更新表）。"""

    def test_reserved_states_match_table(self):
        unreachable = sorted(set(graph.STATUSES) - _reachable())
        self.assertEqual(unreachable, sorted(RESERVED_UNREACHABLE),
                         "状态可达性与迁移表不一致；要么补表行，要么更新 RESERVED_UNREACHABLE")

    def test_all_tables_states_reachable_from_planned_or_reserved(self):
        reachable = _reachable()
        self.assertIn("done", reachable)
        self.assertIn("blocked", reachable)
        self.assertIn("ready", reachable)


class TestTransitionSemantics(unittest.TestCase):
    """C 语义：真库跑三条代表路径。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def _mint(self, nid):
        evidence.add_artifact(self.conn, artifact_id="ART-%s" % nid, path="out/x.txt",
                              sha256=SHA, producer_node=nid)
        evidence.add_evidence(self.conn, evidence_id="EVD-%s" % nid, node_id=nid, kind="artifact",
                              artifact_id="ART-%s" % nid, verifier_id="verifier-ci", verdict="pass")
        return graph.done_credential(self.conn, nid)

    def test_expire_path(self):
        graph.add_node(self.conn, node_id="N-A", title="a", spec="s", status="ready")
        leases.claim(self.conn, "N-A", "agent-1", ttl_sec=10, now=1000)
        self.assertEqual(graph.get_node(self.conn, "N-A")["status"], "claimed")
        leases.expire(self.conn, now=1011)
        node = graph.get_node(self.conn, "N-A")
        self.assertEqual((node["status"], node["attempts"], node["assignee"]), ("ready", 1, None))
        ev = [e for e in events.iter_events(self.conn) if e["kind"] == "status_changed"][-1]
        self.assertEqual((ev["payload"]["from"], ev["payload"]["to"]), ("claimed", "ready"))
        self.assertEqual(graph.snapshot(self.conn), graph.replay_snapshot(self.conn))

    def test_done_requires_credential_and_unlocks_downstream(self):
        graph.add_node(self.conn, node_id="N-A", title="a", spec="s", status="verifying",
                       evidence_required=["artifact"], verifier_ids=["verifier-ci"])
        graph.add_node(self.conn, node_id="N-B", title="b", spec="s", deps=["N-A"])
        with self.assertRaises(graph.CredentialError):
            graph.set_status(self.conn, "N-A", "done")
        graph.set_status(self.conn, "N-A", "done", credential=self._mint("N-A"), reason="evidence_ok")
        self.assertEqual(graph.get_node(self.conn, "N-B")["status"], "ready")

    def test_recover_promotes(self):
        graph.add_node(self.conn, node_id="N-A", title="a", spec="s", status="verifying",
                       evidence_required=["artifact"], verifier_ids=["verifier-ci"])
        graph.set_status(self.conn, "N-A", "done", credential=self._mint("N-A"), reason="evidence_ok")
        graph.add_node(self.conn, node_id="N-C", title="c", spec="s", deps=["N-A"])
        res = recovery.recover(self.conn, now=2000)
        self.assertIn("N-C", res["promoted"])
        self.assertFalse(res["mismatch"], res["mismatch_detail"])


class TestUnblock(unittest.TestCase):
    """E：blocked → ready 必须带 `unblocked:<原因>`；其余解除路径一律拒绝。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")
        graph.add_node(self.conn, node_id="N-A", title="a", spec="s", status="ready")
        graph.set_status(self.conn, "N-A", "blocked", reason="budget_exceeded", assignee=None)

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def _events(self):
        return [e for e in events.iter_events(self.conn) if e["kind"] == "status_changed"]

    def test_unblock_helper_succeeds_and_audits(self):
        node = graph.unblock(self.conn, "N-A", "人工确认预算已调整", note="M5 复核")
        self.assertEqual(node["status"], "ready")
        self.assertIsNone(node["assignee"])
        ev = self._events()[-1]
        self.assertEqual((ev["payload"]["from"], ev["payload"]["to"]), ("blocked", "ready"))
        self.assertEqual(ev["payload"]["reason"], "unblocked:人工确认预算已调整")
        self.assertEqual(ev["payload"]["unblock_note"], "M5 复核")
        self.assertEqual(graph.snapshot(self.conn), graph.replay_snapshot(self.conn))

    def test_set_status_with_prefixed_reason_allowed(self):
        graph.set_status(self.conn, "N-A", "ready", reason="unblocked:策略复核")
        self.assertEqual(graph.get_node(self.conn, "N-A")["status"], "ready")

    def test_missing_reason_rejected(self):
        before = len(events.iter_events(self.conn))
        with self.assertRaises(graph.GraphError):
            graph.set_status(self.conn, "N-A", "ready")
        self.assertEqual(graph.get_node(self.conn, "N-A")["status"], "blocked")
        self.assertEqual(len(events.iter_events(self.conn)), before)

    def test_wrong_prefix_rejected(self):
        for reason in ("manual", "unblock", "release", "unblocked", ""):
            with self.assertRaises(graph.GraphError, msg="应当拒绝 reason=%r" % reason):
                graph.set_status(self.conn, "N-A", "ready", reason=reason)
        self.assertEqual(graph.get_node(self.conn, "N-A")["status"], "blocked")

    def test_empty_unblock_reason_rejected(self):
        with self.assertRaises(graph.GraphError):
            graph.set_status(self.conn, "N-A", "ready", reason="unblocked:")
        with self.assertRaises(graph.GraphError):
            graph.unblock(self.conn, "N-A", "")

    def test_unblock_does_not_touch_other_transitions(self):
        """非 blocked→ready 的迁移不受该守卫影响（ready→planned 仍可降级）。"""
        graph.unblock(self.conn, "N-A", "ok")
        graph.set_status(self.conn, "N-A", "planned", reason="deps_not_done")
        self.assertEqual(graph.get_node(self.conn, "N-A")["status"], "planned")


class TestTerminalGuard(unittest.TestCase):
    """P0：`done` 是运行时终态 —— 迁移表无出边，代码也拒绝一切退出。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")
        graph.add_node(self.conn, node_id="N-A", title="a", spec="s", status="verifying",
                       evidence_required=["artifact"], verifier_ids=["verifier-ci"])
        evidence.add_artifact(self.conn, artifact_id="ART-A", path="out/a.txt", sha256=SHA,
                              producer_node="N-A")
        evidence.add_evidence(self.conn, evidence_id="EVD-A", node_id="N-A", kind="artifact",
                              artifact_id="ART-A", verifier_id="verifier-ci", verdict="pass")
        graph.set_status(self.conn, "N-A", "done",
                         credential=graph.done_credential(self.conn, "N-A"), reason="evidence_ok")

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def test_table_and_code_agree_on_terminal(self):
        exits = [row for row in TABLE if row["frm"] in TERMINAL]
        self.assertEqual(exits, [], "迁移表里不得有终态出边")
        before = len(events.iter_events(self.conn))
        for target in ("planned", "ready", "blocked", "claimed"):
            with self.assertRaises(graph.GraphError, msg="done → %s 应被拒绝" % target):
                graph.set_status(self.conn, "N-A", target)
        self.assertEqual(graph.get_node(self.conn, "N-A")["status"], "done")
        self.assertEqual(len(events.iter_events(self.conn)), before)
        self.assertEqual(graph.snapshot(self.conn), graph.replay_snapshot(self.conn))

    def test_terminal_node_survives_recover(self):
        result = recovery.recover(self.conn, now=2000)
        self.assertEqual(graph.get_node(self.conn, "N-A")["status"], "done")
        self.assertFalse(result["mismatch"], result["mismatch_detail"])


class TestWhitelistRuntime(unittest.TestCase):
    """D2：迁移表就是 `graph.set_status` 的运行时白名单（与终态守卫同层，写入前拒绝）。

    白名单默认开（`CP_TRANSITIONS_ENFORCE` 默认 1，见 lane note 回滚点）；
    这里仍显式打开，保证即使外部设了 0 也能覆盖白名单语义。
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = db.init_db(Path(self._tmp.name) / "cp.db")
        graph.set_transition_enforcement(True)

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()
        graph.set_transition_enforcement(
            __import__("os").environ.get("CP_TRANSITIONS_ENFORCE", "1") == "1"
        )

    def _add(self, nid, status):
        graph.add_node(self.conn, node_id=nid, title=nid, spec="s", status=status,
                       evidence_required=["artifact"], verifier_ids=["verifier-ci"])

    def _events(self):
        return len(events.iter_events(self.conn))

    def test_table_equals_runtime_whitelist(self):
        """单一事实源：测试表 ↔ graph.TRANSITIONS 必须完全相等（任一侧改动都要同步）。"""
        table_edges = {(row["frm"], row["to"]) for row in TABLE}
        self.assertEqual(table_edges, set(graph.TRANSITIONS))
        self.assertEqual(graph.allowed_transitions()["blocked"], {"ready"})
        self.assertEqual(graph.allowed_transitions().get("done", set()), set())

    def test_e_probe_three_edges_rejected(self):
        """E 探针：planned→running / planned→verifying / verifying→submitted 必须拒。"""
        self._add("N-READY", "planned")
        before = self._events()
        for target in ("running", "verifying", "claimed", "submitted", "done"):
            with self.assertRaises(graph.GraphError, msg="planned → %s 应被拒绝" % target):
                graph.set_status(self.conn, "N-READY", target,
                                 credential=None if target != "done" else {})
        self.assertEqual(graph.get_node(self.conn, "N-READY")["status"], "planned")
        self.assertEqual(self._events(), before, "拒绝时不得写事件")

        self._add("N-VERIFY", "verifying")
        before = self._events()
        for target in ("submitted", "planned", "claimed", "running", "blocked"):
            with self.assertRaises(graph.GraphError, msg="verifying → %s 应被拒绝" % target):
                graph.set_status(self.conn, "N-VERIFY", target)
        self.assertEqual(graph.get_node(self.conn, "N-VERIFY")["status"], "verifying")
        self.assertEqual(self._events(), before)

    def test_legal_edges_still_pass(self):
        """白名单内的边必须照常放行（不能误伤正常流程）。"""
        self._add("N-1", "planned")
        graph.set_status(self.conn, "N-1", "ready")           # planned → ready
        graph.set_status(self.conn, "N-1", "claimed", assignee="a")  # ready → claimed
        graph.set_status(self.conn, "N-1", "submitted")       # claimed → submitted
        graph.set_status(self.conn, "N-1", "verifying")       # submitted → verifying
        graph.set_status(self.conn, "N-1", "ready", reason="rejected:x", attempts_delta=1)  # verifying → ready
        graph.set_status(self.conn, "N-1", "planned")         # ready → planned
        self.assertEqual(graph.get_node(self.conn, "N-1")["status"], "planned")
        self.assertEqual(graph.snapshot(self.conn), graph.replay_snapshot(self.conn))

    def test_enforcement_can_be_switched_off_as_rollback(self):
        """回滚点：关闭强制后旧路径恢复可走（仅供历史用例/灰度）。"""
        self._add("N-2", "planned")
        graph.set_transition_enforcement(False)
        graph.set_status(self.conn, "N-2", "running")
        self.assertEqual(graph.get_node(self.conn, "N-2")["status"], "running")
        graph.set_transition_enforcement(True)
        with self.assertRaises(graph.GraphError):
            graph.set_status(self.conn, "N-2", "planned")  # running → planned 不在白名单

    def test_done_credential_path_unchanged(self):
        """白名单不改变凭证路径：合法边 verifying→done 仍需凭证，无凭证拒绝且不写入。"""
        self._add("N-3", "verifying")
        before = self._events()
        with self.assertRaises(graph.CredentialError):
            graph.set_status(self.conn, "N-3", "done")
        self.assertEqual(graph.get_node(self.conn, "N-3")["status"], "verifying")
        self.assertEqual(self._events(), before)
        evidence.add_artifact(self.conn, artifact_id="ART-N-3", path="out/x.txt", sha256=SHA,
                              producer_node="N-3")
        evidence.add_evidence(self.conn, evidence_id="EVD-N-3", node_id="N-3", kind="artifact",
                              artifact_id="ART-N-3", verifier_id="verifier-ci", verdict="pass")
        graph.set_status(self.conn, "N-3", "done",
                         credential=graph.done_credential(self.conn, "N-3"), reason="evidence_ok")
        self.assertEqual(graph.get_node(self.conn, "N-3")["status"], "done")


if __name__ == "__main__":
    unittest.main()
