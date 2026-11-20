/**
 * 准入层闸门归因：**计划层说「被 capacity 挡」，claim 能不能说同一句话**。
 *
 * 第 19 轮把派活计划层的拒绝原因做成可归因（`gate` 字段 + `gates` 汇总）。但
 * `task_claim` 是另一条路径，之前它只回裸错误码：
 *
 *   `graph_capacity` / `partition_capacity` / `rate_limited` / `budget_exceeded`
 *
 * 四个码在**顶层长得一模一样**——`withCore` 的 catch 一律压成
 * `error: 'core-failed'`，真码只剩在 `detail.code` 里。而 worker 契约判的是顶层
 * `error`，于是四条语义完全不同的处置路径被塌成一条：
 *
 * | 实际原因 | 该做什么 | 旧行为 |
 * |---|---|---|
 * | 全图触顶 | 等 worker 完成 | 未知码 → 保守退避 |
 * | 分区满员 | **换域外节点** | 未知码 → 保守退避（干等全图额度，永远等不到） |
 * | 速率超限 | 退避到下一窗口 | 未知码 → 保守退避 |
 * | 预算耗尽 | **人工介入**（重试无用） | 未知码 → 保守退避（一直撞） |
 *
 * 更糟的是「分区满员」这一支：worker 退避等全图额度，而全图额度根本没满——
 * 它会一直等到超时，期间那个域一直是空的。这不是保守，是停摆。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (name) => pathToFileURL(path.join(root, 'lib', name)).href;
const core = await import(lib('core/index.js'));
const { L0ControlService } = await import(lib('service.js'));
const { decideAfterClaimFailure } = await import(
  pathToFileURL(path.join(root, 'tests', 'e2e', 'autonomy', 'src', 'worker-loop.mjs')).href
);

const NODES = ['A1', 'A2', 'A3', 'A4'];

function freshStore(extra = {}) {
  const store = new core.Store();
  core.withCoreStore(store, () => {
    assert.equal(core.graphCommit({
      nodes: NODES.map((nodeId) => ({
        nodeId, title: nodeId, stage: 'build', status: 'planned', deps: [], acceptance: { kind: 'exists' },
      })),
      policies: { maxParallel: 100 },
      ...extra,
    }).ok, true);
  });
  return store;
}

const caught = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
};

// ── 1. ★ 四类限流拒绝各自带 gate，且与计划层同一套词汇 ────────────────────
{
  // 容量：全图租约触顶
  {
    const store = freshStore();
    core.claim(store, 'A1', 'o1');
    store.state.meta.set('graph_max_parallel', '1');
    const error = caught(() => core.claim(store, 'A2', 'o2'));
    assert.ok(error, '应被全图容量拒绝');
    assert.equal(error.code, 'graph_capacity');
    assert.equal(error.gate, 'capacity', `gate 应为 capacity，实际 ${error.gate}`);
  }
  // 分区：局部满员
  {
    const store = freshStore({
      coordination: { enabled: true, maxActive: 100, partitions: [{ id: 'p1', nodeRefs: ['A1', 'A2'], maxActive: 1 }] },
    });
    core.claim(store, 'A1', 'o1');
    const error = caught(() => core.claim(store, 'A2', 'o2'));
    assert.ok(error, '应被分区容量拒绝');
    assert.equal(error.code, 'partition_capacity');
    assert.equal(error.gate, 'partition', `gate 应为 partition，实际 ${error.gate}`);
  }
  // 速率
  {
    const store = freshStore();
    core.claim(store, 'A1', 'o1', { ratePerSecond: 1 });
    const error = caught(() => core.claim(store, 'A2', 'o2', { ratePerSecond: 1 }));
    assert.ok(error, '应被速率拒绝');
    assert.equal(error.code, 'rate_limited');
    assert.equal(error.gate, 'rate', `gate 应为 rate，实际 ${error.gate}`);
  }
  // 预算
  {
    const store = freshStore({ policies: { maxParallel: 100, budgetTokens: 10 } });
    store.journal.append('evidence_added', 'A1', { usageTokens: 10 });
    const error = caught(() => core.claim(store, 'A2', 'o2'));
    assert.ok(error, '应被预算拒绝');
    assert.equal(error.code, 'budget_exceeded');
    assert.equal(error.gate, 'budget', `gate 应为 budget，实际 ${error.gate}`);
  }
  console.log('PASS 1. 容量/分区/速率/预算四类拒绝各带 gate，与计划层同一套词汇');
}

// ── 2. ★ 分区满员先于全图判定：局部原因不能被全局原因掩盖 ──────────────────
// 两者同时成立时（全图也满、域也满），先报分区——因为分区是**更具体**的原因，
// 换域就能立刻恢复，而「等全图」什么也等不到。
{
  const store = freshStore({
    coordination: { enabled: true, maxActive: 1, partitions: [{ id: 'p1', nodeRefs: ['A1', 'A2'], maxActive: 1 }] },
  });
  core.claim(store, 'A1', 'o1');
  const error = caught(() => core.claim(store, 'A2', 'o2'));
  assert.ok(error);
  assert.equal(error.gate, 'partition', `全图与分区同时满时应报更具体的 partition，实际 ${error.gate}（${error.code}）`);
  console.log('PASS 2. 全图与分区同时触顶时报 partition（更具体、换域即恢复）');
}

// ── 3. ★ 顶层 error 不再是 core-failed：真码必须上浮 ──────────────────────
// 这是最要命的一条。worker 契约判 `result.error`，而它以前恒为 `core-failed`
// ——等于把所有准入拒绝都报成「core 挂了」。
{
  const mkCtx = () => ({
    get: (name) => {
      if (name === 'workingDirectory') return { defaultDirectory: root };
      if (name === 'subagents') return { list: () => ['spawn'], startActivation: async () => ({ childId: 'c', messageId: 'm' }) };
      return undefined;
    },
  });
  const svc = new L0ControlService(mkCtx(), {
    workspaceRoot: root, stateDir: tempStateDir('admission'), persistence: 'node', maxParallel: 1,
  }, {});
  try {
    await svc.graphCommit({
      nodes: NODES.map((nodeId) => ({ nodeId, title: nodeId, capability: 'CODE', acceptance: { kind: 'exists' } })),
      policies: { maxParallel: 1 },
    });
    const first = await svc.taskClaim({ nodeId: 'A1', instanceId: 'role-code-01' }, { id: 'lead' });
    assert.equal(first.ok, true, `前置条件失败：首个 claim 没成功（${first.error}）`);

    const rejected = await svc.taskClaim({ nodeId: 'A2', instanceId: 'role-code-02' }, { id: 'lead' });
    assert.equal(rejected.ok, false);
    assert.notEqual(rejected.error, 'core-failed', `顶层 error 不得是 core-failed，实际 ${rejected.error}`);
    assert.equal(rejected.error, 'graph_capacity', `顶层 error 应是真码，实际 ${rejected.error}`);
    assert.equal(rejected.gate, 'capacity', `顶层应带 gate，实际 ${rejected.gate}`);
    assert.equal(rejected.detail?.code, 'graph_capacity', 'detail 仍保留完整错误信息');

    // journal 也要留得下归因：事后查「那天为什么 claim 不上」，只有码是不够的。
    const row = svc.readJournal().filter((r) => r.kind === 'task_claim_rejected').at(-1);
    assert.equal(row.error, 'graph_capacity', `journal 应记真码，实际 ${row.error}`);
    assert.equal(row.gate, 'capacity', `journal 应记 gateway，实际 ${row.gate}`);
    console.log('PASS 3. 顶层 error / gate 与 journal 都记真码（不再是 core-failed）');
  } finally {
    svc.stopDispatch();
  }
}

// ── 4. ★ worker 契约按 gate 分派处置：四条路径互不塌陷 ────────────────────
// 上游只传 code（gate 丢失）时也要能分对——否则闸门码落进「未知码」保守退避，
// 而预算耗尽与分区满员都是**退避无用**的。
{
  const cases = [
    ['graph_capacity', 'capacity', 'backoff'],
    ['partition_capacity', 'partition', 'switch-node'],
    ['rate_limited', 'rate', 'backoff'],
    ['budget_exceeded', 'budget', 'escalate'],
  ];
  for (const [code, gate, expectedAction] of cases) {
    const withGate = decideAfterClaimFailure(code, gate);
    assert.equal(withGate.action, expectedAction, `${code}+${gate} 应判 ${expectedAction}，实际 ${withGate.action}`);
    // 丢了 gate 也必须能从这个码本身分对：不能让「分区满员」退化成「等全图」。
    const codeOnly = decideAfterClaimFailure(code);
    assert.equal(codeOnly.action, expectedAction, `${code}（无 gate）也应判 ${expectedAction}，实际 ${codeOnly.action}`);
    assert.notEqual(codeOnly.reason.includes('未知失败码'), true, `${code} 不该落进未知码分支`);
  }
  // 分区满员必须换节点，不能保守退避——那会一直等到超时，而那个域一直是空的。
  assert.equal(decideAfterClaimFailure('partition_capacity').action, 'switch-node');
  assert.equal(decideAfterClaimFailure('budget_exceeded').action, 'escalate');
  console.log('PASS 4. worker 按 gate 分派处置，丢失 gate 时也能从码本身分对');
}

// ── 5. ★ 预算边界：额度「正好用尽」两层同判 ──────────────────────────────
// 计划层 `budgetBlockedNodes` 用 `>=`（用尽即不派），准入原来用 `>`，于是
// 「used === limit」的节点计划说别派、claim 却放行。而 claim 是直连路径——
// 不经派活的调用方照样拿到租约，等到提交时才发现没额度。
{
  const store = freshStore({ policies: { maxParallel: 100, budgetTokens: 10 } });
  store.journal.append('evidence_added', 'A1', { usageTokens: 10 });

  // 计划层：A1..A4 全部阻塞（全图预算用尽）
  const blocked = core.budgetBlockedNodes(store);
  assert.ok(blocked.size > 0, '计划层应判出预算阻塞节点');

  // 准入层：必须同样拒绝，不能放行
  const error = caught(() => core.claim(store, 'A2', 'o1'));
  assert.ok(error, '额度正好用尽时 claim 必须拒绝（与计划层一致）');
  assert.equal(error.gate, 'budget');

  // 提交层（extra > 0）：正常收尾不能误伤——这是 claim 与 submit 的正当区别。
  // 用一张只剩 5 额度的图验证：声明 5 应放行（正好用完），声明 6 应拒。
  const store2 = freshStore({ policies: { maxParallel: 100, budgetTokens: 10 } });
  store2.journal.append('evidence_added', 'A1', { usageTokens: 5 });
  assert.equal(caught(() => core.assertBudget(store2, 'A2', 5)), null, '声明 5 正好用完额度，应放行');
  const over = caught(() => core.assertBudget(store2, 'A2', 6));
  assert.ok(over, '声明 6 超出剩余 5，应拒绝');
  assert.equal(over.gate, 'budget');
  console.log('PASS 5. 额度正好用尽时 claim 与计划层同判拒绝；提交满额收尾不误伤');
}

// ── 6. 非限流拒绝不带 gate，不被误归因 ──────────────────────────────────
// 租约被占、状态不对、节点不存在——这些不是「闸门」，调任何参数都没用。
{
  const store = freshStore();
  core.claim(store, 'A1', 'o1');
  const held = caught(() => core.claim(store, 'A1', 'o2'));
  assert.ok(held);
  assert.equal(held.code, 'lease_held');
  assert.equal(held.gate, undefined, `lease_held 不该带 gate，实际 ${held.gate}`);

  const missing = caught(() => core.claim(store, 'NOPE', 'o1'));
  assert.ok(missing);
  assert.equal(missing.gate, undefined, '节点不存在不该带 gate');
  console.log('PASS 6. 非限流拒绝（租约被占/节点不存在）不带 gate，不被误归因成闸门');
}

// ── 7. ★ 预算拒绝要进 failed（别再派），不能只进 released（可以重派）────────
// `task_claim_rejected` 一律 release 的语义是「worker 停手了，可以重派」。对容量/
// 分区/速率三种**瞬时**原因正确；对预算耗尽则是错的：条件不会自己变好，放回可派
// = 下一轮再派一个 → 再被拒 → 再放回，无限空转，每轮白烧一次 spawn。
// 与第 17 轮修的 `assembly-failed` 是同一类错：把「重试会好」与「重试无用」混在一起。
{
  const { deriveEnqueueState, applyEnqueueRows, explainRelease, explainFailure } = await import(
    lib('dispatch/enqueue-state.js')
  );
  const rows = [
    { kind: 'node_enqueued', nodeId: 'N1', sessionId: 's1', at: '2026-01-01T00:00:00.000Z' },
    { kind: 'task_claim_rejected', nodeId: 'N1', error: 'budget_exceeded', gate: 'budget', at: '2026-01-01T00:00:01.000Z' },
    { kind: 'node_enqueued', nodeId: 'N2', sessionId: 's2', at: '2026-01-01T00:00:00.000Z' },
    { kind: 'task_claim_rejected', nodeId: 'N2', error: 'graph_capacity', gate: 'capacity', at: '2026-01-01T00:00:01.000Z' },
  ];
  const state = deriveEnqueueState(rows);

  // 预算：进 failed（别再派），也进 released（worker 确实停手了）
  assert.ok(state.failed.has('N1'), '预算耗尽必须进 failed（否则每轮白烧 spawn）');
  assert.equal(state.failed.get('N1').code, 'budget-exhausted');
  assert.equal(state.released.get('N1')?.gate, 'budget', 'released 也要带 gate，面板才解释得清');
  assert.equal(state.live.has('N1'), false, 'worker 已停手，不能还当成活着');

  // 容量：只进 released，不进 failed —— 它是瞬时原因，重试就会好
  assert.equal(state.failed.has('N2'), false, '容量触顶是瞬时原因，不得进 failed（否则节点被永久判死）');
  assert.equal(state.released.get('N2')?.gate, 'capacity');

  // 说明文案必须能区分「再等等」与「永远好不了」
  assert.match(explainRelease(state.released.get('N1')), /重试无用/, '预算耗尽必须明说重试无用');
  assert.match(explainRelease(state.released.get('N2')), /等 worker 完成|租约释放/, '容量触顶要给「等」的建议');
  assert.match(explainFailure(state.failed.get('N1')), /预算/);

  // 解除路径：成功派一次就清掉 failed（人加完预算后手动派一次）
  applyEnqueueRows(state, [{ kind: 'node_enqueued', nodeId: 'N1', sessionId: 's3', at: '2026-01-01T00:00:05.000Z' }]);
  assert.equal(state.failed.has('N1'), false, '重新派活成功应解除预算失败登记');
  console.log('PASS 7. 预算拒绝进 failed（别再派）+ released 带 gate；容量只进 released；重新派活解除');
}

console.log('\nPASS admission gates: 四类拒绝各带 gate / 分区先于全图 / 顶层不再 core-failed / worker 四路分派 / 预算边界同判 / 非限流不误归因 / 预算拒绝不空转');
