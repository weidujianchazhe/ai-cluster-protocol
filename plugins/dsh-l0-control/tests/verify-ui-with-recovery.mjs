/**
 * UI 侧车的 HTTP 契约：`?withRecovery=1` 必须真的透传到 `getSnapshot` 第 4 参。
 *
 * 为什么要单独测：`withRecovery` 是**性能开关**，写错了不会报错——只会
 * 面板每次 10 秒快照都白折叠一遍 journal（千级下每次几十毫秒）。这种"不报错的浪费"
 * 只能靠钉住参数传递来防。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const { startUiServer } = await import(pathToFileURL(path.join(root, 'lib', 'ui-server.js')).href);

const calls = [];
const handle = await startUiServer({
  host: '127.0.0.1',
  port: 0, // 交给系统分配，避免和真实侧车抢端口
  allowedOrigins: [],
  getSnapshot: (sessionId, workspaceRoot, sinceSeq, withRecovery) => {
    calls.push({ sessionId, workspaceRoot, sinceSeq, withRecovery });
    return { ok: true, sessionId: sessionId ?? null, withRecovery: withRecovery === true };
  },
});

const url = (suffix) => `${handle.url}/ui/snapshot${suffix}`;
const headers = { Origin: 'http://127.0.0.1:10504' };

try {
  // ── 1. 不带参数：withRecovery 应是 undefined（不是 false 也不是 true）────────
  const plain = await (await fetch(url(''), { headers })).json();
  assert.equal(plain.ok, true);
  assert.equal(calls.at(-1).withRecovery, undefined, `不带参数时不应传 withRecovery，实际 ${calls.at(-1).withRecovery}`);
  console.log('PASS 1. 不带 withRecovery → 透传 undefined（不误开）');

  // ── 2. withRecovery=1 → true ────────────────────────────────────────────
  const on = await (await fetch(url('?withRecovery=1'), { headers })).json();
  assert.equal(on.withRecovery, true);
  assert.equal(calls.at(-1).withRecovery, true);
  console.log('PASS 2. withRecovery=1 → 透传 true');

  // ── 3. withRecovery=true 也认（前端两种写法都出现）──────────────────────
  await (await fetch(url('?withRecovery=true'), { headers })).json();
  assert.equal(calls.at(-1).withRecovery, true);
  console.log('PASS 3. withRecovery=true → 透传 true');

  // ── 4. withRecovery=0 / 乱写 → undefined（不误开）────────────────────────
  await (await fetch(url('?withRecovery=0'), { headers })).json();
  assert.equal(calls.at(-1).withRecovery, undefined, `withRecovery=0 不应开启，实际 ${calls.at(-1).withRecovery}`);
  await (await fetch(url('?withRecovery=yes'), { headers })).json();
  assert.equal(calls.at(-1).withRecovery, undefined, 'withRecovery=yes 不应开启');
  console.log('PASS 4. withRecovery=0 / 乱写 → 不开启（只认 1/true）');

  // ── 5. 四个参数一起传，互不覆盖 ─────────────────────────────────────────
  await (await fetch(url('?sessionId=s-1&workspaceRoot=%2Ftmp%2Fws&sinceSeq=42&withRecovery=1'), { headers })).json();
  const combo = calls.at(-1);
  assert.equal(combo.sessionId, 's-1');
  assert.equal(combo.workspaceRoot, '/tmp/ws');
  assert.equal(combo.sinceSeq, 42);
  assert.equal(combo.withRecovery, true);
  console.log('PASS 5. sessionId/workspaceRoot/sinceSeq/withRecovery 四参并存');

  // ── 6. /ui/health 不该调用 getSnapshot（探测不能变成全量快照）─────────────
  const before = calls.length;
  const health = await (await fetch(`${handle.url}/ui/health`, { headers })).json();
  assert.equal(health.ok, true);
  assert.equal(calls.length, before, `健康探测不得调用 getSnapshot（多调了 ${calls.length - before} 次）`);
  console.log('PASS 6. /ui/health 不触发快照（探测必须是轻量的）');

  console.log('\nPASS ui withRecovery: 参数透传正确、只认 1/true、四参并存、health 不触发快照');
} finally {
  await handle.close();
}
