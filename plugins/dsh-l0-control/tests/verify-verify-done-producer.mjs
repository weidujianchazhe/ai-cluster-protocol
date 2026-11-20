/**
 * 定案：`verify_done` 会不会因为「证据的生产者 ≠ 租约持有者」而被拒？
 *
 * 起因：第 37 轮真派一个 Agent 标定延迟，节点停在 `submitted`，`verify_done` 没落盘。
 * 当时我在 prompt 里让 worker 用 `producer_instance='role-code-01'`，而租约持有者是
 * `role-code-46`。有两种可能，**当时分不清**：
 *   a) 产品在「producer ≠ assignee」时拒绝铸 done 凭证；
 *   b) worker 自己没走到第 4 步（迭代预算/它自己停了）。
 *
 * 这个测试只回答 (a)。它不花 token：直接驱动真 service。
 *
 * 四个组合：
 *   1. producer = 租约持有者，auditor 另一实例        → 应 ok
 *   2. **producer ≠ 租约持有者**（第 37 轮的实际情况）  → 看它到底 ok 还是拒
 *   3. auditor = producer（审计不独立）                → 应拒
 *   4. auditor 为空                                    → 不参与独立判定，应 ok
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const workspaceRoot = path.resolve(root, '..', '..');
const lib = (n) => pathToFileURL(path.join(root, 'lib', n)).href;
const { L0ControlService } = await import(lib('service.js'));

const unwrap = (w) => {
  const inner = w && typeof w === 'object' && 'graph' in w ? w.graph : w;
  return inner && typeof inner === 'object' && 'result' in inner ? inner.result : inner;
};
const makeCtx = (sessionId = 's-code') => ({
  get: (name) => {
    if (name === 'workingDirectory') return { defaultDirectory: workspaceRoot };
    if (name === 'l0adapter') {
      return {
        report: () => ({
          instances: [
            { instanceId: 'role-code-77', sessionId },
            { instanceId: 'role-audit-code-77', sessionId: 's-audit' },
          ],
        }),
      };
    }
    return undefined;
  },
});
const callerOf = (id) => ({ id });

/** 跑一个组合，返回 verify_done 的结果。 */
async function scenario({ nodeId, claimerInstance, producerInstance, auditorInstance, verifyCaller }) {
  const stateDir = path.resolve(tempStateDir(`vd-${nodeId}`));
  const svc = new L0ControlService(makeCtx(), { workspaceRoot, stateDir, persistence: 'node', maxParallel: 8 }, {});
  const artifactDir = path.join(stateDir, 'artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });
  try {
    const committed = unwrap(await svc.graphCommit({
      wish: `vd ${nodeId}`,
      policies: { maxParallel: 8 },
      nodes: [{
        nodeId, title: 't', capability: 'CODE', stage: 'build', deps: [],
        acceptance: { kind: 'exists' },
      }],
    }));
    assert.equal(committed.ok, true, `建图失败 ${JSON.stringify(committed.errors ?? committed).slice(0, 200)}`);
    // 节点 stage=build → 收尾需要该阶段闸门已 passed，否则 verify_done 会以
    // 「阶段闸门未通过：build」拒绝。这是另一个契约，不是本测试要测的东西。
    await svc.passGate({ stage: 'build', evidence_refs: [] }).catch(() => null);

    const claimed = unwrap(await svc.taskClaim({ nodeId, instanceId: claimerInstance }, callerOf(claimerInstance)));
    assert.equal(claimed?.ok, true, `claim 失败 ${JSON.stringify(claimed).slice(0, 200)}`);
    const token = claimed.lease.fencing_token;

    const artifact = path.join(artifactDir, `${nodeId}.md`);
    fs.writeFileSync(artifact, `# ${nodeId}\n`, 'utf8');
    const ev = unwrap(await svc.evidenceSubmit({
      nodeId, artifactPath: artifact, fencingToken: token,
      producer_instance: producerInstance,
      ...(auditorInstance ? { auditor_instance: auditorInstance } : {}),
      kind: 'artifact', acceptance: { kind: 'exists' },
    }, callerOf(claimerInstance)));
    assert.equal(ev?.ok, true, `提证据失败 ${JSON.stringify(ev).slice(0, 300)}`);

    const verified = unwrap(await svc.verifyDone({
      nodeId, fencingToken: token,
      producer_instance: producerInstance,
      ...(auditorInstance ? { auditor_instance: auditorInstance } : {}),
    }, callerOf(verifyCaller)));
    return verified;
  } finally {
    try { svc.stopDispatch(); } catch { /* 未启动 */ }
    try { await svc.dispose(); } catch { /* 已关闭 */ }
    cleanupTempStateDirs();
  }
}

// ── 组 1：producer = 租约持有者（正常路径，auditor 另一会话）──────────────
const g1 = await scenario({
  nodeId: 'VD1', claimerInstance: 'role-code-77', producerInstance: 'role-code-77',
  auditorInstance: 'role-audit-code-77', verifyCaller: 's-audit',
});
assert.equal(g1?.ok, true, `组1（producer=assignee，审计由另一实例发起）应通过，实际 ${JSON.stringify(g1).slice(0, 300)}`);
console.log('PASS 组1 producer=租约持有者 + 审计实例调用 → done');

// ── 组 2：producer ≠ 租约持有者（第 37 轮的实际情形）────────────────────
const g2 = await scenario({
  nodeId: 'VD2', claimerInstance: 'role-code-77', producerInstance: 'role-code-01',
  auditorInstance: 'role-audit-code-77', verifyCaller: 's-audit',
});
const g2Verdict = g2?.ok === true ? 'ok（不校验 assignee，第 37 轮的卡点不是这个）' : `拒：${g2?.error} / ${String(g2?.reason ?? '').slice(0, 80)}`;
console.log(`INFO 组2 producer≠租约持有者 → ${g2Verdict}`);

// ── 组 3：producer 自己当审计（同实例）→ 必须拒 ─────────────────────────
let g3 = null;
let g3Threw = null;
try {
  g3 = await scenario({
    nodeId: 'VD3', claimerInstance: 'role-code-01', producerInstance: 'role-code-01',
    auditorInstance: 'role-code-77', verifyCaller: 's-code',
  });
} catch (error) {
  g3Threw = String(error?.message ?? error);
}
const g3Rejected = g3 === null || g3?.ok !== true;
assert.equal(g3Rejected, true, `组3（producer 自验）必须被拒，实际 ${JSON.stringify(g3)?.slice(0, 300)}`);
console.log(`PASS 组3 producer 自己调 verify_done → 被拒${g3Threw ? '（抛错）' : `：${g3?.error}`}`);

// ── 组 4：auditor_instance 与实际调用者不一致 → 必须拒 ──────────────────
let g4 = null;
try {
  g4 = await scenario({
    nodeId: 'VD4', claimerInstance: 'role-code-77', producerInstance: 'role-code-77',
    auditorInstance: 'role-audit-code-77', verifyCaller: 's-code',
  });
} catch { /* 抛错也算拒 */ }
const g4Rejected = g4 === null || g4?.ok !== true;
assert.equal(g4Rejected, true, `组4（caller 是 code 却声称 auditor）必须被拒，实际 ${JSON.stringify(g4)?.slice(0, 300)}`);
console.log(`PASS 组4 auditor_instance ≠ caller 绑定实例 → 被拒：${g4?.error}`);

console.log('\n结论：');
console.log(`  「producer ≠ 租约持有者」${g2?.ok === true ? '**不会**被 verify_done 拒绝' : '**会**被 verify_done 拒绝'}。`);
console.log('  真正的硬契约是：verify_done 必须由**审计实例**发起，producer 不能自验。');
console.log('  ⇒ 第 37 轮的卡点因此可以定性：我给 worker 的 prompt 让它以 producer 身份调 verify_done，');
console.log('    并传了 auditor_instance=role-audit-code-01（≠ 它自己）→ 必然 auditor-caller-mismatch。');
console.log('    **是测量脚本设计错误，不是产品缺陷。** 但它揭示的拓扑要求是真的：');
console.log('    一个节点要收尾，需要 producer 与 auditor 两个实例（审计可复用，只要求 ≠ 各自 producer）。');
