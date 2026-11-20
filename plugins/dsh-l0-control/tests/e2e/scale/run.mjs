/**
 * 服务层规模演练：**并发 worker 跑满 service 全路径**（不是 core 纯函数）。
 *
 * 与 `tests/bench-thousand.mjs` 的区别：那份走 core，量的是「状态层每步多快」。
 * 这份走 **service**——每次动作都要 `withCore` + `persist()`（core journal 增量落盘）
 * + 扁平 journal 追加 + 周期快照。真实 worker 面对的就是这条路径，它才是
 * 「1000 个 Agent 能不能同时干活」的那个瓶颈候选。
 *
 * 口径声明（重要）：worker 是**模拟的**（无 LLM、无真 session），测的是插件自己
 * 拥有的那段路径的吞吐与尾延迟。真实的千 Agent 还受 LLM 吞吐、宿主 session 上限、
 * 网络与 token 预算约束——本演练**不作为那些能力已达标的证据**。
 *
 * 演练形状（刻意让并发真的发生）：
 *   - 1 个根节点（research 阶段）+ N-1 个叶子节点（build 阶段），叶子依赖根；
 *   - 根一 done，N-1 个叶子同时进入 ready → W 个 worker 抢同一批候选，
 *     抢输的拿 `lease_held` 再挑下一个（真实竞争，不是分批喂）；
 *   - 阶段闸门按**阶段**过一次（闸门是图级的，不是节点级）；
 *   - 每一轮都跑 `taskNext → taskClaim → evidence → verify`，全部经 service。
 *
 * 用法：
 *   node tests/e2e/scale/run.mjs                     # 默认 300 节点 / 8 worker
 *   node tests/e2e/scale/run.mjs --nodes 1000 --workers 16
 *   node tests/e2e/scale/run.mjs --nodes 1000 --workers 16 --json
 * 退出码：0 全绿 / 1 断言失败 / 2 参数非法 / 3 演练没跑起来。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { tempStateDir, cleanupTempStateDirs } from '../../_temp-state.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..', '..', '..');
const workspaceRoot = path.resolve(pluginRoot, '..', '..');
const lib = (name) => pathToFileURL(path.join(pluginRoot, 'lib', name)).href;
const { L0ControlService } = await import(lib('service.js'));

const argv = process.argv.slice(2);
const numArg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};
const NODE_COUNT = numArg('nodes', 300);
const WORKER_COUNT = numArg('workers', 8);
// `maxParallel` 默认取 worker 数的两倍：正好相等时，16 个 worker 各自持 1 个租约就把全图
// 额度占满（`assertCapacity` 判的是 `active >= maxActive`），于是几乎每次 claim 都被
// `graph_capacity` 拒——那不是负载，是尺度配错，会把 `taskClaim` 的失败数刷成假信号。
const MAX_PARALLEL = numArg('max-parallel', Math.max(WORKER_COUNT * 2, 8));
// 领取速率上限（配置口径 `dispatchRatePerSecond`，默认 100/s）。
// 演练必须能把它调出来：`task_claim` 的速率闸门按「本秒已发租约数」判，
// 16 个 worker 同时抢时它会**必然**成为约束——不显式区分，就会把「配置在限速」
// 误读成「管道跑不快」。
const RATE = numArg('rate', 100);
const AS_JSON = argv.includes('--json');
if (NODE_COUNT < 2) { process.stderr.write('--nodes 至少 2（1 根 + 若干叶子）\n'); process.exit(2); }

const log = (line) => process.stdout.write(`${line}\n`);
const ROOT_NODE = 'N0001';
const leafId = (index) => `N${String(index).padStart(4, '0')}`;
const CODE_WORKERS = Array.from({ length: WORKER_COUNT }, (_, i) => `role-code-${String(i + 1).padStart(2, '0')}`);
const AUDITORS = ['role-audit-code-01', 'role-audit-evidence-01'];
const COORDINATOR_SENTINEL = 'driver-coordinator-never-acts';

// ── 宿主绑定：sessionId ↔ instanceId（演练自己提供；插件逻辑全真） ─────────────
const bindings = new Map();
for (const [index, instanceId] of [...CODE_WORKERS, ...AUDITORS].entries()) bindings.set(instanceId, `sess-${instanceId}-${index}`);
const callerOf = (instanceId) => ({ id: bindings.get(instanceId) });
const makeCtx = () => ({
  get: (name) => {
    if (name === 'workingDirectory') return { defaultDirectory: workspaceRoot };
    if (name === 'subagents') return { list: () => ['spawn'], startActivation: async () => ({ childId: 'c', messageId: 'm' }) };
    if (name === 'l0adapter') {
      return { report: () => ({ instances: [...bindings.entries()].map(([instanceId, sessionId]) => ({ instanceId, sessionId })) }) };
    }
    return undefined;
  },
});

// ── 计时工具（只统计成功调用的耗时；失败调用单列计数） ────────────────────────
const stats = new Map();
function record(op, ms, ok) {
  let row = stats.get(op);
  if (!row) { row = { ok: [], fail: 0 }; stats.set(op, row); }
  if (ok) row.ok.push(ms); else row.fail += 1;
}
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : Number.NaN);
function tableText() {
  const rows = [['动作', '成功', '失败', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms']];
  for (const [op, row] of stats) {
    const sorted = [...row.ok].sort((a, b) => a - b);
    rows.push([op, String(row.ok.length), String(row.fail), pct(sorted, 50).toFixed(2), pct(sorted, 95).toFixed(2), pct(sorted, 99).toFixed(2), (sorted[sorted.length - 1] ?? Number.NaN).toFixed(2)]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((cell, i) => String(cell).padEnd(widths[i])).join('  ')).join('\n');
}

const stateDir = path.resolve(tempStateDir('scale'));
const artifactsDir = path.join(stateDir, 'artifacts');
fs.mkdirSync(artifactsDir, { recursive: true });

const svc = new L0ControlService(makeCtx(), { workspaceRoot, stateDir, persistence: 'node', maxParallel: MAX_PARALLEL, dispatchRatePerSecond: RATE }, {});
const unwrap = (wrapped) => {
  const inner = wrapped && typeof wrapped === 'object' && 'graph' in wrapped ? wrapped.graph : wrapped;
  return inner && typeof inner === 'object' && 'result' in inner ? inner.result : inner;
};

async function timed(op, fn) {
  const start = performance.now();
  let ok = false;
  try {
    const value = await fn();
    ok = value?.ok !== false;
    return value;
  } finally {
    record(op, performance.now() - start, ok);
  }
}

try {
  // ── 1. 建图：根 + 叶子 ──────────────────────────────────────────────────
  const buildStart = performance.now();
  const nodes = [
    { nodeId: ROOT_NODE, title: '根', capability: 'CODE', stage: 'research', deps: [], evidenceRequired: ['artifact'], acceptance: { kind: 'exists' } },
    ...Array.from({ length: NODE_COUNT - 1 }, (_, i) => ({
      nodeId: leafId(i + 2),
      title: `叶子 ${i + 2}`,
      capability: 'CODE',
      stage: 'build',
      deps: [ROOT_NODE],
      evidenceRequired: ['artifact'],
      acceptance: { kind: 'exists' },
    })),
  ];
  const committed = unwrap(await svc.graphCommit({ wish: '服务层规模演练', policies: { maxParallel: MAX_PARALLEL }, nodes }));
  assert.equal(committed?.ok, true, `建图失败：${JSON.stringify(committed?.errors ?? committed).slice(0, 400)}`);
  const buildMs = performance.now() - buildStart;

  // ── 2. 阶段闸门：闸门是**图级**的，每个阶段过一次就够 ────────────────────
  for (const stage of ['research', 'build']) {
    const gate = await timed('passGate', () => svc.passGate({ stage, evidence_refs: [] }));
    assert.notEqual(gate?.ok, false, `阶段闸门 ${stage} 失败：${JSON.stringify(gate).slice(0, 300)}`);
  }

  // ── 3. 并发 worker 循环 ────────────────────────────────────────────────
  const occupied = new Set();
  const auditorOf = (nodeId) => AUDITORS[Number(nodeId.slice(1)) % AUDITORS.length];
  let rejectInjected = false;
  let finished = 0;
  // 「暂时没有候选」不等于「收工」：建图刚起来时只有根节点就绪，先到的 worker 若直接
  // 退出，剩下的 N-1 个叶子就全被最后那个 worker 一个人做完——那样测出来的并发是假的
  // （第一版实测 60 节点里 60 个 claim 全来自 role-code-01）。所以没活干时要等一下，
  // 只有「全部 done」或「没人正在干活且没候选」才退出。
  const inFlight = new Set();
  const yieldTick = () => new Promise((resolve) => setImmediate(resolve));

  async function workerLoop(instanceId) {
    let done = 0;
    for (;;) {
      if (finished >= NODE_COUNT) return done;
      const next = unwrap(await timed('taskNext', () => svc.taskNext({})));
      const ready = Array.isArray(next?.ready) ? next.ready : [];
      const target = ready.find((nodeId) => !occupied.has(nodeId));
      if (!target) {
        if (inFlight.size === 0 && ready.length === 0) return done;
        await yieldTick();
        continue;
      }
      occupied.add(target);
      inFlight.add(target);

      const claimed = unwrap(await timed('taskClaim', () => svc.taskClaim({ nodeId: target, instanceId }, callerOf(instanceId))));
      if (!claimed?.ok) { occupied.delete(target); inFlight.delete(target); continue; } // lease_held 等：换下一个（真实竞争）
      const fencingToken = claimed?.lease?.fencing_token;
      assert.ok(Number.isFinite(fencingToken), `claim 未返回 token：${JSON.stringify(claimed).slice(0, 200)}`);

      const artifact = path.join(artifactsDir, `${instanceId}-${target}.md`);
      fs.writeFileSync(artifact, `# ${target}\n\nby ${instanceId}\n`, 'utf8');
      const auditor = auditorOf(target);

      const evidence = unwrap(await timed('evidenceSubmit', () => svc.evidenceSubmit(
        { nodeId: target, artifactPath: artifact, fencingToken, producer_instance: instanceId, auditor_instance: auditor, kind: 'artifact', acceptance: { kind: 'exists' } },
        callerOf(instanceId),
      )));
      assert.equal(evidence?.ok, true, `证据失败 ${target}：${JSON.stringify(evidence).slice(0, 300)}`);
      // 证据被拒时节点仍持租约，不能留着不动——这里直接抛，让演练失败而不是静默漏节点。

      // 一次性真实驳回（满足「驳回后重试成功」不变量）
      if (!rejectInjected) {
        const selfAudit = await timed('verifyDone(reject)', () => svc.verifyDone(
          { nodeId: target, fencingToken, producer_instance: instanceId, auditor_instance: instanceId },
          callerOf(instanceId),
        ));
        assert.equal(selfAudit?.ok, false, '自审必须被拒');
        rejectInjected = true;
      }

      const verified = unwrap(await timed('verifyDone', () => svc.verifyDone(
        { nodeId: target, fencingToken, producer_instance: instanceId, auditor_instance: auditor },
        callerOf(auditor),
      )));
      assert.equal(verified?.ok, true, `验证失败 ${target}：${JSON.stringify(verified).slice(0, 360)}`);
      inFlight.delete(target);
      finished += 1;
      done += 1;
      // 让出**宏任务**，不是微任务。
      //
      // service 的每个动作内部都是一串 `await`（withCore → persistence），全在微任务队列里。
      // 若只在「没候选」时 `setImmediate`，其余 worker 会被一直压在 setImmediate 里等微任务
      // 队列排空——而那个队列里正好排着 worker-1 的整个循环。实测后果：60 个节点全由
      // `role-code-01` 一个人做完，`owners` 只有一个实例。每做完一个节点让一次宏任务，
      // 并发才是真的。
      await yieldTick();
    }
  }

  const runStart = performance.now();
  const results = await Promise.all(CODE_WORKERS.map((id) => workerLoop(id)));
  const runMs = performance.now() - runStart;
  const processed = results.reduce((sum, n) => sum + n, 0);

  const status = unwrap(await svc.graphStatus({ limit: 1 }));
  const doneCount = Number(status?.counts?.done ?? 0);
  assert.equal(rejectInjected, true, '必须注入一次真实驳回');
  assert.equal(doneCount, NODE_COUNT, `应 ${NODE_COUNT}/${NODE_COUNT} done，实际 ${doneCount}`);
  assert.equal(processed, NODE_COUNT, `worker 自报处理 ${processed} 个，应为 ${NODE_COUNT}`);

  // ── 4. 面板/派发视图在「N 个活登记」上的成本 ────────────────────────────
  const perTick = [];
  for (let i = 0; i < 3; i += 1) {
    const start = performance.now();
    await svc.dispatch({});
    perTick.push(performance.now() - start);
  }
  perTick.sort((a, b) => a - b);

  const persistence = await svc.persistence();
  const journal = { flat: svc.readJournal().length, core: persistence.core.journal.count() };
  const throughput = (NODE_COUNT / runMs) * 1000;
  const msPerNode = runMs / NODE_COUNT;

  // ── 5. 用同一个自主循环校验器断 7 项不变量（节点清单走 @文件，避开命令行长度）──
  const auditFile = svc.journalPath;
  const coreFile = path.join(stateDir, 'core-state', 'journal.jsonl');
  const nodeListFile = path.join(stateDir, 'nodes.txt');
  fs.writeFileSync(nodeListFile, nodes.map((n) => n.nodeId).join(','), 'utf8');
  await svc.dispose();

  const checker = path.resolve(pluginRoot, 'tests', 'e2e', 'autonomy', 'check-autonomy.mjs');
  const run = spawnSync(process.execPath, [checker, auditFile, coreFile, `@${nodeListFile}`, COORDINATOR_SENTINEL], { encoding: 'utf8' });
  let report = null;
  try { report = JSON.parse(String(run.stdout ?? '')); } catch { report = null; }
  if (!report) {
    log(String(run.stdout ?? '').slice(-1500));
    log(String(run.stderr ?? '').slice(-1500));
    throw new Error(`校验器输出不可解析（exit=${run.status}）`);
  }

  const summary = {
    nodes: NODE_COUNT,
    workers: WORKER_COUNT,
    maxParallel: MAX_PARALLEL,
    buildMs: Number(buildMs.toFixed(1)),
    totalMs: Number(runMs.toFixed(1)),
    nodesPerSecond: Number(throughput.toFixed(1)),
    msPerNode: Number(msPerNode.toFixed(3)),
    journal,
    dispatchTickMsMedian: Number(perTick[1].toFixed(2)),
    invariants: { total: report.checks, failed: report.failed },
    ops: Object.fromEntries([...stats].map(([op, row]) => {
      const sorted = [...row.ok].sort((a, b) => a - b);
      return [op, { ok: row.ok.length, fail: row.fail, p50: Number(pct(sorted, 50).toFixed(2)), p95: Number(pct(sorted, 95).toFixed(2)), p99: Number(pct(sorted, 99).toFixed(2)) }];
    })),
  };

  if (AS_JSON) {
    log(JSON.stringify({ ...summary, results: report.results }, null, 2));
  } else {
    log(`${NODE_COUNT} 节点 / ${WORKER_COUNT} worker / maxParallel=${MAX_PARALLEL}，建图 ${buildMs.toFixed(0)} ms`);
    log(tableText());
    log(`\n端到端：${runMs.toFixed(0)} ms，${throughput.toFixed(1)} 节点/秒，${msPerNode.toFixed(3)} ms/节点`);
    log(`journal：扁平 ${journal.flat} 行 / core ${journal.core} 行；dispatch tick 中位 ${perTick[1].toFixed(1)} ms`);
    // 生长性：同一动作在「刚开始」与「快结束时」各取 50 次。若后者明显更贵，说明
    // 每步成本随**已积累的状态**增长（O(history)），而不是随图规模或动作种类。
    const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? Number.NaN; };
    for (const op of ['taskNext', 'verifyDone']) {
      const row = stats.get(op);
      if (!row || row.ok.length < 120) continue;
      const early = median(row.ok.slice(0, 50));
      const late = median(row.ok.slice(-50));
      log(`生长性 ${op.padEnd(12)} 前 50 次 ${early.toFixed(1)} ms → 后 50 次 ${late.toFixed(1)} ms（×${(late / early).toFixed(2)}）`);
    }
    for (const row of report.results ?? []) log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}`);
    log(`\nPASS service-scale e2e: ${report.checks - report.failed}/${report.checks} 项不变量全过（${NODE_COUNT} 节点 / ${WORKER_COUNT} 并发 worker）`);
    log('口径：worker 是模拟的（无 LLM / 无真 session）。本数字只代表插件自己那条路径，不代表千 Agent 端到端吞吐。');
  }
  assert.equal(report.ok, true, `不变量未全过：${report.failed}/${report.checks}`);
} finally {
  try { svc.stopDispatch(); } catch {}
  try { await svc.dispose(); } catch {}
  cleanupTempStateDirs();
}
