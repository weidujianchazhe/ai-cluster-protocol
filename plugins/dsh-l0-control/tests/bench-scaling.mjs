/**
 * 规模扩展曲线：**找 O(n) 还是 O(n²)**。
 *
 * 单点基准只能说明「这个规模下多快」，回答不了「规模翻倍会怎样」。
 * 本脚本对多个规模各跑一遍，输出每节点成本随规模的变化，
 * 并算出「成本增长率 / 规模增长率」—— 接近 1 说明线性（O(n²) 总成本），
 * 接近 0 说明常数。
 *
 * 这是容量结论的关键证据：**如果每节点成本随规模上涨，千级就不是「再等等」的问题，
 * 而是算法复杂度问题**。
 *
 * 用法：`node tests/bench-scaling.mjs [--sizes 500,1000,2000]`
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const sizesArg = argv.includes('--sizes') ? argv[argv.indexOf('--sizes') + 1] : '500,1000,2000';
const sizes = sizesArg
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bench-thousand.mjs');
const rows = [];
for (const nodes of sizes) {
  const output = execFileSync(process.execPath, [script, '--nodes', String(nodes), '--json'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const report = JSON.parse(output);
  const latency = (label) => report.latency.find((row) => row.label === label) ?? {};
  rows.push({
    nodes,
    throughput: report.wall.nodesPerSecond,
    msPerNode: report.wall.msPerNode,
    claimP50: latency('claimTask').p50,
    claimP99: latency('claimTask').p99,
    verifyP50: latency('verifyDone').p50,
    verifyP99: latency('verifyDone').p99,
    journalEvents: report.journal.events,
    eventsPerNode: report.journal.eventsPerNode,
    heapMB: report.memory.heapDeltaMB,
    ok: report.ok,
  });
}

process.stdout.write(`\n规模扩展曲线（每规模 1 遍）\n`);
process.stdout.write('─'.repeat(96) + '\n');
process.stdout.write(
  `  ${'节点'.padStart(6)}${'吞吐'.padStart(10)}${'ms/节点'.padStart(10)}${'claim p50'.padStart(11)}${'verify p50'.padStart(12)}${'事件/节点'.padStart(12)}${'堆MB'.padStart(9)}\n`,
);
for (const row of rows) {
  process.stdout.write(
    `  ${String(row.nodes).padStart(6)}` +
      `${String(row.throughput).padStart(10)}` +
      `${String(row.msPerNode).padStart(10)}` +
      `${String(row.claimP50 ?? '-').padStart(11)}` +
      `${String(row.verifyP50 ?? '-').padStart(12)}` +
      `${String(row.eventsPerNode).padStart(12)}` +
      `${String(row.heapMB).padStart(9)}\n`,
  );
}

process.stdout.write('─'.repeat(96) + '\n');
process.stdout.write('成本增长 vs 规模增长（≈1 = 每节点成本随规模线性上涨 = 总成本 O(n²)）\n');
for (let i = 1; i < rows.length; i += 1) {
  const prev = rows[i - 1];
  const curr = rows[i];
  const scaleGrowth = curr.nodes / prev.nodes;
  const costGrowth = curr.msPerNode / prev.msPerNode;
  const exponent = Math.log(costGrowth) / Math.log(scaleGrowth);
  process.stdout.write(
    `  ${prev.nodes} → ${curr.nodes}：规模 ×${scaleGrowth.toFixed(2)}，每节点成本 ×${costGrowth.toFixed(2)}` +
      ` → 约 O(n^${exponent.toFixed(2)})\n`,
  );
}

const worst = Math.max(...rows.map((row) => row.msPerNode));
const best = Math.min(...rows.map((row) => row.msPerNode));
process.stdout.write(
  `\n每节点成本范围 ${best} – ${worst} ms（×${(worst / best).toFixed(1)}）\n`,
);
process.stdout.write(
  worst / best > 2
    ? '判定：**不是常数成本**——规模翻倍后每节点明显更贵，千级容量受算法复杂度制约，不只看机器。\n'
    : '判定：每节点成本基本恒定，规模扩展主要受机器吞吐制约。\n',
);

process.exit(rows.every((row) => row.ok) ? 0 : 1);
