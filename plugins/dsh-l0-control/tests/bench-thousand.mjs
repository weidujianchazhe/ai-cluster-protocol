/**
 * 千实例容量基准：**在真实 core 上跑大规模图**，量出吞吐 / 延迟分位 / 内存 / journal 放大。
 *
 * 这不是"能不能跑通"的冒烟测试，是容量测量。目标数字：
 *   - 1000 节点 / 20 分区
 *   - 全链跑完（每节点 claim → evidence → verify_done）
 *   - 记录每步耗时，算 p50 / p95 / p99
 *   - 记录 journal 事件数、内存增量
 *
 * **口径声明（很重要）**：
 * 本基准**只测控制面**，不 spawn 真实 Agent。它测的是「控制面在千节点规模下
 * 每步多久、journal 涨多快、内存涨多少」—— 这是千级能力的**必要条件**，
 * 不是充分条件。真实的千 Agent 并发还要受 LLM 吞吐、宿主 session 上限、
 * 网络与 token 预算约束，本基准**不作为那些能力已达标的证据**。
 *
 * 用法：
 *   node tests/bench-thousand.mjs                 # 默认 1000 节点
 *   node tests/bench-thousand.mjs --nodes 2000    # 自定义规模
 *   node tests/bench-thousand.mjs --json          # 机器可读
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const lib = (name) => pathToFileURL(path.join(root, 'lib', name)).href;
const core = await import(lib('core/index.js'));

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};
const NODE_COUNT = argOf('nodes', 1000);
const PARTITION_COUNT = argOf('partitions', 20);
const AS_JSON = argv.includes('--json');
const ARTIFACT = path.join(root, 'README.md');

if (NODE_COUNT % PARTITION_COUNT !== 0) {
  process.stderr.write(`节点数必须是分区数的整数倍：${NODE_COUNT} / ${PARTITION_COUNT}\n`);
  process.exit(2);
}

const perPartition = NODE_COUNT / PARTITION_COUNT;

// ── 构造 1000 节点 / 20 分区图 ──────────────────────────────────────────────
const partitions = [];
const nodes = [];
for (let p = 0; p < PARTITION_COUNT; p += 1) {
  const ids = [];
  for (let i = 0; i < perPartition; i += 1) ids.push(`N${p}-${i}`);
  partitions.push({ id: `part-${p}`, nodeRefs: ids, maxActive: perPartition });
  ids.forEach((nodeId, i) => {
    nodes.push({
      nodeId,
      title: nodeId,
      stage: 'build',
      status: 'planned',
      // 分区内串成链：只有第一个是根节点，其余依赖前一个
      deps: i === 0 ? [] : [ids[i - 1]],
      acceptance: { kind: 'exists' },
    });
  });
}

const spec = {
  wish: `${NODE_COUNT} 节点容量基准`,
  policies: { maxParallel: NODE_COUNT, budgetTokens: 0 },
  coordination: {
    enabled: true,
    maxActive: NODE_COUNT,
    maxQueuedTasks: NODE_COUNT * 10,
    ratePerSecond: NODE_COUNT * 100,
    partitions,
  },
  nodes,
};

// ── 计时工具 ────────────────────────────────────────────────────────────────
const samples = [];
const timed = (label, fn) => {
  const start = process.hrtime.bigint();
  const value = fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  samples.push({ label, ms });
  return value;
};
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0;
function stats(label) {
  const values = samples.filter((s) => s.label === label).map((s) => s.ms).sort((a, b) => a - b);
  return {
    label,
    count: values.length,
    p50: Number(pct(values, 50).toFixed(3)),
    p95: Number(pct(values, 95).toFixed(3)),
    p99: Number(pct(values, 99).toFixed(3)),
    max: Number((values[values.length - 1] ?? 0).toFixed(3)),
    totalMs: Number(values.reduce((sum, v) => sum + v, 0).toFixed(1)),
  };
}

// ── 跑图 ────────────────────────────────────────────────────────────────────
const store = new core.Store();
const run = (fn) => core.withCoreStore(store, fn);

const wallStart = process.hrtime.bigint();
const heapBefore = process.memoryUsage().heapUsed;

timed('submitWish', () => run(() => core.submitWish({ text: spec.wish, maxParallel: NODE_COUNT, budgetTokens: 0 })));
const committed = timed('graphCommit', () => run(() => core.graphCommit(spec)));
if (!committed?.ok) {
  process.stderr.write(`graphCommit 失败：${JSON.stringify(committed?.errors ?? committed).slice(0, 800)}\n`);
  process.exit(1);
}
timed('bootstrap', () => run(() => core.bootstrap(store)));

// 逐分区串行推进：分区内是链，必须按序；分区之间串行跑（本基准量的是控制面单线程成本）
let doneCount = 0;
let claimRejected = 0;
for (let p = 0; p < PARTITION_COUNT; p += 1) {
  run(() => core.passGate(store, 'build', []));
  for (let i = 0; i < perPartition; i += 1) {
    const nodeId = `N${p}-${i}`;
    let claim;
    try {
      claim = timed('claimTask', () => run(() => core.claimTask({ nodeId, role: 'ANY', instanceId: 'ROLE-BENCH-01' })));
    } catch (error) {
      claimRejected += 1;
      process.stderr.write(`claim 抛错 ${nodeId}: ${error?.message}\n`);
      break;
    }
    if (claim?.ok !== true) {
      claimRejected += 1;
      process.stderr.write(`claim 被拒 ${nodeId}: ${JSON.stringify(claim).slice(0, 300)}\n`);
      break;
    }
    const fencingToken = Number(claim.lease.fencing_token);
    const evidence = timed('submitEvidence', () =>
      run(() =>
        core.submitEvidence({
          fencingToken,
          nodeId,
          artifactPath: ARTIFACT,
          producer_instance: 'ROLE-BENCH-01',
          producerInstance: 'ROLE-BENCH-01',
          acceptance: { kind: 'exists' },
          usageTokens: 100,
        }),
      ),
    );
    if (evidence?.ok !== true) {
      process.stderr.write(`evidence 被拒 ${nodeId}: ${JSON.stringify(evidence).slice(0, 300)}\n`);
      break;
    }
    const done = timed('verifyDone', () =>
      run(() =>
        core.verifyDone({
          nodeId,
          producer_instance: 'ROLE-BENCH-01',
          producerInstance: 'ROLE-BENCH-01',
          fencingToken,
          auditor_instance: 'ROLE-AUDIT-BENCH-01',
          auditorInstance: 'ROLE-AUDIT-BENCH-01',
          acceptance: { kind: 'exists' },
        }),
      ),
    );
    if (done?.status !== 'done') {
      process.stderr.write(`verifyDone 失败 ${nodeId}: ${JSON.stringify(done).slice(0, 300)}\n`);
      break;
    }
    doneCount += 1;
  }
}

timed('graphStatus', () => run(() => core.graphStatus({ limit: 10 })));

const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6;
const heapAfter = process.memoryUsage().heapUsed;
const status = run(() => core.graphStatus({ limit: 10 }));
const journalEvents = store.journal.count();

// ── 报告 ────────────────────────────────────────────────────────────────────
const report = {
  ok: doneCount === NODE_COUNT && claimRejected === 0,
  scale: { nodes: NODE_COUNT, partitions: PARTITION_COUNT, perPartition, done: doneCount, claimRejected },
  wall: {
    totalMs: Number(wallMs.toFixed(1)),
    nodesPerSecond: Number((doneCount / (wallMs / 1000)).toFixed(1)),
    msPerNode: Number((wallMs / Math.max(1, doneCount)).toFixed(3)),
  },
  latency: ['submitWish', 'graphCommit', 'bootstrap', 'claimTask', 'submitEvidence', 'verifyDone', 'graphStatus'].map(stats),
  journal: {
    events: journalEvents,
    eventsPerNode: Number((journalEvents / Math.max(1, doneCount)).toFixed(2)),
    bytes: Number(fs.existsSync(path.join(root, '.l0-control')) ? 0 : 0),
  },
  memory: {
    heapDeltaMB: Number(((heapAfter - heapBefore) / 1024 / 1024).toFixed(1)),
    heapUsedMB: Number((heapAfter / 1024 / 1024).toFixed(1)),
  },
  counts: status?.counts ?? null,
  disclaimer:
    '本基准只测控制面（不 spawn 真实 Agent）。千级能力的必要条件是控制面在千节点规模下的每步延迟与内存可接受；LLM 吞吐 / 宿主 session 上限 / token 预算 / 网络不在本基准范围。',
};

if (AS_JSON) {
  process.stdout.write(JSON.stringify(report, null, 2));
} else {
  const pad = (value, width) => String(value).padStart(width);
  process.stdout.write(`\n千实例容量基准（控制面）: ${NODE_COUNT} 节点 / ${PARTITION_COUNT} 分区\n`);
  process.stdout.write('─'.repeat(72) + '\n');
  process.stdout.write(`跑完节点        ${pad(doneCount, 8)} / ${NODE_COUNT}\n`);
  process.stdout.write(`总墙钟          ${pad(report.wall.totalMs, 8)} ms\n`);
  process.stdout.write(`吞吐            ${pad(report.wall.nodesPerSecond, 8)} 节点/秒\n`);
  process.stdout.write(`单节点成本      ${pad(report.wall.msPerNode, 8)} ms/节点\n`);
  process.stdout.write(`journal 事件    ${pad(journalEvents, 8)} （${report.journal.eventsPerNode} 条/节点）\n`);
  process.stdout.write(`堆增量          ${pad(report.memory.heapDeltaMB, 8)} MB\n`);
  process.stdout.write('\n延迟分位（ms）\n');
  process.stdout.write(`  ${'操作'.padEnd(16)}${'次数'.padStart(8)}${'p50'.padStart(9)}${'p95'.padStart(9)}${'p99'.padStart(9)}${'max'.padStart(9)}\n`);
  for (const row of report.latency) {
    if (row.count === 0) continue;
    process.stdout.write(
      `  ${row.label.padEnd(16)}${pad(row.count, 8)}${pad(row.p50, 9)}${pad(row.p95, 9)}${pad(row.p99, 9)}${pad(row.max, 9)}\n`,
    );
  }
  process.stdout.write('\n' + report.disclaimer + '\n');
}

process.exit(report.ok ? 0 : 1);
