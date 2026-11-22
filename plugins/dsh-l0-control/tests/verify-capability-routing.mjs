/**
 * 能力标签路由：**自由能力标签对所有 worker 开放，已知职务标签才做过滤**。
 *
 * 这是修一个真实功能失效的验收。旧实现把两种情况都按
 * `node.capability === worker.role` 等值比较，于是：
 *
 *   - 节点声明 `capability: "distributed-systems-analysis"`（自由标签）
 *   - worker 只能传 `role: "CODE" / "DESIGN" / …`（职务名）
 *   - 两者永远不相等 → **这个节点没有任何 worker 能领到**
 *
 * 工作图声明了需要什么能力，却没有一个执行载体能接 —— 自由能力标签形同废纸。
 *
 * 新规则：
 *
 * | 节点 capability | 语义 | 谁能领 |
 * |---|---|---|
 * | 已知职务（`CODE` / `AUDIT_CODE` …） | 「这类活归这个职务」 | 只有同职务 |
 * | 自由标签（`distributed-systems-analysis`） | 「需要这种能力」 | **所有 worker** |
 * | 未设 | 不限制 | 所有 worker |
 *
 * 为了让"自由标签开放"与"根本不过滤"可区分，节点顺序刻意安排成：
 * **先两个已知职务节点，再自由标签、再无标签**。于是不同 role 的
 * 第一个候选会分别落在不同节点上。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (n) => pathToFileURL(path.join(root, 'lib', n)).href;
const core = await import(lib('core/index.js'));

const dir = path.resolve(tempStateDir('cap-route'));
fs.mkdirSync(dir, { recursive: true });

// 时钟每次被读都前进 → created_at 严格递增，顺序可控
let now = 1_800_000_000_000;
const clock = { nowMs: () => now, nowIso: () => { now += 1000; return new Date(now).toISOString(); } };
const store = new core.Store({ clock });

const committed = core.commitGraph(store, {
  wish: '能力标签路由',
  policies: { maxParallel: 8 },
  nodes: [
    // ① 已知职务
    { nodeId: 'CODE-1', title: '职务 CODE', capability: 'CODE', acceptance: { kind: 'exists' } },
    { nodeId: 'AUDIT-1', title: '职务 AUDIT_CODE', capability: 'AUDIT_CODE', acceptance: { kind: 'exists' } },
    // ② 自由能力标签
    { nodeId: 'FREE-1', title: '自由标签', capability: 'distributed-systems-analysis', acceptance: { kind: 'exists' } },
    // ③ 未设 capability
    { nodeId: 'NOCAP-1', title: '无能力声明', acceptance: { kind: 'exists' } },
  ],
});
assert.equal(committed.ok, true, JSON.stringify(committed.errors ?? committed).slice(0, 300));
core.withCoreStore(store, () => core.bootstrap(store));

// `nextTask` 是 facade 函数，靠 AsyncLocalStorage 里的 store —— 必须 withCoreStore 包住，
// 否则它读到的是空的共享 store，返回 ready=[]、task=null（我第一次就栽在这）。
const next = (role) => core.withCoreStore(store, () => core.nextTask(role === undefined ? {} : { role }));

// ── 1. 已知职务匹配自己 ───────────────────────────────────────────────
{
  const r = next('CODE');
  assert.equal(r.task?.nodeId, 'CODE-1', `role=CODE 应拿 CODE-1，实际 ${r.task?.nodeId}`);
  assert.equal(r.role, 'CODE', 'role 应回显为大写');
}
{
  const r = next('audit_code'); // 大小写不敏感
  assert.equal(r.task?.nodeId, 'AUDIT-1', `role=audit_code 应拿 AUDIT-1，实际 ${r.task?.nodeId}`);
}
console.log('PASS 1. 已知职务标签：CODE→CODE-1，audit_code（小写）→AUDIT-1');

// ── 2. 已知职务不会互相串 ─────────────────────────────────────────────
{
  // role=CODE 不应该拿到 AUDIT-1；因为 CODE-1 排在前，第一个候选能区分
  const r = next('CODE');
  assert.notEqual(r.task?.nodeId, 'AUDIT-1', 'role=CODE 不得拿审计节点');
}
console.log('PASS 2. 已知职务不串台：CODE 不会领到 AUDIT-1');

// ── 3. **自由标签对所有人开放**（这是修复的核心）───────────────────────
for (const role of ['CODE', 'AUDIT_CODE', 'TEST', 'EVIDENCE', 'OPS', 'made-up-role-xyz']) {
  const r = next(role);
  // CODE-1 只给 CODE；AUDIT-1 只给 AUDIT_CODE；其余 role 都会被这两个挡住，
  // 然后落到 FREE-1（自由标签，对所有 worker 开放）
  const expected = role === 'CODE' ? 'CODE-1' : role === 'AUDIT_CODE' ? 'AUDIT-1' : 'FREE-1';
  assert.equal(r.task?.nodeId, expected, `role=${role} 应拿 ${expected}，实际 ${r.task?.nodeId}`);
}
console.log('PASS 3. 自由标签对所有 worker 开放：TEST / EVIDENCE / OPS / 未知角色 都能领到 FREE-1（旧实现全部返回 null）');

// ── 4. 未设 capability 的节点也对所有人开放 ───────────────────────────
{
  // 用正规 claim 把 FREE-1 领走（它会推进 store.epoch，让 readySet 的缓存失效；
  // 直接改 node.status 不会失效缓存，我第一次就栽在这）。
  core.claim(store, 'FREE-1', 'role-code-01', { ttlSec: 600 });
  const r = next('made-up-role-xyz');
  assert.equal(r.task?.nodeId, 'NOCAP-1', `无 capability 的节点应对所有人开放，实际 ${r.task?.nodeId}`);
}
console.log('PASS 4. 未设 capability 的节点同样对所有人开放（落到 NOCAP-1）');

// ── 5. 不传 role 时不过滤 ─────────────────────────────────────────────
{
  // 不预设顺序：`commitGraph` 内部的节点处理顺序不等于数组顺序（它要先建依赖关系），
  // 实测 created_at 顺序是 AUDIT-1 < CODE-1 < FREE-1 < NOCAP-1。
  // 所以这里只断言「不传 role 时 = readySet 的第一个」，不写死是哪个节点。
  const rs = core.withCoreStore(store, () => core.readySet(store));
  const r = next(undefined);
  assert.equal(r.task?.nodeId, rs[0], `不传 role 时 task 应是 readySet 的第一个，实际 ${r.task?.nodeId}`);
  assert.equal(r.role, null, '不传 role 时 role 字段为 null');
  assert.deepEqual(r.ready, rs, '不传 role 时 ready 就是全集，且顺序一致');
}
console.log('PASS 5. 不传 role 不过滤：task == readySet[0]，ready 是全集');

// ── 6. 全部是已知职务且都不匹配时，仍返回 null ────────────────────────
{
  // 只剩 CODE-1 / AUDIT-1 / NOCAP-1（FREE-1 已 claimed），role=TEST 应落到 NOCAP-1
  const r = next('TEST');
  assert.equal(r.task?.nodeId, 'NOCAP-1', `role=TEST 应落到无 capability 节点，实际 ${r.task?.nodeId}`);
  // 再把 NOCAP-1 也领走，就真的没有候选了（用 claim 而不是改 status —— 见组 4 的注释）
  core.claim(store, 'NOCAP-1', 'role-code-02', { ttlSec: 600 });
  const r2 = next('TEST');
  assert.equal(r2.task, null, '已知职务都不匹配且无自由标签节点时，task 为 null');
  assert.ok(r2.ready.length >= 2, 'ready 仍返回全集（不过滤）');
}
console.log('PASS 6. 无候选时 task=null，但 ready 仍是全集（不过滤）');

cleanupTempStateDirs();
console.log('\n全部通过：自由能力标签不再被职务等值比较废掉。');
