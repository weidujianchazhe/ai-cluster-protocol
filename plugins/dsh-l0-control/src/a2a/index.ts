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
export { buildAgentCard, DEFAULT_SKILLS, AGENT_CARD_PATH, AGENT_CARD_ALIAS } from './card.ts';
export { authorize, extractBearer, safeEqual, tokenFingerprint } from './auth.ts';
export { IdempotencyRegistry } from './idempotency.ts';
export { isCancelable, isCanceledRow, toA2ATask, toA2ATaskState, nativeStatusesFor, CANCEL_REASON_PREFIX } from './mapping.ts';
export { PortError, isPortError, portUnavailable } from './port.ts';
export { createA2ARouter } from './router.ts';
export { startA2AServer } from './server.ts';

export type { A2ARouter, A2ARouterOptions } from './router.ts';
export type { A2ATaskPort } from './port.ts';
export type { StartA2AServerOptions, A2AServerHandle } from './server.ts';
export type {
  A2AActor,
  A2AAgentCard,
  A2AAuthConfig,
  A2ACancelOutcome,
  A2ACreateTaskInput,
  A2ACreateTaskResult,
  A2ANodeRow,
  A2ARequest,
  A2AResponse,
  A2AServerConfig,
  A2ASkill,
  A2ATask,
  A2ATaskState,
} from './types.ts';
