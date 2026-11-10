#!/usr/bin/env node
/**
 * serializer 等价性自检：
 *   - 纯 JSON 值原样通过
 *   - undefined / NaN / Infinity / BigInt / function → 按契约折成 JSON 原生值
 *   - Date → ISO；Map → 对象；Set → 数组
 *   - 类实例只取自有可枚举属性
 *   - 循环引用 → "[Circular]"，不栈溢出
 *   - 与旧实现 JSON.parse(JSON.stringify()) 在「纯数据」上结果一致
 */
import assert from 'node:assert/strict';
import { toJsonValue, losslessOutput, losslessOutputWithStats } from '../lib/serializer.js';

// 1) 纯数据等价
const pure = {
  ok: true,
  count: 3,
  ratio: 0.5,
  name: '节点',
  tags: ['a', 'b'],
  nested: { deep: { value: null } },
};
assert.deepEqual(losslessOutput(pure), JSON.parse(JSON.stringify(pure)));

// 2) undefined 键丢弃（对象）/ 元素转 null（数组）
assert.deepEqual(toJsonValue({ a: 1, b: undefined }), { a: 1 });
assert.deepEqual(toJsonValue([1, undefined, 3]), [1, null, 3]);

// 3) 非有限数
assert.deepEqual(toJsonValue({ n: NaN, i: Infinity }), { n: null, i: null });

// 4) BigInt / function / symbol
assert.equal(toJsonValue(BigInt(10)), '10');
assert.equal(toJsonValue(() => 1), null);
assert.equal(toJsonValue(Symbol('x')), null);

// 5) Date
assert.equal(toJsonValue(new Date('2026-11-10T00:00:00.000Z')), '2026-11-10T00:00:00.000Z');
assert.equal(toJsonValue(new Date('invalid')), null);

// 6) Map / Set
assert.deepEqual(toJsonValue(new Map([['k', 1]])), { k: 1 });
assert.deepEqual(toJsonValue(new Set(['a', 'b'])), ['a', 'b']);

// 7) 类实例只取自有可枚举属性
class Node {
  constructor() {
    this.id = 'N1';
    this.status = 'ready';
  }
  get computed() {
    return 'not-enumerable';
  }
}
assert.deepEqual(toJsonValue(new Node()), { id: 'N1', status: 'ready' });

// 8) 循环引用不爆栈
const cyclic = { name: 'root' };
cyclic.self = cyclic;
const out = toJsonValue(cyclic);
assert.equal(out.name, 'root');
assert.equal(out.self, '[Circular]');

// 9) 统计
const stats = losslessOutputWithStats({ a: undefined, b: 1 });
assert.equal(stats.stats.dropped >= 1, true);
assert.deepEqual(stats.value, { b: 1 });

// 10) 同一对象在**不同分支**重复出现不应被误判为循环
const shared = { v: 1 };
assert.deepEqual(toJsonValue({ x: shared, y: shared }), { x: { v: 1 }, y: { v: 1 } });

// 11) 深嵌套不栈溢出（1000 层）
let deep = { v: 0 };
for (let i = 1; i < 1000; i += 1) deep = { v: i, child: deep };
const deepOut = toJsonValue(deep);
assert.equal(deepOut.v, 999);

// 12) 性能对比（仅打印，不做断言）
const big = { nodes: Array.from({ length: 2000 }, (_, i) => ({ nodeId: `N${i}`, status: 'ready', deps: [], capability: 'CODE', stage: 'build' })) };
const t0 = performance.now();
for (let i = 0; i < 50; i += 1) toJsonValue(big);
const t1 = performance.now();
for (let i = 0; i < 50; i += 1) JSON.parse(JSON.stringify(big));
const t2 = performance.now();
console.log(`PASS serializer: 12/12`);
console.log(`  toJsonValue      50x: ${(t1 - t0).toFixed(1)}ms`);
console.log(`  stringify+parse  50x: ${(t2 - t1).toFixed(1)}ms`);
console.log(`  提速: ${(((t2 - t1) / (t1 - t0)) || 0).toFixed(2)}x`);
