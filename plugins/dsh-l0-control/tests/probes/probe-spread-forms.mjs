/**
 * 探针：区分「数组字面量展开」与「函数实参展开」的栈行为。
 *
 * 后者走实参栈（会炸），前者走迭代器协议（不炸）。这个区别决定了
 * `[...inputs, cursorEvent]` 安全而 `push(...inputs)` 不安全。
 */
const N = 200000;
const arr = new Array(N).fill(0).map((_, i) => i);

try {
  const copy = [...arr];
  console.log(`数组字面量 [...arr]      ${N} 条  成功  长度=${copy.length}`);
} catch (error) {
  console.log(`数组字面量 [...arr]      ${N} 条  失败  ${error.message.slice(0, 50)}`);
}

try {
  const merged = [...arr, 999];
  console.log(`字面量 [...arr, x]       ${N + 1} 条  成功  长度=${merged.length}`);
} catch (error) {
  console.log(`字面量 [...arr, x]       ${N + 1} 条  失败  ${error.message.slice(0, 50)}`);
}

try {
  const target = [];
  target.push(...arr);
  console.log(`实参展开 push(...arr)    ${N} 条  成功  长度=${target.length}`);
} catch (error) {
  console.log(`实参展开 push(...arr)    ${N} 条  失败  ${error.message.slice(0, 50)}`);
}

try {
  const out = Math.max(...arr);
  console.log(`Math.max(...arr)         成功  ${out}`);
} catch (error) {
  console.log(`Math.max(...arr)          失败  ${error.message.slice(0, 50)}`);
}

// 分块 push 的成本（替代方案 A）
const t0 = process.hrtime.bigint();
const a = [];
const CHUNK = 10000;
for (let i = 0; i < arr.length; i += CHUNK) a.push(...arr.slice(i, i + CHUNK));
const chunkMs = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`\n分块 push（${CHUNK}/块）  ${chunkMs.toFixed(2)} ms  长度=${a.length}`);

// 循环 push 的成本（替代方案 B）
const t1 = process.hrtime.bigint();
const b = [];
for (const item of arr) b.push(item);
const loopMs = Number(process.hrtime.bigint() - t1) / 1e6;
console.log(`循环 push                ${loopMs.toFixed(2)} ms  长度=${b.length}`);

// 长度预分配 + 下标赋值（替代方案 C）
const t2 = process.hrtime.bigint();
const base = a.length;
a.length = base + arr.length;
for (let i = 0; i < arr.length; i += 1) a[base + i] = arr[i];
const indexMs = Number(process.hrtime.bigint() - t2) / 1e6;
console.log(`预分配 + 下标赋值        ${indexMs.toFixed(2)} ms  长度=${a.length}`);
