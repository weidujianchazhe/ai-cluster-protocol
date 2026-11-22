/**
 * 自由 capability 从工作图 → dispatch → worker 能力包的端到端测试。
 *
 * P1-2 不止是 `task_next` 过滤：旧实现还会在 `enqueuePlan` 里把未知 capability
 * 回退成 `CODE`，但又把 `capability: args.capability`（缺省 undefined）传给 worker。
 * 结果是节点要求的 `distributed-systems-analysis` 在派发时**彻底丢失**。
 *
 * 新契约：
 *   - `role` = 执行载体身份（自由 capability 默认用 CODE 载体）
 *   - `capability` = 节点所需能力包（缺省继承节点自己的 capability）
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (n) => pathToFileURL(path.join(root, 'lib', n)).href;
const { L0ControlService } = await import(lib('service.js'));

const stateDir = tempStateDir('dispatch-capability');
const ctx = {
  get: (name) => {
    if (name === 'workingDirectory') return { defaultDirectory: root };
    if (name === 'subagents') return {
      list: () => ['spawn'],
      startActivation: async () => ({ childId: 'child-1', messageId: 'msg-1' }),
    };
    return undefined;
  },
};

const svc = new L0ControlService(ctx, {
  workspaceRoot: root,
  stateDir,
  persistence: 'node',
  maxParallel: 8,
  coordinatorEnabled: false,
}, {});

const seen = [];
const native = svc.native;
const originalSpawn = native.spawnAgent.bind(native);
native.spawnAgent = async (input, caller) => {
  seen.push({ role: input.role, capability: input.capability, caller });
  return { ok: true, instanceId: 'ROLE-CODE-01', sessionId: 'session-free-capability', via: 'startActivation' };
};

try {
  const freeCapability = 'distributed-systems-analysis';
  const committed = await svc.graphCommit({
    wish: '验证能力需求与执行职务分离',
    policies: { maxParallel: 8 },
    nodes: [
      {
        nodeId: 'FREE-CAP-01',
        title: '分析分布式系统',
        capability: freeCapability,
        stage: 'research',
        deps: [],
        acceptance: { kind: 'exists' },
      },
      {
        nodeId: 'OVERRIDE-01',
        title: '复核审计数据',
        capability: 'AUDIT_CODE',
        stage: 'audit',
        deps: [],
        acceptance: { kind: 'exists' },
      },
    ],
  });
  assert.equal(committed.ok, true, JSON.stringify(committed.errors ?? committed).slice(0, 300));

  // 显式 role=CODE 覆盖两个节点的 carrier role：自由 capability 与被覆盖的已知职务都必须保留进能力包。
  const result = await svc.dispatch(
    { mode: 'interval', enqueue: true, maxPerTick: 2, role: 'CODE' },
    { id: 'lead-session' },
  );
  assert.equal(result.enqueue?.ok, true, JSON.stringify(result.enqueue).slice(0, 300));
  assert.equal(result.enqueue.enqueued.length, 2, '两个节点都应派发');
  assert.equal(seen.length, 2, '应 spawn 两个 worker');
  assert.ok(seen.every((entry) => entry.role === 'CODE'), '显式 role 应决定执行载体身份');
  const enqueuedIds = result.enqueue.enqueued.map((entry) => entry.nodeId).sort();
  assert.deepEqual(enqueuedIds, ['FREE-CAP-01', 'OVERRIDE-01'], '两个候选都应派出去');
  assert.ok(seen.every((entry) => entry.role === 'CODE'), '显式 role 应决定执行载体身份');
  const capabilities = seen.map((entry) => entry.capability);
  assert.ok(capabilities.includes(freeCapability), '自由 capability 必须原样传入能力包');
  assert.ok(capabilities.includes('AUDIT_CODE'), '被显式 role 覆盖的节点职务 capability 也不能丢');
  console.log('PASS 自由 capability 端到端保留：节点需求 → dispatch → worker 能力包');
  console.log('PASS role/capability 分离：显式 role=CODE 控制载体身份，节点能力需求仍保留');
} finally {
  native.spawnAgent = originalSpawn;
  try { svc.stopDispatch(); } catch { /* timer 尚未启动 */ }
  try { await svc.dispose(); } catch { /* 测试清理 */ }
  cleanupTempStateDirs();
}
