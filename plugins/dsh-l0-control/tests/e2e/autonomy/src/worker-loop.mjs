/**
 * worker-loop.mjs — L0 自治 worker 循环的决策核心。
 *
 * 严格实现 `role-code-42-NODE-CONTRACT.md` 的契约语义：
 *   §2.1 task_claim 成功判据 / 失败码分支
 *   §2.2 evidence_submit 硬前置与伪成功判定
 *   §2.3 pass_gate 的 stage 对齐
 *   §3   状态机合法转移表
 *   §6   幂等键与租约 TTL
 *   §8   收口语义（ready 空就停，不算失败）
 *
 * 纯函数、无 IO、无宿主依赖：BUILD 自测可对每个分支单点断言。
 */

export const LEASE_TTL_MS = 600_000;

export const STAGES = ['research', 'design', 'build', 'audit', 'deliver'];

/** §3 状态机：合法转移表（from -> {event -> to}） */
const TRANSITIONS = Object.freeze({
  planned: { deps_done: 'ready' },
  ready: { claim_ok: 'claimed' },
  claimed: { evidence_pass: 'submitted', lease_expired: 'ready' },
  submitted: { verify_pass: 'done', verify_fail: 'submitted' },
  done: {},
});

/**
 * §3 状态机转移。非法转移返回 { ok:false, saw }, 不抛异常（调用方决定是否致命）。
 * @param {string} from
 * @param {string} event
 */
export function transition(from, event) {
  const table = TRANSITIONS[from];
  if (!table) return { ok: false, saw: 'unknown-status', from, event };
  const to = table[event];
  if (!to) return { ok: false, saw: 'illegal-transition', from, event };
  return { ok: true, from, to };
}

/** §1.3 产物命名契约：artifacts/<instanceId>-<nodeId>.md */
export function artifactRelPath(instanceId, nodeId) {
  if (!/^role-[a-z]+-[a-z0-9-]+$/i.test(String(instanceId))) {
    throw new Error(`instanceId 非法: ${instanceId}`);
  }
  if (!/^NODE-[A-Z]+$/.test(String(nodeId))) throw new Error(`nodeId 非法: ${nodeId}`);
  return `artifacts/${instanceId}-${nodeId}.md`;
}

/**
 * §4 伪成功判定：ok:true 但 appended==0 视为未生效（PRD 风险 2 / STATE_LOCKED 静默丢写）。
 * @param {{ok?:boolean, persistence?:{appended?:number, error?:string|null}}} result
 */
export function isPseudoSuccess(result) {
  if (!result || result.ok !== true) return false;
  const appended = result?.persistence?.appended;
  return !(typeof appended === 'number' && appended > 0);
}

/** §2.1 成功判据：owner 匹配 + status=claimed + appended>0，三者缺一不可。 */
export function claimSucceeded(result, instanceId) {
  if (!result || result.ok !== true) return false;
  if (isPseudoSuccess(result)) return false;
  const lease = result?.result?.lease;
  const node = result?.result?.node;
  return lease?.owner === instanceId && node?.status === 'claimed' && node?.assignee === instanceId;
}

/**
 * §4 失败码 → 处置分支。
 * @param {string} code  core/repo/tool 层错误码
 */
export function decideAfterClaimFailure(code) {
  switch (code) {
    case 'LeaseHeld':
      return { action: 'switch-node', reason: '他人持有效 lease，换节点或退避（4 worker 下为常态）' };
    case 'LeaseExpired':
    case 'lease_expired':
      return { action: 'escalate', reason: '僵尸租约须显式 expire/takeover，worker 不得自行 takeover' };
    case 'node-not-ready':
    case 'not-ready':
      return { action: 'repoll', reason: '前驱未 done，回读 ready' };
    case 'STATE_LOCKED':
      return { action: 'backoff', reason: '写锁被占，退避后重取；不得当成功' };
    case 'projection-failed':
    case 'TEAM_NOT_MEMBER':
      return { action: 'ignore', reason: '团队板投影不可用，以 graph 为准，不阻断主流程' };
    default:
      return { action: 'backoff', reason: `未知失败码 ${code}，保守退避` };
  }
}

/**
 * §2.2 acceptance 判定（exists | sha256 | contains）。unknown 绝不当 pass。
 * @param {{kind:'exists'|'sha256'|'contains', expected?:string}} acceptance
 * @param {{exists:boolean, readable:boolean, sha256?:string|null, text?:string|null}} probe
 */
export function evaluateAcceptance(acceptance, probe) {
  const kind = acceptance?.kind;
  if (!probe || probe.readable !== true) return { verdict: 'unknown', saw: 'artifact-unreadable' };
  if (probe.exists !== true) return { verdict: 'unknown', saw: 'artifact-missing' };
  switch (kind) {
    case 'exists':
      return { verdict: 'pass', saw: 'file-present' };
    case 'sha256': {
      const want = String(acceptance?.expected ?? '').toLowerCase();
      const got = String(probe.sha256 ?? '').toLowerCase();
      if (!want || !got) return { verdict: 'unknown', saw: 'digest-unavailable' };
      return got === want ? { verdict: 'pass', saw: 'digest-match' } : { verdict: 'fail', saw: 'digest-mismatch' };
    }
    case 'contains': {
      const want = String(acceptance?.expected ?? '');
      if (!want) return { verdict: 'unknown', saw: 'needle-empty' };
      if (typeof probe.text !== 'string') return { verdict: 'unknown', saw: 'not-text' };
      return probe.text.includes(want) ? { verdict: 'pass', saw: 'substring-hit' } : { verdict: 'fail', saw: 'substring-miss' };
    }
    default:
      return { verdict: 'unknown', saw: `unknown-acceptance-kind:${kind}` };
  }
}

/** §2.2 evidence_submit 成功判据：ok && verdict==='pass' && appended>0 && producer 归属存在。 */
export function submitSucceeded(result) {
  if (!result || result.ok !== true) return false;
  if (isPseudoSuccess(result)) return false;
  const r = result.result ?? {};
  return r.verdict === 'pass' && Boolean(r.producerInstance) && Boolean(r.evidenceId);
}

/** §2.2 节点是否被 evidence_submit 推进（claimed -> submitted）。 */
export function evidenceAdvancedNode(result) {
  const r = result?.result ?? {};
  return r.nodeStatus === 'submitted' && r.advancedFrom === 'claimed';
}

/** §2.3 gate stage 必须等于节点 stage；不一致一律拒绝（PRD AC-4）。 */
export function gateStageMatches(nodeStage, gateStage) {
  if (!STAGES.includes(nodeStage)) return { ok: false, saw: 'unknown-node-stage' };
  if (!STAGES.includes(gateStage)) return { ok: false, saw: 'unknown-gate-stage' };
  return nodeStage === gateStage
    ? { ok: true, saw: 'aligned' }
    : { ok: false, saw: `mismatch:${nodeStage}!=${gateStage}` };
}

/** §2.3 pass_gate 成功判据：ok 且未伪成功 且 gate.status=passed 且 stage 对齐。 */
export function gateSucceeded(result, nodeStage) {
  if (!result || result.ok !== true) return false;
  if (isPseudoSuccess(result)) return false;
  const gate = result?.result?.gate;
  return gate?.status === 'passed' && gate?.stage === nodeStage;
}

/**
 * §8 收口语义：ready 空 → 复读一次；仍空则 stop（不算失败）。
 * @param {string[]} ready
 * @param {{reread?:boolean, heldByOthers?:boolean}} [ctx]
 */
export function nextLoopStep(ready, ctx = {}) {
  const list = Array.isArray(ready) ? ready : [];
  if (list.length > 0) return { step: 'claim', nodeId: list[0] };
  if (!ctx.reread) return { step: 'reread', why: 'ready 空，先复读一次 graph_status（FR-6）' };
  return { step: 'stop', why: ctx.heldByOthers ? '非 done 节点均被他人持有/等待审计' : '无节点可领' };
}

/** §6 租约剩余时间（ms）；<=0 视为僵尸。 */
export function leaseRemainingMs(lease, nowMs = Date.now()) {
  const exp = Number(lease?.expires_at ?? lease?.expiresAt ?? 0);
  if (!Number.isFinite(exp) || exp <= 0) return 0;
  return exp - nowMs;
}

/** §6 僵尸租约判据：expires_at/heartbeat_at 为 0 或已过期。 */
export function isZombieLease(lease, nowMs = Date.now()) {
  const hb = Number(lease?.heartbeat_at ?? lease?.heartbeatAt ?? 0);
  if (!Number.isFinite(hb) || hb <= 0) return true;
  return leaseRemainingMs(lease, nowMs) <= 0;
}

/** §6 幂等键。 */
export function idempotencyKey(nodeId, instanceId, attemptNo) {
  return `${nodeId}|${instanceId}|${attemptNo}`;
}
