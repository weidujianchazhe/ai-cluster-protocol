/**
 * 组织因子 + 协调闭环（`core/organization.ts` + `core/replan.ts` + `core/graphspec.ts`）。
 *
 * 这块是「Agent 集群有没有组织能力」的那条最小链：
 *
 *   组成因子声明组织意图（coordination.organization.integrationContracts）
 *     → organization_review 只读发现（契约状态 / 冲突路由 / 写域重叠 / 协调草案）
 *     → graph_replan 显式改图（**带 graph_version CAS**，旧草案不得覆盖新图）
 *     → 事务外重算 ready
 *
 * 验收要点（每条都是真实会坏的地方）：
 *
 *   1. 同一 journal 重放出同一 `fingerprint`（`generatedAt` 除外）——报告可回放；
 *   2. 只读：审查不写 journal、不改图、不派活；
 *   3. CAS：过期 `expectedGraphVersion` 一律 `replan_stale_graph`，且**零写入**；
 *   4. 终态保护：`done` 节点不得删除或改依赖（要修订就新增节点，不改写历史）；
 *   5. 结构校验前置：自依赖 / 悬空依赖 / 成环 / 半途落图都在事务前拒绝；
 *   6. 集成契约校验：成员数 < 2、引用未知节点、集成节点不依赖成员、集成节点自任成员都要拒；
 *   7. 写域重叠能算出来 —— 前提是 `writeScopes` 真的落到了 NodeRecord（以前落图即丢）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (n) => pathToFileURL(path.join(root, 'lib', n)).href;
const core = await import(lib('core/index.js'));

const dir = path.resolve(tempStateDir('org'));
fs.mkdirSync(dir, { recursive: true });

function makeStore() {
  let now = 1_800_000_000_000;
  const clock = { nowMs: () => now, nowIso: () => { now += 1000; return new Date(now).toISOString(); } };
  return new core.Store({ clock });
}

const spec = (extra = {}) => ({
  wish: '组织因子与协调闭环',
  policies: { maxParallel: 8 },
  coordination: {
    enabled: true,
    organization: {
      integrationContracts: [
        {
          id: 'IC-1',
          nodeRefs: ['A', 'B'],
          integrationNode: 'INT-1',
          contract: 'A 与 B 的产物必须共享同一接口契约',
          acceptance: ['kind:exists'],
        },
      ],
    },
  },
  nodes: [
    { nodeId: 'A', title: '成员 A', capability: 'CODE', stage: 'build', writeScopes: ['src/api/'], acceptance: { kind: 'exists' } },
    { nodeId: 'B', title: '成员 B', capability: 'CODE', stage: 'build', writeScopes: ['src/api/v2/'], acceptance: { kind: 'exists' } },
    { nodeId: 'INT-1', title: '集成', capability: 'AUDIT_CODE', stage: 'build', deps: ['A', 'B'], acceptance: { kind: 'exists' } },
  ],
  ...extra,
});

const review = (store) => core.withCoreStore(store, () => core.organizationStatus({ generatedAt: '2026-01-01T00:00:00.000Z' }));

/** 把一个节点推到 done（claim → 证据 → 阶段闸门 → verify）—— done 有凭证闸门，不能直接 setStatus。 */
function complete(store, nodeId) {
  const artifact = path.join(dir, `${nodeId}.md`);
  fs.writeFileSync(artifact, `# ${nodeId}\n`, 'utf8');
  const lease = core.claim(store, nodeId, 'role-code-01', { ttlSec: 600 });
  const ev = core.withCoreStore(store, () => core.submitEvidence({
    nodeId, artifactPath: artifact, fencingToken: lease.fencing_token,
    producerInstance: 'role-code-01', auditorInstance: 'role-audit-01',
    kind: 'artifact', acceptance: { kind: 'exists' },
  }));
  assert.equal(ev?.ok, true, `${nodeId} 证据应通过: ${JSON.stringify(ev).slice(0, 200)}`);
  core.withCoreStore(store, () => core.passGate(store, 'build', []));
  core.withCoreStore(store, () => core.verifyDone({
    nodeId, fencingToken: lease.fencing_token,
    producerInstance: 'role-code-01', auditorInstance: 'role-audit-01',
  }));
  assert.equal(store.state.nodes.get(nodeId).status, 'done', `${nodeId} 应已 done`);
}

// ── 1. 集成契约写进组成因子后：审查能看到「等待成员」 ────────────────────
{
  const store = makeStore();
  const committed = core.commitGraph(store, spec());
  assert.equal(committed.ok, true, JSON.stringify(committed.errors ?? committed).slice(0, 400));

  const r = review(store);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal(r.readOnly, true, '审查必须是只读的');
  assert.equal(r.organization.summary.total, 1);
  assert.equal(r.organization.summary.waitingMembers, 1, 'A/B 未完成 → 等待成员');
  assert.deepEqual(r.organization.contracts[0].missingMembers, ['A', 'B']);
  assert.deepEqual(r.organization.contracts[0].members, ['A', 'B'], '契约成员要能点回节点');
  assert.ok(
    r.signals.some((s) => s.kind === 'integration-contract' && s.owner === 'agent'),
    '成员未完成 → 应由集群内节点推进（agent），不是人',
  );
}
console.log('PASS 1. 集成契约：成员未完成 → waiting-members + agent 信号');

// ── 2. 只读：审查不写 journal、不改图 ──────────────────────────────────
{
  const store = makeStore();
  core.commitGraph(store, spec());
  const before = store.journal.count();
  const versionBefore = Number(store.state.meta.get('graph_version'));
  const nodesBefore = store.state.nodes.size;
  review(store);
  review(store);
  assert.equal(store.journal.count(), before, '审查不得写 journal');
  assert.equal(Number(store.state.meta.get('graph_version')), versionBefore, '审查不得改图版本');
  assert.equal(store.state.nodes.size, nodesBefore, '审查不得增删节点');
}
console.log('PASS 2. 只读：不写 journal、不改 graph_version、不改节点集');

// ── 3. 可回放：同一 journal 两次审查 → 同一 fingerprint ─────────────────
{
  const a = makeStore();
  const b = makeStore();
  core.commitGraph(a, spec());
  core.commitGraph(b, spec());
  const ra = review(a);
  const rb = review(b);
  assert.equal(ra.fingerprint, rb.fingerprint, '同一构图 + 同一生成时刻 → 同一 fingerprint');
  assert.equal(ra.fingerprint.length, 64, 'sha256 十六进制');

  // 图变了，fingerprint 必须变（否则回放判据没有分辨力）
  complete(a, 'A');
  const ra2 = review(a);
  assert.notEqual(ra.fingerprint, ra2.fingerprint, '状态变化后 fingerprint 必须变');
}
console.log('PASS 3. 可回放：fingerprint 由 state 决定，且对状态变化敏感');

// ── 4. 成员完成后：ready-for-integration + 集成草案（不含 expectedGraphVersion） ─
{
  const store = makeStore();
  core.commitGraph(store, spec());
  complete(store, 'A');
  complete(store, 'B');
  const r = review(store);
  assert.equal(r.organization.summary.readyForIntegration, 1, 'A/B 都完成 → 可集成');
  assert.deepEqual(r.organization.contracts[0].missingMembers, []);
  const next = r.next.find((n) => n.action.includes('执行集成节点 INT-1'));
  assert.ok(next, '下一步必须点名集成节点，不能只说"继续"');
  assert.match(next.reason, /契约/, '理由必须挂在契约上，而不是"依赖已完成"这种空话');
  assert.match(next.reason, /kind:exists/, '验收条目要进理由，执行者才知道按什么交付');
}
console.log('PASS 4. 成员完成后：可集成 + next 点名集成节点并给出契约理由');

// ── 5. 写域重叠：writeScopes 真的落到 NodeRecord 才可能算出来 ──────────
{
  const store = makeStore();
  core.commitGraph(store, spec());
  const nodeA = store.state.nodes.get('A');
  assert.deepEqual(nodeA.budget.writeScopes, ['src/api/'], 'writeScopes 必须随 budget 落图（旧实现落图即丢）');

  const r = review(store);
  const overlap = r.signals.find((s) => s.kind === 'write-scope-overlap');
  assert.ok(overlap, 'src/api/ 与 src/api/v2/ 前缀重叠 → 必须报出来');
  assert.deepEqual(overlap.nodes.sort(), ['A', 'B']);
  assert.match(overlap.detail, /只是声明/, '必须写明 writeScopes 不是文件锁，别被当强制互斥');
  const proposal = r.proposals.find((p) => p.kind === 'add-coordination-node');
  assert.ok(proposal, '重叠要能给协调节点草案');
  assert.equal(
    Object.prototype.hasOwnProperty.call(proposal.replanDraft, 'expectedGraphVersion'),
    false,
    '草案不得自带 expectedGraphVersion：采纳者必须自己读当前版本（防旧草案覆盖新图）',
  );
}
console.log('PASS 5. 写域重叠：前缀重叠检出 + 协调草案不带 expectedGraphVersion');

// ── 6. CAS：过期 graph_version 一律拒绝，且零写入 ──────────────────────
{
  const store = makeStore();
  core.commitGraph(store, spec());
  const beforeVersion = Number(store.state.meta.get('graph_version'));
  const beforeNodes = store.state.nodes.size;
  const beforeSeq = store.journal.count();

  const stale = core.withCoreStore(store, () =>
    core.graphReplan({ reason: 'coordination', expectedGraphVersion: beforeVersion - 1, add: [{ nodeId: 'X', title: 'X', spec: 'x' }] }),
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'replan_stale_graph');
  assert.equal(stale.actualGraphVersion, beforeVersion, '必须回传真实版本，调用方才能重读重试');
  assert.equal(Number(store.state.meta.get('graph_version')), beforeVersion, 'CAS 失败不得改版本');
  assert.equal(store.state.nodes.size, beforeNodes, 'CAS 失败不得改节点');
  assert.equal(store.journal.count(), beforeSeq, 'CAS 失败不得写事件');
}
console.log('PASS 6. CAS：过期 graph_version → replan_stale_graph，零写入');

// ── 7. 缺 expectedGraphVersion 直接拒（不给默认值） ─────────────────────
{
  const store = makeStore();
  core.commitGraph(store, spec());
  const missing = core.withCoreStore(store, () => core.graphReplan({ reason: 'coordination', add: [{ nodeId: 'X', title: 'X', spec: 'x' }] }));
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'expected-graph-version-required');
}
console.log('PASS 7. 缺 expectedGraphVersion → 直接拒（不静默用当前版本兜底）');

// ── 8. 正常改图：版本递增、事件留痕、rewired 可回放 ────────────────────
{
  const store = makeStore();
  core.commitGraph(store, spec());
  const version = Number(store.state.meta.get('graph_version'));
  const ok = core.withCoreStore(store, () =>
    core.graphReplan({
      reason: 'coordination',
      expectedGraphVersion: version,
      add: [{ nodeId: 'COORD-1', title: '接口协调', spec: '统一 A/B 接口', stage: 'design', deps: ['A', 'B'], writeScopes: ['src/api/'] }],
      setDeps: {},
      note: '按组织审查草案补协调节点',
    }),
  );
  assert.equal(ok.ok, true, JSON.stringify(ok).slice(0, 300));
  assert.equal(ok.graph_version, version + 1, '版本必须递增');
  assert.deepEqual(ok.added, ['COORD-1']);
  assert.equal(store.state.nodes.get('COORD-1').budget.writeScopes[0], 'src/api/', 'replan 新增节点也要落 writeScopes');
  assert.equal(store.state.replanEvents.at(-1).graph_version, version + 1, '事件要记图版本');
  assert.equal(store.state.replanEvents.at(-1).reason, 'coordination', '原因写进事件，供回放');
}
console.log('PASS 8. 改图：版本递增 + event 留痕 + 新节点写域落图');

// ── 9. 终态保护：done 节点不得删除 / 改依赖 ────────────────────────────
{
  const store = makeStore();
  core.commitGraph(store, spec());
  complete(store, 'A');
  const version = Number(store.state.meta.get('graph_version'));

  const del = core.withCoreStore(store, () => core.graphReplan({ reason: 'coordination', expectedGraphVersion: version, remove: ['A'] }));
  assert.equal(del.ok, false);
  assert.match(del.message, /终态/, '删除 done 必须前置拒绝');

  const rewire = core.withCoreStore(store, () => core.graphReplan({ reason: 'coordination', expectedGraphVersion: version, setDeps: { A: [] } }));
  assert.equal(rewire.ok, false);
  assert.match(rewire.message, /终态/, '改 done 的依赖也要拒：结论过期应新增修订节点');
  assert.equal(Number(store.state.meta.get('graph_version')), version, '被拒后版本不变');
}
console.log('PASS 9. 终态保护：done 节点删不掉、依赖也改不动');

// ── 10. 结构校验：自依赖 / 悬空依赖 / 成环都在事务前拒 ─────────────────
{
  const store = makeStore();
  core.commitGraph(store, spec());
  const version = Number(store.state.meta.get('graph_version'));

  const selfDep = core.withCoreStore(store, () =>
    core.graphReplan({ reason: 'coordination', expectedGraphVersion: version, add: [{ nodeId: 'S', title: 'S', spec: 's', deps: ['S'] }] }),
  );
  assert.equal(selfDep.ok, false);
  assert.match(selfDep.message, /自依赖/);

  const dangling = core.withCoreStore(store, () =>
    core.graphReplan({ reason: 'coordination', expectedGraphVersion: version, add: [{ nodeId: 'D', title: 'D', spec: 'd', deps: ['GHOST'] }] }),
  );
  assert.equal(dangling.ok, false);
  assert.match(dangling.message, /悬空依赖/);

  const cycle = core.withCoreStore(store, () =>
    core.graphReplan({ reason: 'coordination', expectedGraphVersion: version, setDeps: { A: ['INT-1'] } }),
  );
  assert.equal(cycle.ok, false, 'A → INT-1 → A 必须被拒');
  assert.match(cycle.message, /环/);
  assert.equal(Number(store.state.meta.get('graph_version')), version, '三次拒绝都不得改版本');
}
console.log('PASS 10. 结构校验：自依赖 / 悬空依赖 / 成环 — 事务前拒绝且零写入');

// ── 11. 删节点时下游必须显式改依赖（不静默留悬空） ─────────────────────
{
  const store = makeStore();
  core.commitGraph(store, spec());
  const version = Number(store.state.meta.get('graph_version'));

  const blind = core.withCoreStore(store, () => core.graphReplan({ reason: 'coordination', expectedGraphVersion: version, remove: ['B'] }));
  assert.equal(blind.ok, false, 'B 被 INT-1 依赖，直接删会留悬空 → 必须拒');
  assert.match(blind.message, /悬空依赖/);

  const explicit = core.withCoreStore(store, () =>
    core.graphReplan({ reason: 'coordination', expectedGraphVersion: version, remove: ['B'], setDeps: { 'INT-1': ['A'] } }),
  );
  assert.equal(explicit.ok, true, JSON.stringify(explicit).slice(0, 300));
  assert.deepEqual(store.state.nodes.get('INT-1').deps, ['A']);
  assert.deepEqual(explicit.rewired.map((r) => r.node_id), ['INT-1']);
  assert.deepEqual(explicit.rewired[0].from, ['A', 'B']);
}
console.log('PASS 11. 删节点：不显式改下游 → 拒；显式 setDeps → 通过并留 rewired');

// ── 12. 集成契约校验：五种非法写法都要在 planGraph 阶段拒 ──────────────
{
  const base = spec();
  const plan = (contractPatch, nodePatch) =>
    core.planGraph({
      ...base,
      coordination: { enabled: true, organization: { integrationContracts: [contractPatch] } },
      nodes: nodePatch ?? base.nodes,
    });

  const tooFew = plan({ id: 'IC-X', nodeRefs: ['A'], integrationNode: 'INT-1', contract: 'c', acceptance: ['a'] });
  assert.ok(tooFew.errors.some((e) => e.code === 'integration-contract-scope-invalid'), '成员少于 2 要拒');

  const unknown = plan({ id: 'IC-X', nodeRefs: ['A', 'GHOST'], integrationNode: 'INT-1', contract: 'c', acceptance: ['a'] });
  assert.ok(unknown.errors.some((e) => e.code === 'integration-contract-unknown-node'), '引用未知成员要拒');

  const selfMember = plan({ id: 'IC-X', nodeRefs: ['A', 'INT-1'], integrationNode: 'INT-1', contract: 'c', acceptance: ['a'] });
  assert.ok(selfMember.errors.some((e) => e.code === 'integration-node-in-members'), '集成节点不得自任成员');

  const missingDep = plan(
    { id: 'IC-X', nodeRefs: ['A', 'B'], integrationNode: 'INT-1', contract: 'c', acceptance: ['a'] },
    [
      { nodeId: 'A', title: 'A', acceptance: { kind: 'exists' } },
      { nodeId: 'B', title: 'B', acceptance: { kind: 'exists' } },
      { nodeId: 'INT-1', title: 'INT', deps: ['A'], acceptance: { kind: 'exists' } },
    ],
  );
  assert.ok(
    missingDep.errors.some((e) => e.code === 'integration-node-missing-dependency'),
    '集成节点必须依赖全部契约成员（否则它会先于 B 完成就跑）',
  );

  const noAcceptance = plan({ id: 'IC-X', nodeRefs: ['A', 'B'], integrationNode: 'INT-1', contract: 'c', acceptance: [] });
  assert.ok(noAcceptance.errors.some((e) => e.code === 'integration-contract-acceptance-required'), '契约必须有验收条目');
}
console.log('PASS 12. 集成契约校验：成员数 / 未知节点 / 自任成员 / 缺依赖 / 缺验收 — 五种全拒');

// ── 13. 冲突 → 能力缺口：不静默回退到 CODE ────────────────────────────
{
  const store = makeStore();
  core.commitGraph(store, {
    wish: '能力缺口',
    policies: { maxParallel: 8 },
    nodes: [
      // 6 个无标签节点 + ≥5 匹配 → 触发「无标签 / 证据 / 审计」类冲突；
      // 这些 need 不在图内、也不在目录里时，路由必须落在 human + 「集群缺口」。
      ...Array.from({ length: 6 }, (_, i) => ({ nodeId: `U${i}`, title: `无标签 ${i}`, acceptance: { kind: 'exists' } })),
    ],
  });
  const r = review(store);
  assert.equal(typeof r.conflicts.byRoute, 'object');
  for (const item of r.conflicts.items) {
    assert.notEqual(item.route, 'unresolved', 'routeConflicts 不得把冲突留在 unresolved');
    assert.ok(item.reason.length > 0, `冲突 ${item.id} 必须给出路由理由`);
  }
  // 缺口信号（若本次构型触发了缺口）必须标明是能力缺口，而不是悄悄派给 CODE
  for (const signal of r.signals.filter((s) => s.kind === 'capability-gap')) {
    assert.equal(signal.owner, 'capability', '缺口归「先补能力」，不归任意默认职务');
    assert.match(signal.detail, /集群缺口/);
  }
}
console.log('PASS 13. 冲突路由不留 unresolved；能力缺口标 owner=capability');

cleanupTempStateDirs();
console.log('\n全部通过：组织因子与协调闭环（13 组）');
