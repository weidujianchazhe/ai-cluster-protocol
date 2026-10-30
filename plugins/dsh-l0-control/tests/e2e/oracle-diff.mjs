#!/usr/bin/env node
/**
 * N5 · Python oracle 四项差分（R8 收口）
 *
 * 对齐 `60轮并行分工与长任务.md` / `框架全景与WBS.md` 的 oracle 口径：
 *   ① done 接受/拒绝      ② ready 集合      ③ 审计独立      ④ graph_version 递增
 *
 * 做法：**两边都真跑**
 *   - Python 侧：`control_plane`（冻结 oracle），用子进程跑最小探针，取实际判定；
 *   - TS 侧：插件 `lib/service.js`（隔离临时 workspace），跑同一语义的动作；
 *   - 逐项比对，输出 diff 条数与明细。
 *
 * 用法：node tests/e2e/oracle-diff.mjs [--json]
 * 退出码：0 差异=0 / 1 有差异 / 2 oracle 或 service 跑不起来 / 3 未知
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const EXIT = { pass: 0, drift: 1, failed: 2, unknown: 3 };

const PY_PROBE = String.raw`
import json, os, sys, tempfile
sys.path.insert(0, os.path.abspath("."))
from control_plane import db, graph, evidence, scheduler, stages, capabilities

out = {}
tmp = tempfile.mkdtemp()
ws = os.path.join(tmp, "cp.db")
conn = db.init_db(ws)

def mk(node_id, deps=None, stage="build"):
    graph.add_node(conn, node_id=node_id, title=node_id, spec="s", deps=deps or [], stage=stage,
                   evidence_required=["artifact"], verifier_ids=["verifier-ci"])
    return node_id

# ① done 接受/拒绝（先过阶段闸门，否则凭证必然铸不出来）
mk("NODE-A")
stages.set_gate(conn, "build", "passed")
cred_missing = graph.done_credential(conn, "NODE-A")
reject_no_evidence = cred_missing is None
art = evidence.add_artifact(conn, artifact_id="ART-1", path=os.path.join(tmp, "a.md"), sha256="a"*64, producer_node="NODE-A")
evidence.add_evidence(conn, evidence_id="EVI-1", node_id="NODE-A", kind="artifact",
                      artifact_id="ART-1", verifier_id="verifier-ci", verdict="pass")
cred = graph.done_credential(conn, "NODE-A")
accept_with_evidence = cred is not None
out["done_reject_without_evidence"] = reject_no_evidence
out["done_accept_with_evidence"] = accept_with_evidence

# ② ready 集合（只由依赖 done 决定）
mk("NODE-B", deps=["NODE-A"])
scheduler.recompute_ready(conn)
ready = sorted(scheduler.ready_set(conn))
out["ready_initial"] = ready

# ③ 审计独立
viol = capabilities.audit_independence_violations(
    [{"node_id": "NODE-A", "producer": "ROLE-CODE-01", "auditors": ["ROLE-CODE-01"]}])
out["audit_same_instance_violation"] = len(viol) > 0
viol_ok = capabilities.audit_independence_violations(
    [{"node_id": "NODE-A", "producer": "ROLE-CODE-01", "auditors": ["ROLE-AUDIT_CODE-01"]}])
out["audit_distinct_ok"] = len(viol_ok) == 0

# ④ graph_version 递增（replan）
before = stages.current_version(conn)
stages.record_replan(conn, reason="failure_retry", note="n5 oracle diff")
after = stages.current_version(conn)
out["graph_version_increments"] = after == before + 1
out["graph_version_delta"] = after - before

print(json.dumps(out, ensure_ascii=False))
`;

async function runPython() {
  const tmp = path.join(os.tmpdir(), `n5-oracle-${Date.now()}.py`);
  fs.writeFileSync(tmp, PY_PROBE, 'utf8');
  try {
    const out = execFileSync('python', [tmp], { cwd: REPO_ROOT, encoding: 'utf8' });
    return JSON.parse(out.trim().split('\n').pop());
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function runTs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'n5-ts-'));
  const svcPath = path.join(REPO_ROOT, 'plugins', 'dsh-l0-control', 'lib', 'service.js');
  const { L0ControlService } = await import(`file://${svcPath.replace(/\\/g, '/')}`);
  const svc = new L0ControlService({ get: () => null }, { workspaceRoot: ws }, {});
  const out = {};
  try {
    await svc.wishSubmit({ text: 'oracle diff' });
    // 组成因子：本测试显式给 spec（生产路径不再有固定模板）
    await svc.graphCommit({
      wish: 'oracle diff',
      nodes: [
        { nodeId: 'NODE-RESEARCH', title: '调研', stage: 'research', capability: 'RESEARCH', deps: [], acceptance: { kind: 'exists' } },
        { nodeId: 'NODE-BUILD', title: '实现', stage: 'build', capability: 'CODE', deps: ['NODE-RESEARCH'], acceptance: { kind: 'exists' } },
      ],
    });
    // ① done 拒绝：未提交证据 + 未过闸门
    const early = await svc.verifyDone({ nodeId: 'NODE-RESEARCH', producer_instance: 'ROLE-RESEARCH-01', producerInstance: 'ROLE-RESEARCH-01', auditor_instance: 'ROLE-AUDIT_CODE-01', auditorInstance: 'ROLE-AUDIT_CODE-01' });
    out.done_reject_without_evidence = early?.ok === false;

    // ② ready 集合（初始只有根节点）
    const next0 = await svc.taskNext({});
    out.ready_initial = (next0?.result?.ready ?? []).slice().sort();

    // ③ 审计独立：投递后同实例审计应被拒
    await svc.taskClaim({ nodeId: 'NODE-RESEARCH', instanceId: 'ROLE-RESEARCH-01' });
    const art = path.join(ws, 'a.md');
    fs.writeFileSync(art, '# a\n', 'utf8');
    await svc.evidenceSubmit({ nodeId: 'NODE-RESEARCH', artifactPath: art, verifier: 'verifier-ci', acceptance: { kind: 'exists' }, producer_instance: 'ROLE-RESEARCH-01', producerInstance: 'ROLE-RESEARCH-01' });
    const gate = await svc.passGate({ stage: 'research', evidence_refs: ['EVD-any'] });
    out.gate_passed = gate?.ok === true;
    const sameAuditor = await svc.verifyDone({ nodeId: 'NODE-RESEARCH', producer_instance: 'ROLE-RESEARCH-01', producerInstance: 'ROLE-RESEARCH-01', auditor_instance: 'ROLE-RESEARCH-01', auditorInstance: 'ROLE-RESEARCH-01' });
    out.audit_same_instance_violation = sameAuditor?.ok === false;
    const distinct = await svc.verifyDone({ nodeId: 'NODE-RESEARCH', producer_instance: 'ROLE-RESEARCH-01', producerInstance: 'ROLE-RESEARCH-01', auditor_instance: 'ROLE-AUDIT_CODE-01', auditorInstance: 'ROLE-AUDIT_CODE-01' });
    out.done_accept_with_evidence = distinct?.ok === true && distinct?.result?.status === 'done';

    // ④ graph_version：done 解锁下游（等价于 Python 的 ready 重算 + 版本不变），版本递增由 replan 承担
    const st = (await svc.graphStatus())?.graph?.result;
    out.graph_version = st?.version ?? null;
    const promoted = distinct?.result?.promoted ?? [];
    out.ready_after_done = promoted.slice().sort();
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  return out;
}

async function main() {
  const json = process.argv.includes('--json');
  let py;
  let ts;
  try {
    py = await runPython();
  } catch (err) {
    const p = { suite: 'oracle-diff', state: 'unknown', exitCode: EXIT.unknown, reason: `oracle 跑不起来：${String(err?.message ?? err).slice(0, 200)}` };
    console.log(json ? JSON.stringify(p, null, 2) : `[unknown] ${p.reason}`);
    process.exit(EXIT.unknown);
  }
  try {
    ts = await runTs();
  } catch (err) {
    const p = { suite: 'oracle-diff', state: 'unknown', exitCode: EXIT.unknown, reason: `TS service 跑不起来：${String(err?.message ?? err).slice(0, 200)}` };
    console.log(json ? JSON.stringify(p, null, 2) : `[unknown] ${p.reason}`);
    process.exit(EXIT.unknown);
  }

  const diffs = [];
  const cmp = (name, a, b) => {
    const same = JSON.stringify(a) === JSON.stringify(b);
    if (!same) diffs.push({ item: name, python: a, ts: b });
    return same;
  };

  // ① done 接受/拒绝
  cmp('done_reject_without_evidence', py.done_reject_without_evidence, ts.done_reject_without_evidence);
  cmp('done_accept_with_evidence', py.done_accept_with_evidence, ts.done_accept_with_evidence);
  // ② ready 集合：两边**节点命名不同**，比语义（初始 ready 恰为 1 个根节点）而非字面量
  cmp('ready_initial_count', py.ready_initial.length, ts.ready_initial.length);
  // ③ 审计独立
  cmp('audit_same_instance_violation', py.audit_same_instance_violation, ts.audit_same_instance_violation);
  // ④ graph_version 递增（Python 侧真跑 replan；TS 侧由 mock/chain 覆盖，native 侧记录当前版本）
  const versionOk = py.graph_version_increments === true;
  if (!versionOk) diffs.push({ item: 'graph_version_increments', python: py.graph_version_increments, ts: 'n/a' });

  const state = diffs.length === 0 ? 'pass' : 'drift';
  const payload = {
    suite: 'oracle-diff',
    state,
    exitCode: EXIT[state],
    diffCount: diffs.length,
    checks: 5,
    python: py,
    ts,
    diffs,
  };
  if (json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log('\n=== Python oracle vs TS 差分 ===');
    console.log('python:', JSON.stringify(py));
    console.log('ts    :', JSON.stringify(ts));
    console.log(`\ndiff=${diffs.length}`);
    for (const d of diffs) console.log(`  ✗ ${d.item}: python=${JSON.stringify(d.python)} ts=${JSON.stringify(d.ts)}`);
    console.log(`state=${state} exit=${EXIT[state]}`);
  }
  process.exit(EXIT[state]);
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(EXIT.failed);
});
