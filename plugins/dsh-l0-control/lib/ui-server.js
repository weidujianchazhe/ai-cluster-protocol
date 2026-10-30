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
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(text);
}

export async function startUiServer(options                 )                          {
  const host = options.host || '127.0.0.1';
  const port = Number(options.port ?? 47831);
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
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      res.end();
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
    if (path !== '/ui/snapshot' && path !== '/ui/health') {
      send(res, 404, { ok: false, error: 'not-found', path });
      return;
    }
    try {
      const snapshot = await options.getSnapshot(sessionId, workspaceRoot, sinceSeq);
      send(res, 200, path === '/ui/health' ? { ok: true, at: new Date().toISOString() } : snapshot);
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