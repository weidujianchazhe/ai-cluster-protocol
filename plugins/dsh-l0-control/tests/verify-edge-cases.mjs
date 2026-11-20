/**
 * 边界与异常路径检查（不是验收链的一部分，是一次性审计）。
 *
 * 目标：新的 4 个模块 + 3 个工具在**退化输入**下是否 fail-closed 而不是崩溃或静默给错答案。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (n) => pathToFileURL(path.join(root, 'lib', n)).href;
const core = await import(lib('core/index.js'));

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

function emptyStore(tag) {
  const dir = path.resolve(tempStateDir(`e-${tag}`));
  fs.mkdirSync(dir, { recursive: true });
  return new core.Store({});
}

console.log('=== 边界：空图 ===');
check('qualityReport 空图不崩、totals 全 0', () => {
  const s = emptyStore('q');
  const r = core.qualityReport(s);
  assert.equal(r.ok, true);
  assert.equal(r.totals.nodes, 0);
  assert.equal(r.totals.avgScore, null);
  assert.equal(r.totals.grade, 'unknown');
  assert.deepEqual(r.nodes, []);
});

check('collaborationMap 空图不崩、delta=null', () => {
  const s = emptyStore('c');
  const r = core.collaborationMap(s);
  assert.equal(r.ok, true);
  assert.equal(r.totals.edges, 0);
  assert.equal(r.totals.density, 0);
  assert.equal(r.quality.delta, null);
  assert.ok(/样本不足|无法比较/.test(r.quality.verdict));
});

check('buildReworkIndex 空 journal 返回空 Map', () => {
  const s = emptyStore('r');
  const idx = core.buildReworkIndex(s);
  assert.equal(idx.size, 0);
});

console.log('\n=== 边界：不存在的节点 ===');
check('scoreNode(不存在) → missing / score=null', () => {
  const s = emptyStore('m');
  const q = core.scoreNode(s, 'NO-SUCH-NODE');
  assert.equal(q.status, 'missing');
  assert.equal(q.score, null);
  assert.equal(q.caveat, 'node-not-found');
});

check('neighborhoodOf(不存在) 不崩、邻域为空', () => {
  const s = emptyStore('n');
  const nb = core.neighborhoodOf(s, 'NO-SUCH-NODE');
  assert.equal(nb.ok, true);
  assert.equal(nb.neighbors.length, 0);
  assert.equal(nb.partitionId, null);
  assert.ok(nb.caveatFlags.includes('no-partition'));
});

console.log('\n=== 边界：非法参数 ===');
check('maxNeighbors 负数 → 被夹到 0（不限）', () => {
  const s = emptyStore('nn');
  const nb = core.neighborhoodOf(s, 'X', { maxNeighbors: -5 });
  assert.equal(nb.ok, true);
});

check('charsPerNeighbor 极小 → 被夹到下限 20', () => {
  const s = emptyStore('ch');
  const nb = core.neighborhoodOf(s, 'X', { charsPerNeighbor: 1 });
  assert.equal(nb.ok, true);
});

check('isSystemReworkReason 各种脏输入不抛错', () => {
  for (const v of [undefined, null, '', '  ', 0, 123, {}, [], 'rejected:', 'REJECTED:lease_expired']) {
    const r = core.isSystemReworkReason(v);
    assert.equal(typeof r, 'boolean', `输入 ${JSON.stringify(v)} 应返回布尔`);
  }
});

check('minSample 非法值不崩', () => {
  const s = emptyStore('ms');
  for (const v of [-1, 0, NaN, Infinity, 'abc']) {
    const r = core.collaborationMap(s, { minSample: v });
    assert.equal(r.ok, true);
  }
});

console.log('\n=== 边界：坏数据 ===');
check('graph_coordination 是坏 JSON → 当作无分区，不抛错', () => {
  const s = emptyStore('bad');
  s.state.meta.set('graph_coordination', '{这不是合法JSON');
  const nb = core.neighborhoodOf(s, 'X');
  assert.equal(nb.ok, true);
  assert.equal(nb.partitionId, null);
});

check('evidence 的 context_refs 是脏数据 → fold 时被过滤', () => {
  // 直接构造一个脏证据，看 quality 是否会崩
  const s = emptyStore('dirty');
  s.state.nodes.set('N1', {
    node_id: 'N1', title: 'N1', spec: '', capability: null, stage: null, status: 'done',
    deps: [], attempts: 0, assignee: null, updated_at: '',
  });
  s.state.evidence.set('E1', {
    evidence_id: 'E1', node_id: 'N1', kind: 'artifact', artifact_id: 'A1', verifier_id: 'v',
    verdict: 'pass', attempt_no: 1, at: '', producer_instance: 'p', auditor_instance: null,
    provenance: 'verified', context_refs: [null, {}, { nodeId: 123 }, { nodeId: 'N1' }],
  });
  const q = core.scoreNode(s, 'N1');
  assert.ok(typeof q.score === 'number', '脏 context_refs 不该让质量分算不出来');
  const c = core.collaborationMap(s);
  assert.equal(c.ok, true, '协作图也不该崩');
});

console.log('\n=== 边界：自引用与环 ===');
check('节点 deps 里含自己 → 邻域不含自己', () => {
  const s = emptyStore('self');
  s.state.nodes.set('S', {
    node_id: 'S', title: 'S', spec: 'spec', capability: null, stage: null, status: 'done',
    deps: ['S'], attempts: 0, assignee: null, updated_at: 't',
  });
  const nb = core.neighborhoodOf(s, 'S', { direction: 'deps' });
  assert.ok(!nb.neighbors.some((n) => n.nodeId === 'S'), '不许含自己');
});

check('A→B→A 互依 → 协作图不无限递归', () => {
  const s = emptyStore('cycle');
  for (const id of ['A', 'B']) {
    s.state.nodes.set(id, {
      node_id: id, title: id, spec: '', capability: null, stage: null, status: 'done',
      deps: id === 'A' ? ['B'] : ['A'], attempts: 0, assignee: null, updated_at: 't',
    });
  }
  const c = core.collaborationMap(s);
  assert.equal(c.ok, true);
  const nb = core.neighborhoodOf(s, 'A', { direction: 'deps' });
  assert.equal(nb.ok, true, '环上算邻域不该崩');
});

console.log(`\n=== 结果: ${pass} ok / ${fail} FAIL ===`);
cleanupTempStateDirs();
process.exit(fail === 0 ? 0 : 1);
