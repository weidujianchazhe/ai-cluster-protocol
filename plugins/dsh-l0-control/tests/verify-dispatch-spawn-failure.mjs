/**
 * 派发失败的处置：**宿主满了要重试，组装失败要停手**。
 *
 * 场景来自千级运行时的真实两难：
 *   - 宿主并发上限是**临时**的。今天把「宿主满了」判成永久失败，等于宿主一繁忙
 *     就把整张图的就绪节点全判死，等它闲下来也没人再派——图停在原地。
 *   - 组装失败（preset 不存在 / prompt 超长 / role 非法）是**确定性**的。
 *     每轮都重试它，等于每轮白烧一次 spawn，还把 journal 刷满同样的错误，
 *     真正的故障信号被自己淹没。
 *
 * 旧实现把两者都塞进 `spawn-failed`，没有 `retryable` 概念，于是只能选一种行为，
 * 而两种都是错的。本测试走真实 service 路径，只把 `startActivation` 换成可控桩。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const { L0ControlService } = await import(pathToFileURL(path.join(root, 'lib', 'service.js')).href);

/** 每个节点下一次 spawn 要抛什么错；抛 null 表示成功。 */
const scripted = new Map();
const attempts = new Map();
const makeCtx = () => ({
  get: (name) => {
    if (name === 'workingDirectory') return { defaultDirectory: root };
    if (name === 'subagents') {
      return {
        list: () => ['spawn'],
        startActivation: async (request) => {
          const text = String(request?.request?.prompt?.[0]?.text ?? '');
          const nodeId = (text.match(/\b(F\d+)\b/) ?? [])[1] ?? 'unknown';
          attempts.set(nodeId, (attempts.get(nodeId) ?? 0) + 1);
          const thrown = scripted.get(nodeId);
          if (thrown) throw thrown;
          return { childId: `child-${nodeId}-${attempts.get(nodeId)}`, messageId: `msg-${nodeId}` };
        },
      };
    }
    return undefined;
  },
});

const stateDir = tempStateDir('spawn-fail');
const CONFIG = { workspaceRoot: root, stateDir, persistence: 'node', dispatchRatePerSecond: 100 };

const svc = new L0ControlService(makeCtx(), CONFIG, {});
try {
  const committed = await svc.graphCommit({
    wish: 'spawn 失败分类',
    nodes: [
      { nodeId: 'F1', title: '组装会失败', capability: 'CODE', acceptance: { kind: 'exists' } },
      { nodeId: 'F2', title: '宿主会满', capability: 'CODE', acceptance: { kind: 'exists' } },
      { nodeId: 'F3', title: '正常节点', capability: 'CODE', acceptance: { kind: 'exists' } },
    ],
    policies: { maxParallel: 8 },
  });
  assert.equal(committed.ok, true, JSON.stringify(committed.errors ?? []));

  // F1：确定性组装失败（preset 不存在）——重试一万次也不会变好
  scripted.set('F1', new Error('agent preset "no-such-preset" not found'));
  // F2：宿主并发上限——过一会儿就能派
  scripted.set('F2', Object.assign(new Error('max concurrent activations reached (limit 8)'), { code: 'EDSH_LIMIT' }));

  // ── 1. 第一轮：三个都尝试派，两类失败被区分开 ─────────────────────────────
  const first = await svc.dispatch({ mode: 'interval', enqueue: true, maxPerTick: 8 }, { id: 'lead' });
  const failedById = new Map((first.enqueue.failed ?? []).map((row) => [row.nodeId, row]));
  assert.equal(failedById.get('F1')?.retryable, false, 'F1 组装失败必须标 retryable=false');
  assert.equal(failedById.get('F1')?.failureCode, 'assembly-failed');
  assert.equal(failedById.get('F2')?.retryable, true, 'F2 宿主满载必须标 retryable=true');
  assert.equal(failedById.get('F2')?.failureCode, 'host-capacity');
  assert.deepEqual(first.enqueue.enqueued.map((row) => row.nodeId), ['F3'], '只有正常节点被派出去');
  console.log('PASS 1. 第一轮：组装失败 retryable=false / 宿主满载 retryable=true / 正常节点派出');

  // ── 2. 失败性质必须落进 journal（否则折叠层看不出区别）──────────────────
  const rows = svc.readJournal().filter((row) => row.kind === 'node_enqueue_failed');
  const dot = (nodeId) => rows.find((row) => row.nodeId === nodeId);
  assert.equal(dot('F1')?.retryable, false, 'journal 里 F1 必须记 retryable=false');
  assert.equal(dot('F1')?.failureCode, 'assembly-failed');
  assert.equal(dot('F2')?.retryable, true, 'journal 里 F2 必须记 retryable=true');
  assert.equal(dot('F2')?.failureCode, 'host-capacity');
  console.log('PASS 2. 失败性质落进 journal（retryable / failureCode 都有）');

  // ── 3. ★ 第二轮：F1 被跳过（不再 spawn），F2 仍然重试 ────────────────────
  const f1Before = attempts.get('F1');
  const f2Before = attempts.get('F2');
  const second = await svc.dispatch({ mode: 'interval', enqueue: true, maxPerTick: 8 }, { id: 'lead' });
  const skipped = (second.enqueue.skipped ?? []).find((row) => row.nodeId === 'F1');
  assert.ok(skipped, `F1 应出现在 skipped 里，实际 ${JSON.stringify(second.enqueue.skipped)}`);
  assert.equal(skipped.error, 'spawn-permanently-failed');
  assert.match(skipped.explain, /确定性派发失败/);
  assert.equal(attempts.get('F1'), f1Before, 'F1 不得再 spawn（旧实现每轮白烧一次）');
  assert.equal(attempts.get('F2'), f2Before + 1, 'F2 是宿主满载，必须重试');
  console.log('PASS 3. 第二轮：F1 停止派发（不再 spawn）/ F2 仍重试（旧实现两者一视同仁）');

  // ── 4. dispatchView 把「确定性失败」单列，不与 released 混淆 ──────────────
  const view = svc.dispatchView();
  assert.equal(view.failed?.count, 1, `视图应报 1 个确定性失败，实际 ${JSON.stringify(view.failed)}`);
  assert.equal(view.failed.rows[0].nodeId, 'F1');
  assert.equal(view.failed.rows[0].code, 'assembly-failed');
  assert.match(view.failed.rows[0].explain, /改配置或改任务/);
  assert.equal(view.released.rows.some((row) => row.nodeId === 'F1'), false, '确定性失败不该出现在 released 里（那是「可以重派」）');
  console.log('PASS 4. dispatchView.failed 单列，不与 released（可重派）混淆');

  // ── 5. ★ 唯一解除路径：修好配置后手动派一次，登记自动失效 ────────────────
  scripted.delete('F1'); // 等价于「人把 preset 建好了」
  // 直接派这一节点（不经计划，模拟人工干预）
  const manual = await svc.spawnAgent({ role: 'CODE', task: 'F1 · 手动重派' }, { id: 'lead' });
  assert.equal(manual.ok, true, `手动派应成功：${JSON.stringify(manual).slice(0, 200)}`);
  // 手动派走的是 agent_spawn 工具，不写 node_enqueued；所以这里补一条等价事件，
  // 证明「成功派发清掉失败登记」这条折叠规则在真实路径上成立。
  svc.appendJournal('node_enqueued', { nodeId: 'F1', role: 'CODE', instanceId: manual.instanceId, sessionId: manual.sessionId, caller: 'lead' });
  const afterFix = await svc.dispatch({ mode: 'interval', enqueue: true, maxPerTick: 8 }, { id: 'lead' });
  assert.equal(svc.dispatchView().failed?.count, 0, '成功派发后失败登记必须清空');
  assert.equal((afterFix.enqueue.skipped ?? []).some((row) => row.nodeId === 'F1'), false, 'F1 不再被跳过');
  console.log('PASS 5. 成功派发清掉失败登记（改配置后手动派一次即解除）');

  // ── 6. 跨重启仍然记得「确定性失败别再派」────────────────────────────────
  // 这条是 `failed` 放在 journal 而非进程内 Set 的意义。
  // 用一个**新**节点造失败：F1 上一轮已被成功派出（live 登记会挡住它，
  // 于是它根本不会进入 spawn 路径，也就造不出新的失败登记）。
  scripted.set('F4', new Error('agent preset "no-such-preset" not found'));
  const committed4 = await svc.graphCommit({
    nodes: [{ nodeId: 'F4', title: '重启前再坏一次', capability: 'CODE', acceptance: { kind: 'exists' } }],
  });
  assert.equal(committed4.ok, true, JSON.stringify(committed4.errors ?? []));
  await svc.dispatch({ mode: 'interval', enqueue: true, maxPerTick: 8 }, { id: 'lead' });
  const beforeRestart = svc.dispatchView().failed?.count ?? 0;
  assert.ok(beforeRestart >= 1, `重启前应有一次确定性失败登记，实际 ${beforeRestart}`);
  svc.stopDispatch();
  await svc.dispose();

  const restarted = new L0ControlService(makeCtx(), CONFIG, {});
  try {
    const view2 = restarted.dispatchView();
    const failedIds = (view2.failed?.rows ?? []).map((row) => row.nodeId);
    assert.ok(failedIds.includes('F4'), `重启后仍应记得 F4 是确定性失败，实际 ${JSON.stringify(failedIds)}`);
    console.log('PASS 6. 跨重启仍记得「确定性失败别再派」（登记在 journal，不是进程内）');
  } finally {
    restarted.stopDispatch();
  }

  console.log('\nPASS spawn failure dispatch: 宿主满载重试 / 组装失败停手 / 成功派发解除 / 跨重启有效');
} finally {
  svc.stopDispatch();
}
