import assert from 'node:assert/strict';
import { Store, withCoreStore, graphCommit, graphStatus, addNode } from '../lib/core/index.js';

const a = new Store();
const b = new Store();
const add = (store, nodeId) => addNode(store, { nodeId, title: nodeId, spec: nodeId, stage: 'build', deps: [] });

const run = async (store, nodeId, pauseMs) => withCoreStore(store, async () => {
  add(store, nodeId);
  await new Promise((resolve) => setTimeout(resolve, pauseMs));
  add(store, `${nodeId}-2`);
  return graphStatus().counts;
});

const [countsA, countsB] = await Promise.all([run(a, 'A', 15), run(b, 'B', 0)]);
assert.deepEqual(countsA, { nodes: 2, edges: 0, done: 0, blocked: 0 });
assert.deepEqual(countsB, { nodes: 2, edges: 0, done: 0, blocked: 0 });
assert.deepEqual([...a.state.nodes.keys()].sort(), ['A', 'A-2']);
assert.deepEqual([...b.state.nodes.keys()].sort(), ['B', 'B-2']);
console.log('PASS per-async-scope core store isolation under interleaving');
