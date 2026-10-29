# 插件按对话启用/停用（access）

## 目标

插件默认不再对所有工作区/对话窗口生效。第一次新建对话窗口未选择本插件 → 该会话默认停用；用户可在插件面板或首次对话入口启用。

## 数据

- `enabledSessions: Map<sessionId, boolean>`，持久化到插件 journal：`access_changed {sessionId, enabled, at, by}`。
- 默认 `accessDefault='disabled'`：没有记录的 sessionId = 停用。
- 恢复：构造时按 journal 最后一条 access_changed 重建；旧会话可按需迁移。
- 工具入口：`index.ts` 在 authorize 前检查 `service.isSessionEnabled(exec.agent?.id)`；未启用返回 `{ok:false,error:'not-enabled', sessionId, hint:'在 AI集群工作协议 面板启用'}`，不调用工具、不写业务 journal（可写 access_denied 审计）。

## 服务

```ts
isSessionEnabled(sessionId: string): boolean
setSessionEnabled(sessionId: string, enabled: boolean, by?: string): {ok, sessionId, enabled}
accessSnapshot(): { default: 'disabled'; sessions: {sessionId, enabled, at}[] }
```

## UI 侧车

- `GET /ui/access?sessionId=` → `{ok, sessionId, enabled}`
- `POST /ui/access` body `{sessionId, enabled, by?}` → 更新；CORS 允许 POST。
- `uiSnapshot` 带 `access: {enabled, default}`（当前 session）。

## UI

1. **事实源卡片缩半行**：左侧“事实源 / 插件 journal（TeamTask 是投影）”，右侧放“启用/停用本对话”切换按钮；高度约原来一半。
2. 选中 session 未启用：统计卡显示“未启用”，团队/任务/黑板显示启用提示 + 立即启用按钮；不显示别的 session 数据。
3. **首次对话入口**：在 `conversation.input.left`（或可用 composer 槽）注册一个轻量按钮/菜单项“启用 AI集群工作协议”，仅当前 session 未启用时显示；点击 POST `/ui/access`；成功后提示刷新。
4. 工作区/对话列表仍按 DSH 权威 sessionIds；归档/子会话过滤保留。

## 验收

- 默认未启用：工具调用返回 `not-enabled`；UI 显示启用入口。
- 启用后工具可用；停用后立即拒绝。
- reload 后启用状态恢复。
- 面板切换只影响当前 session，不串其他 session。
- 事实源卡片半行布局；首次对话入口可点。
