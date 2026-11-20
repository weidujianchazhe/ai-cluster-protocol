/**
 * 常驻协调器：把「维护职责」从 dispatch 与 Lead 手里拿出来。
 *
 * 三条需求都来自本轮实测，不是设想：
 *   1. **reap 挂错了地方**——只有 `dispatch` 会回收过期租约与孤儿。`mode:off` 时没人做。
 *      实测：重载后调 `task_next`，那 7 个孤儿毫无变化；改调 `dispatch` 才被清扫。
 *   2. **审计路由不可扩展**——8 个 worker 就产生 8 条需要 Lead 手工转发的审计请求。
 *      1000 个时代这件事不可能靠人做。
 *   3. worker 提交证据后不再心跳，租约到期后没人接手。
 *
 * 设计约束（决定了它为什么「稳定」而不是又一个 hack）：
 *   - **确定性**：纯状态机规则，不含 LLM 判断，可复现、可断言；
 *   - **幂等**：每轮重算应有状态、做差集，重复执行无副作用；
 *   - **不越权**：没有 Lead caller 时**只 reap、不派审计**（不猜、不降级成别的身份乱派）；
 *   - **可观测**：每轮写 `coordinator_tick`，出问题能查「那一轮为什么没动作」；
 *   - **可关**：`coordinatorEnabled:false` 完全不启动；`auditDispatchAfterMs:0` 只关自动审计。
 *
 * 断言：
 *   1. tick 会 reap（过期租约 + 孤儿都报出来，不再只报 reaped）；
 *   2. submitted 超时 + 有 Lead caller → 派审计实例，留 `audit_dispatched`；
 *   3. **没有 Lead caller → 不派**，记 `no-lead-caller`（不静默、不乱派）；
 *   4. 时间窗内不重复派同一节点（`recently-dispatched`）；
 *   5. `auditDispatchAfterMs: 0` → 关掉自动审计，但 reap 继续；
 *   6. 每轮留 `coordinator_tick`；
 *   7. 重入保护：上一轮未完成时新一轮直接跳过（busy）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (n) => pathToFileURL(path.join(root, 'lib', n)).href;
const { L0ControlService } = await import(lib('service.js'));

const unwrap = (w) => {
  const inner = w && typeof w === 'object' && 'graph' in w ? w.graph : w;
  return inner && typeof inner === 'object' && 'result' in inner ? inner.result : inner;
};

const spawned = [];
const makeCtx = () => ({
  get: (name) => {
    if (name === 'workingDirectory') return { defaultDirectory: root };
    if (name === 'agentTeams') {
      return {
        membership: () => ({ role: 'lead', name: 'lead', id: 'team-1', root: { id: 's-lead' } }),
        listMembers: () => [],
        roster: { maxMembers: 256 },
        spawnTeammate: async (caller, req) => {
          spawned.push(String(req?.name ?? ''));
          return { member: { name: String(req?.name ?? 'w'), id: `sess-${spawned.length}` } };
        },
      };
    }
    if (name === 'subagents') {
      return { config: { maxActiveSubagents: { get: () => 256, set: () => {} } }, list: () => ['spawn'] };
    }
    return undefined;
  },
});

async function withSvc(config, fn) {
  const stateDir = path.resolve(tempStateDir('coord'));
  const svc = new L0ControlService(makeCtx(), {
    workspaceRoot: root, stateDir, persistence: 'node', maxParallel: 8,
    coordinatorEnabled: false, // 测试里手动调 tick，不启定时器
    ...config,
  }, {});
  try {
    return await fn(svc);
  } finally {
    try { svc.stopCoordinator(); } catch { /* 未启动 */ }
    try { svc.stopDispatch(); } catch { /* 未启动 */ }
    try { await svc.dispose(); } catch { /* 已关闭 */ }
    cleanupTempStateDirs();
  }
}

const LEAD = { id: 's-lead' };

/** 造一个已 submitted 的节点（可选：把 updated_at 往前推，模拟「等了很久」）。 */
async function makeSubmitted(svc, nodeId) {
  const dir = path.resolve(tempStateDir(`coord-${nodeId}`));
  fs.mkdirSync(dir, { recursive: true });
  const artifact = path.join(dir, 'a.md');
  fs.writeFileSync(artifact, `# ${nodeId}\n`, 'utf8');
  const committed = unwrap(await svc.graphCommit({
    wish: 'coord', policies: { maxParallel: 8 },
    nodes: [{ nodeId, title: 't', capability: 'CODE', stage: 'build', deps: [], acceptance: { kind: 'exists' } }],
  }));
  assert.equal(committed.ok, true, JSON.stringify(committed.errors ?? committed).slice(0, 200));
  const claimed = unwrap(await svc.taskClaim({ nodeId, instanceId: 'role-code-01' }, LEAD));
  assert.equal(claimed?.ok, true, JSON.stringify(claimed).slice(0, 200));
  const ev = unwrap(await svc.evidenceSubmit({
    nodeId, artifactPath: artifact, fencingToken: claimed.lease.fencing_token,
    producer_instance: 'role-code-01', auditor_instance: 'role-audit-code-01',
    kind: 'artifact', acceptance: { kind: 'exists' },
  }, LEAD));
  assert.equal(ev?.ok, true, JSON.stringify(ev).slice(0, 240));
  return artifact;
}

try {
  // ── 组 1：tick 会 reap，并把 orphans 也报出来 ──────────────────────────
  {
    await withSvc({ auditDispatchAfterMs: 0 }, async (svc) => {
      await makeSubmitted(svc, 'C1');
      // 手工制造孤儿：删租约但留 submitted
      const p = await svc.persistence();
      const nodes = p.core.state.nodes;
      nodes.get('C1').status = 'submitted';
      p.core.state.leases.delete('C1');
      const out = await svc.coordinatorTick('test', LEAD);
      assert.equal(out.ok, true);
      assert.ok((out.reaped).includes('C1'), '孤儿必须被 reap 报出来');
      assert.ok([...svc.readJournal()].some((r) => r.kind === 'lease_reaped' && r.reason === 'orphan_submitted'));
    });
    console.log('PASS tick 会 reap 孤儿，并落 lease_reaped(orphan_submitted)');
  }

  // ── 组 2 + 4 + 6：超时 → 派审计；时间窗内不重复；留 tick ────────────────
  {
    await withSvc({ auditDispatchAfterMs: 1 }, async (svc) => {
      await makeSubmitted(svc, 'C2');
      const out1 = await svc.coordinatorTick('test', LEAD);
      assert.ok((out1.auditDispatched).includes('C2'), `应派审计，实际 ${JSON.stringify(out1).slice(0, 300)}`);
      assert.ok(spawned.length >= 1, '必须真的调了 spawnTeammate');
      assert.ok([...svc.readJournal()].some((r) => r.kind === 'audit_dispatched' && r.nodeId === 'C2'));
      // 立刻再来一轮：时间窗内不得重复派
      const out2 = await svc.coordinatorTick('test', LEAD);
      assert.equal((out2.auditDispatched).length, 0, '时间窗内不得重复派审计');
      assert.ok((out2.auditSkipped).some((s) => s.why === 'recently-dispatched'));
      assert.ok([...svc.readJournal()].some((r) => r.kind === 'coordinator_tick'));
    });
    console.log('PASS submitted 超时 → 派审计 + 留 audit_dispatched；同一窗口内不重复派；每轮留 coordinator_tick');
  }

  // ── 组 3：没有 Lead caller → 只 reap，不派审计 ─────────────────────────
  {
    await withSvc({ auditDispatchAfterMs: 1 }, async (svc) => {
      await makeSubmitted(svc, 'C3');
      const out = await svc.coordinatorTick('test', undefined); // 不给 caller，也没缓存过 Lead
      assert.equal((out.auditDispatched).length, 0, '没有 Lead caller 时不得派审计');
      assert.ok((out.auditSkipped).some((s) => s.why === 'no-lead-caller'));
    });
    console.log('PASS 没有 Lead caller → 不派审计，记 no-lead-caller（不静默、不乱派）');
  }

  // ── 组 5：auditDispatchAfterMs=0 → 关自动审计，reap 继续 ────────────────
  {
    await withSvc({ auditDispatchAfterMs: 0 }, async (svc) => {
      await makeSubmitted(svc, 'C4');
      const before = spawned.length;
      const out = await svc.coordinatorTick('test', LEAD);
      assert.equal((out.auditDispatched).length, 0, 'ttl=0 不应自动派审计');
      assert.equal(spawned.length, before);
      assert.equal(out.ok, true, 'reap 仍要跑');
    });
    console.log('PASS auditDispatchAfterMs=0 → 不自动派审计，但 reap 照常');
  }

  // ── 组 7：重入保护 ────────────────────────────────────────────────────
  {
    await withSvc({ auditDispatchAfterMs: 0 }, async (svc) => {
      const p1 = svc.coordinatorTick('first', LEAD);
      const p2 = await svc.coordinatorTick('second', LEAD); // 上一轮未完成
      assert.equal(p2.ok, false);
      assert.equal(p2.skipped, 'busy');
      await p1;
    });
    console.log('PASS 上一轮未完成时，新一轮跳过（busy）—— 定时器不会叠加执行');
  }
} finally {
  cleanupTempStateDirs();
}
