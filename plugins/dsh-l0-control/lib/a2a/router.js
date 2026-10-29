/**
 * A2A 路由（纯函数：A2ARequest → A2AResponse，不依赖 node:http）。
 *
 * 路由表：
 *   GET  /.well-known/agent-card.json    （公开发现，可关）
 *   GET  /a2a/agent-card                 （同上别名）
 *   POST /a2a                            （A2A JSON-RPC 2.0 信封）
 *   POST /a2a/tasks                      （REST 建任务；幂等键）
 *   GET  /a2a/tasks/:id                  （REST 查状态）
 *   POST /a2a/tasks/:id/cancel           （REST 取消）
 *
 * 错误码约定（全部 `{error:{code,message,details?}}`）：
 *   401 unauthorized · 403 tenant-mismatch · 404 not-found / task-not-found
 *   400 invalid-json / invalid-task-request / idempotency-key-required / invalid-idempotency-key
 *   405 method-not-allowed · 409 idempotency-conflict / task-not-cancelable
 *   413 payload-too-large · 500 internal · 502 port-failed · 503 port-unavailable
 */
import { createHash } from 'node:crypto';
import { authorize } from './auth.js';
import { AGENT_CARD_ALIAS, AGENT_CARD_PATH } from './card.js';
import { IdempotencyRegistry } from './idempotency.js';
import { isCancelable, toA2ATask } from './mapping.js';
import { isPortError } from './port.js';
                                             
             
           
               
                
             
             
              
                  
                    

const JSON_TYPE = 'application/json; charset=utf-8';

                                   
                    
                     
                      
                           
 

                            
                                                
                     
                            
 

function normalizePath(path        )         {
  const withoutQuery = String(path || '/').split('?')[0];
  if (withoutQuery.length > 1 && withoutQuery.endsWith('/')) return withoutQuery.slice(0, -1);
  return withoutQuery || '/';
}

function normalizeHeaders(headers                        )                         {
  const out                         = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
  }
  return out;
}

function jsonResponse(status        , body         , headers                         = {})              {
  return {
    status,
    headers: { 'content-type': JSON_TYPE, ...headers },
    body,
  };
}

function errorResponse(
  status        ,
  code        ,
  message        ,
  extra                                                          = {},
)              {
  const body                                                                  = { error: { code, message } };
  if (extra.details !== undefined) body.error.details = extra.details;
  return jsonResponse(status, body, extra.headers ?? {});
}

function methodNotAllowed(allow        )              {
  return errorResponse(405, 'method-not-allowed', `本路由只接受 ${allow}`, { headers: { allow } });
}

/** 从 A2A / 简化 两种请求体里取任务文本。 */
function extractMessage(raw         )                {
  if (typeof raw === 'string') return raw.trim() ? raw : null;
  if (!raw || typeof raw !== 'object') return null;
  const body = raw                           ;
  if (typeof body.text === 'string' && body.text.trim()) return body.text;
  const message = body.message;
  if (typeof message === 'string' && message.trim()) return message;
  if (message && typeof message === 'object') {
    const parts = (message                           ).parts;
    if (Array.isArray(parts)) {
      const texts = parts
        .map((part) => (part && typeof part === 'object' ? (part                           ).text : undefined))
        .filter((text)                 => typeof text === 'string' && text.trim().length > 0);
      if (texts.length > 0) return texts.join('\n');
    }
  }
  if (typeof body.subject === 'string' && body.subject.trim()) return body.subject;
  return null;
}

function taskView(row            , now              )              {
  const task = toA2ATask(row, { now });
  return jsonResponse(200, task, {
    'x-a2a-cancelable': isCancelable(row.status) ? 'true' : 'false',
    'x-a2a-native-status': row.status,
  });
}

                                        

const RPC_METHODS = ['message/send', 'tasks/get', 'tasks/cancel']         ;

function rpcResult(id           , result         )              {
  return jsonResponse(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id           , code        , message        , data          )              {
  const error                                                    = { code, message };
  if (data !== undefined) error.data = data;
  return jsonResponse(200, { jsonrpc: '2.0', id, error });
}

function rpcFromHttp(response             , id           )              {
  if (response.status >= 200 && response.status < 300) return rpcResult(id, response.body);
  const body = response.body                                                                             ;
  const err = body?.error;
  const code = response.status === 404 ? -32001 : response.status === 409 ? -32002 : -32000;
  return rpcError(id, code, err?.message ?? 'A2A request failed', {
    httpStatus: response.status,
    code: err?.code ?? 'a2a-error',
    details: err?.details,
  });
}

export function createA2ARouter(options                  )            {
  const { port, card } = options;
  const authConfig                = { ...options.auth };
  const config                  = options.config ?? {};
  const now = config.now ?? Date.now;
  const requireKey = config.requireIdempotencyKey !== false;
  const idempotency = new IdempotencyRegistry({
    ttlMs: config.idempotencyTtlMs,
    now,
  });

  async function createTask(
    headers                        ,
    rawBody                    ,
    actor          ,
  )                       {
    let parsed          = null;
    const text = typeof rawBody === 'string' ? rawBody.trim() : '';
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        return errorResponse(400, 'invalid-json', '请求体不是合法 JSON');
      }
    }

    const message = extractMessage(parsed);
    if (!message) {
      return errorResponse(400, 'invalid-task-request', '缺少任务文本（message / message.parts[].text / text / subject）');
    }

    const key = headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) {
      if (requireKey) {
        return errorResponse(400, 'idempotency-key-required', 'POST /a2a/tasks 需要 Idempotency-Key 头（可用 config.requireIdempotencyKey=false 放宽）');
      }
    } else if (key.length > 200) {
      return errorResponse(400, 'invalid-idempotency-key', 'Idempotency-Key 过长（>200）');
    }

    const fingerprint = createHash('sha256')
      .update(`POST\n/a2a/tasks\n${text}`, 'utf8')
      .digest('hex');

    if (typeof key === 'string' && key.length > 0) {
      const outcome = idempotency.begin(key, fingerprint);
      if (outcome.kind === 'conflict') {
        return errorResponse(409, 'idempotency-conflict', '同一 Idempotency-Key 携带了不同的请求体', {
          details: { originalFingerprint: outcome.originalFingerprint, fingerprint },
        });
      }
      if (outcome.kind === 'replay') {
        // 重放固定 200（不是首次的 201）：201 表示"本次创建了资源"，重放并没有创建，
        // 客户端可据此区分首次与重放；资源 id 与 body 与首次完全一致。
        return {
          status: 200,
          headers: { ...outcome.headers, 'idempotent-replay': 'true' },
          body: outcome.body,
        };
      }
    }

    try {
      const created = await port.createTask({
        message,
        idempotencyKey: typeof key === 'string' ? key : '',
        actor: actor.id,
        metadata: parsed && typeof parsed === 'object'
          ? ((parsed                           ).metadata                                       )
          : undefined,
      });
      const response = jsonResponse(201, toA2ATask(created.row, { now }), {
        location: `/a2a/tasks/${encodeURIComponent(created.taskId)}`,
        'idempotent-replay': 'false',
        'x-a2a-cancelable': isCancelable(created.row.status) ? 'true' : 'false',
        'x-a2a-native-status': created.row.status,
      });
      if (typeof key === 'string' && key.length > 0) {
        idempotency.settle(key, fingerprint, response.status, response.headers, response.body);
      }
      return response;
    } catch (error) {
      // 失败不占键：允许客户端用同一 key 重试真正的可恢复失败。
      if (typeof key === 'string' && key.length > 0) idempotency.release(key);
      return mapPortError(error);
    }
  }

  async function cancelTask(
    taskId        ,
    rawBody                    ,
    actor          ,
  )                       {
    let reason                    ;
    const text = typeof rawBody === 'string' ? rawBody.trim() : '';
    if (text.length > 0) {
      try {
        const parsed = JSON.parse(text)                           ;
        if (typeof parsed?.reason === 'string') reason = parsed.reason;
      } catch {
        return errorResponse(400, 'invalid-json', '取消请求体不是合法 JSON');
      }
    }
    try {
      const outcome = await port.cancelTask(taskId, reason, actor);
      if (outcome.kind === 'not-found') {
        return errorResponse(404, 'task-not-found', `任务不存在：${taskId}`);
      }
      if (outcome.kind === 'not-cancelable') {
        return errorResponse(409, 'task-not-cancelable', `任务处于 ${outcome.status}，不允许 cancel`, {
          details: { nodeId: outcome.nodeId, status: outcome.status, cancelable: false },
        });
      }
      return taskView(outcome.row, now);
    } catch (error) {
      return mapPortError(error);
    }
  }

  async function readTask(taskId        , actor          )                       {
    try {
      const row = await port.getTask(taskId, actor);
      if (!row) return errorResponse(404, 'task-not-found', `任务不存在：${taskId}`);
      return taskView(row, now);
    } catch (error) {
      return mapPortError(error);
    }
  }

  function mapPortError(error         )              {
    if (isPortError(error)) {
      const status = Number((error                      ).status) || 502;
      const code = String((error                    ).code || 'port-failed');
      const message = String((error                        ).message ?? '端口调用失败');
      const details = (error                         ).details;
      return errorResponse(status, code, message, details === undefined ? {} : { details });
    }
    return errorResponse(500, 'internal', '内部错误');
  }

  /**
   * A2A JSON-RPC 2.0 信封（最小面）：
   *   message/send  -> 建任务（幂等键取 params.metadata.idempotencyKey / message.messageId）
   *   tasks/get     -> 查任务
   *   tasks/cancel  -> 取消任务
   * 传输错误（401）仍走 HTTP；业务错误走 JSON-RPC error，HTTP 200。
   */
  async function handleRpc(
    rawBody                    ,
    headers                        ,
    actor          ,
  )                       {
    const text = typeof rawBody === 'string' ? rawBody.trim() : '';
    if (!text) return rpcError(null, -32700, 'Parse error: empty body');
    let envelope         ;
    try {
      envelope = JSON.parse(text);
    } catch {
      return rpcError(null, -32700, 'Parse error: invalid JSON');
    }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      return rpcError(null, -32600, 'Invalid Request: envelope must be an object');
    }
    const request = envelope                           ;
    const id = (typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null)             ;
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return rpcError(id, -32600, 'Invalid Request: jsonrpc="2.0" and method are required');
    }
    const method = request.method;
    const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params                           
      : {};

    if (method === 'message/send') {
      const message = params.message;
      const messageText = extractMessage({ message });
      if (!messageText) return rpcError(id, -32602, 'Invalid params: message.parts[].text is required');
      const metadata = params.metadata && typeof params.metadata === 'object' && !Array.isArray(params.metadata)
        ? params.metadata                           
        : undefined;
      const messageObject = message && typeof message === 'object' ? message                            : {};
      const idempotencyKey = metadata?.idempotencyKey ?? messageObject.messageId ?? headers['idempotency-key'];
      const rpcHeaders = typeof idempotencyKey === 'string' && idempotencyKey.length > 0
        ? { ...headers, 'idempotency-key': idempotencyKey }
        : headers;
      const response = await createTask(
        rpcHeaders,
        JSON.stringify({ message, metadata }),
        actor,
      );
      return rpcFromHttp(response, id);
    }

    if (method === 'tasks/get') {
      const taskId = params.id ?? params.taskId;
      if (typeof taskId !== 'string' || !taskId.trim()) {
        return rpcError(id, -32602, 'Invalid params: id is required');
      }
      const response = await readTask(taskId, actor);
      return rpcFromHttp(response, id);
    }

    if (method === 'tasks/cancel') {
      const taskId = params.id ?? params.taskId;
      if (typeof taskId !== 'string' || !taskId.trim()) {
        return rpcError(id, -32602, 'Invalid params: id is required');
      }
      const reason = typeof params.reason === 'string' ? params.reason : undefined;
      const response = await cancelTask(taskId, JSON.stringify({ reason }), actor);
      return rpcFromHttp(response, id);
    }

    return rpcError(id, -32601, `Method not found: ${method}`, {
      supported: [...RPC_METHODS],
      streaming: false,
      pushNotifications: false,
    });
  }

  async function handle(req            )                       {
    const method = String(req.method ?? 'GET').toUpperCase();
    const path = normalizePath(req.path);
    const headers = normalizeHeaders(req.headers);

    if (path === AGENT_CARD_PATH || path === AGENT_CARD_ALIAS) {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed('GET, HEAD');
      if (authConfig.cardPublic === false) {
        const auth = authorize(headers, authConfig);
        if (!auth.ok) {
          return errorResponse(auth.status, auth.code, auth.message, { headers: auth.headers });
        }
      }
      return jsonResponse(200, card, { 'cache-control': 'no-store' });
    }

    // A2A JSON-RPC endpoint: POST /a2a
    if (path === '/a2a') {
      if (method !== 'POST') return methodNotAllowed('POST');
      const auth = authorize(headers, authConfig);
      if (!auth.ok) {
        return errorResponse(auth.status, auth.code, auth.message, { headers: auth.headers });
      }
      return handleRpc(req.body, headers, auth.actor);
    }

    if (!path.startsWith('/a2a/')) {
      return errorResponse(404, 'not-found', `无此路由：${path}`);
    }

    const auth = authorize(headers, authConfig);
    if (!auth.ok) {
      return errorResponse(auth.status, auth.code, auth.message, { headers: auth.headers });
    }
    const actor = auth.actor;

    if (path === '/a2a/tasks') {
      if (method !== 'POST') return methodNotAllowed('POST');
      return createTask(headers, req.body, actor);
    }

    const cancelMatch = /^\/a2a\/tasks\/([^/]+)\/cancel$/.exec(path);
    if (cancelMatch) {
      if (method !== 'POST') return methodNotAllowed('POST');
      return cancelTask(decodeURIComponent(cancelMatch[1]), req.body, actor);
    }

    const taskMatch = /^\/a2a\/tasks\/([^/]+)$/.exec(path);
    if (taskMatch) {
      if (method !== 'GET') return methodNotAllowed('GET');
      return readTask(decodeURIComponent(taskMatch[1]), actor);
    }

    return errorResponse(404, 'not-found', `无此路由：${path}`);
  }

  return {
    handle,
    card,
    idempotencySize: () => idempotency.size,
  };
}


//# sourceURL=a2a\router.js