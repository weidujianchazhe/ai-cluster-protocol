/**
 * selftest.mjs — worker-loop 契约自测。
 *
 * 覆盖 CONTRACT §2.1/§2.2/§2.3/§3/§4/§6/§8 的每个分支，并额外对真实落盘产物做一次
 * exists 探针（证明 acceptance 判定能与真实文件系统对齐）。
 *
 * 用法：node plugins/dsh-l0-control/tests/e2e/autonomy/src/selftest.mjs
 * 退出码：0 全通过 / 1 有失败
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  artifactRelPath,
  claimSucceeded,
  decideAfterClaimFailure,
  evaluateAcceptance,
  evidenceAdvancedNode,
  gateStageMatches,
  gateSucceeded,
  idempotencyKey,
  isPseudoSuccess,
  isZombieLease,
  leaseRemainingMs,
  nextLoopStep,
  submitSucceeded,
  transition,
} from './worker-loop.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const artifactsDir = path.resolve(here, '..', 'artifacts');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) });
  }
}

const claimedOk = (instanceId = 'role-code-42') => ({
  ok: true,
  result: {
    lease: { node_id: 'NODE-BUILD', owner: instanceId, fencing_token: 1, expires_at: 1793286787630, heartbeat_at: 1793286787030 },
    node: { node_id: 'NODE-BUILD', status: 'claimed', assignee: instanceId },
  },
  persistence: { appended: 3, error: null },
});

// ── §2.1 claim 成功判据 ─────────────────────────────────────────────
test('claim: 三要素齐备 → 成功', () => {
  assert.equal(claimSucceeded(claimedOk(), 'role-code-42'), true);
});

test('claim: owner 不匹配 → 失败（不得代领）', () => {
  assert.equal(claimSucceeded(claimedOk('role-code-43'), 'role-code-42'), false);
});

test('claim: status 非 claimed → 失败', () => {
  const r = claimedOk();
  r.result.node.status = 'ready';
  assert.equal(claimSucceeded(r, 'role-code-42'), false);
});

test('claim: ok:true 但 appended=0（STATE_LOCKED 静默丢写）→ 伪成功判失败', () => {
  const r = claimedOk();
  r.persistence = { appended: 0, error: 'STATE_LOCKED' };
  assert.equal(isPseudoSuccess(r), true);
  assert.equal(claimSucceeded(r, 'role-code-42'), false);
});

// ── §4 失败码分支 ──────────────────────────────────────────────────
test('失败码: LeaseHeld → switch-node', () => {
  assert.equal(decideAfterClaimFailure('LeaseHeld').action, 'switch-node');
});

test('失败码: LeaseExpired / lease_expired → escalate（不 takeover）', () => {
  assert.equal(decideAfterClaimFailure('LeaseExpired').action, 'escalate');
  assert.equal(decideAfterClaimFailure('lease_expired').action, 'escalate');
});

test('失败码: STATE_LOCKED → backoff', () => {
  assert.equal(decideAfterClaimFailure('STATE_LOCKED').action, 'backoff');
});

test('失败码: TEAM_NOT_MEMBER / projection-failed → ignore（不阻断）', () => {
  assert.equal(decideAfterClaimFailure('TEAM_NOT_MEMBER').action, 'ignore');
  assert.equal(decideAfterClaimFailure('projection-failed').action, 'ignore');
});

test('失败码: 未知码 → 保守 backoff', () => {
  assert.equal(decideAfterClaimFailure('WAT').action, 'backoff');
});

// ── §2.2 acceptance 与 evidence ────────────────────────────────────
test('acceptance exists: 文件在 → pass', () => {
  assert.equal(evaluateAcceptance({ kind: 'exists' }, { exists: true, readable: true }).verdict, 'pass');
});

test('acceptance exists: 文件缺失 → unknown（不得当 pass）', () => {
  const r = evaluateAcceptance({ kind: 'exists' }, { exists: false, readable: true });
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.saw, 'artifact-missing');
});

test('acceptance exists: 不可读 → unknown', () => {
  assert.equal(evaluateAcceptance({ kind: 'exists' }, { exists: true, readable: false }).verdict, 'unknown');
});

test('acceptance sha256: 匹配 pass / 不匹配 fail / 缺摘要 unknown', () => {
  const digest = 'a'.repeat(64);
  assert.equal(evaluateAcceptance({ kind: 'sha256', expected: digest }, { exists: true, readable: true, sha256: digest }).verdict, 'pass');
  assert.equal(evaluateAcceptance({ kind: 'sha256', expected: digest }, { exists: true, readable: true, sha256: 'b'.repeat(64) }).verdict, 'fail');
  assert.equal(evaluateAcceptance({ kind: 'sha256' }, { exists: true, readable: true, sha256: digest }).verdict, 'unknown');
});

test('acceptance contains: 命中 pass / 未命中 fail / 非文本 unknown', () => {
  const probe = { exists: true, readable: true, text: 'nodeId: NODE-BUILD' };
  assert.equal(evaluateAcceptance({ kind: 'contains', expected: 'NODE-BUILD' }, probe).verdict, 'pass');
  assert.equal(evaluateAcceptance({ kind: 'contains', expected: 'NODE-DELIVER' }, probe).verdict, 'fail');
  assert.equal(evaluateAcceptance({ kind: 'contains', expected: 'x' }, { exists: true, readable: true, text: null }).verdict, 'unknown');
});

test('acceptance: 未知 kind → unknown', () => {
  assert.equal(evaluateAcceptance({ kind: 'regex' }, { exists: true, readable: true }).verdict, 'unknown');
});

test('submit: verdict=pass + producer + evidenceId → 成功，且节点 claimed→submitted', () => {
  const r = {
    ok: true,
    result: { verdict: 'pass', producerInstance: 'role-code-42', evidenceId: 'EVD-NODE-BUILD-1-abc12345', nodeStatus: 'submitted', advancedFrom: 'claimed' },
    persistence: { appended: 3, error: null },
  };
  assert.equal(submitSucceeded(r), true);
  assert.equal(evidenceAdvancedNode(r), true);
});

test('submit: verdict=unknown → 失败（unknown 不得当 pass）', () => {
  const r = { ok: true, result: { verdict: 'unknown', producerInstance: 'role-code-42', evidenceId: 'EVD-x' }, persistence: { appended: 1 } };
  assert.equal(submitSucceeded(r), false);
});

test('submit: producer 缺失 → 失败（producer-unknown）', () => {
  const r = { ok: true, result: { verdict: 'pass', producerInstance: null, evidenceId: 'EVD-x' }, persistence: { appended: 1 } };
  assert.equal(submitSucceeded(r), false);
});

// ── §2.3 gate ─────────────────────────────────────────────────────
test('gate: stage 对齐 build → ok', () => {
  assert.deepEqual(gateStageMatches('build', 'build'), { ok: true, saw: 'aligned' });
});

test('gate: stage 错配 build != design → 拒绝（AC-4）', () => {
  const r = gateStageMatches('build', 'design');
  assert.equal(r.ok, false);
  assert.match(r.saw, /^mismatch:/);
});

test('gate: 非 5 段枚举 → 拒绝', () => {
  assert.equal(gateStageMatches('build', 'deploy').ok, false);
  assert.equal(gateStageMatches('deploy', 'deploy').ok, false);
});

test('gate: passed + 对齐 → 成功；伪成功 → 失败', () => {
  const good = { ok: true, result: { gate: { stage: 'build', status: 'passed' } }, persistence: { appended: 1 } };
  assert.equal(gateSucceeded(good, 'build'), true);
  const pseudo = { ...good, persistence: { appended: 0, error: 'STATE_LOCKED' } };
  assert.equal(gateSucceeded(pseudo, 'build'), false);
  assert.equal(gateSucceeded({ ...good, result: { gate: { stage: 'design', status: 'passed' } } }, 'build'), false);
});

// ── §3 状态机 ─────────────────────────────────────────────────────
test('状态机: planned→ready→claimed→submitted→done 全链合法', () => {
  assert.equal(transition('planned', 'deps_done').to, 'ready');
  assert.equal(transition('ready', 'claim_ok').to, 'claimed');
  assert.equal(transition('claimed', 'evidence_pass').to, 'submitted');
  assert.equal(transition('submitted', 'verify_pass').to, 'done');
});

test('状态机: worker 不能直接 claimed→done（越权自证）', () => {
  const r = transition('claimed', 'verify_pass');
  assert.equal(r.ok, false);
  assert.equal(r.saw, 'illegal-transition');
});

test('状态机: claimed→ready 仅凭 lease_expired；submitted 失败留在 submitted', () => {
  assert.equal(transition('claimed', 'lease_expired').to, 'ready');
  assert.equal(transition('submitted', 'verify_fail').to, 'submitted');
});

test('状态机: done 为终态，未知状态拒绝', () => {
  assert.equal(transition('done', 'claim_ok').ok, false);
  assert.equal(transition('archived', 'claim_ok').saw, 'unknown-status');
});

// ── §6 租约 ───────────────────────────────────────────────────────
test('租约: TTL 内剩余>0，过期后<=0', () => {
  const lease = { expires_at: 1_000_000, heartbeat_at: 400_000 };
  assert.equal(leaseRemainingMs(lease, 1_000_000 - 600_000), 600_000);
  assert.equal(leaseRemainingMs(lease, 1_000_001), -1);
});

test('租约: expires_at/heartbeat_at=0 判为僵尸（本轮实测成因）', () => {
  assert.equal(isZombieLease({ node_id: 'NODE-RESEARCH', owner: 'role-code-41', fencing_token: 0, expires_at: 0, heartbeat_at: 0 }), true);
  assert.equal(isZombieLease({ expires_at: 2_000_000, heartbeat_at: 1_500_000 }, 1_600_000), false);
});

test('幂等键: (nodeId, instanceId, attemptNo) 唯一', () => {
  assert.equal(idempotencyKey('NODE-BUILD', 'role-code-42', 1), 'NODE-BUILD|role-code-42|1');
  assert.notEqual(idempotencyKey('NODE-BUILD', 'role-code-42', 1), idempotencyKey('NODE-BUILD', 'role-code-42', 2));
});

// ── §8 收口 ───────────────────────────────────────────────────────
test('收口: ready 非空 → claim', () => {
  assert.deepEqual(nextLoopStep(['NODE-BUILD']), { step: 'claim', nodeId: 'NODE-BUILD' });
});

test('收口: ready 空首次 → reread（FR-6）', () => {
  assert.equal(nextLoopStep([]).step, 'reread');
});

test('收口: ready 空且已复读 → stop，不算失败', () => {
  const r = nextLoopStep([], { reread: true, heldByOthers: true });
  assert.equal(r.step, 'stop');
  assert.match(r.why, /被他人持有/);
});

// ── §1.3 命名契约 ─────────────────────────────────────────────────
test('命名: role-code-42 + NODE-BUILD → artifacts/role-code-42-NODE-BUILD.md', () => {
  assert.equal(artifactRelPath('role-code-42', 'NODE-BUILD'), 'artifacts/role-code-42-NODE-BUILD.md');
});

test('命名: 非法 instanceId / nodeId 抛错', () => {
  assert.throws(() => artifactRelPath('coordinator', 'NODE-BUILD'));
  assert.throws(() => artifactRelPath('role-code-42', 'build'));
});

// ── 真实落盘探针：acceptance 与文件系统对齐 ────────────────────────
test('真实产物探针: 上游 CONTRACT 产物 exists → pass 且 sha256 可复算', () => {
  const file = path.join(artifactsDir, 'role-code-42-NODE-CONTRACT.md');
  const exists = fs.existsSync(file);
  const readable = exists && fs.statSync(file).isFile();
  assert.equal(evaluateAcceptance({ kind: 'exists' }, { exists, readable }).verdict, 'pass');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(digest.length, 64);
  assert.equal(evaluateAcceptance({ kind: 'sha256', expected: digest }, { exists, readable, sha256: digest }).verdict, 'pass');
  assert.equal(evaluateAcceptance({ kind: 'contains', expected: 'NODE-CONTRACT' }, { exists, readable, text: fs.readFileSync(file, 'utf8') }).verdict, 'pass');
});

test('真实产物探针: 不存在的产物必须 unknown 而非 pass', () => {
  const file = path.join(artifactsDir, 'role-code-42-DOES-NOT-EXIST.md');
  assert.equal(evaluateAcceptance({ kind: 'exists' }, { exists: fs.existsSync(file), readable: false }).verdict, 'unknown');
});

// ── 汇总 ─────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  <-- ${r.error}`}\n`);
}
const report = { total: results.length, passed: results.length - failed.length, failed: failed.length, ok: failed.length === 0 };
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit(report.ok ? 0 : 1);
