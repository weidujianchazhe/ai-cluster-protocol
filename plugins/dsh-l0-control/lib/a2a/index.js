/**
 * A2A 最小传输 · 公开面（供主窗口 M4 接线）。
 *
 * 接线三步：
 *   1. 实现 `A2ATaskPort`（3 个方法，返回扁平 NodeRow）；
 *   2. `const router = createA2ARouter({ port, card: buildAgentCard({ url }), auth, config })`；
 *   3. `startA2AServer({ router })` 或把 `router.handle` 挂到宿主 webServer 路由。
 *
 * 本目录不 import core/service，也不改插件入口（写域边界见 lane note）。
 */
export { buildAgentCard, DEFAULT_SKILLS, AGENT_CARD_PATH, AGENT_CARD_ALIAS } from './card.js';
export { authorize, extractBearer, safeEqual, tokenFingerprint } from './auth.js';
export { IdempotencyRegistry } from './idempotency.js';
export { isCancelable, isCanceledRow, toA2ATask, toA2ATaskState, nativeStatusesFor, CANCEL_REASON_PREFIX } from './mapping.js';
export { PortError, isPortError, portUnavailable } from './port.js';
export { createA2ARouter } from './router.js';
export { startA2AServer } from './server.js';

                                                               
                                             
                                                                          
             
           
               
                
                   
                     
                      
             
             
              
                  
           
          
               
                    


//# sourceURL=a2a\index.js