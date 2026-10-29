# Lane P · A2A 最小传输（`src/a2a/`）

> 日期：2026-10-29 · 执行者：integration-analyst · 任务：task-30（预算 5 轮）
> 写域：`plugins/dsh-l0-control/src/a2a/`、`plugins/dsh-l0-control/tests/e2e/a2a/`、本文件
> **不改** `service.ts` / `index.ts` / `tools.ts`（接线归主窗口 M4）

---

## 0. 结论

4 个端点 + 鉴权 + 幂等 + 图/TeamTask 映射全部落地，`32/33 → 33/33` 断言通过（真实 HTTP 客户端打真实 `node:http` 服务）。
模块**零依赖 core/service**：只依赖一个 3 方法的 `A2ATaskPort`，主窗口 3 行接线即可用。

---

## 1. 文件与职责

| 文件 | 职责 | 依赖 |
|---|---|---|
| `types.ts` | 全部类型（A2A Task / AgentCard / 请求响应 / NodeRow） | 无 |
| `card.ts` | `buildAgentCard()`、默认 skills、card 路径常量 | 无 |
| `auth.ts` | bearer 静态令牌、`timingSafeEqual` 比较、可选租户钩子 | `node:crypto` |
| `idempotency.ts` | `IdempotencyRegistry`（TTL + 容量上限，fresh/replay/conflict） | 无 |
| `mapping.ts` | 图状态 ↔ A2A 状态、`toA2ATask`、cancel 判定 | 无 |
| `port.ts` | `A2ATaskPort` 接口 + `PortError` | 无 |
| `router.ts` | 纯函数路由 `handle(req) → res`（不含 node:http） | 上面全部 |
| `server.ts` | `node:http` 薄载体（体量限制、HEAD、close） | `node:http` |
| `index.ts` | 公开面 barrel | 全部 |
| `tests/e2e/a2a/run.mjs` | 33 条 e2e 断言（真实 fetch） | `src/a2a/*.ts` 直连 |

---

## 2. 公开接口签名（M4 接线用）

### 2.1 端口（唯一接缝）

```ts
interface A2ATaskPort {
  createTask(input: A2ACreateTaskInput): Promise<A2ACreateTaskResult>;   // {taskId, row}
  getTask(taskId: string, actor: A2AActor): Promise<A2ANodeRow | null>;
  cancelTask(taskId: string, reason: string | undefined, actor: A2AActor): Promise<A2ACancelOutcome>;
}

interface A2ANodeRow {
  nodeId: string; status: string; revision?: number;
  teamTaskId?: string | null; assignee?: string | null;
  artifacts?: { path: string; text?: string }[];
  updatedAt?: string; contextId?: string;
  blockedReason?: string | null;      // cancel 借道 blocked 的标记位
}

interface A2ACreateTaskInput { message: string; idempotencyKey: string; actor: string; metadata?: Record<string, unknown> }
type A2ACancelOutcome =
  | { kind: 'canceled'; row: A2ANodeRow }
  | { kind: 'not-cancelable'; nodeId: string; status: string }
  | { kind: 'not-found'; nodeId: string };
```

### 2.2 路由 / 服务

```ts
function createA2ARouter(o: {
  port: A2ATaskPort; card: A2AAgentCard; auth: A2AAuthConfig; config?: A2AServerConfig;
}): { handle(req: A2ARequest): Promise<A2AResponse>; card: A2AAgentCard; idempotencySize(): number }

function startA2AServer(o: { router: A2ARouter; host?: string; port?: number; maxBodyBytes?: number })
  : Promise<{ url: string; host: string; port: number; requests: number; close(): Promise<void> }>
```

### 2.3 主窗口接线（3 步）

```js
const port = {                      // ① 用 core facade 实现三方法，返回扁平 NodeRow
  createTask: async (input) => { const node = await core.wishOrNode(input.message); return { taskId: node.node_id, row: toRow(node) }; },
  getTask:    async (id) => core.getNode(id) ? toRow(core.getNode(id)) : null,
  cancelTask: async (id, reason) => core.cancelNode(id, reason),   // blocked + `canceled:<reason>`
};
const router = createA2ARouter({ port, card: buildAgentCard({ url }), auth: { tokens: [process.env.A2A_TOKEN] } });  // ②
const server = await startA2AServer({ router });                                                                     // ③
```

---

## 3. 端点与状态码

| 方法 | 路径 | 成功 | 主要失败 |
|---|---|---|---|
| GET | `/.well-known/agent-card.json`、`/a2a/agent-card` | 200 card | 405（非 GET/HEAD） |
| POST | `/a2a/tasks` | **201** + `Location` + `idempotent-replay:false` | 400 `idempotency-key-required`/`invalid-json`/`invalid-task-request`；409 `idempotency-conflict`；401/403；413 |
| GET | `/a2a/tasks/:id` | 200 task + `x-a2a-cancelable` + `x-a2a-native-status` | 404 `task-not-found`；401 |
| POST | `/a2a/tasks/:id/cancel` | **200** state=`canceled` | 409 `task-not-cancelable`；404；401 |

**幂等重放固定 200**（不是首次的 201）：201 表示"本次创建了资源"，重放没有创建；id 与 body 与首次一致，头 `idempotent-replay:true`。

---

## 4. 三个设计决定（含理由）

### 4.1 cancel 借道 `blocked`（图里没有 canceled 状态）
`src/core/status.ts` 的 `NODE_STATUSES` 只有 `planned/ready/claimed/running/submitted/verifying/done/blocked`，`TRANSITIONS` 白名单里也没有任何 `*→canceled` 边。
因此 cancel **不新增状态**：落 `status=blocked` + `blockedReason="canceled:<reason>"`，由 `mapping.toA2ATaskState` 渲染成 A2A `canceled`。
好处：① 不破坏 16 条迁移白名单与 Python oracle 差分；② `blocked` 本就有 `→ready` 的复活路径，取消后重新排期是合法迁移，不是特例。
可取消集合 = `{ready, claimed, running, blocked}`（与 `*→blocked` 边一致）；`submitted/verifying/done` 一律 409（证据门禁期与终态不可撤）。

### 4.2 重复 cancel 幂等 200（不是 409）
R1 我报的是"重复 cancel → 409"，实作改为**幂等 200**：cancel 是客户端会重试的写操作，用幂等键之外的"天然幂等"更符合预期（已 canceled 再 cancel → 200、state 仍 `canceled`、**revision 不再增长**，P22 有断言）。409 只留给**真的不可取消**（done/verifying/submitted，P23/P24）。

### 4.3 幂等/租户的边界
- **幂等注册表在进程内、不落盘**：窗口只需覆盖客户端重试；落盘会与 N4 的 journal/快照写域重叠，且"重放语义"本该由权威层承担。容量上限 5000 + TTL 24h 防内存刷爆。
- **失败不占键**（P14）：400/5xx 后同键可重试，避免"一次失败把键占死"。
- **租户只在传输层做钩子**（`x-a2a-tenant` 与 `config.auth.requireTenant` 比对 → 403 `tenant-mismatch`）；真实租户隔离归 **Lane S**，接线时把 `authorize` 换成 S 的模块即可，路由不动。
- **令牌比较先 sha256 再 `timingSafeEqual`**：常量长度、无早退；401 带 `WWW-Authenticate`；无 token 配置时**一律 401**（配置缺失不等于放开）。

---

## 5. 测试（33 条，`node tests/e2e/a2a/run.mjs`）

| 段 | 覆盖 | 条数 |
|---|---|---:|
| card | 公开发现 + 别名 + metadata 口径 | 2 |
| auth | 无/错 token 401（且不触达端口）、GET 也 401 不泄漏存在性、403 租户、租户放行 | 5 |
| create+idempotency | 201/Location/状态、replay、conflict、缺键、非法 JSON、空诉求、失败不占键 | 7 |
| query | GET 同节点、404、未知路由、405+Allow、DELETE 405 | 5 |
| cancel | 200 canceled 映射、GET 仍 canceled、**幂等 200 且 revision 不涨**、done/verifying 409、404 | 6 |
| mapping | 8 状态全表、未知→unknown、`canceled:` 前缀、cancelable 白名单、artifacts 投影 | 5 |
| port-errors | PortError→409 带 details 不透堆栈、普通 Error→500 不泄漏 message | 2 |
| limits | 413 payload-too-large | 1 |

退出码沿用四态：`0` pass / `1` drift / `2` failed / `3` unknown（本套现为 `0`）。

---

## 6. 给 M4 的接线注意事项

1. **端口必须返回扁平 NodeRow**，不要回 core 的类实例/闭包——宿主与 HTTP 都要求 lossless JSON（N1 的 `team_status` 就是踩了这个坑）。
2. `cancelTask` 必须由 core 走 `checkTransition(current → blocked)`，不要绕过白名单直接改 status。
3. `getTask` 的 `teamTaskId` 可为 null（投影未建/未刷新）：A2A 侧允许 null，客户端不得据此判失败。
4. 若宿主 `webServer` 路由受限，直接 `startA2AServer` 起本地端口即可（计划 §5 允许 sidecar 降级），路由行为不变。
5. Card 的 `url` 必须填**外部可达**地址（不是 `127.0.0.1`），否则外部 Agent 按 Card 回连会失败。

---

## 7. 未覆盖 / 留给后续

- 流式（`message/stream`、SSE）：Card 已声明 `streaming:false`，**不虚报**。
- push notification / webhook 回调：`pushNotifications:false`。
- A2A 完整 JSON-RPC 信封（`message/send` 等方法名）：本版是 RESTful 最小面；若需兼容全规范，可在 router 上加一层 JSON-RPC 翻译，不动 port/mapping。
- 跨进程幂等（多副本部署）：需要把注册表换成共享存储，届时归 N4/S。
