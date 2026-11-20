import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const { withCoreStore, foldEvents, Store, graphCommit, claim } = await import(pathToFileURL(path.join(root, 'lib', 'core', 'index.js')).href);
const { L0ControlService } = await import(pathToFileURL(path.join(root, 'lib', 'service.js')).href);

const stateDir = tempStateDir('ckpt');
const ctx = { get: (n) => n === 'workingDirectory' ? { defaultDirectory: root } : undefined };
const svc = new L0ControlService(ctx, { workspaceRoot: root, stateDir }, {});

try {
  // 1. 建图 + 分区
  const spec = {
    wish: 'checkpoint 验收',
    coordination: {
      enabled: true,
      maxActive: 10,
      partitions: [
        { id: 'root', nodeRefs: [], maxActive: 5 },
        { id: 'left', parentId: 'root', nodeRefs: ['N1', 'N2'], maxActive: 2 },
        { id: 'right', parentId: 'root', nodeRefs: ['N3'], maxActive: 1 },
      ],
    },
    nodes: [
      { nodeId: 'N1', title: '左 1', capability: 'CODE', acceptance: { kind: 'exists' } },
      { nodeId: 'N2', title: '左 2', capability: 'CODE', acceptance: { kind: 'exists' } },
      { nodeId: 'N3', title: '右 1', capability: 'CODE', acceptance: { kind: 'exists' } },
    ],
  };
  const committed = await svc.graphCommit(spec);
  assert.equal(committed.ok, true, JSON.stringify(committed.errors ?? []));

  // 2. 落检查点（left 分区）
  const ckpt1 = await svc.graphCheckpoint({ partitionId: 'left' });
  assert.equal(ckpt1.ok, true, JSON.stringify(ckpt1.error));
  assert.equal(ckpt1.checkpoint.partitionId, 'left');
  assert.equal(ckpt1.checkpoint.nodeRefs.length, 2);
  assert.deepEqual(ckpt1.checkpoint.nodeStates.map((n) => n.nodeId).sort(), ['N1', 'N2']);

  // 3. 恢复报告：baseSeq 之后无事件 → replayed=0
  const rec1 = await svc.graphRecover({ partitionId: 'left' });
  assert.equal(rec1.ok, true);
  assert.equal(rec1.checkpoint.partitionId, 'left');
  assert.equal(rec1.replayed, 0);

  // 4. 模拟后续事件：claim N1
  const claimed = await svc.taskClaim({ nodeId: 'N1', instanceId: 'ROLE-CODE-01' });
  assert.equal(claimed.ok, true);

  // 5. 恢复报告：baseSeq 不变，且检查点之后确实多出待重放事件
  //    （一次 claim 会写 lease_claimed + status_changed 等多条，故只断言「变多了」）
  const rec2 = await svc.graphRecover({ partitionId: 'left' });
  assert.equal(rec2.ok, true);
  assert.equal(rec2.baseSeq, rec1.baseSeq);
  assert.ok(rec2.replayed > rec1.replayed, `replayed 应增长：${rec1.replayed} -> ${rec2.replayed}`);

  // 6. 重放验证（独立 store）：图 + claim 后把 core journal 折进全新 Store，
  //    节点状态与租约必须复原——这是「按检查点恢复后重放」真正要保证的事。
  const graphStore = new Store();
  withCoreStore(graphStore, () => {
    graphCommit({ nodes: [
      { nodeId: 'R1', title: 'R1', acceptance: { kind: 'exists' } },
      { nodeId: 'R2', title: 'R2', acceptance: { kind: 'exists' } },
    ] });
    claim(graphStore, 'R1', 'ROLE-CODE-01');
  });
  const folded = foldEvents(graphStore.journal.raw());
  assert.equal(folded.nodes.size, 2, '重放后节点数应为 2');
  assert.equal(folded.nodes.get('R1').status, 'claimed', '重放后 R1 应为 claimed');
  assert.equal(folded.leases.get('R1').owner, 'ROLE-CODE-01', '重放后 R1 租约 owner 应保持');

  console.log('PASS checkpoint/recover: partition checkpoint, baseSeq, replay growth, fold consistency');
} finally {
  svc.stopDispatch();
}
