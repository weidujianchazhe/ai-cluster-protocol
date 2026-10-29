# Access 拆分：协作 vs 工作区管理

## 目标

启用插件 ≠ 启用工作区管理。两个开关独立：

| 开关 | 作用 | 默认 |
|---|---|---|
| `coordination` | 智能体协调/集群协作（graph/team/evidence/audit/A2A 等工具） | 未启用 |
| `management` | 管理区创建/记录（`project_init`、管理区卡片/目录） | `off` |

`management` 三态：

- `off`：拒绝 `project_init`，不创建管理区；AI 不能自行建。
- `auto`：AI 自行判断是否调用 `project_init`；可建可不建。
- `on`：允许并鼓励 `project_init`。

## 数据

`access_changed { sessionId, coordination, management, at, by }`

- `isSessionEnabled(sessionId)` = coordination true（guard 用这个）。
- `managementFor(sessionId)` = `'off'|'auto'|'on'`。
- 恢复按 journal 最后一条；旧记录只有 `enabled` 时迁移为 `{coordination:enabled, management:'off'}`。

## 工具

- 所有插件工具：coordination 未启用 → `not-enabled`。
- `project_init` 额外检查 management：
  - off → `{ok:false,error:'management-disabled',hint:'在面板把工作区管理设为 auto/on'}`
  - auto/on → 执行；auto 时只由 AI 决定是否调用，不自动建。
- 其它管理区读取（UI 管理区 tab）按 management 状态显示；off 时不展示管理区内容。

## UI

事实源半行右侧两个控件：

```text
[协作 开/关] [工作区管理：关/自动/开]
```

- 首次对话入口只启用 `coordination`，不碰 management。
- 未启用协作：统计 `—` + 启用按钮。
- 协作开、管理 off：集群统计正常，管理区 tab 显示“工作区管理未启用”。
- 管理 auto：tab 显示“自动（由 AI 决定是否创建）”。
- 管理 on：正常显示/允许 project_init。

## 验收

- 默认 coordination=false、management=off。
- 只开协作：project_init 返回 `management-disabled`；其他工具可用。
- 管理 auto：project_init 可调用（AI 决定）。
- 管理 on/off 切换即时生效；reload 恢复。
- UI 两个控件独立，不互相覆盖。
