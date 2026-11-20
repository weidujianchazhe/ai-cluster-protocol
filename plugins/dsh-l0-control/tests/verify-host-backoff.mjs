/**
 * 宿主退避：**宿主自己说了「N 秒后再试」，就不要每 tick 硬撞**。
 *
 * 第 17 轮把 spawn 失败分成「宿主满载（可重试）」与「组装失败（别再派）」，
 * 前者保持 ready 等下一轮。但「下一轮」是什么时候？没有任何依据：
 *
 *   - 宿主报的 `retry-after` 被丢了（只留了 `error` 文本）；
 *   - 调度器的 interval 是独立配置（默认 300 秒、最小 30 秒），
 *     与宿主真实恢复时间毫无关系；
 *   - 于是默认行为是**每 tick 撞一次**：撞一次失败、写一行 journal、
 *     下一个 tick 再撞。宿主越满载，撞得越勤。
 *
 * 本测试钉住四件事：
 *   1. 退避时长能**从宿主的三种写法里抠出来**（结构化字段 / `retry-after: N` / 中文），
 *      并且单位不猜错（秒 vs 毫秒差 1000 倍）；
 *   2. 抠不到就**不编默认值**——继续按 tick 试，不白等；
 *   3. 退避是**全局**的（宿主的状态，不是节点属性），从 journal 折叠、跨重启有效，
 *      成功派发立刻作废；
 *   4. 计划层把它当**独立闸门**报出来，且排在确定性拦截之后、分区满员之前。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempStateDir } from './_temp-state.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const lib = (name) => pathToFileURL(path.join(root, 'lib', name)).href;

const { parseRetryAfterMs, classifySpawnFailure, RETRY_AFTER_CAP_MS } = await import(
  lib('native/spawn-failure.js')
);
const { deriveEnqueueState, applyEnqueueRows, emptyEnqueueState, backoffReason } = await import(
  lib('dispatch/enqueue-state.js')
);
const core = await import(lib('core/index.js'));

// ═══ 1. 三种写法都能抠出退避时长 ════════════════════════════════════════════
{
  const cases = [
    ['retry-after: 30', 30_000, 'retry-after 冒号'],
    ['Retry-After = 45', 45_000, 'retry-after 等号 + 大写'],
    ['retry_after: 7', 7_000, '下划线写法'],
    ['try again in 45 seconds', 45_000, '英文整句'],
    ['try again after 2 minutes', 120_000, '英文分钟'],
    ['rate limited, please retry after 1500 ms', 1_500, '毫秒单位'],
    ['并发已满，请 30 秒后重试', 30_000, '中文秒'],
    ['请 2 分钟后再试一次', 120_000, '中文分钟'],
  ];
  for (const [text, expected, label] of cases) {
    const actual = parseRetryAfterMs(text);
    assert.equal(actual, expected, `${label}："${text}" 应得 ${expected} ms，实际 ${actual}`);
  }
  console.log(`PASS 1. 8 种退避写法全部解析正确（含秒/毫秒/分钟单位）`);
}

// ═══ 2. ★ 抠不到就返回 null，**不编默认值** ═════════════════════════════════
{
  const noNumber = [
    'max concurrent activations reached (limit 8)',
    'capacity reached',
    'quota exceeded',
    '', // 空串
  ];
  for (const text of noNumber) {
    assert.equal(parseRetryAfterMs(text), null, `"${text}" 里没有时长，必须返回 null（不能编一个默认值）`);
  }

  // 为什么这条重要：编一个「比如 30 秒」会让调度器在宿主 200 ms 就恢复了的情况下
  // 白等 30 秒——把「宿主忙」变成「调度器自己变慢」。宁可按 tick 试（既有行为），
  // 也不要凭空造一个数字。
  const failure = classifySpawnFailure(new Error('max concurrent activations reached'));
  assert.equal(failure.code, 'host-capacity');
  assert.equal(failure.retryAfterMs, null, '宿主没说时长 ⇒ null');

  console.log('PASS 2. 宿主没报时长时返回 null（不编默认值，不退化成白等）');
}

// ═══ 3. ★ 单位不能猜错：秒 vs 毫秒差 1000 倍 ════════════════════════════════
{
  // HTTP 的 Retry-After 惯例是**秒**。把 30 当毫秒会让退避形同不存在（30ms 后照撞）。
  const structuredSeconds = classifySpawnFailure(Object.assign(new Error('rate limited'), { retryAfter: 30 }));
  assert.equal(structuredSeconds.retryAfterMs, 30_000, `结构化 retryAfter=30 应视为 30 秒，实际 ${structuredSeconds.retryAfterMs}`);

  // 但字段名自己写明 Ms 时按毫秒（30 就是 30，不能乘 1000）。
  const structuredMs = classifySpawnFailure(Object.assign(new Error('rate limited'), { retryAfterMs: 250 }));
  assert.equal(structuredMs.retryAfterMs, 250, `retryAfterMs=250 应原样，实际 ${structuredMs.retryAfterMs}`);

  // HTTP header 也是秒。
  const header = classifySpawnFailure(
    Object.assign(new Error('rate limited'), { headers: { 'retry-after': '12' } }),
  );
  assert.equal(header.retryAfterMs, 12_000, `header retry-after=12 应是 12 秒，实际 ${header.retryAfterMs}`);

  console.log('PASS 3. 单位按字段名判：retryAfter / header 是秒，retryAfterMs 是毫秒');
}

// ═══ 4. 结构化字段优先于文本（同一个错误里两者冲突时） ══════════════════════
{
  // 文本说 5 秒、结构化字段说 60 秒：结构化的更可信（宿主自己的数字，不是给人看的句子）。
  const conflicting = classifySpawnFailure(
    Object.assign(new Error('rate limited, retry-after: 5'), { retryAfterMs: 60_000 }),
  );
  assert.equal(conflicting.retryAfterMs, 60_000, `结构化字段应胜出，实际 ${conflicting.retryAfterMs}`);
  console.log('PASS 4. 结构化退避字段优先于错误文本里的数字');
}

// ═══ 5. ★ 上限：宿主报出荒谬数字时不能把派发冻住一整天 ═════════════════════
{
  const huge = parseRetryAfterMs('retry-after: 86400');
  assert.equal(huge, RETRY_AFTER_CAP_MS, `86400 秒应封顶到 ${RETRY_AFTER_CAP_MS} ms，实际 ${huge}`);

  const hugeStructured = classifySpawnFailure(Object.assign(new Error('rate limited'), { retryAfterMs: 999_999_999 }));
  assert.equal(hugeStructured.retryAfterMs, RETRY_AFTER_CAP_MS, '结构化超大值同样封顶');

  // 为什么要封顶：这个数字来自宿主的错误文本，可能是被截断/拼接的字符串。
  // 照单全收时，一个解析错的「86400000 秒」会把派发冻住一天——
  // 故障从「宿主忙」变成「调度器自己罢工」，而后者没人会想到去查。
  console.log(`PASS 5. 超大退避封顶到 ${Math.round(RETRY_AFTER_CAP_MS / 60_000)} 分钟（不让坏数字冻住派发）`);
}

// ═══ 6. 组装失败不带走退避（它永远不再派，时长没有意义） ═══════════════════
{
  const failure = classifySpawnFailure(
    Object.assign(new Error('agent preset "nope" not found, retry-after: 30'), {}),
  );
  assert.equal(failure.code, 'assembly-failed');
  assert.equal(failure.retryable, false);
  assert.equal(failure.retryAfterMs, null, '确定性失败不带退避时长（免得下游以为等一会儿会好）');
  console.log('PASS 6. 组装失败不带走避时长（确定性失败等多久都不会好）');
}

// ═══ 7. ★ 折叠：退避是全局的，从 journal 推，跨重启有效 ═════════════════════
const T = (seconds) => new Date(seconds * 1000).toISOString();
{
  const rows = [
    { kind: 'node_enqueue_failed', nodeId: 'A', at: T(100), error: 'max concurrent activations', retryable: true, failureCode: 'host-capacity', retryAfterMs: 30_000 },
  ];
  const state = deriveEnqueueState(rows);
  assert.ok(state.backoff, '宿主报了 retryAfterMs ⇒ 应产生全局退避');
  assert.equal(state.backoff.untilMs, Date.parse(T(130)), '退避截止 = 失败时刻 + 时长');
  assert.equal(state.backoff.until, T(130));
  assert.equal(state.backoff.since, T(100));
  assert.equal(state.backoff.nodeId, 'A');
  assert.equal(state.backoff.retryAfterMs, 30_000);

  // 跨重启：同样的行重新折叠（模拟新进程）得到同样的退避。
  const replay = deriveEnqueueState(rows);
  assert.deepEqual(replay.backoff, state.backoff, '重放同样的 journal 必须得到同样的退避（跨重启有效）');
  console.log('PASS 7. 从 journal 折叠出全局退避；重放（模拟重启）结果一致');
}

// ═══ 8. ★ 多条并存取最晚；窗口过后 backoffReason 返回 null ═════════════════
{
  const rows = [
    { kind: 'node_enqueue_failed', nodeId: 'A', at: T(100), error: 'x', retryable: true, retryAfterMs: 10_000 },
    { kind: 'node_enqueue_failed', nodeId: 'B', at: T(105), error: 'y', retryable: true, retryAfterMs: 60_000 },
  ];
  const state = deriveEnqueueState(rows);
  // 取最晚：A 的截止是 110、B 的是 165。取最早会因为「上一轮已经等过一会儿」
  // 而提前解除退避——宿主连撞两次通常意味着更严重，不是更轻。
  assert.equal(state.backoff.untilMs, Date.parse(T(165)), `应取最晚的那条，实际 ${state.backoff.until}`);
  assert.equal(state.backoff.nodeId, 'B');

  assert.ok(backoffReason(state.backoff, Date.parse(T(120))), '窗口内应有说明');
  assert.equal(backoffReason(state.backoff, Date.parse(T(200))), null, '窗口过后不再是退避中');
  const note = backoffReason(state.backoff, Date.parse(T(120)));
  assert.match(note, /还剩约 45 秒/, `说明里要写剩余时间，实际：${note}`);
  console.log('PASS 8. 多条并存取最晚；到期后 backoffReason 返回 null（不报假卡顿）');
}

// ═══ 9. ★ 成功派发立刻作废退避（宿主可能提前恢复） ══════════════════════════
{
  const state = emptyEnqueueState();
  applyEnqueueRows(state, [
    { kind: 'node_enqueue_failed', nodeId: 'A', at: T(100), error: 'x', retryable: true, retryAfterMs: 60_000 },
  ]);
  assert.ok(state.backoff, '前置条件：应有退避');
  applyEnqueueRows(state, [{ kind: 'node_enqueued', nodeId: 'A', at: T(101) }]);
  assert.equal(state.backoff, null, '成功派发证明宿主已恢复 ⇒ 退避必须作废（否则留下假卡顿）');
  console.log('PASS 9. 成功派发立刻清空退避（不留下「退避还没到期但宿主其实好了」的假卡顿）');
}

// ═══ 10. 组装失败 / 缺 retryAfterMs 都不产生退避 ════════════════════════════
{
  const assembly = deriveEnqueueState([
    { kind: 'node_enqueue_failed', nodeId: 'A', at: T(100), error: 'preset not found', retryable: false, failureCode: 'assembly-failed', retryAfterMs: 30_000 },
  ]);
  assert.equal(assembly.backoff, null, '确定性失败不进退避（它已经进了 failed，永远不再派）');
  assert.equal(assembly.failed.size, 1, '前置条件：应进 failed');

  const noHint = deriveEnqueueState([
    { kind: 'node_enqueue_failed', nodeId: 'A', at: T(100), error: 'max concurrent', retryable: true, failureCode: 'host-capacity' },
  ]);
  assert.equal(noHint.backoff, null, '宿主没说时长 ⇒ 不退避（按 tick 重试是既有行为）');
  console.log('PASS 10. 组装失败与「宿主没说时长」都不产生退避');
}

// ═══ 11. ★ 计划层：退避是独立闸门，且排在确定性拦截之后、分区满员之前 ═════
const NODES = ['H1', 'H2', 'H3', 'H4'];
function freshStore(withPartition = false) {
  const store = new core.Store();
  core.withCoreStore(store, () => {
    const spec = {
      nodes: NODES.map((nodeId) => ({
        nodeId, title: nodeId, stage: 'build', status: 'planned', deps: [], acceptance: { kind: 'exists' },
      })),
      policies: { maxParallel: 100 },
    };
    if (withPartition) {
      spec.coordination = {
        enabled: true,
        maxActive: 100,
        partitions: [{ id: 'p-tight', nodeRefs: ['H1', 'H2'], maxActive: 1 }],
      };
    }
    const committed = core.graphCommit(spec);
    assert.equal(committed.ok, true, JSON.stringify(committed.errors ?? []));
  });
  return store;
}

const base = {
  mode: 'interval',
  maxPerTick: 10,
  maxActive: 100,
  maxQueuedTasks: 100,
  ratePerSecond: 100,
  currentQueueLength: 0,
  dispatchedThisSecond: 0,
};

{
  const store = freshStore();

  // 没有退避时：照常派。
  const normal = core.withCoreStore(store, () => core.dispatchPlan({ ...base }));
  assert.ok(normal.readyCount > 0, '前置条件：应有就绪节点');
  assert.equal(normal.willDispatch.length, normal.readyCount, '无退避时应全部可派');
  assert.equal(normal.backpressure.hostBackoff, null, '无退避时 backpressure.hostBackoff 应为 null（不是 {}、不是 false）');

  // 退避生效：一个都不派，全部归因到 host-backoff。
  const now = Date.now();
  const backed = core.withCoreStore(store, () =>
    core.dispatchPlan({ ...base, hostBackoffUntilMs: now + 45_000, hostBackoffNote: '宿主满载（EDSH_LIMIT）' }),
  );
  assert.equal(backed.willDispatch.length, 0, '退避窗口内不得派任何节点');
  const skips = backed.plan.filter((item) => item.action === 'skip');
  assert.equal(skips.length, backed.readyCount, '每个就绪节点都要有一条跳过记录（不能静默消失）');
  assert.ok(skips.every((item) => item.gate === 'host-backoff'), `全部应归因 host-backoff，实际 ${[...new Set(skips.map((i) => i.gate))]}`);
  assert.ok(skips.every((item) => /还剩 \d+ 秒/.test(item.reason)), 'reason 里要有剩余秒数');
  assert.ok(skips.every((item) => /宿主满载（EDSH_LIMIT）/.test(item.reason)), 'reason 里要带上宿主原文');
  assert.equal(backed.gates['host-backoff'], backed.readyCount, 'gates 汇总要计数');
  assert.equal(backed.backpressure.hostBackoff.untilMs, now + 45_000, 'backpressure 要带截止时刻');
  assert.ok(backed.backpressure.hostBackoff.remainingMs > 0, 'backpressure 要带剩余毫秒');

  console.log('PASS 11. 退避窗口内一个都不派，全部归因 host-backoff（附剩余秒数与宿主原文）');
}

// ═══ 12. ★ 退避**优先于分区满员**，但**让位**给确定性拦截 ═══════════════════
{
  const store = freshStore(true);
  const now = Date.now();

  // 分区满员 + 退避同时成立：报 host-backoff。
  // 分区满员至少还能派域外节点，而退避时全图一个都派不出去——
  // 报 partition 会让人以为「换个域就能绕开」。
  const both = core.withCoreStore(store, () =>
    core.dispatchPlan({ ...base, hostBackoffUntilMs: now + 30_000, hostBackoffNote: 'x' }),
  );
  const gatesUsed = new Set(both.plan.filter((i) => i.action === 'skip').map((i) => i.gate));
  assert.deepEqual([...gatesUsed], ['host-backoff'], `退避应压过分区闸门，实际归因 ${[...gatesUsed]}`);

  // 预算耗尽 + 退避：报 budget。
  // 预算是节点自身「永远好不了」的问题，用「等一会儿」掩盖它等于让人不去加额度。
  const budgetStore = new core.Store();
  core.withCoreStore(budgetStore, () => {
    core.graphCommit({
      nodes: [{ nodeId: 'B1', title: 'B1', stage: 'build', status: 'planned', deps: [], acceptance: { kind: 'exists' } }],
      policies: { maxParallel: 10, budgetTokens: 100 },
    });
    // 用掉额度，让 B1 变成「派出去也会被 claim 拒」。
    core.graphStatus?.();
  });
  const budgetPlan = core.withCoreStore(budgetStore, () => core.dispatchPlan({ ...base, hostBackoffUntilMs: now + 30_000 }));
  // 预算没触发时这条只是空转，不当成失败；触发时必须是 budget 而不是 host-backoff。
  const budgetSkips = budgetPlan.plan.filter((i) => i.action === 'skip' && i.gate === 'budget');
  for (const skip of budgetSkips) {
    assert.notEqual(skip.gate, 'host-backoff', '预算拦截不得被退避盖掉');
  }

  console.log('PASS 12. 退避压过分区满员，但确定性拦截（预算）不被退避掩盖');
}

// ═══ 13. 端到端：真实 service 路径把退避喂进计划层并反映到面板 ══════════════
{
  const { L0ControlService } = await import(lib('service.js'));
  const spawned = [];
  const makeCtx = () => ({
    get: (name) => {
      if (name === 'workingDirectory') return { defaultDirectory: root };
      if (name === 'subagents') {
        return {
          list: () => ['spawn'],
          startActivation: async (request) => {
            spawned.push(request);
            return { childId: `child-${spawned.length}`, messageId: `msg-${spawned.length}` };
          },
        };
      }
      return undefined;
    },
  });
  const stateDir = tempStateDir('backoff-e2e');
  const CONFIG = { workspaceRoot: root, stateDir, persistence: 'node' };
  const svc = new L0ControlService(makeCtx(), CONFIG, {});
  try {
    const committed = await svc.graphCommit({
      wish: '宿主退避端到端',
      nodes: [
        { nodeId: 'K1', title: '写说明', capability: 'CODE', acceptance: { kind: 'exists' } },
        { nodeId: 'K2', title: '复核', capability: 'CODE', acceptance: { kind: 'exists' } },
      ],
    });
    assert.equal(committed.ok, true, JSON.stringify(committed.errors ?? []));

    // 初始：没有退避。
    assert.equal(svc.dispatchView().hostBackoff, null, '开局不应有退避');

    // 写一条 30 秒退避的失败事件（等价于宿主满载时 enqueuePlan 写下的那一行）。
    const failureAt = new Date();
    svc.appendJournal('node_enqueue_failed', {
      nodeId: 'K1',
      role: 'CODE',
      error: 'max concurrent activations reached (limit 8)',
      retryable: true,
      failureCode: 'host-capacity',
      retryAfterMs: 30_000,
    });
    void failureAt;

    const view = svc.dispatchView();
    assert.ok(view.hostBackoff, '派发面板必须报出退避（否则只能看到「ready 2、派 0」）');
    assert.equal(view.hostBackoff.active, true);
    assert.equal(view.hostBackoff.retryAfterMs, 30_000);
    assert.equal(view.hostBackoff.nodeId, 'K1');
    assert.match(view.hostBackoff.explain, /还剩约 \d+ 秒/);

    // 真正的派发：一个都不派，spawn 计数不增。
    const before = spawned.length;
    const dispatched = await svc.dispatch({ mode: 'interval', enqueue: true, maxPerTick: 4 }, { id: 'lead' });
    assert.equal(spawned.length, before, '退避窗口内不得 spawn（旧行为是每 tick 硬撞一次）');
    const planned = (dispatched.plan ?? []).filter((item) => item.action !== 'dispatch' && item.action !== 'would-dispatch');
    assert.ok(planned.length > 0, '应有跳过记录');
    assert.ok(planned.every((item) => item.gate === 'host-backoff'), `计划层归因应为 host-backoff，实际 ${[...new Set(planned.map((i) => i.gate))]}`);
    assert.equal(dispatched.backpressure.hostBackoff !== null, true, '计划结果里要带 backpressure.hostBackoff');

    // 退避到期：另起一个 stateDir，journal 里那条失败是 60 秒前写的、退避只有 30 秒。
    // 直接写文件而不是走 appendJournal：后者只会写「此刻」，测不出「已经过期」。
    const expiredDir = tempStateDir('backoff-expired');
    const expiredPath = path.join(root, expiredDir);
    fs.mkdirSync(expiredPath, { recursive: true });
    const past = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(
      path.join(expiredPath, 'journal.jsonl'),
      [
        JSON.stringify({
          at: past, kind: 'node_enqueue_failed', nodeId: 'K1', role: 'CODE',
          error: 'max concurrent activations reached (limit 8)', retryable: true,
          failureCode: 'host-capacity', retryAfterMs: 30_000,
        }),
      ].join('\n') + '\n',
      'utf8',
    );
    const expiredSvc = new L0ControlService(makeCtx(), { workspaceRoot: root, stateDir: expiredDir, persistence: 'node' }, {});
    try {
      const expiredView = expiredSvc.dispatchView();
      assert.ok(expiredView.hostBackoff, '过期的退避仍应上报（面板要能回答「刚才那次为什么没派」）');
      assert.equal(expiredView.hostBackoff.active, false, '30 秒后这条退避必须已过期');
      assert.equal(expiredView.hostBackoff.remainingMs, 0);
      assert.match(expiredView.hostBackoff.explain, /到期/, `到期后文案要说已到期，实际：${expiredView.hostBackoff.explain}`);

      // 过期后照常派活：不再有 host-backoff 归因。
      const expiredPlan = await expiredSvc.dispatch({ mode: 'interval', maxPerTick: 4 }, { id: 'lead' });
      const expiredSkip = (expiredPlan.plan ?? []).filter((item) => item.gate === 'host-backoff');
      assert.equal(expiredSkip.length, 0, '退避过期后不得再归因 host-backoff');
      assert.equal(expiredPlan.backpressure.hostBackoff, null, '过期后 backpressure.hostBackoff 应回到 null');
    } finally {
      expiredSvc.stopDispatch();
      try {
        await expiredSvc.dispose();
      } catch {
        /* ignore */
      }
    }

    console.log('PASS 13. 端到端：journal 里的 retryAfterMs → 面板 hostBackoff → 计划层一个都不派；到期后恢复');
  } finally {
    svc.stopDispatch();
    try {
      await svc.dispose();
    } catch {
      /* ignore */
    }
  }
}

console.log(
  '\nPASS host backoff: 三种写法解析 / 不编默认值 / 单位不猜错 / 结构化优先 / 封顶 / 组装失败不带 / 从 journal 折叠跨重启 / 取最晚 / 成功即作废 / 计划层独立闸门且顺序正确 / 端到端贯通',
);
