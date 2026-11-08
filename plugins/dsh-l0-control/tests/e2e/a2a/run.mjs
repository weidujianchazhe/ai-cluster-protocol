/**
 * Lane P · A2A 最小传输 e2e（真实 HTTP 客户端 → 真实 node:http 服务 → 内存端口）
 *
 * 运行：node plugins/dsh-l0-control/tests/e2e/a2a/run.mjs [--json]
 * 依赖：Node ≥22.18（原生剥类型，直接 import `src/a2a/*.ts`；无需 build）
 *
 * 退出码（与仓库既有约定对齐）：
 *   0 全 pass · 1 drift（跑完但有降级） · 2 failed（断言失败） · 3 unknown（依赖缺失）
 *
 * 覆盖验收：Agent Card / 建任务 / 查状态 / cancel 映射 / 未授权 401 / 幂等（replay+conflict）
 *          + 403 租户 / 404 / 405 / 400 / 413 / 状态映射全表
 */
import { startA2AServer } from '../../../src/a2a/server.ts';
import { createA2ARouter } from '../../../src/a2a/router.ts';
import { buildAgentCard } from '../../../src/a2a/card.ts';
import { toA2ATask, toA2ATaskState, isCancelable } from '../../../src/a2a/mapping.ts';
import { PortError } from '../../../src/a2a/port.ts';

const TOKEN = 'test-token-abc123';
const TENANT = 'tenant-a';

// ── 内存端口（模拟主窗口 M4 的接线实现）─────────────────────────────
function createMockPort() {
  const nodes = new Map();
  const stats = { createCalls: 0, cancelCalls: 0, getCalls: 0 };
  let seq = 0;
  const stamp = () => new Date(1761800000000 + seq * 1000).toISOString();

  return {
    stats,
    nodes,
    async createTask(input) {
      stats.createCalls += 1;
      seq += 1;
      const nodeId = `NODE-A2A-${String(seq).padStart(3, '0')}`;
      const row = {
        nodeId,
        status: 'ready',
        revision: 1,
        teamTaskId: `task-${900 + seq}`,
        assignee: null,
        updatedAt: stamp(),
        contextId: `ctx-${nodeId}`,
        blockedReason: null,
      };
      nodes.set(nodeId, row);
      void input;
      return { taskId: nodeId, row };
    },
    async getTask(id) {
      stats.getCalls += 1;
      return nodes.get(id) ?? null;
    },
    async cancelTask(id, reason) {
      stats.cancelCalls += 1;
      const row = nodes.get(id);
      if (!row) return { kind: 'not-found', nodeId: id };
      if (['done', 'verifying', 'submitted'].includes(row.status)) {
        return { kind: 'not-cancelable', nodeId: id, status: row.status };
      }
      if (row.status === 'blocked' && String(row.blockedReason ?? '').startsWith('canceled:')) {
        return { kind: 'canceled', row };
      }
      const next = {
        ...row,
        status: 'blocked',
        blockedReason: `canceled:${reason ?? 'client-request'}`,
        revision: row.revision + 1,
        updatedAt: stamp(),
      };
      nodes.set(id, next);
      return { kind: 'canceled', row: next };
    },
  };
}

// ── 断言框架 ────────────────────────────────────────────────────
const results = [];
let currentSection = '';

function section(name) {
  currentSection = name;
}

async function test(id, name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ id, section: currentSection, name, status: 'pass', ms: Date.now() - started });
  } catch (error) {
    results.push({
      id,
      section: currentSection,
      name,
      status: 'fail',
      ms: Date.now() - started,
      error: String(error?.message ?? error),
    });
  }
}

function ok(value, message) {
  if (!value) throw new Error(message ?? 'expected truthy');
}

function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message ?? 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function contains(haystack, needle, message) {
  const text = typeof haystack === 'string' ? haystack : JSON.stringify(haystack);
  if (!text.includes(needle)) throw new Error(`${message ?? 'not contains'}: ${needle} ∉ ${text.slice(0, 300)}`);
}

// ── 服务启动 helper ─────────────────────────────────────────────
async function withServer(options, fn) {
  const port = createMockPort();
  const router = createA2ARouter({
    port,
    card: buildAgentCard({ url: 'http://placeholder' }),
    auth: options.auth ?? { tokens: [TOKEN] },
    config: options.config ?? { now: () => 1761800000000 },
  });
  const server = await startA2AServer({ router, maxBodyBytes: options.maxBodyBytes });
  try {
    return await fn({ base: server.url, port, router, server });
  } finally {
    await server.close();
  }
}

async function call(base, method, path, { token = TOKEN, key, body, raw, headers = {}, tenant } = {}) {
  const head = { ...headers };
  if (token !== null) head.authorization = `Bearer ${token}`;
  if (key !== undefined) head['idempotency-key'] = key;
  if (tenant !== undefined) head['x-a2a-tenant'] = tenant;
  if (body !== undefined || raw !== undefined) head['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method,
    headers: head,
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, headers: Object.fromEntries(response.headers), json, text };
}

// ── 主流程 ─────────────────────────────────────────────────────
async function main() {
  // 1. Agent Card
  section('card');
  await withServer({}, async ({ base }) => {
    await test('P1', 'GET /.well-known/agent-card.json 公开可读', async () => {
      const res = await call(base, 'GET', '/.well-known/agent-card.json', { token: null });
      eq(res.status, 200);
      eq(res.json?.name, 'dsh-l0-control');
      eq(res.json?.protocolVersion, '1.0');
      ok(Array.isArray(res.json?.skills) && res.json.skills.length >= 3, 'skills 应 ≥3');
      eq(res.json?.metadata?.stateAuthority, 'plugin-journal');
      eq(res.json?.metadata?.teamTaskRole, 'projection');
    });
    await test('P2', 'GET /a2a/agent-card 别名同样可读', async () => {
      const res = await call(base, 'GET', '/a2a/agent-card', { token: null });
      eq(res.status, 200);
      eq(res.json?.name, 'dsh-l0-control');
    });
  });

  // 2. 鉴权
  section('auth');
  await withServer({}, async ({ base, port }) => {
    await test('P3', '无 Authorization → 401 + WWW-Authenticate，且端口未被调用', async () => {
      const res = await call(base, 'POST', '/a2a/tasks', { token: null, key: 'k-401', body: { text: 'x' } });
      eq(res.status, 401);
      eq(res.json?.error?.code, 'unauthorized');
      contains(res.headers['www-authenticate'] ?? '', 'Bearer');
      eq(port.stats.createCalls, 0, '401 不得触达端口');
    });
    await test('P4', '错误 token → 401', async () => {
      const res = await call(base, 'POST', '/a2a/tasks', { token: 'wrong-token', key: 'k-401b', body: { text: 'x' } });
      eq(res.status, 401);
    });
    await test('P5', 'GET /a2a/tasks/:id 无 token → 401（不是 404，不泄漏存在性）', async () => {
      const res = await call(base, 'GET', '/a2a/tasks/NODE-A2A-999', { token: null });
      eq(res.status, 401);
    });
  });

  await withServer({ auth: { tokens: [TOKEN], requireTenant: TENANT } }, async ({ base }) => {
    await test('P6', '租户不匹配 → 403 tenant-mismatch', async () => {
      const res = await call(base, 'POST', '/a2a/tasks', { key: 'k-403', body: { text: 'x' }, tenant: 'tenant-b' });
      eq(res.status, 403);
      eq(res.json?.error?.code, 'tenant-mismatch');
    });
    await test('P7', '租户匹配 → 放行 201', async () => {
      const res = await call(base, 'POST', '/a2a/tasks', { key: 'k-tenant-ok', body: { text: 'tenant ok' }, tenant: TENANT });
      eq(res.status, 201);
    });
  });

  // 3. 建任务 / 幂等
  section('create+idempotency');
  await withServer({}, async ({ base, port }) => {
    let firstId = null;
    await test('P8', 'POST /a2a/tasks → 201 + Location + 状态 submitted', async () => {
      const res = await call(base, 'POST', '/a2a/tasks', {
        key: 'idem-1',
        body: { message: { role: 'user', parts: [{ kind: 'text', text: '建一个 CRUD 后端节点' }] } },
      });
      eq(res.status, 201);
      firstId = res.json?.id;
      ok(typeof firstId === 'string' && firstId.startsWith('NODE-A2A-'), 'id 应是节点 id');
      eq(res.json?.status?.state, 'submitted', 'ready → submitted');
      eq(res.json?.metadata?.nodeId, firstId);
      eq(res.json?.metadata?.nativeStatus, 'ready');
      eq(res.json?.metadata?.teamTaskId, 'task-901');
      eq(res.headers.location, `/a2a/tasks/${firstId}`);
      eq(res.headers['idempotent-replay'], 'false');
      eq(res.headers['x-a2a-cancelable'], 'true');
      eq(port.stats.createCalls, 1);
    });

    await test('P9', '同键同体 → replay（200、同 id、端口只建一次）', async () => {
      const body = { message: { role: 'user', parts: [{ kind: 'text', text: '建一个 CRUD 后端节点' }] } };
      const res = await call(base, 'POST', '/a2a/tasks', { key: 'idem-1', body });
      eq(res.status, 200);
      eq(res.json?.id, firstId);
      eq(res.headers['idempotent-replay'], 'true');
      eq(port.stats.createCalls, 1, 'replay 不得重复建节点');
    });

    await test('P10', '同键异体 → 409 idempotency-conflict', async () => {
      const res = await call(base, 'POST', '/a2a/tasks', {
        key: 'idem-1',
        body: { message: { role: 'user', parts: [{ kind: 'text', text: '完全不同的诉求' }] } },
      });
      eq(res.status, 409);
      eq(res.json?.error?.code, 'idempotency-conflict');
      eq(port.stats.createCalls, 1);
    });

    await test('P11', '缺 Idempotency-Key → 400 idempotency-key-required', async () => {
      const res = await call(base, 'POST', '/a2a/tasks', { body: { text: 'no key' } });
      eq(res.status, 400);
      eq(res.json?.error?.code, 'idempotency-key-required');
    });

    await test('P12', '非法 JSON → 400 invalid-json', async () => {
      const res = await call(base, 'POST', '/a2a/tasks', { key: 'k-bad', raw: '{' });
      eq(res.status, 400);
      eq(res.json?.error?.code, 'invalid-json');
    });

    await test('P13', '空诉求 → 400 invalid-task-request', async () => {
      const res = await call(base, 'POST', '/a2a/tasks', { key: 'k-empty', body: {} });
      eq(res.status, 400);
      eq(res.json?.error?.code, 'invalid-task-request');
    });

    await test('P14', '失败不占键：同键重试可再建', async () => {
      const bad = await call(base, 'POST', '/a2a/tasks', { key: 'k-retry', raw: '{' });
      eq(bad.status, 400);
      const good = await call(base, 'POST', '/a2a/tasks', { key: 'k-retry', body: { text: '重试成功' } });
      eq(good.status, 201, '失败的 key 不应残留');
    });
  });

  // 4. 查状态
  section('query');
  await withServer({}, async ({ base }) => {
    let nodeId = null;
    await test('P15', '建任务后 GET /a2a/tasks/:id 返回同一节点', async () => {
      const created = await call(base, 'POST', '/a2a/tasks', { key: 'q-1', body: { text: '查询用节点' } });
      nodeId = created.json?.id;
      const res = await call(base, 'GET', `/a2a/tasks/${nodeId}`);
      eq(res.status, 200);
      eq(res.json?.id, nodeId);
      eq(res.json?.status?.state, 'submitted');
      eq(res.json?.metadata?.revision, 1);
      eq(res.headers['x-a2a-cancelable'], 'true');
    });
    await test('P16', '未知 id → 404 task-not-found', async () => {
      const res = await call(base, 'GET', '/a2a/tasks/NODE-NOPE');
      eq(res.status, 404);
      eq(res.json?.error?.code, 'task-not-found');
    });
    await test('P17', '未知路由 → 404 not-found', async () => {
      const res = await call(base, 'GET', '/a2a/nope');
      eq(res.status, 404);
      eq(res.json?.error?.code, 'not-found');
    });
    await test('P18', 'GET /a2a/tasks（方法不匹配）→ 405 + Allow', async () => {
      const res = await call(base, 'GET', '/a2a/tasks');
      eq(res.status, 405);
      eq(res.headers.allow, 'POST');
    });
    await test('P19', 'DELETE 任务 → 405（不实现删除）', async () => {
      const res = await call(base, 'DELETE', `/a2a/tasks/${nodeId}`);
      eq(res.status, 405);
    });
  });

  // 5. cancel 映射
  section('cancel');
  await withServer({}, async ({ base, port }) => {
    let nodeId = null;
    await test('P20', 'cancel → 200 state=canceled（图里落 blocked:canceled:*）', async () => {
      const created = await call(base, 'POST', '/a2a/tasks', { key: 'c-1', body: { text: '要取消的节点' } });
      nodeId = created.json?.id;
      const res = await call(base, 'POST', `/a2a/tasks/${nodeId}/cancel`, { body: { reason: '不需要了' } });
      eq(res.status, 200);
      eq(res.json?.status?.state, 'canceled');
      eq(res.json?.metadata?.nativeStatus, 'blocked');
      eq(res.json?.metadata?.revision, 2);
      eq(port.stats.cancelCalls, 1);
    });
    await test('P21', 'cancel 后 GET 仍读到 canceled（映射稳定）', async () => {
      const res = await call(base, 'GET', `/a2a/tasks/${nodeId}`);
      eq(res.status, 200);
      eq(res.json?.status?.state, 'canceled');
      eq(res.headers['x-a2a-cancelable'], 'true', 'blocked 仍可再 cancel（幂等）');
    });
    await test('P22', '重复 cancel 幂等 → 200 canceled（不报错、不重复改图）', async () => {
      const before = port.nodes.get(nodeId)?.revision;
      const res = await call(base, 'POST', `/a2a/tasks/${nodeId}/cancel`, { body: {} });
      eq(res.status, 200);
      eq(res.json?.status?.state, 'canceled');
      eq(port.nodes.get(nodeId)?.revision, before, '幂等 cancel 不得再涨 revision');
    });
    await test('P23', 'done 节点 cancel → 409 task-not-cancelable', async () => {
      const done = { nodeId: 'NODE-DONE', status: 'done', revision: 5, teamTaskId: null, updatedAt: '2026-10-29T00:00:00.000Z' };
      port.nodes.set(done.nodeId, done);
      const res = await call(base, 'POST', '/a2a/tasks/NODE-DONE/cancel', { body: {} });
      eq(res.status, 409);
      eq(res.json?.error?.code, 'task-not-cancelable');
      eq(res.json?.error?.details?.status, 'done');
    });
    await test('P24', 'verifying 节点 cancel → 409（证据门禁期不可撤）', async () => {
      port.nodes.set('NODE-VERIFY', { nodeId: 'NODE-VERIFY', status: 'verifying', revision: 3 });
      const res = await call(base, 'POST', '/a2a/tasks/NODE-VERIFY/cancel', { body: {} });
      eq(res.status, 409);
    });
    await test('P25', '取消不存在的任务 → 404', async () => {
      const res = await call(base, 'POST', '/a2a/tasks/NODE-GHOST/cancel', { body: {} });
      eq(res.status, 404);
      eq(res.json?.error?.code, 'task-not-found');
    });
  });

  // 6. 状态映射全表（纯函数）
  section('mapping');
  await test('P26', '8 个原生状态全覆盖映射', async () => {
    const expect = {
      planned: 'submitted',
      ready: 'submitted',
      claimed: 'working',
      running: 'working',
      submitted: 'working',
      verifying: 'working',
      blocked: 'input-required',
      done: 'completed',
    };
    for (const [native, a2a] of Object.entries(expect)) {
      eq(toA2ATaskState(native), a2a, `映射 ${native}`);
    }
  });
  await test('P27', '未知状态 → unknown（不猜 completed）', async () => {
    eq(toA2ATaskState('weird-status'), 'unknown');
    eq(toA2ATaskState(''), 'unknown');
  });
  await test('P28', 'blocked + canceled:* → canceled', async () => {
    eq(toA2ATaskState('blocked', 'canceled:no-longer-needed'), 'canceled');
    eq(toA2ATaskState('blocked', 'waiting-human'), 'input-required');
  });
  await test('P29', 'cancelable 白名单 = {ready,claimed,running,blocked}', async () => {
    for (const s of ['ready', 'claimed', 'running', 'blocked']) ok(isCancelable(s), `${s} 应可取消`);
    for (const s of ['planned', 'submitted', 'verifying', 'done']) ok(!isCancelable(s), `${s} 不应可取消`);
  });
  await test('P30', '产物 → artifacts 数组（path 兜底为 text）', async () => {
    const task = toA2ATask({
      nodeId: 'NODE-ART',
      status: 'done',
      revision: 9,
      artifacts: [{ path: 'out/a.md', text: '# A' }, { path: 'out/b.json' }],
    });
    eq(task.status.state, 'completed');
    eq(task.artifacts?.length, 2);
    eq(task.artifacts?.[0]?.parts?.[0]?.text, '# A');
    eq(task.artifacts?.[1]?.parts?.[0]?.text, 'out/b.json');
  });

  // 7. 端口异常映射
  section('port-errors');
  await withServer({}, async ({ base, port }) => {
    await test('P31', '端口抛 PortError(409) → 409 且不透堆栈', async () => {
      const created = await call(base, 'POST', '/a2a/tasks', { key: 'e-1', body: { text: '异常节点' } });
      const nodeId = created.json?.id;
      const original = port.getTask.bind(port);
      port.getTask = async () => {
        throw new PortError('state-conflict', '图修订冲突', 409, { revision: 7 });
      };
      const res = await call(base, 'GET', `/a2a/tasks/${nodeId}`);
      eq(res.status, 409);
      eq(res.json?.error?.code, 'state-conflict');
      eq(res.json?.error?.details?.revision, 7);
      ok(!res.text.includes('at '), '不得回传堆栈');
      port.getTask = original;
    });
    await test('P32', '端口抛普通 Error → 500 internal（不泄漏细节）', async () => {
      const original = port.getTask.bind(port);
      port.getTask = async () => {
        throw new Error('secret internal detail');
      };
      const res = await call(base, 'GET', '/a2a/tasks/NODE-X');
      eq(res.status, 500);
      eq(res.json?.error?.code, 'internal');
      ok(!res.text.includes('secret internal detail'), '不得泄漏内部消息');
      port.getTask = original;
    });
  });

  // 8. 体量限制
  section('limits');
  await withServer({ maxBodyBytes: 64 }, async ({ base }) => {
    await test('P33', '超大请求体 → 413 payload-too-large', async () => {
      const big = { text: 'x'.repeat(200) };
      const res = await call(base, 'POST', '/a2a/tasks', { key: 'big-1', body: big });
      eq(res.status, 413);
      eq(res.json?.error?.code, 'payload-too-large');
    });
  });

  // 9. A2A JSON-RPC 2.0 信封
  section('jsonrpc');
  await withServer({}, async ({ base, port }) => {
    let nodeId = null;
    const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

    await test('R1', 'message/send → JSON-RPC result（A2A Task，200）', async () => {
      const res = await call(base, 'POST', '/a2a', {
        body: rpc('r1', 'message/send', {
          message: { role: 'user', parts: [{ kind: 'text', text: 'JSON-RPC 建节点' }], messageId: 'msg-r1' },
        }),
      });
      eq(res.status, 200);
      eq(res.json?.jsonrpc, '2.0');
      eq(res.json?.id, 'r1');
      nodeId = res.json?.result?.id;
      ok(typeof nodeId === 'string' && nodeId.startsWith('NODE-A2A-'), 'result.id 应是节点 id');
      eq(res.json?.result?.status?.state, 'submitted');
      eq(res.json?.result?.metadata?.nodeId, nodeId);
      eq(port.stats.createCalls, 1);
    });

    await test('R2', 'tasks/get → JSON-RPC result（同一节点）', async () => {
      const res = await call(base, 'POST', '/a2a', { body: rpc(2, 'tasks/get', { id: nodeId }) });
      eq(res.status, 200);
      eq(res.json?.id, 2);
      eq(res.json?.result?.id, nodeId);
      eq(res.json?.result?.status?.state, 'submitted');
    });

    await test('R3', 'message/send 同 messageId 重放 → 同 id、不重复建', async () => {
      const envelope = rpc('r3', 'message/send', {
        message: { role: 'user', parts: [{ kind: 'text', text: 'JSON-RPC 建节点' }], messageId: 'msg-r1' },
      });
      const res = await call(base, 'POST', '/a2a', { body: envelope });
      eq(res.status, 200);
      eq(res.json?.result?.id, nodeId);
      eq(port.stats.createCalls, 1, '重放不得重复建节点');
    });

    await test('R4', 'tasks/cancel → JSON-RPC result state=canceled', async () => {
      const res = await call(base, 'POST', '/a2a', {
        body: rpc('r4', 'tasks/cancel', { id: nodeId, reason: 'rpctest' }),
      });
      eq(res.status, 200);
      eq(res.json?.result?.status?.state, 'canceled');
      eq(res.json?.result?.metadata?.nativeStatus, 'blocked');
      eq(port.stats.cancelCalls, 1);
    });

    await test('R5', '未知 method → -32601 + supported[]', async () => {
      const res = await call(base, 'POST', '/a2a', { body: rpc('r5', 'message/stream', {}) });
      eq(res.status, 200);
      eq(res.json?.error?.code, -32601);
      ok(Array.isArray(res.json?.error?.data?.supported), '应带 supported 列表');
      ok(res.json.error.data.supported.includes('message/send'), 'supported 应含 message/send');
    });

    await test('R6', 'message/send 缺文本 → -32602', async () => {
      const res = await call(base, 'POST', '/a2a', { body: rpc('r6', 'message/send', { message: { parts: [] } }) });
      eq(res.status, 200);
      eq(res.json?.error?.code, -32602);
    });

    await test('R7', '非法 JSON → -32700（HTTP 200）', async () => {
      const res = await call(base, 'POST', '/a2a', { raw: '{' });
      eq(res.status, 200);
      eq(res.json?.error?.code, -32700);
      eq(res.json?.id, null);
    });

    await test('R8', '缺 jsonrpc/method → -32600', async () => {
      const res = await call(base, 'POST', '/a2a', { body: { id: 'bad', method: 'tasks/get', params: {} } });
      eq(res.status, 200);
      eq(res.json?.error?.code, -32600);
    });

    await test('R9', 'JSON-RPC 端点无 token → HTTP 401（传输层）', async () => {
      const res = await call(base, 'POST', '/a2a', {
        token: null,
        body: rpc('r9', 'tasks/get', { id: nodeId }),
      });
      eq(res.status, 401);
      eq(res.json?.error?.code, 'unauthorized');
    });
  });

  // ── 汇总 ──────────────────────────────────────────────────
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail');
  const payload = {
    ok: failed.length === 0,
    lane: 'P',
    suite: 'a2a',
    total: results.length,
    passed,
    failed: failed.length,
    exitCode: failed.length === 0 ? 0 : 2,
    sections: [...new Set(results.map((r) => r.section))],
    results,
  };

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    for (const r of results) {
      const mark = r.status === 'pass' ? 'PASS' : 'FAIL';
      process.stdout.write(`${mark} ${r.id} ${r.name}${r.error ? `\n     ↳ ${r.error}` : ''}\n`);
    }
    process.stdout.write(`\n${passed}/${results.length} passed${failed.length ? `, ${failed.length} failed` : ''}\n`);
  }
  return payload.exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`suite crashed: ${String(error?.stack ?? error)}\n`);
    process.exit(3);
  });
