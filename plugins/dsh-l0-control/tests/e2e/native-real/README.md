# native-real · 真实 DSH Agent 团队执行（N6）

这里不放"模拟链"，只放**真实跑过**的记录与断言脚本。

## 目录

```
run-20261029T1407Z.json   一次真实执行的完整记录（实例 / 图 / 投影 / 回执）
check.mjs                 断言脚本：不串号 / 审计独立 / 投影同源
```

## 怎么跑

```bash
node tests/e2e/native-real/check.mjs                 # 默认吃本目录的记录
node tests/e2e/native-real/check.mjs path/to/run.json
```

退出码：`0` 全绿 / `1` 断言失败 / `3` 记录不可读（fail-closed，unknown 不当 pass）。

## 记录里能看出什么

- **实例真的存在**：`ROLE-CODE-01 / ROLE-CODE-02 / ROLE-AUDIT_CODE-01` 各有独立 `sessionId`，
  `agent_spawn` 走 `subagents.startActivation(parent=exec.agent, maxDepth=2)`；
- **消息真的送达**：`ROLE-CODE-01` 的回复是 `CODE-01 ECHO`（对应 `agent_message` 的 followup），
  不是 spawn 时的初始任务 `CODE-01 READY` —— 说明投递到了正确实例；
- **图状态是权威**：`claimed → submitted → done`，证据 `EVD-NODE-RESEARCH-1-f0aafc94`，
  `verify_done` 后 `NODE-PRD` 被解锁；
- **TeamTask 只是投影**：`task-18` 的 `nodeId=NODE-RESEARCH`，终态 `completed` 与图 `done` 一致；
  投影由 `board_task_create / board_task_update`（`agentTeams.createTask/updateTask`）维护。

## 工具命名（避让宿主同名工具）

| 本插件工具 | 对应宿主能力 | 为什么改名 |
|---|---|---|
| `agent_spawn` | `subagents.startActivation` | 宿主已有 `spawn_agent` |
| `agent_message` | `subagents.sendMessage` | 宿主已有 `send_message`（Team 通信） |
| `board_task_create` / `board_task_update` | `agentTeams.createTask/updateTask` | 宿主已有 `team_task_*` |
| `graph_export` | fs 导出 | 宿主已有 `export` |
| `decision_record` | 决策账本 | 宿主已有 `decide` |

## 注意

- 真跑要消耗真实子 Agent 轮次；`agent_message` 只对**直接连续子会话**有效；
- 实例表会写进 `.l0-control/journal.jsonl` 的 `agent_spawned` 行，重启后可回放（`send_message` 仍可用）；
- 本目录**不写** core/state，只记录与断言。
