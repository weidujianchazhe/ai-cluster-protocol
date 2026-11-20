/**
 * 探针：`push(...arr)` 在多大批量上炸栈。
 *
 * 背景：`state/journal.ts` 的 `appendBatch()` 结尾是 `this.recordsCache.push(...out)`。
 * 10 万节点一次性落盘时抛 `Maximum call stack size exceeded`——而**文件已经写完了**，
 * 于是盘上有 20 万行、内存里 0 行、游标还停在 1：一次「写成功但状态没更新」的静默错位。
 *
 * 这里只测临界规模，不猜。
 */
const sizes = [1000, 10000, 50000, 100000, 120000, 125000, 130000, 150000];

console.log('push(...arr) 的批量上限（Node v' + process.version + '）\n');
let lastOk = 0;
for (const n of sizes) {
  const arr = new Array(n).fill(0).map((_, i) => ({ i }));
  const target = [];
  try {
    target.push(...arr);
    lastOk = n;
    console.log(`  ${String(n).padStart(7)}  成功   长度=${target.length}`);
  } catch (error) {
    console.log(`  ${String(n).padStart(7)}  失败   ${error.constructor.name}: ${String(error.message).slice(0, 60)}`);
  }
}
console.log(`\n最大成功规模：${lastOk}`);
console.log('对照：循环 push 在任意规模都安全，只是多一层循环。');

// 同规模用循环验证
const big = new Array(200000).fill(0).map((_, i) => ({ i }));
const t0 = process.hrtime.bigint();
const out = [];
for (const item of big) out.push(item);
const loopMs = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`\n循环 push 200000 条：${loopMs.toFixed(2)} ms（长度=${out.length}）`);
