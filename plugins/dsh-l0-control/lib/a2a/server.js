/**
 * node:http 载体（薄）：把请求转成 `A2ARequest`、把 `A2AResponse` 写回。
 *
 * 刻意不做的事：不做路由判定、不做鉴权、不做状态映射——那些都在 router/mapping。
 * 这样主窗口换载体（webServer 路由 / sidecar / 测试直连）时行为不变。
 */
import http from 'node:http';
                                             

                                        
                    
                
                
                        
 

                                  
              
               
               
                            
                         
 

export async function startA2AServer(options                       )                           {
  const host = options.host ?? '127.0.0.1';
  const port = Number.isInteger(options.port) ? Number(options.port) : 0;
  const maxBodyBytes = Number(options.maxBodyBytes ?? 1024 * 1024);
  let requests = 0;

  const server = http.createServer(async (req, res) => {
    requests += 1;
    const chunks           = [];
    let size = 0;
    let tooLarge = false;
    try {
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maxBodyBytes) {
          tooLarge = true;
          break;
        }
        chunks.push(buffer);
      }
    } catch {
      // 读取中断按空体处理，由 router 判 400/404。
    }

    if (tooLarge) {
      const payload = JSON.stringify({ error: { code: 'payload-too-large', message: `请求体超过 ${maxBodyBytes} 字节` } });
      res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
      res.end(payload);
      return;
    }

    const headers                         = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(',');
    }

    try {
      const response = await options.router.handle({
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const payload = response.body === undefined ? '' : JSON.stringify(response.body);
      res.writeHead(response.status, response.headers);
      if ((req.method ?? 'GET').toUpperCase() === 'HEAD') res.end();
      else res.end(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'internal', message } }));
    }
  });

  await new Promise      ((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    url: `http://${host}:${actualPort}`,
    host,
    port: actualPort,
    get requests() {
      return requests;
    },
    close: () =>
      new Promise      ((resolve, reject) => {
        (server                                                   ).closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}


//# sourceURL=a2a\server.js