/**
 * P0：`submitted` + 租约过期 = 永久死锁。
 *
 * 这个漏洞是本轮真派 Agent 时被一个 worker（`role-code-63`）代码级定位并隔离复现的，
 * 随后审计实例（`role-audit-code-47`）逐行读源码独立复核确认。不是靠读代码猜出来的。
 *
 * 原始现象：8 个 worker 都交了证据，但都没在 TTL 内完成 verify，于是多个节点永久卡在
 * `submitted`。审计实例的结论更狠：**这对任何「提交后租约过期」的节点都成立**。
 *
 * 死锁链条（三处同时成立）：
 *   1. `expire()` 只把 `claimed`/`running` 送回 ready —— `submitted`/`verifying` 被跳过，
 *      租约删了但状态与 assignee 原地保留；
 *   2. `task_claim` 要求 ready → 拒（"节点不在 ready"）；
 *   3. `verify_done` 要求活租约（`assertFencing`）→ 拒（"租约不存在"）；
 *   而唯一能救它的 `rejectNode` 只被 `verifyDone` 的 `credential-unavailable` 分支调用，
 *   那个分支在 `assertFencing` **之后** → 永远到不了。
 *
 * 触发条件不苛刻：**TTL 默认 60 s，而一轮真审计（复核哈希 + 复算数值）很容易超**。
 *
 * 断言：
 *   1. submitted + 租约过期 → expire() 后回 **ready**（不留 submitted）；
 *   2. 回 ready 后**能重新 claim**，且 token **单调更大**；
 *   3. 旧 token 的 verify_done 被 fencing 拒；
 *   4. attempts **+1** 且留 `node_rejected`（证明走 reject 路径，不是偷改状态）；
 *   5. `claimed` 过期**仍走原路径**（ready + attempts+1，**无** node_rejected）——回归；
 *   6. `verifying` 过期同样回 ready（不只修 submitted）；
 *   7. **租约仍存活时不得误驳回**（submitted 且未过期 → 状态原样）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (n) => pathToFileURL(path.join(root, 'lib', n)).href;
const core = await import(lib('core/index.js'));

/** 造 1 个 ready 节点 + 一个真实产物文件。 */
function makeStore(tag, nodeId) {
  const dir = path.resolve(tempStateDir(`dl-${tag}`));
  fs.mkdirSync(dir, { recursive: true });
  const artifact = path.join(dir, 'a.md');
  fs.writeFileSync(artifact, `# ${nodeId}\n`, 'utf8');
  const store = new core.Store({});
  const committed = core.commitGraph(store, {
    wish: 'deadlock',
    policies: { maxParallel: 8 },
    nodes: [{ nodeId, title: 't', capability: 'CODE', stage: 'build', deps: [], acceptance: { kind: 'exists' } }],
  });
  assert.equal(committed.ok, true, JSON.stringify(committed.errors ?? committed).slice(0, 200));
  core.bootstrap(store);
  return { store, artifact, dir };
}

/** claim → 提交证据，返回 lease；断言真的推进到 submitted。 */
function claimAndSubmit(store, nodeId, artifact, ttlSec) {
  const lease = core.claim(store, nodeId, 'role-code-01', { ttlSec });
  // **显式关闭「审计期延长」**（`auditLeaseTtlSec: 0`）：本文件测的是
  // 「租约按 ttlSec 到期」这条语义。若让系统在提交后把窗口延到 600 s，
  // 那 1 秒后就永不过期，断言会悄悄变成在测另一件事——**测试之间的语义耦合**。
  const ev = core.withCoreStore(store, () => core.submitEvidence({
    nodeId, artifactPath: artifact, fencingToken: lease.fencing_token,
    producerInstance: 'role-code-01', auditorInstance: 'role-audit-code-01',
    kind: 'artifact', acceptance: { kind: 'exists' }, auditLeaseTtlSec: 0,
  }));
  assert.equal(ev?.ok, true, `提证据失败：${JSON.stringify(ev).slice(0, 240)}`);
  assert.equal(core.getNode(store, nodeId).status, 'submitted', '提交后应进入 submitted');
  return lease;
}

try {
  // ── 组 1..4：submitted + 过期 → ready，可重 claim，旧 token 失效，attempts+1 ──
  {
    const { store, artifact } = makeStore('main', 'D1');
    const lease = claimAndSubmit(store, 'D1', artifact, 1);
    const before = core.getNode(store, 'D1');

    const expired = core.expire(store, { now: lease.expires_at + 1 });
    assert.deepEqual(expired, ['D1'], 'expire 应回收该租约');

    const after = core.getNode(store, 'D1');
    assert.equal(after.status, 'ready', `**死锁修复点**：submitted 过期后必须回 ready，实际 ${after.status}`);
    assert.equal(after.assignee, null, '回 ready 必须清空 assignee');
    assert.equal(after.attempts, before.attempts + 1, `必须走 reject 路径（attempts+1），实际 ${after.attempts}`);

    const rejection = store.journal.view().filter((e) => e.kind === 'node_rejected').pop();
    assert.ok(rejection, '必须留 node_rejected 事件（可归因）');
    assert.equal(String(rejection.payload?.reason), 'lease_expired');
    assert.equal(Number(rejection.payload?.detail?.fencingToken), lease.fencing_token, '驳回要记下旧 token，便于追责');

    const again = core.claim(store, 'D1', 'role-code-02', { ttlSec: 60 });
    assert.ok(again.fencing_token > lease.fencing_token, '重 claim 的 token 必须单调更大');

    let oldTokenRejected = false;
    try {
      core.withCoreStore(store, () => core.verifyDone({ nodeId: 'D1', fencingToken: lease.fencing_token, producer_instance: 'role-code-01' }));
    } catch {
      oldTokenRejected = true;
    }
    assert.equal(oldTokenRejected, true, '旧 token 必须被 fencing 拒');
  }
  console.log('PASS submitted + 过期 → ready / assignee 清空 / attempts+1 / node_rejected 留痕 / 可重 claim（token 更大）/ 旧 token 被拒');

  // ── 组 5：claimed 过期仍走原路径（回归）──────────────────────────────
  {
    const { store } = makeStore('claimed', 'D2');
    const lease = core.claim(store, 'D2', 'role-code-01', { ttlSec: 1 });
    core.expire(store, { now: lease.expires_at + 1 });
    const node = core.getNode(store, 'D2');
    assert.equal(node.status, 'ready', 'claimed 过期仍应回 ready');
    assert.equal(node.attempts, 1, 'claimed 过期 attempts 仍应 +1');
    assert.equal(store.journal.view().filter((e) => e.kind === 'node_rejected').length, 0,
      'claimed 过期走 setStatus 老路径，**不应**产生 node_rejected');
  }
  console.log('PASS claimed 过期仍走原路径（ready + attempts+1，无 node_rejected）—— 回归未破');

  // ── 组 6：verifying 过期同样回 ready ──────────────────────────────────
  {
    const { store, artifact } = makeStore('verifying', 'D3');
    const lease = claimAndSubmit(store, 'D3', artifact, 1);
    core.setStatus(store, 'D3', 'verifying', { reason: 'verify_started', notify: false });
    core.expire(store, { now: lease.expires_at + 1 });
    assert.equal(core.getNode(store, 'D3').status, 'ready', 'verifying 过期也必须回 ready');
  }
  console.log('PASS verifying 过期同样回 ready（不只修 submitted）');

  // ── 组 7：租约仍存活时，submitted 不得被误驳回 ────────────────────────
  {
    const { store, artifact } = makeStore('alive', 'D4');
    const lease = claimAndSubmit(store, 'D4', artifact, 600);
    core.expire(store, { now: lease.heartbeat_at + 1 }); // 租约还活着
    const node = core.getNode(store, 'D4');
    assert.equal(node.status, 'submitted', '租约未过期时 submitted 必须原样保留（不得误驳回）');
    assert.equal(node.assignee, 'role-code-01', 'assignee 不得被清空');
    assert.equal(store.state.leases.size, 1, '租约不得被删除');
  }
  console.log('PASS 租约存活时 submitted 原样保留（不误驳回）');

  // ── 组 8：**孤儿 submitted**（租约已被删）也必须被清扫 ─────────────────
  //
  // 补的是第二层漏洞：`expire()` 遍历 `state.leases`，只看得见**还存在**的租约。
  // 所以「租约早被删掉、节点却留在 submitted」的节点永远进不了它的循环 ——
  // 第一层修复对它们零作用。真实事故里就这样卡住了 7 个节点。
  {
    const { store, artifact } = makeStore('orphan', 'D5');
    claimAndSubmit(store, 'D5', artifact, 600);
    store.state.leases.delete('D5'); // 手工制造孤儿，还原线上现场
    assert.equal(core.getNode(store, 'D5').status, 'submitted', '前置：节点仍 submitted');
    assert.equal(store.state.leases.has('D5'), false, '前置：租约确实已不存在');

    const before = core.getNode(store, 'D5');
    core.withCoreStore(store, () => core.reapExpiredLeases({}));
    const after = core.getNode(store, 'D5');
    assert.equal(after.status, 'ready', `**孤儿清扫点**：无租约的 submitted 必须回 ready，实际 ${after.status}`);
    assert.equal(after.attempts, before.attempts + 1, '孤儿清扫也走 reject 路径，attempts+1');
    const orphanRejection = store.journal.view().filter((e) => e.kind === 'node_rejected').pop();
    assert.ok(orphanRejection, '必须留 node_rejected');
    assert.equal(String(orphanRejection.payload?.reason), 'orphan_submitted', '原因必须可区分于 lease_expired');
    core.claim(store, 'D5', 'role-code-03', { ttlSec: 60 }); // 能重新 claim
  }
  console.log('PASS 孤儿 submitted（租约已删）被清扫回 ready，原因 orphan_submitted，可重 claim');
} finally {
  cleanupTempStateDirs();
}
