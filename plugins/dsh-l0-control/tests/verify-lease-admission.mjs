import assert from 'node:assert/strict';
import {
  Store, withCoreStore, graphCommit, graphStatus, claimTask, claim, release, takeover, foldEvents,
  budgetView, assertBudget, claimsInWindow,
} from '../lib/core/index.js';

let now = 1_800_000_000_000;
const clock = { nowMs: () => now, nowIso: () => new Date(now).toISOString() };
const store = new Store({ clock });
const nodes = ['A', 'B', 'C', 'D'].map((nodeId) => ({ nodeId, title: nodeId, acceptance: { kind: 'exists' } }));
withCoreStore(store, () => {
  assert.equal(graphCommit({ nodes, policies: { maxParallel: 3 }, coordination: {
    enabled: true, maxActive: 3, partitions: [
      { id: 'root', nodeRefs: [], maxActive: 1 },
      { id: 'left', parentId: 'root', nodeRefs: ['A', 'B'], maxActive: 1 },
      { id: 'right', parentId: 'root', nodeRefs: ['C'], maxActive: 1 },
    ],
  } }).ok, true);
});
const results = ['A', 'B', 'C', 'D'].map((nodeId) => {
  try { return { nodeId, lease: claim(store, nodeId, nodeId, { ttlSec: 1 }) }; }
  catch (error) { return { nodeId, error: error.code }; }
});
assert.deepEqual(results.filter((r) => r.lease).map((r) => r.nodeId), ['A', 'D']);
assert.deepEqual(results.filter((r) => r.error).map((r) => r.error), ['partition_capacity', 'partition_capacity']);
const journalBefore = store.journal.raw().length;
assert.throws(() => claim(store, 'B', 'B'), { code: 'partition_capacity' });
assert.equal(store.journal.raw().length, journalBefore);
assert.equal(store.state.leaseCounters.has('B'), false);
withCoreStore(store, () => assert.equal(claimTask({ nodeId: 'A', instanceId: 'A' }).alreadyHeld, true));
release(store, 'A', 'A', results[0].lease.fencing_token);
claim(store, 'B', 'B', { ttlSec: 10 });
now += 1001;
withCoreStore(store, () => assert.throws(() => claimTask({ nodeId: 'D', instanceId: 'D' }), { code: 'lease_expired' }));
// 过期接管也要重新走准入，并消费新额度。
store.state.meta.set('graph_max_parallel', '1');
assert.throws(() => takeover(store, 'D', 'next'), { code: 'graph_capacity' });
store.state.meta.set('graph_max_parallel', '3');
const recovered = new Store({ clock, state: foldEvents(store.journal.raw()) });
assert.equal(recovered.state.meta.get('graph_max_parallel'), '3');
assert.throws(() => claim(recovered, 'C', 'C'), { code: 'partition_capacity' });
assert.equal(takeover(recovered, 'D', 'next').fencing_token, 2);
release(recovered, 'B', 'B', recovered.state.leases.get('B').fencing_token);
assert.throws(() => claim(recovered, 'C', 'C', { hostLimit: 1 }), { code: 'graph_capacity' });

// 速率：本秒发放数由 journal 推导，超限即拒且不写任何状态。
const rateStore = new Store({ clock });
withCoreStore(rateStore, () => {
  assert.equal(graphCommit({ nodes: ['R1', 'R2', 'R3'].map((nodeId) => ({ nodeId, title: nodeId, acceptance: { kind: 'exists' } })) }).ok, true);
});
claim(rateStore, 'R1', 'R1', { ratePerSecond: 2 });
claim(rateStore, 'R2', 'R2', { ratePerSecond: 2 });
const rateBefore = rateStore.journal.raw().length;
assert.throws(() => claim(rateStore, 'R3', 'R3', { ratePerSecond: 2 }), { code: 'rate_limited' });
assert.equal(rateStore.journal.raw().length, rateBefore);
now += 1000;
claim(rateStore, 'R3', 'R3', { ratePerSecond: 2 });
assert.equal(claimsInWindow(rateStore, now, 1000), 1);

// 预算：全图 / 节点上限各自独立；只读视图与判定口径一致。
const budgetStore = new Store({ clock });
withCoreStore(budgetStore, () => {
  assert.equal(graphCommit({
    nodes: [{ nodeId: 'B1', title: 'B1', acceptance: { kind: 'exists' }, budget: { maxTokens: 100 } }],
    policies: { budgetTokens: 150 },
  }).ok, true);
});
assert.equal(budgetView(budgetStore).globalLimit, 150);
assert.equal(budgetView(budgetStore).nodes[0].limit, 100);
assert.throws(() => assertBudget(budgetStore, 'B1', 151), { code: 'budget_exceeded' });
assert.throws(() => assertBudget(budgetStore, 'B1', 101), { code: 'budget_exceeded' });
assertBudget(budgetStore, 'B1', 90);
withCoreStore(budgetStore, () => {
  const status = graphStatus();
  assert.equal(status.budget.total, 0);
  assert.equal(status.budget.globalLimit, 150);
});

console.log('PASS lease admission: concurrent contenders, ancestors, host/graph limits, rate window, budget caps, no-write failures, expiry, takeover and replay');
