/**
 * 端到端：**从 lib 起服务 → 起侧车 → 真发 HTTP**，确认面板拿到的 JSON 里真的有
 * `dispatch` 与 `recovery`。
 *
 * 为什么不能只测 service：`dispatchView()` 单测通过、`getSnapshot` 参数透传也通过，
 * 但两者之间的接线（`index.ts` 的 pool.get(...).uiSnapshot(...) → ui-server → 前端）
 * 仍可能断。断了的症状是「面板上那一页永远空白」，而所有单测都是绿的。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const { L0ControlService } = await import(pathToFileURL(path.join(root, 'lib', 'service.js')).href);
const { startUiServer } = await import(pathToFileURL(path.join(root, 'lib', 'ui-server.js')).href);

const ctx = {
  get: (name) => {
    if (name === 'workingDirectory') return { defaultDirectory: root };
    if (name === 'subagents') return { list: () => ['spawn'], startActivation: async () => ({ childId: 'c', messageId: 'm' }) };
    return undefined;
  },
};

const service = new L0ControlService(ctx, { workspaceRoot: root, stateDir: tempStateDir('http'), maxParallel: 4 }, {});

// 跟 index.ts 的接线保持一致：把第 4 个参数（withRecovery）真的传进 uiSnapshot
const handle = await startUiServer({
  host: '127.0.0.1',
  port: 0,
  allowedOrigins: [],
  getSnapshot: (sessionId, workspaceRoot, sinceSeq, withRecovery) =>
    service.uiSnapshot({ sessionId, sinceSeq, withRecovery: withRecovery === true }),
});

const headers = { Origin: 'http://127.0.0.1:10504' };

try {
  await service.graphCommit({
    wish: 'HTTP 端到端',
    nodes: [
      { nodeId: 'H1', title: 'h1', capability: 'CODE', acceptance: { kind: 'exists' } },
      { nodeId: 'H2', title: 'h2', capability: 'CODE', acceptance: { kind: 'exists' } },
    ],
  });
  service.appendJournal('node_enqueued', { nodeId: 'H1', instanceId: 'role-code-01', sessionId: 's-h1' });
  service.appendJournal('task_claimed', { nodeId: 'H1', instanceId: 'role-code-01' });
  service.appendJournal('node_enqueued', { nodeId: 'H2', instanceId: 'role-code-02', sessionId: 's-h2' });
  service.appendJournal('task_claim_rejected', { nodeId: 'H2', reason: 'lease_held' });
  // H3：确定性组装失败 —— 面板必须能看到「这个节点已停止派发」。
  // 与 H2 的释放记录语义相反（H2 可以重派，H3 不该再派），所以两者不能混成一栏。
  service.appendJournal('node_enqueue_failed', {
    nodeId: 'H3', error: 'spawn-failed', retryable: false, failureCode: 'assembly-failed', role: 'CODE',
  });

  // ── 1. 默认快照：有 dispatch，没有 recovery（按需）────────────────────────
  const plain = await (await fetch(`${handle.url}/ui/snapshot`, { headers })).json();
  assert.equal(plain.ok, true);
  assert.ok(plain.dispatch, '快照必须带 dispatch 字段（否则面板那一页永远空）');
  assert.equal(plain.dispatch.ok, true, JSON.stringify(plain.dispatch).slice(0, 200));
  assert.equal(plain.recovery, null, '默认不应带 recovery（按需拉）');
  console.log('PASS 1. HTTP 快照带 dispatch、不带 recovery');

  // ── 2. dispatch 内容能在 HTTP 上正确还原 ─────────────────────────────────
  assert.equal(plain.dispatch.active.count, 1, `active 应=1（H1 活着，H2 已释放），实际 ${plain.dispatch.active.count}`);
  assert.equal(plain.dispatch.active.claimed, 1, 'H1 已 claim');
  assert.equal(plain.dispatch.released.count, 1, 'H2 应为已释放');
  assert.equal(plain.dispatch.released.rows[0]?.nodeId, 'H2');
  assert.equal(plain.dispatch.released.rows[0]?.reason, 'claim-rejected');
  assert.ok(String(plain.dispatch.released.rows[0]?.explain).includes('准入拒绝'));
  // 确定性失败必须单列在 failed，不能混进 released（两者语义相反）
  assert.equal(plain.dispatch.failed?.count, 1, `failed 应=1，实际 ${JSON.stringify(plain.dispatch.failed)}`);
  assert.equal(plain.dispatch.failed.rows[0]?.nodeId, 'H3');
  assert.equal(plain.dispatch.failed.rows[0]?.code, 'assembly-failed');
  assert.ok(String(plain.dispatch.failed.rows[0]?.explain).includes('确定性派发失败'));
  assert.equal(
    plain.dispatch.released.rows.some((row) => row.nodeId === 'H3'),
    false,
    '确定性失败不得出现在 released（那是「可以重派」）',
  );
  // 积压面必须经 HTTP 送达面板：不报出来，配置项是否生效只能靠翻 journal 数。
  assert.ok(plain.dispatch.queue, '快照必须带 dispatch.queue（否则面板看不到排队额度）');
  assert.equal(
    plain.dispatch.queue.queued,
    plain.dispatch.active.unclaimed,
    `queue.queued 与 active.unclaimed 必须是同一个数，实际 ${plain.dispatch.queue.queued} vs ${plain.dispatch.active.unclaimed}`,
  );
  assert.equal(typeof plain.dispatch.queue.saturated, 'boolean');
  assert.ok('maxQueued' in plain.dispatch.queue);
  // 闸门面同理：面板要回答「为什么这一轮没派」，答案必须经 HTTP 送到。
  assert.ok('lastTick' in plain.dispatch, '快照必须带 dispatch.lastTick（否则面板看不到被谁挡）');
  // 跨轮累积也要送到：它回答「这段时间主要卡在哪」，是 lastTick 回答不了的。
  assert.ok('gateHistory' in plain.dispatch, '快照必须带 dispatch.gateHistory（跨轮累积）');
  console.log('PASS 2. HTTP 上 active/claimed/released/failed/queue/lastTick/gateHistory 与 journal 一致，且语义不混');

  // ── 3. withRecovery=1 时有恢复面 ─────────────────────────────────────────
  const withRec = await (await fetch(`${handle.url}/ui/snapshot?withRecovery=1`, { headers })).json();
  assert.equal(withRec.ok, true);
  assert.notEqual(withRec.recovery, null, 'withRecovery=1 必须带恢复面');
  assert.equal(typeof withRec.recovery.baseSeq, 'number');
  assert.ok(Array.isArray(withRec.recovery.resume));
  assert.equal(withRec.recovery.driftDetected, false);
  console.log('PASS 3. withRecovery=1 → 恢复面经 HTTP 正确返回');

  // ── 4. JSON 可序列化（没有 Map/undefined 混进来）─────────────────────────
  const raw = JSON.stringify(withRec);
  assert.ok(!raw.includes('"[object'), 'JSON 里出现了无法序列化的值');
  assert.ok(raw.length < 2_000_000, `快照过大（${raw.length} 字节），千级下会把面板拖死`);
  console.log(`PASS 4. 快照可序列化且体积可控（${(raw.length / 1024).toFixed(0)} KB）`);

  console.log('\nPASS ui e2e: lib → 侧车 → HTTP 全链打通，dispatch/recovery 都能被面板读到');
} finally {
  await handle.close();
  service.stopDispatch();
}
