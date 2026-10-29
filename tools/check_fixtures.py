#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""check_fixtures.py —— L0 工作图 schema 与 L1.1 作用域判定的 fixture 检查

用法：python tools/check_fixtures.py
依据：designs/_research/L0调用层-设计细化.md（§1-§10）、designs/_research/L1.1作用域判据-讨论稿.md（§2-§10）。

设计取舍：
  · 只用标准库：自带一个 JSON Schema 2020-12 的**子集**校验器（不引 jsonschema）。
  · 三态输出与退出码对齐管理区约定：0 全通过 / 1 有问题 / 2 仅待核 / 3 脚本自身错。
  · 语义检查只覆盖「schema 表达不了、且已写进设计」的少数规则；不假装覆盖全部状态机。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

try:  # Windows 控制台默认可能是 GBK
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_DIR = ROOT / "schema"
FIXTURES = ROOT / "fixtures"
MANIFEST = FIXTURES / "manifest.json"

PASS = 0
FAIL = 0
TBD = 0


def ok(msg):
    print("[通过] " + msg)


def problem(msg):
    print("[问题] " + msg)


def note(msg):
    global TBD
    TBD += 1
    print("[待核] " + msg)


# ── JSON Schema 子集校验器 ──────────────────────────────────────────────
def _type_name(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int):
        return "integer"
    if isinstance(v, float):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    if isinstance(v, dict):
        return "object"
    return type(v).__name__


def _is_type(v, t):
    if t == "object":
        return isinstance(v, dict)
    if t == "array":
        return isinstance(v, list)
    if t == "string":
        return isinstance(v, str)
    if t == "integer":
        return isinstance(v, int) and not isinstance(v, bool)
    if t == "number":
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    if t == "boolean":
        return isinstance(v, bool)
    if t == "null":
        return v is None
    return True


def _resolve(root_schema, ref):
    if not ref.startswith("#/"):
        raise ValueError("只支持本地 $ref：" + ref)
    node = root_schema
    for part in ref[2:].split("/"):
        node = node[part]
    return node


def validate(inst, schema, root_schema, path="$"):
    errs = []
    if not isinstance(schema, dict):
        return errs
    if "$ref" in schema:
        return validate(inst, _resolve(root_schema, schema["$ref"]), root_schema, path)

    t = schema.get("type")
    if t is not None:
        ts = t if isinstance(t, list) else [t]
        if not any(_is_type(inst, x) for x in ts):
            errs.append("%s: 类型应为 %s，实际 %s" % (path, t, _type_name(inst)))
            return errs

    if "const" in schema and inst != schema["const"]:
        errs.append("%s: 取值必须为 %r" % (path, schema["const"]))
    if "enum" in schema and inst not in schema["enum"]:
        errs.append("%s: 取值不在枚举 %s（实际 %r）" % (path, schema["enum"], inst))

    if isinstance(inst, str):
        if "minLength" in schema and len(inst) < schema["minLength"]:
            errs.append("%s: 长度小于 %s" % (path, schema["minLength"]))
        if "maxLength" in schema and len(inst) > schema["maxLength"]:
            errs.append("%s: 长度大于 %s" % (path, schema["maxLength"]))
        if "pattern" in schema and re.search(schema["pattern"], inst) is None:
            errs.append("%s: 不符合格式 %s（实际 %r）" % (path, schema["pattern"], inst))

    if isinstance(inst, (int, float)) and not isinstance(inst, bool):
        if "minimum" in schema and inst < schema["minimum"]:
            errs.append("%s: 小于最小值 %s" % (path, schema["minimum"]))
        if "maximum" in schema and inst > schema["maximum"]:
            errs.append("%s: 大于最大值 %s" % (path, schema["maximum"]))

    if isinstance(inst, list):
        if "minItems" in schema and len(inst) < schema["minItems"]:
            errs.append("%s: 元素少于 %s 个" % (path, schema["minItems"]))
        if "maxItems" in schema and len(inst) > schema["maxItems"]:
            errs.append("%s: 元素多于 %s 个" % (path, schema["maxItems"]))
        if schema.get("uniqueItems"):
            seen, dups = set(), []
            for i, x in enumerate(inst):
                key = json.dumps(x, sort_keys=True, ensure_ascii=False)
                if key in seen:
                    dups.append(i)
                seen.add(key)
            if dups:
                errs.append("%s: uniqueItems 不满足（重复下标 %s）" % (path, dups))
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for i, x in enumerate(inst):
                errs.extend(validate(x, item_schema, root_schema, "%s[%d]" % (path, i)))

    if isinstance(inst, dict):
        for k in schema.get("required", []):
            if k not in inst:
                errs.append("%s: 缺少必填字段 \"%s\"" % (path, k))
        props = schema.get("properties", {})
        for k, v in inst.items():
            if k in props:
                errs.extend(validate(v, props[k], root_schema, "%s.%s" % (path, k)))
            elif schema.get("additionalProperties") is False:
                errs.append("%s: 不允许的字段 \"%s\"" % (path, k))

    for key in ("allOf", "anyOf", "oneOf"):
        if key not in schema:
            continue
        candidates = schema[key]
        results = [validate(inst, s, root_schema, path) for s in candidates]
        if key == "allOf":
            for r in results:
                errs.extend(r)
        elif key == "anyOf":
            if all(r for r in results):
                errs.append("%s: anyOf 无一支满足" % path)
        else:  # oneOf
            if sum(1 for r in results if not r) != 1:
                errs.append("%s: oneOf 必须恰好一支满足" % path)
    return errs


# ── 语义检查（schema 表达不了的部分）──────────────────────────────────
def graph_errors(g):
    errs = []
    nodes = g.get("nodes", [])
    node_ids = [n.get("node_id") for n in nodes]
    if len(set(node_ids)) != len(node_ids):
        errs.append("节点 id 重复：%s" % node_ids)
    unit_ids = [u.get("unit_id") for u in g.get("state_units", [])]
    if len(set(unit_ids)) != len(unit_ids):
        errs.append("状态单元 id 重复：%s" % unit_ids)
    art_ids = [a.get("artifact_id") for a in g.get("artifacts", [])]
    if len(set(art_ids)) != len(art_ids):
        errs.append("产物 id 重复：%s" % art_ids)

    idset = set(node_ids)
    dep_map = {n.get("node_id"): set(n.get("deps", [])) for n in nodes}
    for e in g.get("edges", []):
        if e.get("kind") == "blocks":
            dep_map.setdefault(e.get("to"), set()).add(e.get("from"))
    for nid, deps in dep_map.items():
        for d in deps:
            if d not in idset:
                errs.append("依赖不存在：%s -> %s" % (nid, d))

    # 依赖环（DFS）
    color = {}

    def dfs(nid, stack):
        color[nid] = 1
        for d in dep_map.get(nid, ()):
            if d not in idset:
                continue
            if color.get(d) == 1:
                cycle = stack[stack.index(d):] + [d] if d in stack else stack + [d]
                errs.append("依赖成环：%s" % " -> ".join(cycle))
                return True
            if color.get(d, 0) == 0 and dfs(d, stack + [d]):
                return True
        color[nid] = 2
        return False

    for nid in idset:
        if color.get(nid, 0) == 0 and dfs(nid, [nid]):
            break

    for n in nodes:
        if n.get("status") in ("accepted", "done") and not n.get("verifier_ids"):
            errs.append("节点 %s 状态 %s 但缺 verifier_ids（检验不可绕过 / 产出必须自足）"
                        % (n.get("node_id"), n.get("status")))

    for a in g.get("artifacts", []):
        if a.get("producer_node") not in idset:
            errs.append("产物的 producer 节点不存在：%s -> %s"
                        % (a.get("artifact_id"), a.get("producer_node")))

    # ── v2：决策 / 证据 / 依赖门控 / 阶段闸门 / 重算版本 ──
    status_of = {n.get("node_id"): n.get("status") for n in nodes}
    art_set = set(art_ids)

    decisions = g.get("decisions", [])
    dec_ids = [d.get("decision_id") for d in decisions]
    if len(set(dec_ids)) != len(dec_ids):
        errs.append("决策 id 重复：%s" % dec_ids)
    dec_map = {d.get("decision_id"): d for d in decisions}
    for d in decisions:
        did = d.get("decision_id")
        if d.get("node_id") and d["node_id"] not in idset:
            errs.append("决策 %s 的 node_id 不存在：%s" % (did, d["node_id"]))
        level = d.get("level")
        status = d.get("status")
        if level == "L2":
            if not d.get("default_option_id"):
                errs.append("决策 %s（L2）缺 default_option_id（默认值 + 超时推进是硬要求）" % did)
            if not d.get("timeout_sec"):
                errs.append("决策 %s（L2）缺 timeout_sec" % did)
            if status == "timed_out" and d.get("chosen_option_id") != d.get("default_option_id"):
                errs.append("决策 %s（L2）超时后 chosen 必须等于默认值：chosen=%s default=%s"
                            % (did, d.get("chosen_option_id"), d.get("default_option_id")))
        elif level == "L3":
            if status not in ("confirmed", "blocked"):
                errs.append("决策 %s（L3）状态必须 confirmed 或 blocked（硬闸门）" % did)
            if status == "confirmed" and not d.get("chosen_option_id"):
                errs.append("决策 %s（L3）confirmed 但缺 chosen_option_id" % did)
        else:  # L0 / L1
            if status not in ("auto", "confirmed", "overridden"):
                errs.append("决策 %s（%s）状态非法：%s" % (did, level, status))
            if not d.get("chosen_option_id"):
                errs.append("决策 %s（%s）缺 chosen_option_id" % (did, level))

    for n in nodes:
        did = n.get("decision_id")
        if did and did not in dec_map:
            errs.append("节点 %s 引用的 decision_id 不存在：%s" % (n.get("node_id"), did))

    # 证据绑定 done：done 必须有证据、全部 pass、覆盖 evidence_required
    for n in nodes:
        ev = n.get("evidence", [])
        for e in ev:
            if e.get("artifact_id") not in art_set:
                errs.append("证据 %s 引用的 artifact 不存在：%s"
                            % (e.get("evidence_id"), e.get("artifact_id")))
        if n.get("status") == "done":
            if not ev:
                errs.append("节点 %s 状态 done 但缺证据（done 只能由证据事务触发）" % n.get("node_id"))
                continue
            bad = [e.get("evidence_id") for e in ev if e.get("verdict") != "pass"]
            if bad:
                errs.append("节点 %s 状态 done 但证据未通过：%s"
                            % (n.get("node_id"), "、".join(map(str, bad))))
            required = set(n.get("evidence_required", []))
            got = {e.get("kind") for e in ev if e.get("verdict") == "pass"}
            missing = sorted(required - got)
            if missing:
                errs.append("节点 %s 状态 done 但缺必需证据类型：%s"
                            % (n.get("node_id"), "、".join(missing)))

    # 依赖门控 ready：ready 的依赖必须全部 done
    for n in nodes:
        if n.get("status") == "ready":
            for dep in n.get("deps", []):
                if status_of.get(dep) != "done":
                    errs.append("节点 %s 状态 ready 但依赖 %s 未 done（ready 只能由依赖 done 事件触发）"
                                % (n.get("node_id"), dep))

    # 阶段闸门：done 节点所在阶段闸门必须 passed
    gates = {x.get("stage"): x.get("status") for x in g.get("stage_gates", [])}
    for n in nodes:
        st = n.get("stage")
        if st and n.get("status") == "done" and gates.get(st) != "passed":
            errs.append("节点 %s 状态 done 但阶段闸门 %s 未 passed" % (n.get("node_id"), st))

    # 重算事件版本不得超前
    for r in g.get("replan_events", []):
        if r.get("graph_version", 0) > g.get("version", 0):
            errs.append("重算事件 %s 的 graph_version 超前于当前版本 %s"
                        % (r.get("event_id"), g.get("version")))
    return errs


# ── L1.1 判定（fail-closed）────────────────────────────────────────────
ALLOWED_KINDS = ("evidence", "counterexample", "premise", "decision")


def decide(req):
    units = req.get("units", [])
    reasons = []
    if req.get("revoke"):
        revoked = set(req.get("revoked_units", []))
        if not revoked:
            return {"decision": "deny", "reasons": ["REVOKE_WITHOUT_TARGET"], "contaminated": []}
        contaminated = set()
        changed = True
        while changed:
            changed = False
            for u in units:
                uid = u.get("unit_id")
                if uid in contaminated:
                    continue
                deps = set(u.get("deps", []))
                if uid in revoked or deps & (revoked | contaminated):
                    contaminated.add(uid)
                    changed = True
        return {"decision": "invalidate", "reasons": ["REVOKED_UPSTREAM"],
                "contaminated": sorted(contaminated)}

    stale = False
    denied = False
    for u in units:
        scope = u.get("scope")
        if scope is None:
            reasons.append("UNLABELED_SCOPE")
            denied = True
        elif scope == "private":
            reasons.append("PRIVATE_SCOPE")
            denied = True
        else:
            gv, rv = u.get("graph_version"), req.get("graph_version")
            if gv and rv and gv != rv:
                reasons.append("STALE_UNIT")
                stale = True
            elif u.get("competing"):
                reasons.append("COMPETING_PATH")
                denied = True
            elif u.get("status") != "confirmed":
                reasons.append("UNVERIFIED")
                denied = True
            elif u.get("kind") not in ALLOWED_KINDS:
                reasons.append("UNVERIFIED")
                denied = True

    uniq = list(dict.fromkeys(reasons))
    decision = "invalidate" if stale else ("deny" if denied else "allow")
    return {"decision": decision, "reasons": uniq, "contaminated": []}


# ── 运行 ────────────────────────────────────────────────────────────────
def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def run_graph_case(case, ws_schema):
    global PASS, FAIL
    f = ROOT / case["file"]
    if not f.exists():
        note("缺文件：%s" % case["file"])
        return "tbd"
    g = load_json(f)
    errs = validate(g, ws_schema, ws_schema) + graph_errors(g)
    expect = case["expect"]
    if expect == "valid":
        if errs:
            problem("%s 期望合法，实际 %d 处错误：%s" % (case["file"], len(errs), "；".join(errs[:4])))
            FAIL += 1
            return "fail"
        ok("%s（合法）" % case["file"])
        PASS += 1
        return "pass"
    # expect invalid
    if not errs:
        problem("%s 期望非法，但校验通过（门禁瞎了）" % case["file"])
        FAIL += 1
        return "fail"
    needle = case.get("expect_error_contains", "")
    if needle and not any(needle in e for e in errs):
        problem("%s 报错未命中预期关键字 %r：%s" % (case["file"], needle, "；".join(errs[:4])))
        FAIL += 1
        return "fail"
    ok("%s（按预期拒绝：%s）" % (case["file"], errs[0][:80]))
    PASS += 1
    return "pass"


def run_l11_case(case, scope_schema):
    global PASS, FAIL
    f = ROOT / case["file"]
    if not f.exists():
        note("缺文件：%s" % case["file"])
        return "tbd"
    req = load_json(f)
    errs = validate(req, scope_schema, scope_schema)
    if errs:
        problem("%s 结构不合法：%s" % (case["file"], "；".join(errs[:4])))
        FAIL += 1
        return "fail"
    got = decide(req)
    exp = case["expect"]
    bad = []
    if got["decision"] != exp["decision"]:
        bad.append("decision 期望 %s 实际 %s" % (exp["decision"], got["decision"]))
    if sorted(got["reasons"]) != sorted(exp["reasons"]):
        bad.append("reasons 期望 %s 实际 %s" % (exp["reasons"], got["reasons"]))
    if sorted(got["contaminated"]) != sorted(exp["contaminated"]):
        bad.append("contaminated 期望 %s 实际 %s" % (exp["contaminated"], got["contaminated"]))
    if bad:
        problem("%s 判定不符：%s" % (case["file"], "；".join(bad)))
        FAIL += 1
        return "fail"
    ok("%s（%s%s）" % (case["file"], got["decision"],
                       ("：" + "、".join(got["reasons"])) if got["reasons"] else ""))
    PASS += 1
    return "pass"


def main():
    global PASS, FAIL, TBD
    try:
        ws_schema = load_json(SCHEMA_DIR / "work_graph.schema.json")
        scope_schema = load_json(SCHEMA_DIR / "l1_scope.schema.json")
        manifest = load_json(MANIFEST)
    except Exception as e:  # 脚本自身错
        print("[待核] 脚本自身错误：%s" % e)
        return 3

    print("== 1. 工作图 schema / 语义 fixture ==")
    for case in manifest.get("graph", []):
        run_graph_case(case, ws_schema)

    print()
    print("== 2. L1.1 作用域判定 fixture ==")
    for case in manifest.get("l11", []):
        run_l11_case(case, scope_schema)

    print()
    print("-" * 46)
    print("[通过] %d  |  [问题] %d  |  [待核] %d" % (PASS, FAIL, TBD))
    if FAIL:
        return 1
    if TBD:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
