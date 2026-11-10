/**
 * 只读 UI 侧车：给 `@local/dsh-l0-control-ui` 面板提供快照。
 *
 * 边界：
 *   - 仅 GET/OPTIONS，无写路径；绑定 127.0.0.1；不参与控制面决策。
 *   - 数据来自 L0ControlService.uiSnapshot()（journal + graph + team_status 缓存 + 工作区目录）。
 *   - 端口冲突/启动失败只记 journal，不影响插件主功能。
 */
import http from 'node:http';

export interface UiServerOptions {
  host?: string;
  port?: number;
  /** 额外允许的 Origin（反代/自定义域名场景）；回环 host 默认已放行，无需在此重复列出。 */
  allowedOrigins?: string[];
  /** `sessionId` 来自 `?sessionId=`；`workspaceRoot` 来自 `?workspaceRoot=`；`sinceSeq` 来自 `?sinceSeq=`（黑板增量）。 */
  getSnapshot: (sessionId?: string, workspaceRoot?: string, sinceSeq?: number) => unknown | Promise<unknown>;
  /** 工作区 registry 列表 + 各自 counts（`/ui/workspaces`）。 */
  getWorkspaces?: () => unknown | Promise<unknown>;
  /** 用目标 session 的 Agent 重新读一次 team_status，填充该 session 快照。 */
  refreshTeam?: (input: { workspaceRoot?: string; sessionId?: string }) => unknown | Promise<unknown>;
  /** 读某对话的启用状态（缺省 = 恒 disabled）。 */
  getAccess?: (sessionId?: string, workspaceRoot?: string) => unknown;
  /** 工作区集群状态（clusterId/default/enabledAt）。 */
  getCluster?: (workspaceRoot?: string) => unknown;
  /** 智能体花名册（从 journal 折叠；不依赖 team_status 与活 Agent）。 */
  getAgents?: (workspaceRoot?: string) => unknown;
  /** 第一次启用工作区集群；可同时启用当前 session。 */
  enableCluster?: (input: { workspaceRoot?: string; sessionId?: string }) => unknown;
  /** 启用/停用某对话（coordination / management 两个轴独立）；写 journal `access_changed`。 */
  setAccess?: (input: { sessionId: string; enabled?: boolean; coordination?: boolean; management?: string; by?: string; workspaceRoot?: string }) => unknown;
  /** 检查更新（只检查，不 apply）；返回 `{ok, available, currentVersion, latestVersion, ...}`。 */
  getUpdateInfo?: () => unknown | Promise<unknown>;
  /** 从面板建项目：`{workspaceRoot, projectName, wish, dryRun, sessionId}`（受 management 轴约束）。 */
  projectInit?: (input: {
    workspaceRoot?: string;
    projectName?: string;
    wish?: string;
    dryRun?: boolean;
    sessionId?: string;
  }) => unknown | Promise<unknown>;
}

export interface UiServerHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

const JSON_TYPE = 'application/json; charset=utf-8';

/**
 * CORS Origin 判定：**本机回环 host 的全部端口** + 显式追加白名单。
 *
 * 为什么不再写死端口：上一版把白名单定成 `127.0.0.1:11288`，而 DSH GUI 的端口是**会变的**
 * （实测从 11288 变成 5291），端口一换面板就 `origin-forbidden` → 浏览器侧只看到
 * `Failed to fetch`，看起来像"侧车没启动"，排查方向会被完全带偏。
 *
 * 安全边界：只放 host ∈ {127.0.0.1, localhost, 0.0.0.0, [::1], ::1} 的 origin，
 * 外部站点（`https://evil.com`）仍一律 403；`null`/`file://` 也拒。
 * 本机其它端口的页面在理论上仍可发请求，但 POST 全是 `content-type: application/json`
 * （必触发预检），预检同样走本判定，非回环源拿不到 CORS 头即被浏览器拦。
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '[::1]', '::1']);

/** 解析 Origin；非 `http(s)` / 解析失败 / 非回环 host → undefined。 */
function parseLoopbackOrigin(origin: string): string | undefined {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const hostname = url.hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(hostname) ? origin : undefined;
}

function allowedOrigin(req: http.IncomingMessage, extraOrigins?: readonly string[]): string | undefined {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin) return undefined;
  if (Array.isArray(extraOrigins) && extraOrigins.includes(origin)) return origin;
  return parseLoopbackOrigin(origin);
}

/** 读 JSON body（限 64KB，防止误传大包）。 */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 64 * 1024) throw new Error('body-too-large');
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  // CORS 响应头由请求处理入口按 Origin 白名单设置（见 startUiServer），此处不发 `*`。
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

export async function startUiServer(options: UiServerOptions): Promise<UiServerHandle> {
  const host = options.host || '127.0.0.1';
  const port = Number(options.port ?? 47831);
  const server = http.createServer(async (req, res) => {
    const method = String(req.method || 'GET').toUpperCase();
    const rawUrl = String(req.url || '/');
    const path = rawUrl.split('?')[0];
    let sessionId: string | undefined;
    let workspaceRoot: string | undefined;
    let sinceSeq: number | undefined;
    try {
      const query = new URLSearchParams(rawUrl.split('?')[1] ?? '');
      const value = query.get('sessionId');
      if (value && String(value).trim()) sessionId = String(value).trim();
      const ws = query.get('workspaceRoot');
      if (ws && String(ws).trim()) workspaceRoot = String(ws).trim();
      const since = query.get('sinceSeq');
      if (since && Number.isFinite(Number(since))) sinceSeq = Math.max(0, Math.floor(Number(since)));
    } catch {
      sessionId = undefined;
      workspaceRoot = undefined;
      sinceSeq = undefined;
    }
    const origin = allowedOrigin(req, options.allowedOrigins);
    const hasOrigin = typeof req.headers.origin === 'string' && req.headers.origin.length > 0;
    // Chromium 的「本地网络访问」策略：页面去请求 127.0.0.1 上的另一个端口时，
    // 预检会带 `Access-Control-Request-Private-Network: true`，服务端必须回
    // `Access-Control-Allow-Private-Network: true`，否则浏览器直接判失败——
    // 表现就是面板报 Failed to fetch，而用 node/curl 测同一个 URL 却是 200。
    const wantsPrivateNetwork = String(req.headers['access-control-request-private-network'] ?? '').toLowerCase() === 'true';
    if (method === 'OPTIONS') {
      if (!origin) {
        send(res, 403, { ok: false, error: 'origin-forbidden' });
        return;
      }
      const headers: Record<string, string | number> = {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, accept',
        vary: 'Origin',
      };
      if (wantsPrivateNetwork) headers['access-control-allow-private-network'] = 'true';
      res.writeHead(204, headers);
      res.end();
      return;
    }
    // Origin 白名单校验：带 Origin 但不在白名单 → 403；POST 必须带白名单 Origin（无 Origin 视为跨站，拒绝）。
    if ((hasOrigin && !origin) || (method === 'POST' && !origin)) {
      send(res, 403, { ok: false, error: 'origin-forbidden' });
      return;
    }
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      if (wantsPrivateNetwork) res.setHeader('access-control-allow-private-network', 'true');
    }
    // GET /ui/cluster：工作区集群状态
    if (method === 'GET' && path === '/ui/cluster') {
      if (typeof options.getCluster !== 'function') {
        send(res, 501, { ok: false, error: 'cluster-not-wired' });
        return;
      }
      try {
        send(res, 200, options.getCluster(workspaceRoot));
      } catch (error) {
        send(res, 500, { ok: false, error: 'cluster-read-failed', message: String((error as Error)?.message ?? error) });
      }
      return;
    }
    // POST /ui/cluster-enable：第一次启用工作区集群
    if (method === 'POST' && path === '/ui/cluster-enable') {
      if (typeof options.enableCluster !== 'function') {
        send(res, 501, { ok: false, error: 'cluster-enable-not-wired' });
        return;
      }
      let body: any = {};
      try {
        body = await readJsonBody(req);
      } catch (error) {
        send(res, 400, { ok: false, error: 'bad-json', message: String((error as Error)?.message ?? error) });
        return;
      }
      const targetRoot = String(body?.workspaceRoot ?? workspaceRoot ?? '').trim();
      if (!targetRoot) {
        send(res, 400, { ok: false, error: 'workspaceRoot-required' });
        return;
      }
      try {
        send(res, 200, options.enableCluster({ workspaceRoot: targetRoot, sessionId: body?.sessionId ? String(body.sessionId) : sessionId }));
      } catch (error) {
        send(res, 500, { ok: false, error: 'cluster-enable-failed', message: String((error as Error)?.message ?? error) });
      }
      return;
    }
    // POST /ui/team-refresh：用目标 session 的 Agent 重新读 team_status
    if (method === 'POST' && path === '/ui/team-refresh') {
      if (typeof options.refreshTeam !== 'function') {
        send(res, 501, { ok: false, error: 'team-refresh-not-wired' });
        return;
      }
      let body: any = {};
      try {
        body = await readJsonBody(req);
      } catch (error) {
        send(res, 400, { ok: false, error: 'bad-json', message: String((error as Error)?.message ?? error) });
        return;
      }
      const targetRoot = String(body?.workspaceRoot ?? workspaceRoot ?? '').trim();
      const targetSession = String(body?.sessionId ?? sessionId ?? '').trim();
      if (!targetRoot || !targetSession) {
        send(res, 400, { ok: false, error: 'workspaceRoot-sessionId-required' });
        return;
      }
      try {
        send(res, 200, await options.refreshTeam({ workspaceRoot: targetRoot, sessionId: targetSession }));
      } catch (error) {
        send(res, 500, { ok: false, error: 'team-refresh-failed', message: String((error as Error)?.message ?? error) });
      }
      return;
    }
    // POST /ui/access：按对话启用/停用（唯一写路径，其余仍是只读）
    if (method === 'POST' && path === '/ui/access') {
      if (typeof options.setAccess !== 'function') {
        send(res, 501, { ok: false, error: 'access-not-wired' });
        return;
      }
      let body: any = {};
      try {
        body = await readJsonBody(req);
      } catch (error) {
        send(res, 400, { ok: false, error: 'bad-json', message: String((error as Error)?.message ?? error) });
        return;
      }
      const target = String(body?.sessionId ?? sessionId ?? '').trim();
      const hasCoordination = typeof body?.coordination === 'boolean' || typeof body?.enabled === 'boolean';
      const hasManagement = body?.management !== undefined;
      if (!target || (!hasCoordination && !hasManagement)) {
        send(res, 400, { ok: false, error: 'sessionId-and-axis-required', axes: ['coordination', 'management'] });
        return;
      }
      try {
        const result = options.setAccess({
          sessionId: target,
          ...(typeof body?.coordination === 'boolean' ? { coordination: body.coordination } : {}),
          ...(typeof body?.enabled === 'boolean' && typeof body?.coordination !== 'boolean' ? { coordination: body.enabled } : {}),
          ...(hasManagement ? { management: String(body.management) } : {}),
          ...(body?.workspaceRoot ? { workspaceRoot: String(body.workspaceRoot) } : {}),
          by: body?.by,
        });
        send(res, 200, result ?? { ok: true, sessionId: target });
      } catch (error) {
        send(res, 500, { ok: false, error: 'access-write-failed', message: String((error as Error)?.message ?? error) });
      }
      return;
    }
    // POST /ui/project-init：面板建项目（management 轴为 off 时 409，且零写入）
    if (method === 'POST' && path === '/ui/project-init') {
      if (typeof options.projectInit !== 'function') {
        send(res, 501, { ok: false, error: 'project-init-not-wired' });
        return;
      }
      let body: any = {};
      try {
        body = await readJsonBody(req);
      } catch (error) {
        send(res, 400, { ok: false, error: 'bad-json', message: String((error as Error)?.message ?? error) });
        return;
      }
      const target = String(body?.sessionId ?? sessionId ?? '').trim();
      if (!target || !String(body?.workspaceRoot ?? '').trim() || !String(body?.projectName ?? '').trim()) {
        send(res, 400, { ok: false, error: 'sessionId-workspaceRoot-projectName-required' });
        return;
      }
      try {
        const result = (await options.projectInit({
          sessionId: target,
          workspaceRoot: String(body.workspaceRoot),
          projectName: String(body.projectName),
          wish: body?.wish ? String(body.wish) : undefined,
          dryRun: body?.dryRun !== false,
        })) as { ok?: boolean; error?: string } | undefined;
        if (result && result.ok === false && result.error === 'management-disabled') {
          send(res, 409, result);
          return;
        }
        send(res, 200, result ?? { ok: false, error: 'project-init-empty' });
      } catch (error) {
        send(res, 500, { ok: false, error: 'project-init-failed', message: String((error as Error)?.message ?? error) });
      }
      return;
    }
    if (method !== 'GET') {
      send(res, 405, { ok: false, error: 'method-not-allowed', allow: 'GET, POST, OPTIONS' });
      return;
    }
    // GET /ui/agents：智能体花名册（journal 折叠，不依赖 team_status / 活 Agent）
    if (path === '/ui/agents') {
      if (typeof options.getAgents !== 'function') {
        send(res, 501, { ok: false, error: 'agents-not-wired' });
        return;
      }
      try {
        const roster = options.getAgents(workspaceRoot);
        send(res, 200, roster ?? { ok: false, error: 'agents-empty' });
      } catch (error) {
        send(res, 500, { ok: false, error: 'agents-failed', message: String((error as Error)?.message ?? error) });
      }
      return;
    }
    if (path === '/ui/workspaces') {
      if (typeof options.getWorkspaces !== 'function') {
        send(res, 501, { ok: false, error: 'workspaces-not-wired' });
        return;
      }
      try {
        const list = await options.getWorkspaces();
        send(res, 200, { ok: true, workspaces: Array.isArray(list) ? list : [] });
      } catch (error) {
        send(res, 500, { ok: false, error: 'workspaces-failed', message: String((error as Error)?.message ?? error) });
      }
      return;
    }
    if (path === '/ui/access') {
      if (typeof options.getAccess !== 'function') {
        send(res, 501, { ok: false, error: 'access-not-wired' });
        return;
      }
      const result = options.getAccess(sessionId, workspaceRoot);
      send(res, 200, result ?? { ok: true, sessionId: sessionId ?? null, enabled: false, default: 'disabled' });
      return;
    }
    if (path === '/ui/update-check') {
      if (typeof options.getUpdateInfo !== 'function') {
        send(res, 200, {
          ok: false,
          error: 'update-check-unwired',
          message: '检查更新未接线；升级插件后重试。',
        });
        return;
      }
      try {
        const info = (await options.getUpdateInfo()) ?? { ok: false, error: 'update-check-empty' };
        send(res, 200, info);
      } catch (error) {
        // fail-soft：检查失败不 500
        send(res, 200, { ok: false, error: 'update-check-failed', message: String((error as Error)?.message ?? error) });
      }
      return;
    }
    // 轻量健康端点：**不调用 getSnapshot**（否则前端每次探测都要构造一次全量快照）。
    // 面板用它做「侧车是否可达 / 端口是否就是它」的探测，必须极便宜。
    if (path === '/ui/health') {
      send(res, 200, {
        ok: true,
        service: 'dsh-l0-control-ui-sidecar',
        port: (() => {
          const addr = req.socket?.localPort;
          return typeof addr === 'number' ? addr : null;
        })(),
        at: new Date().toISOString(),
      });
      return;
    }
    if (path !== '/ui/snapshot') {
      send(res, 404, { ok: false, error: 'not-found', path });
      return;
    }
    try {
      const snapshot = await options.getSnapshot(sessionId, workspaceRoot, sinceSeq);
      send(res, 200, snapshot);
    } catch (error) {
      send(res, 500, { ok: false, error: 'snapshot-failed', message: String((error as Error)?.message ?? error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
