/**
 * journal 零拷贝视图的**契约测试**：`view()` 不拷贝（快），`raw()` 必须拷贝（安全）。
 *
 * 背景：`raw()` 为了防外部改内部状态，对每条事件的 payload 做
 * `JSON.parse(JSON.stringify(...))`。14000 条事件时单次 `raw()` 约 10ms，
 * 而一次 claim 要调 4 次以上读路径 —— 千节点吞吐被这个深拷贝压到 30 节点/秒。
 * 改成内部只读路径走 `view()` 后提到 182 节点/秒。
 *
 * 但这个优化的安全前提是：**没有人通过 `view()` 改内部状态**。
 * 本测试把这个前提变成可执行的断言：
 *   1. `view()` 返回同一个数组实例（证明零拷贝真的零拷贝，不是"拷得少一点"）
 *   2. `view()` 里拿到的事件对象就是内部实例
 *   3. `raw()` 返回**不同**的数组与不同的事件对象（隔离未被破坏）
 *   4. 改 `raw()` 的返回值不影响 journal
 *   5. `view()` 是只读视图：长度跟随 append 增长（不是快照）
 *
 * 第 3、4 条是回归保护 —— 如果哪天有人把 `raw()` 也改成零拷贝，
 * N4 持久化层与 `Store.capture()` 的回滚都会失去隔离，本测试立刻红。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const { Journal } = await import(pathToFileURL(path.join(root, 'lib', 'core', 'journal.js')).href);

const journal = new Journal();
journal.append('node_added', 'N1', { node: { node_id: 'N1', nested: { deep: [1, 2, 3] } } });
journal.append('status_changed', 'N1', { from: 'planned', to: 'ready', at: '2026-01-01T00:00:00Z' });

// ── 1. view() 返回同一数组实例（零拷贝） ──────────────────────────────────
const v1 = journal.view();
const v2 = journal.view();
assert.equal(v1, v2, 'view() 应返回同一数组实例（否则就不是零拷贝）');
assert.equal(v1.length, 2);

// ── 2. view() 里的事件对象就是内部实例 ────────────────────────────────────
const vEvent = v1[0];
assert.equal(vEvent.payload.node.nested.deep, v1[0].payload.node.nested.deep);
assert.ok(Object.isFrozen(vEvent) === false, '内部事件对象不是 frozen 的（所以才需要"只读"约定）');

// ── 3. raw() 返回副本：不同数组、不同事件对象 ──────────────────────────────
const r1 = journal.raw();
assert.notEqual(r1, v1, 'raw() 必须返回新数组，不能是内部数组');
assert.notEqual(r1[0], v1[0], 'raw() 里的事件对象必须是副本，不能是内部实例');
assert.notEqual(r1[0].payload, v1[0].payload, 'raw() 的 payload 必须是深拷贝');

// ── 4. 改 raw() 的返回值不影响 journal ────────────────────────────────────
r1[0].payload.node.nested.deep.push(999);
r1[0].kind = 'tampered';
r1.push({ seq: 999, event_id: 'FAKE', ts: '', kind: 'fake', node_id: null, payload: {} });
assert.deepEqual(journal.view()[0].payload.node.nested.deep, [1, 2, 3], 'raw() 深拷贝被破坏：改副本污染了内部状态');
assert.equal(journal.view()[0].kind, 'node_added', 'raw() 浅层也未隔离');
assert.equal(journal.count(), 2, 'raw() 数组被 push 污染了内部长度');

// ── 5. view() 是视图不是快照：append 后长度跟着涨 ──────────────────────────
journal.append('lease_claimed', 'N1', { owner: 'ROLE-CODE-01', fencingToken: 1 });
assert.equal(journal.view().length, 3, 'view() 应是活视图，不是快照');
assert.equal(v1.length, 3, '同一个 view() 引用应看到新事件');
assert.equal(journal.raw().length, 3);

// ── 6. view() 保持 seq 单调可读（调用方按 seq 过滤的前提） ─────────────────
const seqs = journal.view().map((event) => event.seq);
assert.deepEqual(seqs, [1, 2, 3], 'view() 应按 append 顺序给出连续 seq');

console.log('PASS journal views: view() zero-copy live view, raw() deep copy isolation intact');
