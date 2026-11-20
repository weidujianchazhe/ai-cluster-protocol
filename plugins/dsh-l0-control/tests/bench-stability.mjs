/**
 * 千节点基准稳定性：连跑 N 遍，看吞吐与分位抖动。
 *
 * 单次基准不能作为容量证据 —— 需要对同一规模重复测量，确认数字不是偶然。
 * 本脚本输出每遍的吞吐 / claimTask p99 / verifyDone p99 / 堆增量，并给出
 * min / median / max 与抖动幅度。
 *
 * 用法：`node tests/bench-stability.mjs [--runs 3] [--nodes 1000]`
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};
const RUNS = argOf('runs', 3);
const NODES = argOf('nodes', 1000);

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bench-thousand.mjs');
const runs = [];
for (let i = 0; i < RUNS; i += 1) {
  const output = execFileSync(process.execPath, [script, '--nodes', String(NODES), '--json'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  runs.push(JSON.parse(output));
}

const latencyOf = (report, label) => report.latency.find((row) => row.label === label) ?? {};
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

process.stdout.write(`\n千节点基准稳定性（${RUNS} 遍 / ${NODES} 节点）\n`);
process.stdout.write('─'.repeat(74) + '\n');
process.stdout.write(`  ${'遍'.padStart(3)}${'吞吐'.padStart(12)}${'claim p99'.padStart(13)}${'verify p99'.padStart(13)}${'堆增量MB'.padStart(12)}\n`);
runs.forEach((report, index) => {
  process.stdout.write(
    `  ${String(index + 1).padStart(3)}` +
      `${String(report.wall.nodesPerSecond).padStart(12)}` +
      `${String(latencyOf(report, 'claimTask').p99 ?? '-').padStart(13)}` +
      `${String(latencyOf(report, 'verifyDone').p99 ?? '-').padStart(13)}` +
      `${String(report.memory.heapDeltaMB).padStart(12)}\n`,
  );
});

const throughput = runs.map((report) => report.wall.nodesPerSecond);
const med = median(throughput);
const spread = ((Math.max(...throughput) - Math.min(...throughput)) / med) * 100;
process.stdout.write('─'.repeat(74) + '\n');
process.stdout.write(
  `吞吐 min/median/max: ${Math.min(...throughput)} / ${med} / ${Math.max(...throughput)}  （抖动 ${spread.toFixed(1)}%）\n`,
);
process.stdout.write(`全部跑完: ${runs.every((report) => report.ok) ? '是' : '否'}\n`);

// 抖动超过 30% 说明测量不稳（或机器被别的东西抢占），数字不可作为容量证据
const stable = spread <= 30 && runs.every((report) => report.ok);
process.stdout.write(`\n结论：${stable ? '稳定（抖动 ≤30%），数字可用作容量证据' : '抖动过大或未全跑完，数字不可用作容量证据'}\n`);
process.exit(stable ? 0 : 1);
