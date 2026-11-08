# Changelog

## 0.1.1

### 工作图

- `wish_submit` 记录愿望并返回建图指令，不自动生成固定节点；节点与依赖由 `graph_plan` 预览、`graph_commit` 落图。
- `graph_plan`：零写入校验（ID 唯一 / 依赖存在 / 无环 / 阶段合法 / 每节点可验收 / 预算合法），返回 `wouldBeReady` 与拓扑序。
- `graph_commit`：校验通过才写入，重复提交幂等，失败零写入。
- `graph_status`：返回节点最小投影并支持 `limit` / `offset` 分页。

### 派活与租约

- 新增 `task_heartbeat({nodeId, fencingToken, ttlSec?})`：续租只认 `fencingToken` 能力凭证，不绑定智能体身份；任一载体持凭证即可续租。
- `agent_spawn` 支持三种子 Agent 组装策略；未注册的 provider 显式报错，不静默回退。
- `agent_reap` 默认 dry-run，只释放句柄并归档会话，不删除权威记录；触发条件由配置面控制（默认关闭）。

### 证据与审计

- 证据带来源分级：`verified`（已核验）/ `inferred`（推断）/ `assumed`（假设）；只有 `verified` 能支撑节点完成。
- 传 `acceptance` 且命中时按机器核验收录为 `verified`；只有手写结论时记为 `inferred`。
- `verify_done` 要求生产方与审计方不同，且审计方须为审计职务；结论未知不得通过。

### 记忆优先

- 新增 `memory_load` / `memory_writeback`：按需读取任务卡、状态与报告，写回结论、证据指针与下一步。
- 新增 `memory-first` Agent 预设；启用协作的对话默认保留最近 30 轮上下文。

### 多工作区与面板

- 每个工作区独立状态目录与串行 journal；面板可按工作区/对话查看，显示团队、活跃子 Agent、就绪节点与黑板事件。
- UI 侧车只读、默认绑定 `127.0.0.1`；跨源按来源主机判定，回环来源任意端口放行，外部站点拒绝。

### 发布

- 版本 0.1.1；MIT License。
- 工具数 22。
