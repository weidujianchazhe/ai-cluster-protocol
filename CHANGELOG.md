# Changelog

## 0.1.1

### 记忆优先 / 上下文成本

- 新增 `memory-first` Agent Preset（`presets/memory-first`）：先读任务卡/STATE/最近交接，最近对话优先，旧内容按需检索。
- 启用插件的会话接入 `agent/pre-step` 上下文裁剪：默认保留最近 **30 个用户轮次**（`contextRecentTurns`）。
- 新增 `memory_load` / `memory_writeback` 工具：按需读取任务卡、`STATE.md`、一篇报告；写回结论/下一步/证据为短报告并在任务卡追加指针。
- 子 Agent 继承父 session 的 access；默认 `memory-first`（activation 路径）或记忆优先 prompt（Team member 路径）。
- 子 Agent 默认使用最小 context pack，不继承父会话完整历史。
- 黑板增量/摘要：`sinceSeq` 游标、最近 40 条 + 按 kind 汇总。
- 能力包上下文：worker prompt 使用 `capability` / `contextPack`，role 只作实例身份与工具白名单。

### 工作图

- 新增 `graph_plan`（零写入校验/预览）与 `graph_commit`（任意合法 DAG 落图，幂等）。
- `wish_submit` 只记录愿望并返回建图指令，不再自动生成固定 6 节点。
- 支持回填已完成节点的 `status: done`。

### 多工作区 / UI

- `ServicePool` + registry：每个工作区独立 stateDir/journal/lock；主工作区沿用旧目录。
- UI 支持按工作区/对话查看，活跃子 Agent 列表，就绪节点空图提示；标签改为“递归子 Agent 总数”。
- `project_init` 支持选中工作区、同级 `<project>-管理区`、UI 新建项目。
- 修复 UI 服务内存态落后于持久层时工作图显示 0 nodes 的问题。

### 发布

- 工具数 15 → 19。
- 版本 0.1.1；MIT License；release 附件由 `git archive` 生成，不含 `.git`/本地状态。
