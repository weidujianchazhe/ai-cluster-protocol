/**
 * `task_next` 的可观测契约：**顺序、过滤、无副作用**。
 *
 * 第 32 轮把它内部的两次全图克隆去掉了（原来 `recomputeReady` 与 `nextTask` 各调一次
 * `listNodes()`，而 `listNodes()` 既排序全图又对每个节点 `cloneNode()`；千节点实测一次
 * 跑里 `task_next` 被调 2479 次才完成 1000 个节点）。改成 `readySet()`（只排序就绪子集、
 * 只产出 id）+ 全量重算不排序不克隆。
 *
 * 这类「换成更便宜的等价实现」的改动，唯一需要守住的是**可观测契约没变**：
 *
 *   1. `ready` 的顺序 == `readySet()` 的顺序（`created_at` → `node_id`）；
 *   2. `task` 是过滤后候选的第一个；
 *   3. `role` 过滤按 capability（大小写不敏感）；没有匹配时 `task === null` 但 `ready` 仍是全集；
 *   4. 依赖未完成的 `planned` 节点**永远**不出现在 `ready` 里；
 *   5. 调用不改变任何节点状态、不发租约。
 *
 * 构造上刻意让 **created_at 顺序与 node_id 字典序相反**（先建 `Z-ROOT`、后建 `A-ROOT`）：
 * 只按 node_id 排的实现会露馅，只按 created_at 排的实现才会得到 `['Z-ROOT','A-ROOT']`。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const lib = (name) => pathToFileURL(path.join(root, 'lib', name)).href;
const {
  Store, withCoreStore, commitGraph, bootstrap, nextTask, readySet, listNodes, getNode,
} = await import(lib('core/index.js'));

let now = 1_800_000_000_000;
// 时钟**每次被读都前进**：落图时 `created_at` 取 `nowIso()`，这样同一次提交里的节点
// 也会拿到严格递增的 created_at，从而能把「创建顺序」与「node_id 字典序」区分开。
const clock = { nowMs: () => now, nowIso: () => { now += 1000; return new Date(now).toISOString(); } };
const store = new Store({ clock });

// 两次落图：**跨提交的依赖不被允许**（`graph_commit` 只在同一份 spec 内校验 deps），
// 所以「先建 Z-ROOT、后建 A-ROOT」必须分两次提交才能拿到不同的 `created_at`，
// 而带依赖的 M-CHILD 要跟它的依赖放进同一份 spec。
const commit1 = commitGraph(store, {
  wish: 'task_next 契约',
  policies: { maxParallel: 8 },
  nodes: [{ nodeId: 'Z-ROOT', title: '先建但字典序靠后', capability: 'CODE', acceptance: { kind: 'exists' } }],
});
assert.equal(commit1.ok, true, `建图失败 Z-ROOT：${JSON.stringify(commit1.errors ?? commit1)}`);
now += 60_000; // 让两批节点的 created_at 明确分开
const commit2 = commitGraph(store, {
  wish: 'task_next 契约',
  policies: { maxParallel: 8 },
  nodes: [
    { nodeId: 'A-ROOT', title: '后建但字典序靠前', capability: 'AUDIT_CODE', acceptance: { kind: 'exists' } },
    { nodeId: 'M-CHILD', title: '依赖 A-ROOT', capability: 'CODE', deps: ['A-ROOT'], acceptance: { kind: 'exists' } },
  ],
});
assert.equal(commit2.ok, true, `建图失败 A-ROOT：${JSON.stringify(commit2.errors ?? commit2)}`);
withCoreStore(store, () => bootstrap(store));

// ── 1. 顺序由 created_at 决定，不是 node_id 字典序 ──────────────────────────
withCoreStore(store, () => {
  const result = nextTask({});
  assert.deepEqual(result.ready, ['Z-ROOT', 'A-ROOT'], `ready 应按 created_at 排序，实际 ${JSON.stringify(result.ready)}`);
  assert.deepEqual(result.ready, readySet(store), 'ready 顺序必须与 readySet() 一致');
  assert.equal(result.task.nodeId, 'Z-ROOT', 'task 应是候选的第一个');
});

// ── 2. 依赖未完成的 planned 节点永不出现在 ready ────────────────────────────
withCoreStore(store, () => {
  const ready = nextTask({}).ready;
  assert.ok(!ready.includes('M-CHILD'), 'M-CHILD 依赖未完成，不得就绪');
  assert.equal(getNode(store, 'M-CHILD').status, 'planned');
});

// ── 3. role 过滤：按 capability 大小写不敏感；无匹配时 task=null 但 ready 不减 ──
withCoreStore(store, () => {
  const codeOnly = nextTask({ role: 'code' });
  assert.equal(codeOnly.task.nodeId, 'Z-ROOT', 'capability=CODE 应匹配 role=code');
  assert.deepEqual(codeOnly.ready, readySet(store), 'role 过滤不影响 ready 全集');
  const audit = nextTask({ role: 'audit_code' });
  assert.equal(audit.task.nodeId, 'A-ROOT', 'role=audit_code 应匹配 capability=AUDIT_CODE');
  const none = nextTask({ role: 'NO_SUCH_ROLE' });
  assert.equal(none.task, null, '没有匹配时 task 为 null');
  assert.deepEqual(none.ready, readySet(store), 'task 为 null 时 ready 仍是全集');
});

// ── 4. 无副作用：不改状态、不发租约 ────────────────────────────────────────
withCoreStore(store, () => {
  const before = [...store.state.nodes.values()].map((n) => `${n.node_id}:${n.status}`).sort();
  const leasesBefore = store.state.leases.size;
  for (let i = 0; i < 5; i += 1) nextTask({});
  const after = [...store.state.nodes.values()].map((n) => `${n.node_id}:${n.status}`).sort();
  assert.deepEqual(after, before, 'nextTask 不得改节点状态');
  assert.equal(store.state.leases.size, leasesBefore, 'nextTask 不得发租约');
});

// ── 5. 就绪 ⇒ 依赖全都 done；planned 不得混进 ready ────────────────────────
withCoreStore(store, () => {
  const ready = nextTask({}).ready;
  for (const nodeId of ready) {
    for (const dep of getNode(store, nodeId).deps) {
      assert.equal(getNode(store, dep).status, 'done', `${nodeId} 就绪但依赖 ${dep} 未 done`);
    }
  }
  for (const node of listNodes(store)) {
    if (node.status === 'planned') assert.ok(!ready.includes(node.node_id), `${node.node_id} 是 planned 却出现在 ready`);
  }
});

console.log('PASS task_next 契约：created_at 优先 / 顺序==readySet / role 大小写不敏感 / 无副作用 / 就绪即依赖已 done');
