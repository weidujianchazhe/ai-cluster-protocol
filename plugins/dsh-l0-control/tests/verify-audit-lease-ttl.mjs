/**
 * 审计窗口的租约延长（`auditLeaseTtlSec`）。
 *
 * 为什么需要：`verify_done` 要求**活租约**，而租约默认 TTL 60 s 是给「生产阶段」定的
 * （快速失败很好）。但证据一提交，节点就进入「等审计」——一轮真审计要复核产物哈希、
 * 复算数值，**很容易超过 60 s**。
 *
 * 而 worker 提交后通常就不再心跳了，**审计方又没有 fencingToken**（token 是生产者的），
 * 于是谁都续不了这个租约 → 到期 → 节点卡在 submitted。
 * 本轮真实事故就是这样连环卡死 7 个节点（M8-01/03/04/05/06/07/MEASURE-01）。
 *
 * 断言：
 *   1. 证据提交成功 → 租约被延长到 `auditLeaseTtlSec`（默认 600 s）；
 *   2. 落 `lease_audit_extended` 事件（含 ttl_sec，可归因）；
 *   3. **只延长不缩短**：已更宽的租约不被这次调用改小；
 *   4. `auditLeaseTtlSec=0` → 不延长（可用作显式关闭）；
 *   5. 延长后**仍能正常过期**：到期后 `expire()` 会把 submitted 驳回 ready
 *      （与两层死锁修复配合，不会因为延长而制造新的永久卡死）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (n) => pathToFileURL(path.join(root, 'lib', n)).href;
const core = await import(lib('core/index.js'));

function makeStore(tag, nodeId) {
  const dir = path.resolve(tempStateDir(`at-${tag}`));
  fs.mkdirSync(dir, { recursive: true });
  const artifact = path.join(dir, 'a.md');
  fs.writeFileSync(artifact, `# ${nodeId}\n`, 'utf8');
  const store = new core.Store({});
  const committed = core.commitGraph(store, {
    wish: 'audit ttl',
    policies: { maxParallel: 8 },
    nodes: [{ nodeId, title: 't', capability: 'CODE', stage: 'build', deps: [], acceptance: { kind: 'exists' } }],
  });
  assert.equal(committed.ok, true, JSON.stringify(committed.errors ?? committed).slice(0, 200));
  core.bootstrap(store);
  return { store, artifact, dir };
}

/** claim → 提交证据（带 auditLeaseTtlSec），返回 {lease, ev}。 */
function claimAndSubmit(store, nodeId, artifact, ttlSec, auditLeaseTtlSec) {
  const lease = core.claim(store, nodeId, 'role-code-01', { ttlSec });
  const ev = core.withCoreStore(store, () => core.submitEvidence({
    nodeId, artifactPath: artifact, fencingToken: lease.fencing_token,
    producerInstance: 'role-code-01', auditorInstance: 'role-audit-code-01',
    kind: 'artifact', acceptance: { kind: 'exists' },
    ...(auditLeaseTtlSec === undefined ? {} : { auditLeaseTtlSec }),
  }));
  assert.equal(ev?.ok, true, `提证据失败：${JSON.stringify(ev).slice(0, 240)}`);
  return { lease, ev };
}

try {
  // ── 组 1 + 2：提交后租约被延到 600 s，并留事件 ────────────────────────
  {
    const { store, artifact } = makeStore('main', 'A1');
    const { lease } = claimAndSubmit(store, 'A1', artifact, 60, 600);
    const after = core.currentLease(store, 'A1');
    assert.ok(after, '提交后租约必须仍存在');
    const expected = after.heartbeat_at + 600 * 1000;
    assert.equal(after.expires_at, expected, `租约应延到 heartbeat+600s，实际 ${after.expires_at - after.heartbeat_at} ms`);
    assert.ok(after.expires_at > lease.expires_at, '延后必须比原 60s 窗口更晚');
    const ev = store.journal.view().filter((e) => e.kind === 'lease_audit_extended').pop();
    assert.ok(ev, '必须留 lease_audit_extended');
    assert.equal(Number(ev.payload?.ttl_sec), 600);
    assert.equal(Number(ev.payload?.fencing_token), lease.fencing_token, '事件要记下 token，便于追责');
  }
  console.log('PASS 证据提交 → 租约延到 600s，留 lease_audit_extended（含 ttl_sec / token）');

  // ── 组 3：只延长不缩短 ────────────────────────────────────────────────
  {
    const { store, artifact } = makeStore('wider', 'A2');
    // 先给一个已经很宽的窗口（2000 s），提交时要求 600 s → 不得被改小
    const lease = core.claim(store, 'A2', 'role-code-01', { ttlSec: 2000 });
    const before = lease.expires_at;
    core.withCoreStore(store, () => core.submitEvidence({
      nodeId: 'A2', artifactPath: artifact, fencingToken: lease.fencing_token,
      producerInstance: 'role-code-01', auditorInstance: 'role-audit-code-01',
      kind: 'artifact', acceptance: { kind: 'exists' }, auditLeaseTtlSec: 600,
    }));
    const after = core.currentLease(store, 'A2');
    assert.equal(after.expires_at, before, '已更宽的租约不得被这次调用改小');
    assert.equal(store.journal.view().filter((e) => e.kind === 'lease_audit_extended').length, 0,
      '没有实际延长就不该写事件');
  }
  console.log('PASS 已更宽的租约不被改小（只延长不缩短），且不写无意义事件');

  // ── 组 4：auditLeaseTtlSec=0 → 不延长 ────────────────────────────────
  {
    const { store, artifact } = makeStore('off', 'A3');
    const { lease } = claimAndSubmit(store, 'A3', artifact, 60, 0);
    const after = core.currentLease(store, 'A3');
    assert.ok(Math.abs(after.expires_at - lease.expires_at) < 5, 'ttl=0 时租约窗口不应变化');
    assert.equal(store.journal.view().filter((e) => e.kind === 'lease_audit_extended').length, 0);
  }
  console.log('PASS auditLeaseTtlSec=0 → 不延长（可显式关闭）');

  // ── 组 5：延长后仍能正常过期（不制造新的永久卡死）────────────────────
  {
    const { store, artifact } = makeStore('expire', 'A4');
    claimAndSubmit(store, 'A4', artifact, 60, 600);
    const lease = core.currentLease(store, 'A4');
    core.expire(store, { now: lease.expires_at + 1 });
    const node = core.getNode(store, 'A4');
    assert.equal(node.status, 'ready', '审计窗口过期后，两层修复必须把它驳回 ready（不得永久卡死）');
  }
  console.log('PASS 审计窗口过期后仍正常驳回 ready（延长不制造新死锁）');
} finally {
  cleanupTempStateDirs();
}
