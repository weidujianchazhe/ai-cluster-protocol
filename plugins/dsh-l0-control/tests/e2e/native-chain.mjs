#!/usr/bin/env node
/**
 * N5 · native 全链驱动（R7）
 *
 * 目标链路（Lead 指定顺序）：
 *   wish_submit → 每阶段 pass_gate(stage,[evidenceId]) → task_next → claim
 *              → evidence_submit → verify_done → decide → export
 *
 * 设计要点：
 *   - **每次跑用隔离临时 workspace**，跑完删除（不污染插件真实状态）；
 *   - 阶段闸门按 5 段推进：research → design → build → audit → deliver；
 *   - `pass_gate` 未暴露时**不伪造**：该阶段记 `gate-unavailable` 并停在该阶段（不折算 pass）；
 *   - 同一实例不得同时持有两个活跃节点（e2e 自带守卫，顺带验 A2）。
 *
 * 用法：node tests/e2e/native-chain.mjs [--json]
 * 退出码：0 pass / 1 drift（有 skip）/ 2 failed / 3 unknown（service 不可用）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const PLUGIN = path.join(REPO_ROOT, 'plugins', 'dsh-l0-control');
const EXIT = { pass: 0, drift: 1, failed: 2, unknown: 3 };

const STAGES = ['research', 'design', 'build', 'audit', 'deliver'];
const ROLE_BY_CAPABILITY = {
  RESEARCH: 'ROLE-RESEARCH-01',
  DESIGN: 'ROLE-DESIGN-01',
  CODE: 'ROLE-CODE-01',
  INTEGRATION: 'ROLE-INTEGRATION-01',
  TEST: 'ROLE-TEST-01',
  AUDIT: 'ROLE-AUDIT_CODE-01',
  DOC: 'ROLE-DOC-01',
  OPS: 'ROLE-OPS-01',
};
/** 审计实例：必须 ≠ 生产者，且职务属审计职务 */
const AUDITOR_BY_CAPABILITY = {
  AUDIT: 'ROLE-AUDIT_EVIDENCE-01',
};
const DEFAULT_AUDITOR = 'ROLE-AUDIT_EVIDENCE-01';

const checks = [];
const add = (id, title, ok, detail = '') => checks.push({ id, title, ok: !!ok, detail });
const skip = (id, title, detail) => checks.push({ id, title, ok: null, skip: true, detail });

async function main() {
  const json = process.argv.includes('--json');
  const svcPath = path.join(PLUGIN, 'lib', 'service.js');
  if (!fs.existsSync(svcPath)) {
    const p = { suite: 'native-chain', state: 'unknown', exitCode: EXIT.unknown, reason: `service 未构建：${svcPath}` };
    console.log(json ? JSON.stringify(p, null, 2) : `[unknown] ${p.reason}`);
    process.exit(EXIT.unknown);
  }

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'n5-chain-'));
  let exitCode = EXIT.failed;
  try {
    const { L0ControlService } = await import(`file://${svcPath.replace(/\\/g, '/')}`);
    const svc = new L0ControlService({ get: () => null }, { workspaceRoot: ws }, {});

    // ── 0) 能力面：pass_gate 是否暴露
    const gateApi = typeof svc.passGate === 'function' ? 'svc.passGate' : null;
    if (gateApi) add('C0', 'pass_gate 已暴露', true, gateApi);
    else skip('C0', 'pass_gate 未暴露（N2 桥接中）', '阶段闸门无法推进；不伪造 gate 通过');

    // ── 1) wish_submit（只记愿望）+ graph_commit（本测试自己给的 6 节点 spec，不是生产模板）
    const wish = await svc.wishSubmit({ text: 'N5 native chain: 记账 CRUD' });
    const wr = wish?.result ?? {};
    const spec = {
      wish: 'N5 native chain: 记账 CRUD',
      nodes: [
        { nodeId: 'NODE-RESEARCH', title: '调研', stage: 'research', capability: 'RESEARCH', deps: [], acceptance: { kind: 'exists' } },
        { nodeId: 'NODE-PRD', title: 'PRD', stage: 'design', capability: 'DESIGN', deps: ['NODE-RESEARCH'], acceptance: { kind: 'exists' } },
        { nodeId: 'NODE-CONTRACT', title: '契约', stage: 'design', capability: 'DESIGN', deps: ['NODE-PRD'], acceptance: { kind: 'exists' } },
        { nodeId: 'NODE-BUILD', title: '实现', stage: 'build', capability: 'CODE', deps: ['NODE-CONTRACT'], acceptance: { kind: 'exists' } },
        { nodeId: 'NODE-AUDIT', title: '审计', stage: 'audit', capability: 'AUDIT', deps: ['NODE-BUILD'], acceptance: { kind: 'exists' } },
        { nodeId: 'NODE-DELIVER', title: '交付', stage: 'deliver', capability: 'OPS', deps: ['NODE-AUDIT'], acceptance: { kind: 'exists' } },
      ],
    };
    const committed = await svc.graphCommit(spec);
    const cr = committed?.result ?? {};
    const nodeIds = cr.order ?? [];
    add(
      'C1',
      'wish_submit 只记愿望（graph-plan-required）+ graph_commit 落 6 节点',
      wish?.ok === true && wr.graphPlanRequired === true && committed?.ok === true && nodeIds.length === 6,
      `planRequired=${wr.graphPlanRequired === true} committed=${committed?.ok === true} nodes=${nodeIds.length} ready=${JSON.stringify(cr.ready ?? [])}`,
    );

    // 读图拿节点元信息（stage / capability / evidence_required）
    const graph = (await svc.graphStatus())?.graph?.result?.graph ?? {};
    const nodes = graph.nodes ?? [];
    const byId = new Map(nodes.map((n) => [n.node_id, n]));

    // ── 2) 逐阶段：pass_gate → 该阶段节点 claim/evidence/verify_done
    const artifactDir = path.join(ws, 'artifacts');
    fs.mkdirSync(artifactDir, { recursive: true });
    const stageReport = [];
    let gateBlocked = null;

    // 按 **ready 集**驱动（依赖序由 core 保证）；每节点：claim → evidence → pass_gate(stage) → verify_done
    const stageReportMap = new Map();
    const push = (stage, row) => {
      if (!stageReportMap.has(stage)) stageReportMap.set(stage, []);
      stageReportMap.get(stage).push(row);
    };
    const verifierFor = (node) => (node.verifier_ids ?? node.verifierIds ?? [])[0] ?? 'verifier-ci';
    let guard = 0;

    while (guard++ < 60) {
      const next = await svc.taskNext({});
      const ready = next?.result?.ready ?? [];
      if (!ready.length) break;

      for (const nodeId of ready) {
        const node = byId.get(nodeId) ?? {};
        const stage = node.stage ?? 'research';
        const instance = ROLE_BY_CAPABILITY[node.capability] ?? `ROLE-${node.capability ?? 'CODE'}-01`;

        const claim = await svc.taskClaim({ nodeId, instanceId: instance });
        if (claim?.ok !== true) {
          push(stage, { nodeId, step: 'claim', ok: false, code: claim?.detail?.code ?? claim?.error });
          continue;
        }

        const artifact = path.join(artifactDir, `${nodeId}.md`);
        fs.writeFileSync(artifact, `# ${nodeId}\nN5 e2e artifact\n`, 'utf8');

        // acceptance 必须显式（无 acceptance 且无 verdict → unknown，不得当 pass）；verifier 取节点允许清单
        let ev = null;
        let usedSpelling = null;
        for (const [label, extra] of [
          ['both', { producer_instance: instance, producerInstance: instance }],
          ['snake', { producer_instance: instance }],
          ['camel', { producerInstance: instance }],
        ]) {
          ev = await svc.evidenceSubmit({
            nodeId,
            artifactPath: artifact,
            verifier: verifierFor(node),
            acceptance: { kind: 'exists' },
            ...extra,
          });
          if (ev?.ok === true) { usedSpelling = label; break; }
        }
        const evId = ev?.result?.evidenceId ?? null;
        push(stage, { nodeId, step: 'evidence', ok: ev?.ok === true, code: ev?.ok === true ? `via:${usedSpelling}` : ev?.error ?? null, evidenceId: evId, instance });
        if (ev?.ok !== true) continue;

        if (!gateApi) {
          push(stage, { nodeId, step: 'gate', ok: false, code: 'gate-unavailable' });
          gateBlocked = stage;
          continue;
        }
        const g = await svc.passGate({ stage, evidence_refs: evId ? [evId] : [] });
        push(stage, { nodeId, step: 'pass_gate', ok: g?.ok === true, code: g?.ok === true ? 'passed' : g?.error ?? null });
        if (g?.ok !== true) {
          gateBlocked = stage;
          continue;
        }

        const auditor = AUDITOR_BY_CAPABILITY[node.capability] ?? DEFAULT_AUDITOR;
        const done = await svc.verifyDone({
          nodeId,
          producer_instance: instance,
          producerInstance: instance,
          auditor_instance: auditor,
          auditorInstance: auditor,
        });
        push(stage, { nodeId, step: 'verify_done', ok: done?.ok === true, code: done?.ok === true ? 'done' : done?.error ?? null });
      }
      if (gateBlocked) break;
    }

    for (const stage of STAGES) {
      const rows = stageReportMap.get(stage);
      if (!rows) continue;
      const gateRow = rows.find((r) => r.step === 'pass_gate');
      stageReport.push({ stage, gate: gateRow ? (gateRow.ok ? 'passed' : gateRow.code) : 'n/a', nodes: rows });
    }

    // ── 3) decide + export（不依赖闸门）
    const dec = await svc.decide({
      decisionId: 'DEC-N5-CHAIN',
      level: 'L0',
      question: 'N5 全链：是否接受当前交付？',
      options: [{ option_id: 'yes', label: '接受' }, { option_id: 'no', label: '退回' }],
      optionId: 'yes',
      note: 'native chain',
    });
    add('C7', 'decide 创建 L0 决策', dec?.ok === true, dec?.ok === true ? 'ok' : `code=${dec?.error}`);
    const exp = await svc.exportProjection({ outDir: path.join(ws, 'export') });
    add('C8', 'export 投影', exp?.ok === true, exp?.ok === true ? 'ok' : `code=${exp?.error}`);

    // ── 4) 汇总判定
    const flat = stageReport.flatMap((s) => s.nodes.map((n) => ({ stage: s.stage, ...n })));
    const failedSteps = flat.filter((n) => n.ok === false && n.code !== 'gate-unavailable');
    const gatedSteps = flat.filter((n) => n.code === 'gate-unavailable');
    const verified = flat.filter((n) => n.step === 'verify_done' && n.ok === true);

    const allVerified = verified.length === nodes.length && nodes.length > 0;
    if (gatedSteps.length > 0) {
      // 闸门未桥接 → 阻塞属"依赖未就位"，记 SKIP 而不是 FAIL（不折算 pass）
      skip('C9', '全链完成（被闸门阻塞，未折算）', `verified=${verified.length}/${nodes.length}；阻塞于 ${gateBlocked ?? 'n/a'}`);
      skip('C10', '闸门阻塞（等 N2 pass_gate 桥接）', `stages 阻塞于 ${gateBlocked ?? 'n/a'}`);
    } else {
      add('C9', '全链完成（所有节点 verify_done 通过）', allVerified, `verified=${verified.length}/${nodes.length}`);
    }

    const failed = checks.filter((c) => c.ok === false).length;
    const skipped = checks.filter((c) => c.skip).length;
    const passed = checks.filter((c) => c.ok === true).length;
    const state = failed > 0 ? 'failed' : skipped > 0 ? 'drift' : 'pass';
    exitCode = EXIT[state];

    const payload = { suite: 'native-chain', state, exitCode, passed, failed, skipped, total: checks.length, stages: stageReport, checks };
    if (json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log('\n=== native 全链 ===');
      for (const s of stageReport) {
        console.log(`\n[${s.stage}] gate=${s.gate}`);
        for (const n of s.nodes) console.log(`  ${n.ok === true ? 'PASS' : 'FAIL'} ${n.nodeId.padEnd(16)} ${String(n.step).padEnd(12)} ${n.code ?? ''} ${n.evidenceId ?? ''}`);
      }
      console.log('\n--- checks ---');
      for (const c of checks) console.log(`${c.skip ? 'SKIP' : c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(4)} ${c.title}${c.detail ? ' — ' + c.detail : ''}`);
      console.log(`\nstate=${state} passed=${passed} failed=${failed} skipped=${skipped} exit=${exitCode}`);
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(EXIT.failed);
});
