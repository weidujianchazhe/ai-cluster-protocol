/**
 * 只读 UI 侧车：给 `@local/dsh-l0-control-ui` 面板提供快照。
 *
 * 边界：
 *   - 仅 GET/OPTIONS，无写路径；绑定 127.0.0.1；不参与控制面决策。
 *   - 数据来自 L0ControlService.uiSnapshot()（journal + graph + team_status 缓存 + 工作区目录）。
 *   - 端口冲突/启动失败只记 journal，不影响插件主功能。
 */
import http from 'node:http';

                                  
                
                
                                                         
                            
                                                                                                            
                                                                                                             
                                                       
                                                   
                                                              
                                                                                                      
                                    
                                                                      
                                              
                                                   
                                                       
                                                  
                                            
                                                                                      
                                    
                                                                                     
                                                                              
                                                                                                                                                             
                                                                                    
                                                   
                                                                                          
                         
                           
                         
                  
                     
                       
                                   
 

                                 
              
               
                         
 

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

/**
 * 桌面端自定义协议：DSH 应用把页面跑在 `dsh-app://app` 下（Electron 自定义 scheme）。
 * 它既不是 `null`（sandboxed iframe），也不是 http 回环——只认后两者会让面板**永久**连不上，
 * 且表现为 "Failed to fetch / sidecar-unreachable"，从错误里完全看不出是 Origin 被拒。
 * 实测（2026-11-10）：journal 里 ui_origin_rejected 的 origin 就是 `dsh-app://app`。
 */
const APP_SCHEMES = new Set(['dsh-app:', 'dsh-app-web:', 'app:']);

/** 解析 Origin；自定义应用协议 / http(s) 回环 → 原样返回；其余 undefined。 */
function parseLoopbackOrigin(origin        )                     {
  let url     ;
  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }
  if (APP_SCHEMES.has(url.protocol)) return origin;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const hostname = url.hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(hostname) ? origin : undefined;
}

function allowedOrigin(req                      , extraOrigins                    )                     {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin) return undefined;
  if (Array.isArray(extraOrigins) && extraOrigins.includes(origin)) return origin;
  // opaque origin：面板若跑在 file:// 或 sandboxed iframe 里，浏览器会发字面量 `null`。
  // 服务只绑 127.0.0.1，所以这类来源仍是"本机页面"；响应 ACAO 必须原样回 `null`，
  // 回 `*` 或具体 origin 都不会被浏览器接受。不认这条，面板就永远 sidecar-unreachable。
  if (origin === 'null') return 'null';
  return parseLoopbackOrigin(origin);
}

/** 读 JSON body（限 64KB，防止误传大包）。 */
async function readJsonBody(req                      )                   {
  const chunks           = [];
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

function send(res                     , status        , body         )       {
  const text = JSON.stringify(body);
  // CORS 响应头由请求处理入口按 Origin 白名单设置（见 startUiServer），此处不发 `*`。
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

export async function startUiServer(options                 )                          {
  const host = options.host || '127.0.0.1';
  const port = Number(options.port ?? 47831);
  /**
   * 请求计数（path × 来源）：诊断"面板连不上"时，关键问题是**浏览器的请求到底有没有到服务端**。
   * 只看服务端日志无法区分「没到达」和「到达但被拒」，这个计数器能把两种情况分开：
   *   - 计数在涨 → 请求到了，问题在响应/跨源；
   *   - 计数不涨 → 根本没到，问题在客户端/网络策略。
   */
  const requestStats                                                                        = {};
  const bump = (key        , origin        ) => {
    const row = requestStats[key] ?? { count: 0, lastOrigin: '', lastAt: '' };
    row.count += 1;
    row.lastOrigin = origin || '(none)';
    row.lastAt = new Date().toISOString();
    requestStats[key] = row;
  };
  const server = http.createServer(async (req, res) => {
    const method = String(req.method || 'GET').toUpperCase();
    const rawUrl = String(req.url || '/');
    const path = rawUrl.split('?')[0];
    let sessionId                    ;
    let workspaceRoot                    ;
    let sinceSeq                    ;
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
    const rawOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const origin = allowedOrigin(req, options.allowedOrigins);
    const hasOrigin = rawOrigin.length > 0;
    if (path === '/ui/stats') {
      send(res, 200, { ok: true, at: new Date().toISOString(), port, stats: requestStats });
      return;
    }
    bump(`${method} ${path}`, rawOrigin);
    if (hasOrigin && !origin) {
      // 记下**浏览器实际发来的 Origin**：只说 "Failed to fetch" 时，这是唯一能定位的线索。
      try {
        options.onRejectedOrigin?.({ origin: rawOrigin, path, method });
      } catch {
        // 诊断失败不影响主流程
      }
    }
    // Chromium 的「本地网络访问」策略：页面去请求 127.0.0.1 上的另一个端口时，
    // 预检会带 `Access-Control-Request-Private-Network: true`，服务端必须回
    // `Access-Control-Allow-Private-Network: true`，否则浏览器直接判失败——
    // 表现就是面板报 Failed to fetch，而用 node/curl 测同一个 URL 却是 200。
    const wantsPrivateNetwork = String(req.headers['access-control-request-private-network'] ?? '').toLowerCase() === 'true';
    if (method === 'OPTIONS') {
      if (!origin) {
        send(res, 403, { ok: false, error: 'origin-forbidden', origin: rawOrigin || null });
        return;
      }
      const headers                                  = {
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
      send(res, 403, { ok: false, error: 'origin-forbidden', origin: rawOrigin || null });
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
        send(res, 500, { ok: false, error: 'cluster-read-failed', message: String((error         )?.message ?? error) });
      }
      return;
    }
    // POST /ui/cluster-enable：第一次启用工作区集群
    if (method === 'POST' && path === '/ui/cluster-enable') {
      if (typeof options.enableCluster !== 'function') {
        send(res, 501, { ok: false, error: 'cluster-enable-not-wired' });
        return;
      }
      let body      = {};
      try {
        body = await readJsonBody(req);
      } catch (error) {
        send(res, 400, { ok: false, error: 'bad-json', message: String((error         )?.message ?? error) });
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
        send(res, 500, { ok: false, error: 'cluster-enable-failed', message: String((error         )?.message ?? error) });
      }
      return;
    }
    // POST /ui/team-refresh：用目标 session 的 Agent 重新读 team_status
    if (method === 'POST' && path === '/ui/team-refresh') {
      if (typeof options.refreshTeam !== 'function') {
        send(res, 501, { ok: false, error: 'team-refresh-not-wired' });
        return;
      }
      let body      = {};
      try {
        body = await readJsonBody(req);
      } catch (error) {
        send(res, 400, { ok: false, error: 'bad-json', message: String((error         )?.message ?? error) });
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
        send(res, 500, { ok: false, error: 'team-refresh-failed', message: String((error         )?.message ?? error) });
      }
      return;
    }
    // POST /ui/access：按对话启用/停用（唯一写路径，其余仍是只读）
    if (method === 'POST' && path === '/ui/access') {
      if (typeof options.setAccess !== 'function') {
        send(res, 501, { ok: false, error: 'access-not-wired' });
        return;
      }
      let body      = {};
      try {
        body = await readJsonBody(req);
      } catch (error) {
        send(res, 400, { ok: false, error: 'bad-json', message: String((error         )?.message ?? error) });
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
        send(res, 500, { ok: false, error: 'access-write-failed', message: String((error         )?.message ?? error) });
      }
      return;
    }
    // POST /ui/project-init：面板建项目（management 轴为 off 时 409，且零写入）
    if (method === 'POST' && path === '/ui/project-init') {
      if (typeof options.projectInit !== 'function') {
        send(res, 501, { ok: false, error: 'project-init-not-wired' });
        return;
      }
      let body      = {};
      try {
        body = await readJsonBody(req);
      } catch (error) {
        send(res, 400, { ok: false, error: 'bad-json', message: String((error         )?.message ?? error) });
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
        }))                                                ;
        if (result && result.ok === false && result.error === 'management-disabled') {
          send(res, 409, result);
          return;
        }
        send(res, 200, result ?? { ok: false, error: 'project-init-empty' });
      } catch (error) {
        send(res, 500, { ok: false, error: 'project-init-failed', message: String((error         )?.message ?? error) });
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
        send(res, 500, { ok: false, error: 'agents-failed', message: String((error         )?.message ?? error) });
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
        send(res, 500, { ok: false, error: 'workspaces-failed', message: String((error         )?.message ?? error) });
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
        send(res, 200, { ok: false, error: 'update-check-failed', message: String((error         )?.message ?? error) });
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
      send(res, 500, { ok: false, error: 'snapshot-failed', message: String((error         )?.message ?? error) });
    }
  });
  await new Promise      ((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    close: () => new Promise      ((resolve) => server.close(() => resolve())),
  };
}


//# sourceURL=ui-server.js