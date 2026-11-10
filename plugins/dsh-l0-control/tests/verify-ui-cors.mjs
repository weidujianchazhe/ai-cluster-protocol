#!/usr/bin/env node
/**
 * UI 服务的跨源判定自检（真实起服务、真实发请求）。
 *
 * 覆盖三类"面板连不上"的历史真因：
 *   1. 端口写死 → 由面板运行时解析（另测），这里只保证服务端不按端口设卡；
 *   2. `Origin: null`（sandboxed iframe / blob）；
 *   3. `dsh-app://app`（DSH 桌面端自定义协议）——只认 http 回环会让面板永久不可达。
 * 外部站点必须继续 403；预检必须回对应 ACAO。
 */
import assert from 'node:assert/strict';
import { startUiServer } from '../lib/ui-server.js';

const handle = await startUiServer({
  host: '127.0.0.1',
  port: 0,
  getSnapshot: () => ({ ok: true, probe: 'snapshot' }),
  getCluster: () => ({ ok: true }),
  getAgents: () => ({ ok: true, total: 3, running: 1, idle: 2, withLease: 1, byRole: { CODE: 3 }, items: [] }),
  onRejectedOrigin: () => {},
});
const base = handle.url;
const results = [];

const check = async (label, origin, expectStatus, expectAcao) => {
  const headers = origin ? { origin, accept: 'application/json' } : { accept: 'application/json' };
  const res = await fetch(`${base}/ui/health`, { headers });
  const acao = res.headers.get('access-control-allow-origin');
  results.push({ label, status: res.status, acao });
  assert.equal(res.status, expectStatus, `${label}: status ${res.status} != ${expectStatus}`);
  if (expectAcao !== undefined) {
    assert.equal(acao, expectAcao, `${label}: ACAO ${acao} != ${expectAcao}`);
  }
};

// 允许：桌面自定义协议 / opaque / 回环
await check('dsh-app://app', 'dsh-app://app', 200, 'dsh-app://app');
await check('Origin: null', 'null', 200, 'null');
await check('loopback any port', 'http://127.0.0.1:14511', 200, 'http://127.0.0.1:14511');
await check('localhost', 'http://localhost:9', 200, 'http://localhost:9');
await check('无 Origin（本机直连）', null, 200, undefined);

// 拒绝：外部站点 / 非回环 http
await check('external', 'https://evil.example.com', 403, undefined);
await check('non-loopback http', 'http://192.168.1.5:8080', 403, undefined);

// 预检：允许的来源回 204 + ACAO；外部 403
for (const [origin, expect] of [['dsh-app://app', 204], ['null', 204], ['https://evil.example.com', 403]]) {
  const res = await fetch(`${base}/ui/access`, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
      'access-control-request-private-network': 'true',
    },
  });
  assert.equal(res.status, expect, `预检 ${origin}: ${res.status} != ${expect}`);
  if (expect === 204) {
    assert.equal(res.headers.get('access-control-allow-private-network'), 'true', '预检应允许私有网络');
  }
}

// /ui/agents 在 dsh-app 来源下可用
const agents = await fetch(`${base}/ui/agents`, { headers: { origin: 'dsh-app://app' } });
assert.equal(agents.status, 200);
const roster = await agents.json();
assert.equal(roster.total, 3);

await handle.close();
console.log(`PASS ui-cors: ${results.length + 4} 项（dsh-app / null / 回环放行，外部与私网 http 拒绝，预检合规）`);
