// 离线验证：修复后 planGraph 的返回值不再含 undefined（宿主 lossless-JSON 校验通过）
import { planGraph } from '../lib/core/graphspec.js';

function collectUndefined(value, path = '$', out = []) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectUndefined(item, `${path}[${i}]`, out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) out.push(`${path}.${k}`);
      else collectUndefined(v, `${path}.${k}`, out);
    }
  }
  return out;
}

const cases = [
  ['无 designBoundary / coordination', { wish: 'probe', nodes: [{ nodeId: 'A', title: 'a', capability: 'CODE', stage: 'build', deps: [] }] }],
  ['只给 designBoundary', { wish: 'probe', designBoundary: { maxNodes: 3, complexity: 'small' }, nodes: [{ nodeId: 'A', title: 'a', capability: 'CODE', stage: 'build', deps: [] }] }],
  ['全给', { wish: 'probe', designBoundary: { maxNodes: 3 }, coordination: { enabled: false }, nodes: [{ nodeId: 'A', title: 'a', capability: 'CODE', stage: 'build', deps: [] }] }],
];

let bad = 0;
for (const [label, spec] of cases) {
  const out = planGraph(spec);
  const undef = collectUndefined(out);
  const keys = ['designBoundary', 'coordination'];
  const nulled = keys.map((k) => `${k}=${out[k] === null ? 'null' : typeof out[k]}`).join(' ');
  console.log(`${undef.length === 0 ? 'PASS' : 'FAIL'}  ${label}  planId=${out.planId}  ${nulled}  undefined=${undef.length}${undef.length ? ' -> ' + undef.join(',') : ''}`);
  if (undef.length) bad += 1;
}
console.log(bad === 0 ? '\nALL PASS' : `\nFAILED: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
