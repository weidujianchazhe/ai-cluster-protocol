/**
 * 邻域感知（③）：**只读同分区内已完成节点的定长摘要**。
 *
 * 三条硬约束，每条都有对应的断言组：
 *
 *   1. **只读 done**（无环的保证）→ 进行中的节点不出现
 *   2. **只读同分区**（单向的保证）→ 别的分区不出现
 *   3. **定长 + 成本可见** → 不随规模增长，且明确报出 approxTokens
 *
 * 另外两组针对"不破坏"：
 *   - **不在分区里 → 优雅返回**（no-partition，不抛错）
 *   - **只读**：调用前后 journal 长度不变
 *
 * 最容易做错的两点，专门设组：
 *   - **含自己**：邻域不该包含调用者自己
 *   - **排序稳定**：同一份数据算两次必须同一个顺序（否则谈可复现没有意义）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (n) => pathToFileURL(path.join(root, 'lib', n)).href;
const core = await import(lib('core/index.js'));

function makeStore(tag) {
  const dir = path.resolve(tempStateDir(`n-${tag}`));
  fs.mkdirSync(dir, { recursive: true });
  return { store: new core.Store({}), dir };
}

/** 建图 + 分区。nodes: [{id, spec}]；partitions: [{id, refs}] */
function build(store, nodes, partitions, maxParallel = 16) {
  const committed = core.commitGraph(store, {
    wish: 'neighborhood',
    policies: { maxParallel },
    coordination: {
      enabled: true,
      partitions: partitions.map((p) => ({ id: p.id, nodeRefs: p.refs })),
    },
    nodes: nodes.map((n) => ({
      nodeId: n.id,
      title: n.title ?? n.id,
      spec: n.spec ?? `关于 ${n.id} 的规格`,
      capability: 'CODE',
      stage: 'build',
      deps: [],
      acceptance: { kind: 'exists' },
    })),
  });
  assert.equal(committed.ok, true, JSON.stringify(committed.errors ?? committed).slice(0, 300));
  core.bootstrap(store);
}

/** 把一个节点推到 done（claim → 证据 → 闸门 → verify）。 */
function complete(store, dir, nodeId) {
  const artifact = path.join(dir, `${nodeId}.md`);
  fs.writeFileSync(artifact, `# ${nodeId}\n`, 'utf8');
  const lease = core.claim(store, nodeId, 'role-code-01', { ttlSec: 600 });
  const ev = core.withCoreStore(store, () => core.submitEvidence({
    nodeId, artifactPath: artifact, fencingToken: lease.fencing_token,
    producerInstance: 'role-code-01', auditorInstance: 'role-audit-01',
    kind: 'artifact', acceptance: { kind: 'exists' },
  }));
  assert.equal(ev?.ok, true, `${nodeId} 证据应通过: ${JSON.stringify(ev).slice(0, 200)}`);
  // **先过阶段闸门**：verifyDone 要求对应 stage 已 passed
  // 注意 core 层的签名是 `passGate(store, stage, evidenceRefs)`，不是对象
  core.withCoreStore(store, () => core.passGate(store, 'build', []));
  const v = core.withCoreStore(store, () => core.verifyDone({
    nodeId, fencingToken: lease.fencing_token,
    producerInstance: 'role-code-01', auditorInstance: 'role-audit-01',
  }));
  assert.equal(store.state.nodes.get(nodeId).status, 'done',
    `${nodeId} 应已 done，实际 ${store.state.nodes.get(nodeId).status}（verify 返回 ${JSON.stringify(v).slice(0, 200)}）`);
}

// ── 组 1：只读同分区的 done 邻居 ──────────────────────────────────────
{
  const { store, dir } = makeStore('basic');
  build(store,
    [{ id: 'A1' }, { id: 'A2' }, { id: 'A3' }, { id: 'B1' }],
    [{ id: 'p1', refs: ['A1', 'A2', 'A3'] }, { id: 'p2', refs: ['B1'] }]);
  complete(store, dir, 'A1');
  complete(store, dir, 'A2');
  complete(store, dir, 'B1');

  const nb = core.neighborhoodOf(store, 'A3');
  assert.equal(nb.partitionId, 'p1', 'A3 属于 p1');
  assert.equal(nb.neighbors.length, 2, 'p1 内已完成 2 个（A1/A2）');
  assert.deepEqual(nb.neighbors.map((n) => n.nodeId).sort(), ['A1', 'A2']);
  assert.ok(!nb.neighbors.some((n) => n.nodeId === 'B1'), '**不许跨分区**（B1 在 p2）');
  assert.ok(!nb.neighbors.some((n) => n.nodeId === 'A3'), '**不许含自己**');
  console.log('PASS 只读同分区的 done 邻居：A3 看到 A1/A2，看不到 B1（跨区）、不含自己');
}

// ── 组 2：只读 done —— 进行中的节点不出现 ────────────────────────────
{
  const { store, dir } = makeStore('doneonly');
  build(store, [{ id: 'X1' }, { id: 'X2' }, { id: 'X3' }], [{ id: 'p', refs: ['X1', 'X2', 'X3'] }]);
  complete(store, dir, 'X1');
  // X2 只 claim 不完成（进行中）
  const lease = core.claim(store, 'X2', 'role-code-01', { ttlSec: 600 });
  assert.equal(store.state.nodes.get('X2').status, 'claimed');

  const nb = core.neighborhoodOf(store, 'X3');
  assert.deepEqual(nb.neighbors.map((n) => n.nodeId), ['X1'], '**进行中的 X2 不得出现**');
  console.log('PASS 只读 done：X2 在 claimed 状态 → 不出现（这是无环的保证）');
}

// ── 组 3：定长截断 + 成本可见 ────────────────────────────────────────
{
  const { store, dir } = makeStore('limit');
  const ids = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'];
  build(store, ids.map((id) => ({ id, spec: 'x'.repeat(500) })), [{ id: 'p', refs: ids }]);
  for (const id of ids.slice(0, 6)) complete(store, dir, id);

  const nb = core.neighborhoodOf(store, 'L7', { maxNeighbors: 3, charsPerNeighbor: 100 });
  assert.equal(nb.neighbors.length, 3, 'maxNeighbors=3 应只给 3 个');
  assert.equal(nb.totals.partitionDone, 6, '但总数应如实报 6');
  assert.equal(nb.totals.shown, 3);
  assert.ok(nb.caveatFlags.includes('truncated'), '机器标记应含 truncated');
  assert.ok(nb.caveat?.includes('未展示'), '人读文本要说明，不能静默少给');
  for (const n of nb.neighbors) {
    assert.ok(n.summary.length <= 101, `摘要不得超过 charsPerNeighbor=100（实际 ${n.summary.length}）`);
  }
  assert.ok(nb.cost.approxTokens > 0, '必须报出成本估算');
  assert.equal(nb.cost.chars, nb.neighbors.reduce((s, n) => s + n.title.length + n.summary.length, 0), 'chars 应等于实际字符数');
  console.log(`PASS 定长截断：6 个 done 只给 3 个（caveat 说明），摘要≤100 字，成本 ${nb.cost.approxTokens} token`);
}

// ── 组 4：不在分区里 → 优雅返回，不抛错 ──────────────────────────────
{
  const { store } = makeStore('nopart');
  build(store, [{ id: 'Z1' }, { id: 'Z2' }], [{ id: 'p', refs: ['Z1'] }]); // Z2 不在分区
  const nb = core.neighborhoodOf(store, 'Z2');
  assert.equal(nb.ok, true, '不在分区不是错误');
  assert.equal(nb.partitionId, null);
  assert.equal(nb.neighbors.length, 0);
  assert.ok(nb.caveatFlags.includes('no-partition'), '机器标记应含 no-partition');
  // 「怎么启用」在人读的 caveat 里（note 是固定文本，不随情况变）
  assert.ok(nb.caveat?.includes('coordination.partitions'), '要告诉人怎么启用');
  console.log('PASS 不在分区 → ok=true / partitionId=null / caveatFlags=[no-partition]（不抛错，且给出启用方法）');
}

// ── 组 5：排序稳定（同一份数据两次算出同样顺序）──────────────────────
{
  const { store, dir } = makeStore('stable');
  const ids = ['S1', 'S2', 'S3', 'S4'];
  build(store, ids.map((id) => ({ id })), [{ id: 'p', refs: ids }]);
  for (const id of ids.slice(0, 3)) complete(store, dir, id);

  const a = core.neighborhoodOf(store, 'S4').neighbors.map((n) => n.nodeId);
  const b = core.neighborhoodOf(store, 'S4').neighbors.map((n) => n.nodeId);
  assert.deepEqual(a, b, '两次调用必须同一顺序（排序稳定是可复现的前提）');
  console.log(`PASS 排序稳定：两次调用顺序一致 ${JSON.stringify(a)}`);
}

// ── 组 6：只读 —— 算邻域不写 journal ────────────────────────────────
{
  const { store, dir } = makeStore('ro');
  build(store, [{ id: 'R1' }, { id: 'R2' }], [{ id: 'p', refs: ['R1', 'R2'] }]);
  complete(store, dir, 'R1');
  const before = store.journal.size;
  core.neighborhoodOf(store, 'R2');
  const after = store.journal.size;
  assert.equal(after, before, `邻域感知不许写 journal（${before} → ${after}）`);
  console.log(`PASS 只读：调用前后 journal 长度一致（${before}）`);
}

// ── 组 7：verifiedEvidence 提示（不参与判定，只是可信度线索）──────────
{
  const { store, dir } = makeStore('ved');
  build(store, [{ id: 'V1' }, { id: 'V2' }], [{ id: 'p', refs: ['V1', 'V2'] }]);
  complete(store, dir, 'V1');
  const nb = core.neighborhoodOf(store, 'V2');
  const v1 = nb.neighbors.find((n) => n.nodeId === 'V1');
  assert.ok(v1, 'V1 应在邻域里');
  assert.equal(v1.verifiedEvidence, 1, 'V1 有 1 条 verified 证据');
  assert.ok(nb.note.includes('不参与任何判定'), 'note 必须声明不参与判定');
  console.log('PASS verifiedEvidence 提示存在（1 条），且 note 声明不参与判定');
}


// ── 组 8：纵向 —— 只读直接上游（deps）────────────────────────────────
{
  const { store, dir } = makeStore('deps');
  // 链式：R → M → (L1, L2)，外加一个独立节点
  const committed = core.commitGraph(store, {
    wish: 'vertical',
    policies: { maxParallel: 16 },
    nodes: [
      { nodeId: 'R', title: 'R', spec: '研究结论', capability: 'RESEARCH', stage: 'build', deps: [], acceptance: { kind: 'exists' } },
      { nodeId: 'M', title: 'M', spec: '中间产物', capability: 'CODE', stage: 'build', deps: ['R'], acceptance: { kind: 'exists' } },
      { nodeId: 'L1', title: 'L1', spec: '下游一', capability: 'CODE', stage: 'build', deps: ['M'], acceptance: { kind: 'exists' } },
      { nodeId: 'L2', title: 'L2', spec: '下游二', capability: 'CODE', stage: 'build', deps: ['M'], acceptance: { kind: 'exists' } },
    ],
  });
  assert.equal(committed.ok, true, JSON.stringify(committed.errors ?? committed).slice(0, 200));
  core.bootstrap(store);
  complete(store, dir, 'R');
  complete(store, dir, 'M');

  const nb = core.neighborhoodOf(store, 'L1', { direction: 'deps' });
  assert.deepEqual(nb.neighbors.map((n) => n.nodeId), ['M'], '**只读直接上游 M，不读 R（深度 1 不做祖先链）**');
  assert.equal(nb.neighbors[0].via, 'dep', '来源应标为 dep');
  assert.equal(nb.totals.deps, 1, 'L1 有 1 个 deps');
  assert.equal(nb.totals.depsDone, 1, '其中 1 个已完成');
  assert.ok(!nb.neighbors.some((n) => n.nodeId === 'L2'), '**不读下游（L2 也是 M 的下游）**');
  console.log('PASS 纵向：L1 只看到直接上游 M（看不到祖先 R、也看不到平行下游 L2），via=dep');
}

// ── 组 9：纵向 -- 上游未完成时不出现，且 caveat 说明 ──────────────────
{
  const { store, dir } = makeStore('deps-pending');
  const committed = core.commitGraph(store, {
    wish: 'vp',
    policies: { maxParallel: 16 },
    nodes: [
      { nodeId: 'U', title: 'U', capability: 'CODE', stage: 'build', deps: [], acceptance: { kind: 'exists' } },
      { nodeId: 'D', title: 'D', capability: 'CODE', stage: 'build', deps: ['U'], acceptance: { kind: 'exists' } },
    ],
  });
  assert.equal(committed.ok, true);
  core.bootstrap(store);
  // U 只 claim 不完成 → D 其实还不是 ready，但我们仍能算邻域（工具是只读的）
  core.claim(store, 'U', 'role-code-01', { ttlSec: 600 });

  const nb = core.neighborhoodOf(store, 'D', { direction: 'deps' });
  assert.equal(nb.neighbors.length, 0, '上游未完成 → 邻域为空');
  assert.equal(nb.totals.depsDone, 0);
  assert.ok(nb.caveatFlags.includes('deps-pending'), '机器标记应含 deps-pending');
  assert.ok(nb.caveat?.includes('尚未完成'), `必须说明有依赖没完成：${nb.caveat}`);
  console.log('PASS 纵向：上游未完成 → 不出现，且 caveat 说明「N 个依赖尚未完成」');
}

// ── 组 10：both —— 上游优先于同分区 ──────────────────────────────────
{
  const { store, dir } = makeStore('both');
  // 节点 T：deps=[UP]；同时它在分区 p 里，同区还有 P1/P2
  const committed = core.commitGraph(store, {
    wish: 'both',
    policies: { maxParallel: 16 },
    coordination: { enabled: true, partitions: [{ id: 'p', nodeRefs: ['T', 'UP', 'P1', 'P2'] }] },
    nodes: [
      { nodeId: 'UP', title: 'UP', spec: '上游产物', capability: 'CODE', stage: 'build', deps: [], acceptance: { kind: 'exists' } },
      { nodeId: 'P1', title: 'P1', spec: '同区一', capability: 'CODE', stage: 'build', deps: [], acceptance: { kind: 'exists' } },
      { nodeId: 'P2', title: 'P2', spec: '同区二', capability: 'CODE', stage: 'build', deps: [], acceptance: { kind: 'exists' } },
      { nodeId: 'T', title: 'T', capability: 'CODE', stage: 'build', deps: ['UP'], acceptance: { kind: 'exists' } },
    ],
  });
  assert.equal(committed.ok, true, JSON.stringify(committed.errors ?? committed).slice(0, 200));
  core.bootstrap(store);
  for (const id of ['UP', 'P1', 'P2']) complete(store, dir, id);

  // 只给 2 个名额：上游 UP 必须排在两个同区节点之前
  const nb = core.neighborhoodOf(store, 'T', { direction: 'both', maxNeighbors: 2 });
  assert.equal(nb.neighbors.length, 2);
  assert.equal(nb.neighbors[0].nodeId, 'UP', '**上游优先：第一名必须是 UP**');
  assert.equal(nb.neighbors[0].via, 'dep');
  assert.equal(nb.totals.shownFromDeps, 1, '展示了 1 个上游');
  assert.equal(nb.totals.shownFromPartition, 1, '展示了 1 个同区');
  assert.ok(nb.caveatFlags.includes('truncated'), '被截断要说明');
  console.log(`PASS both：上游优先（第 1 名 UP/via=dep，第 2 名 ${nb.neighbors[1].nodeId}/via=partition）`);
}

cleanupTempStateDirs();
