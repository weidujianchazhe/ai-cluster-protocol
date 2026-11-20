/**
 * 增量 ready 重算的**等价性**验证：增量结果必须与全量重算逐条相同。
 *
 * 背景：`recomputeReady` 挂在**每个 done 钩子**上，全量版对全图跑 `depsDone`，
 * 总成本 O(n²)。增量版只扫「当前 ready」+「依赖含刚完成节点的 planned」，
 * 5000 节点实测 2.93ms → 0.44ms（×6.7）。
 *
 * 但「更快」不等于「算得对」。本测试构造多种拓扑，在**每个** done 之后
 * 同时跑两种算法，断言 promoted / demoted **完全一致**：
 *
 *   拓扑 A 长链     N0 → N1 → ... → N7        每次只解锁一个
 *   拓扑 B 扇出     根 → 8 个叶子              一次解锁 8 个
 *   拓扑 C 扇入     4 个中间 → 同一个汇聚点    汇聚点要等全部 done
 *   拓扑 D 混合     菱形 + 独立链              相对复杂的依赖
 *   拓扑 E 孤立     8 个互不依赖                根节点同时 ready
 *
 * 每个拓扑在每个节点 done 后，用**同一份状态**分别跑全量与增量。
 * 为了不给状态造成副作用，两种算法都在**克隆出来的 store 快照**上跑。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const lib = (name) => pathToFileURL(path.join(root, 'lib', name)).href;
const core = await import(lib('core/index.js'));
const readyMod = await import(lib('core/ready.js'));

const MATERIAL = path.join(root, 'README.md');

/** 一个极简的可克隆 store：只需要 nodes/edges/leases/gates/evidence/meta 与 journal。 */
function cloneStore(source) {
  const clone = new core.Store();
  clone.state = structuredClone(source.state);
  clone.journal.restore(source.journal.raw());
  return clone;
}

/** 跑一个节点到 done（claim → evidence → verify_done），返回它的 nodeId。 */
function runNode(store, nodeId) {
  const run = (fn) => core.withCoreStore(store, fn);
  run(() => core.passGate(store, 'build', []));
  const claim = run(() => core.claimTask({ nodeId, role: 'ANY', instanceId: 'ROLE-CODE-01' }));
  assert.equal(claim.ok, true, `${nodeId} claim 失败：${JSON.stringify(claim)}`);
  const fencingToken = Number(claim.lease.fencing_token);
  const evidence = run(() =>
    core.submitEvidence({
      fencingToken,
      nodeId,
      artifactPath: MATERIAL,
      producerInstance: 'ROLE-CODE-01',
      acceptance: { kind: 'exists' },
    }),
  );
  assert.equal(evidence.ok, true, `${nodeId} evidence 失败：${JSON.stringify(evidence)}`);
  const done = run(() =>
    core.verifyDone({
      nodeId,
      producerInstance: 'ROLE-CODE-01',
      fencingToken,
      auditorInstance: 'ROLE-AUDIT_CODE-01',
      acceptance: { kind: 'exists' },
    }),
  );
  assert.equal(done.status, 'done', `${nodeId} verify_done 失败：${JSON.stringify(done)}`);
}

const TOPOLOGIES = {
  '长链': (() => {
    const ids = Array.from({ length: 8 }, (_, i) => `C${i}`);
    return {
      ids,
      nodes: ids.map((nodeId, i) => ({
        nodeId,
        title: nodeId,
        stage: 'build',
        deps: i === 0 ? [] : [ids[i - 1]],
        acceptance: { kind: 'exists' },
      })),
      order: ids,
    };
  })(),
  '扇出': (() => {
    const ids = ['F-root', ...Array.from({ length: 8 }, (_, i) => `F${i}`)];
    return {
      ids,
      nodes: [
        { nodeId: 'F-root', title: 'root', stage: 'build', deps: [], acceptance: { kind: 'exists' } },
        ...Array.from({ length: 8 }, (_, i) => ({
          nodeId: `F${i}`,
          title: `F${i}`,
          stage: 'build',
          deps: ['F-root'],
          acceptance: { kind: 'exists' },
        })),
      ],
      order: ids,
    };
  })(),
  '扇入': (() => {
    const mids = Array.from({ length: 4 }, (_, i) => `G-mid${i}`);
    const ids = [...mids, 'G-sink'];
    return {
      ids,
      nodes: [
        ...mids.map((nodeId) => ({
          nodeId,
          title: nodeId,
          stage: 'build',
          deps: [],
          acceptance: { kind: 'exists' },
        })),
        { nodeId: 'G-sink', title: 'sink', stage: 'build', deps: [...mids], acceptance: { kind: 'exists' } },
      ],
      order: [...mids, 'G-sink'],
    };
  })(),
  '混合': {
    ids: ['M-a', 'M-b', 'M-c', 'M-d', 'M-e', 'M-f'],
    nodes: [
      { nodeId: 'M-a', title: 'a', stage: 'build', deps: [], acceptance: { kind: 'exists' } },
      { nodeId: 'M-b', title: 'b', stage: 'build', deps: ['M-a'], acceptance: { kind: 'exists' } },
      { nodeId: 'M-c', title: 'c', stage: 'build', deps: ['M-a'], acceptance: { kind: 'exists' } },
      { nodeId: 'M-d', title: 'd', stage: 'build', deps: ['M-b', 'M-c'], acceptance: { kind: 'exists' } },
      { nodeId: 'M-e', title: 'e', stage: 'build', deps: [], acceptance: { kind: 'exists' } },
      { nodeId: 'M-f', title: 'f', stage: 'build', deps: ['M-e'], acceptance: { kind: 'exists' } },
    ],
    order: ['M-a', 'M-b', 'M-c', 'M-d', 'M-e', 'M-f'],
  },
  '孤立': {
    ids: Array.from({ length: 8 }, (_, i) => `I${i}`),
    nodes: Array.from({ length: 8 }, (_, i) => ({
      nodeId: `I${i}`,
      title: `I${i}`,
      stage: 'build',
      deps: [],
      acceptance: { kind: 'exists' },
    })),
    order: Array.from({ length: 8 }, (_, i) => `I${i}`),
  },
};

let comparisons = 0;

for (const [name, topology] of Object.entries(TOPOLOGIES)) {
  const store = new core.Store();
  const run = (fn) => core.withCoreStore(store, fn);
  run(() => core.submitWish({ text: `增量等价：${name}`, maxParallel: 16, budgetTokens: 0 }));
  run(() => core.graphCommit({ wish: `增量等价：${name}`, nodes: topology.nodes }));
  run(() => core.bootstrap(store));

  // 起点也要一致（bootstrap 走全量，两侧相同，无需比对）
  for (const nodeId of topology.order) {
    run(() => core.passGate(store, 'build', []));
    runNode(store, nodeId);

    // 同一份状态上分别跑两种算法（克隆隔离，互不影响）
    const fullStore = cloneStore(store);
    const incrStore = cloneStore(store);
    const full = core.withCoreStore(fullStore, () =>
      readyMod.recomputeReady(fullStore, { reason: 'probe', silent: true }),
    );
    const incr = core.withCoreStore(incrStore, () =>
      readyMod.recomputeReady(incrStore, { reason: 'probe', silent: true, unblockedBy: nodeId }),
    );

    assert.deepEqual(
      [...incr.promoted].sort(),
      [...full.promoted].sort(),
      `[${name}] ${nodeId} done 后 promoted 不一致：增量=${JSON.stringify(incr.promoted)} 全量=${JSON.stringify(full.promoted)}`,
    );
    assert.deepEqual(
      [...incr.demoted].sort(),
      [...full.demoted].sort(),
      `[${name}] ${nodeId} done 后 demoted 不一致：增量=${JSON.stringify(incr.demoted)} 全量=${JSON.stringify(full.demoted)}`,
    );

    // 再验证「跑完之后两边的 ready 集合也相同」—— 这是可观测结果，不只是中间量
    const fullReady = core.withCoreStore(fullStore, () => readyMod.readySet(fullStore));
    const incrReady = core.withCoreStore(incrStore, () => readyMod.readySet(incrStore));
    assert.deepEqual(
      [...incrReady].sort(),
      [...fullReady].sort(),
      `[${name}] ${nodeId} done 后 readySet 不一致`,
    );
    comparisons += 1;
  }
}

// ── 反向验证：增量模式也必须能**降级**非法 ready ────────────────────────────
// 构造一个「ready 但依赖未 done」的矛盾态，确认增量路径不会漏掉降级。
{
  const store = new core.Store();
  const run = (fn) => core.withCoreStore(store, fn);
  run(() => core.submitWish({ text: '增量降级', maxParallel: 4, budgetTokens: 0 }));
  run(() =>
    core.graphCommit({
      wish: '增量降级',
      nodes: [
        { nodeId: 'X1', title: 'X1', stage: 'build', deps: [], acceptance: { kind: 'exists' } },
        { nodeId: 'X2', title: 'X2', stage: 'build', deps: ['X1'], acceptance: { kind: 'exists' } },
      ],
    }),
  );
  run(() => core.bootstrap(store));
  // 手工把 X2（依赖未 done）标成 ready —— 矛盾态
  run(() => {
    store.state.nodes.get('X2').status = 'ready';
  });
  const demoted = run(() => readyMod.recomputeReady(store, { reason: 'probe', silent: true, unblockedBy: 'X1' }));
  assert.deepEqual(demoted.demoted, ['X2'], `增量路径必须降级非法 ready，实际：${JSON.stringify(demoted)}`);
  assert.equal(store.state.nodes.get('X2').status, 'planned');
}

console.log(
  `PASS ready incremental: promoted/demoted/readySet identical to full recompute across ${comparisons} comparisons over 5 topologies, illegal-ready demotion still works`,
);
