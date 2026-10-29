# -*- coding: utf-8 -*-
"""A7 一致性夹具：适配器 8 动作黄金/失败路径 + capability 快照 diff + 四态退出码。

口径（TASK-20261029-10FB0A / WP-09 T09-5）
-------------------------------------------
* 快照 = `adapter_capabilities`（能力声明）+ `adapter_report`（实例与计量）+ `adapter_spike`（可达性）的合并体；
* 8 个黄金动作：spawn / call / artifact_io / state_cas / verify / meter / checkpoint / takeover；
* 四态与退出码：`pass`=0、`drift`=1、`failed`=2、`unknown`=3（unknown 一律 fail-closed，不当 pass）；
* **对账只用实例级 usage**：宿主 `meter.total` 含同宿主其他会话（其他 lane 的 Agent），
  与实例无关，故 `evaluate()` 绝不用它做判定；实例缺 `usage` 字段时直接判 `unknown`。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

GOLDEN_ACTIONS: tuple[str, ...] = (
    "spawn",
    "call",
    "artifact_io",
    "state_cas",
    "verify",
    "meter",
    "checkpoint",
    "takeover",
)

#: 契约要求的质量声明（不可悄悄升级）
GOLDEN_QUALITY: dict[str, Any] = {
    "supports_whitebox": False,
    "supports_prefix_cache": "observable-only",
    "same_model_only": False,
}

STATE_PASS = "pass"
STATE_DRIFT = "drift"
STATE_FAILED = "failed"
STATE_UNKNOWN = "unknown"

EXIT_CODES: dict[str, int] = {
    STATE_PASS: 0,
    STATE_DRIFT: 1,
    STATE_FAILED: 2,
    STATE_UNKNOWN: 3,
}

#: 动作缺失/降级到 absent 视为破坏契约
FATAL_LEVELS = {"absent"}


def load_snapshot(path: str | Path) -> tuple[dict[str, Any] | None, str | None]:
    """读快照；不可读或非对象时返回 (None, 原因)，由调用方判 unknown。"""
    try:
        raw = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        return None, "快照不可读：%s" % exc
    try:
        data = json.loads(raw)
    except ValueError as exc:
        return None, "快照不是合法 JSON：%s" % exc
    if not isinstance(data, dict):
        return None, "快照根节点不是对象"
    return data, None


def load_golden(path: str | Path) -> dict[str, Any]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return {
        "actions": tuple(data.get("actions") or GOLDEN_ACTIONS),
        "quality": dict(data.get("quality") or GOLDEN_QUALITY),
        "minCodeVersion": int(data.get("minCodeVersion") or 0),
    }


def reconcile(instances: list[dict[str, Any]]) -> dict[str, Any]:
    """实例级对账：只读 `usage`，宿主 total 不参与判定。"""
    basis: list[dict[str, Any]] = []
    missing: list[str] = []
    for row in instances:
        iid = str(row.get("instanceId") or row.get("instance_id") or "?")
        usage = row.get("usage")
        if not isinstance(usage, dict):
            missing.append(iid)
            continue
        basis.append(
            {
                "instanceId": iid,
                "calls": int(usage.get("calls") or 0),
                "inputTokens": int(usage.get("inputTokens") or 0),
                "outputTokens": int(usage.get("outputTokens") or 0),
                "cacheReadTokens": int(usage.get("cacheReadTokens") or 0),
            }
        )
    return {
        "basis": "instanceUsage",
        "instances": basis,
        "missingUsage": missing,
        "totals": {
            "calls": sum(row["calls"] for row in basis),
            "inputTokens": sum(row["inputTokens"] for row in basis),
            "outputTokens": sum(row["outputTokens"] for row in basis),
            "cacheReadTokens": sum(row["cacheReadTokens"] for row in basis),
        },
        "hostTotalIgnored": True,
    }


def evaluate(snapshot: dict[str, Any], golden: dict[str, Any] | None = None) -> dict[str, Any]:
    """四态判定。返回 {state, exitCode, findings, reconciliation}。"""
    golden = golden or {"actions": GOLDEN_ACTIONS, "quality": GOLDEN_QUALITY, "minCodeVersion": 0}
    findings: list[dict[str, Any]] = []

    capabilities = snapshot.get("capabilities")
    if not isinstance(capabilities, dict) or not capabilities:
        return {
            "state": STATE_UNKNOWN,
            "exitCode": EXIT_CODES[STATE_UNKNOWN],
            "findings": [{"kind": "schema", "detail": "缺 capabilities 对象"}],
            "reconciliation": None,
        }

    expected_actions = list(golden["actions"])
    contract_version = snapshot.get("contractVersion")
    if contract_version is None:
        findings.append({"kind": "schema", "detail": "缺 contractVersion（未知契约代次）"})

    code_version = int(snapshot.get("codeVersion") or 0)
    if code_version < int(golden.get("minCodeVersion") or 0):
        findings.append(
            {
                "kind": "drift",
                "detail": "codeVersion %d < 黄金最低 %d" % (code_version, int(golden.get("minCodeVersion") or 0)),
            }
        )

    # 1) 8 动作齐全 + 不降级到 absent
    for action in expected_actions:
        info = capabilities.get(action)
        if not isinstance(info, dict):
            findings.append({"kind": "missing-action", "detail": action})
            continue
        level = info.get("level")
        if level in FATAL_LEVELS:
            findings.append({"kind": "level-absent", "detail": "%s=%s" % (action, level)})

    # 2) 质量声明不得悄悄升级（白盒/前缀缓存/同源）
    quality = snapshot.get("quality")
    if isinstance(quality, dict):
        for key, expected in golden["quality"].items():
            actual = quality.get(key)
            if actual != expected:
                findings.append(
                    {"kind": "quality-drift", "detail": "%s: %r != %r" % (key, actual, expected)}
                )
    else:
        findings.append({"kind": "schema", "detail": "缺 quality 声明"})

    # 3) 对账只用 instanceUsage
    instances = snapshot.get("instances")
    if not isinstance(instances, list):
        findings.append({"kind": "usage-basis-missing", "detail": "缺 instances 列表，无法做实例级对账"})
        reconciliation = None
    else:
        reconciliation = reconcile(instances)
        if reconciliation["missingUsage"]:
            findings.append(
                {
                    "kind": "usage-basis-missing",
                    "detail": "实例缺 usage：%s" % ",".join(reconciliation["missingUsage"]),
                }
            )

    if any(f["kind"] in {"missing-action", "level-absent"} for f in findings):
        state = STATE_FAILED
    elif any(f["kind"] in {"schema", "usage-basis-missing"} for f in findings):
        state = STATE_UNKNOWN
    elif findings:
        state = STATE_DRIFT
    else:
        state = STATE_PASS
    return {
        "state": state,
        "exitCode": EXIT_CODES[state],
        "findings": findings,
        "reconciliation": reconciliation,
    }


#: 插件自检（`lib/selftest.mjs`）用例前缀 → 失败时的判定等级
SELFTEST_CRITICAL_PREFIXES: tuple[str, ...] = ("fencing", "verify")
SELFTEST_ADVISORY_PREFIXES: tuple[str, ...] = ("usage", "budget", "recover", "conformance")


def evaluate_selftest(report: dict[str, Any] | None) -> dict[str, Any]:
    """把插件自检报告并入同一套四态判定（fencing / verify 失败 = failed）。

    自检报告结构：`{ok, total, failed, checks:[{name, ok, detail}]}`。
    报告缺失或没有 checks → unknown（fail-closed，不当 pass）。
    """
    if not isinstance(report, dict) or not isinstance(report.get("checks"), list) or not report["checks"]:
        return {
            "state": STATE_UNKNOWN,
            "exitCode": EXIT_CODES[STATE_UNKNOWN],
            "findings": [{"kind": "schema", "detail": "自检报告缺失或无 checks"}],
        }
    findings: list[dict[str, Any]] = []
    for row in report["checks"]:
        if row.get("ok"):
            continue
        name = str(row.get("name") or "")
        if any(name.startswith(prefix) for prefix in SELFTEST_CRITICAL_PREFIXES):
            findings.append({"kind": "failed", "detail": name})
        elif any(name.startswith(prefix) for prefix in SELFTEST_ADVISORY_PREFIXES):
            findings.append({"kind": "drift", "detail": name})
        else:
            findings.append({"kind": "drift", "detail": name})

    if any(f["kind"] == "failed" for f in findings):
        state = STATE_FAILED
    elif findings:
        state = STATE_DRIFT
    else:
        state = STATE_PASS
    return {"state": state, "exitCode": EXIT_CODES[state], "findings": findings}


def main(argv: list[str] | None = None) -> int:
    """CLI：`python -m control_plane.tests.integration.a7_conformance --snapshot S [--golden G]`。"""
    import argparse

    parser = argparse.ArgumentParser(description="A7 adapter conformance fixture (four-state exit codes)")
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--golden", default=str(Path(__file__).with_name("fixtures") / "capabilities.golden.json"))
    args = parser.parse_args(argv)

    snapshot, error = load_snapshot(args.snapshot)
    if snapshot is None:
        result = {
            "state": STATE_UNKNOWN,
            "exitCode": EXIT_CODES[STATE_UNKNOWN],
            "findings": [{"kind": "schema", "detail": error}],
            "reconciliation": None,
        }
    else:
        result = evaluate(snapshot, load_golden(args.golden))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result["exitCode"]


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
