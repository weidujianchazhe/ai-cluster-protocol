/**
 * 预算作用域：**各花各的，不互相冻死**。
 *
 * 旧实现的缺陷（实测复现）：`assertBudget` 遍历 `view.partitions` 里的**所有**分区，
 * 只要有一个分区超限就抛错，于是
 *
 *   A 分区预算用尽 100/100
 *   → B 分区里毫不相干的 B1 也被拒（`协调域 pa 预算超限`）
 *
 * 这不是"保守"，这是错的：预算的作用域就是它声明的那个作用域。多分区场景下，
 * 一个热点分区烧完自己的额度就会把整张图冻结，而现场报的错误还是「pa 超限」——
 * 排查的人会去查 pa，根本想不到 B1 被误伤。
 *
 * 同一条链上还有第二个缺陷：`dispatchPlan` 完全不看预算，于是候选里会给出
 * 注定被 claim 拒的节点。派出去 → claim 被拒 → worker 按契约停手 → 登记释放
 * → 下一轮又选中它，形成"派了被拒、拒了再派"的空转，每次白烧一份 spawn。
 *
 * 本测试同时钉住三件事：作用域隔离、祖先链传递、派活计划与准入同口径。
 */
import assert from 'node:assert/strict';
import {
  Store, withCoreStore, graphCommit, assertBudget, budgetBlockedNodes, budgetView, dispatchPlan,
} from '../lib/core/index.js';

let now = 1_800_000_000_000;
const clock = { nowMs: () => now, nowIso: () => new Date(now).toISOString() };

function freshStore(spec) {
  const store = new Store({ clock });
  withCoreStore(store, () => {
    const r = graphCommit(spec);
    assert.equal(r.ok, true, JSON.stringify(r.errors ?? []));
  });
  return store;
}

// ── 1. 两个平级分区：一个满，另一个照常 ────────────────────────────────────
const flat = freshStore({
  nodes: [
    { nodeId: 'A1', title: 'A1', acceptance: { kind: 'exists' } },
    { nodeId: 'B1', title: 'B1', acceptance: { kind: 'exists' } },
  ],
  coordination: {
    enabled: true,
    maxActive: 8,
    partitions: [
      { id: 'pa', nodeRefs: ['A1'], maxActive: 4, budgetTokens: 100 },
      { id: 'pb', nodeRefs: ['B1'], maxActive: 4, budgetTokens: 100 },
    ],
  },
});
// 只花 A 分区的额度
flat.journal.append('evidence_added', 'A1', { usageTokens: 100 });
assert.deepEqual(
  budgetView(flat).partitions.map((p) => `${p.id}:${p.used}/${p.limit}`),
  ['pa:100/100', 'pb:0/100'],
);
assert.throws(() => assertBudget(flat, 'A1', 1), { code: 'budget_exceeded' });
assertBudget(flat, 'B1', 1);
assertBudget(flat, 'B1', 100);
assert.throws(() => assertBudget(flat, 'B1', 101), { code: 'budget_exceeded' });
console.log('PASS 1. A 分区满不误伤 B 分区（旧实现遍历全部分区，B1 会被拒）');

// ── 2. 派活计划与准入同口径：预算满的节点不出现在候选里 ────────────────────
withCoreStore(flat, () => {
  const plan = dispatchPlan({ mode: 'interval', dryRun: true, maxPerTick: 8, maxActive: 8 });
  assert.deepEqual(plan.willDispatch, ['B1'], 'A1 预算满，不该出现在候选里');
  const skipped = plan.plan.find((row) => row.nodeId === 'A1');
  assert.equal(skipped.action, 'skip');
  assert.match(skipped.reason, /预算拦截/, `跳过原因应说明是预算，实际 ${skipped.reason}`);
  assert.match(skipped.reason, /pa/, '原因里应指出是哪个作用域');
  assert.match(skipped.reason, /100\/100/, '原因里应给出 已用/上限');
});
console.log('PASS 2. 派活计划按预算过滤，并说明「哪个作用域、用了多少」');

// ── 3. 祖先链：父分区满 → 子分区节点也不能超 ───────────────────────────────
const nested = freshStore({
  nodes: [
    { nodeId: 'N1', title: 'N1', acceptance: { kind: 'exists' } },
    { nodeId: 'N2', title: 'N2', acceptance: { kind: 'exists' } },
  ],
  coordination: {
    enabled: true,
    maxActive: 8,
    partitions: [
      { id: 'root', nodeRefs: [], maxActive: 8, budgetTokens: 50 },
      { id: 'childA', parentId: 'root', nodeRefs: ['N1'], maxActive: 4 },
      { id: 'childB', parentId: 'root', nodeRefs: ['N2'], maxActive: 4 },
    ],
  },
});
// 花在 N1 上：childA 没设上限，但父 root 汇总到 50/50
nested.journal.append('evidence_added', 'N1', { usageTokens: 50 });
assert.throws(() => assertBudget(nested, 'N1', 1), { code: 'budget_exceeded' });
assert.throws(
  () => assertBudget(nested, 'N2', 1),
  { code: 'budget_exceeded' },
  '父分区满 → 同父下的兄弟节点也必须被挡（root 是汇总口径）',
);
console.log('PASS 3. 祖先链传递：父分区满 → 同父下的兄弟节点一并被挡');

withCoreStore(nested, () => {
  const plan = dispatchPlan({ mode: 'interval', dryRun: true, maxPerTick: 8, maxActive: 8 });
  assert.deepEqual(plan.willDispatch, [], '父分区满时不该有候选');
  const reasons = plan.plan.map((row) => row.reason);
  assert.ok(reasons.every((r) => /预算拦截/.test(r)), '两个节点都应给出预算原因');
});
console.log('PASS 3b. 父分区满 → 派活计划无候选，且每个节点都有预算原因');

// ── 4. 全图满：所有节点都挡，原因落在 global ────────────────────────────────
const globalFull = freshStore({
  nodes: [
    { nodeId: 'G1', title: 'G1', acceptance: { kind: 'exists' } },
    { nodeId: 'G2', title: 'G2', acceptance: { kind: 'exists' } },
  ],
  policies: { budgetTokens: 20 },
});
globalFull.journal.append('evidence_added', 'G1', { usageTokens: 20 });
assert.throws(() => assertBudget(globalFull, 'G2', 1), { code: 'budget_exceeded' });
const globalBlocked = budgetBlockedNodes(globalFull);
assert.equal(globalBlocked.get('G1').scope, 'global');
assert.equal(globalBlocked.get('G2').scope, 'global');
console.log('PASS 4. 全图满 → 所有节点都被标记，作用域是 global');

// ── 5. 节点自身上限独立生效 ────────────────────────────────────────────────
const nodeCapStore = freshStore({
  nodes: [
    { nodeId: 'C1', title: 'C1', acceptance: { kind: 'exists' }, budget: { maxTokens: 10 } },
    { nodeId: 'C2', title: 'C2', acceptance: { kind: 'exists' } },
  ],
});
nodeCapStore.journal.append('evidence_added', 'C1', { usageTokens: 10 });
assert.throws(() => assertBudget(nodeCapStore, 'C1', 1), { code: 'budget_exceeded' });
assertBudget(nodeCapStore, 'C2', 999_999, 'C2 没设节点上限，也不在任何有上限的分区里 → 应放行');
const nodeBlocked = budgetBlockedNodes(nodeCapStore);
assert.equal(nodeBlocked.get('C1').scope, 'node');
assert.equal(nodeBlocked.has('C2'), false);
console.log('PASS 5. 节点上限只作用于该节点，不影响同图其它节点');

// ── 6. 无任何预算上限时早退（不扫 journal，不累加 token）──────────────────
const noLimit = freshStore({
  nodes: [{ nodeId: 'F1', title: 'F1', acceptance: { kind: 'exists' } }],
});
// 塞 5000 条证据事件：如果 budgetBlockedNodes 没有早退，这里会明显变慢
for (let i = 0; i < 5000; i += 1) noLimit.journal.append('evidence_added', 'F1', { usageTokens: 1 });
const t0 = process.hrtime.bigint();
for (let i = 0; i < 200; i += 1) budgetBlockedNodes(noLimit);
const perCallMs = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
assert.equal(budgetBlockedNodes(noLimit).size, 0, '无上限时不该有任何节点被拦');
// 早退后成本与事件数无关：上限 0.05ms 在 5000 事件下只有量级意义，
// 真正被钉住的是「不随 journal 增长而增长」——有上限时同一指标会到毫秒级。
assert.ok(perCallMs < 0.05, `无上限时必须早退（不扫 journal），实测 ${perCallMs.toFixed(3)} ms/次`);
console.log(`PASS 6. 无预算上限时早退，不随 journal 增长（5000 事件下 ${perCallMs.toFixed(4)} ms/次）`);

console.log('\nPASS budget scope: 分区作用域隔离 / 祖先链传递 / 全图与节点上限 / 派活计划同口径 / 无上限零代价');
