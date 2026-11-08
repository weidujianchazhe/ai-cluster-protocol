# AI集群工作协议 · DSH 原生集群工作插件

一个**许愿式集群工作插件**，不是普通单 Agent 工具：

- 你提交一个愿望，插件把愿望记录为意图，由 AI 按需求组装**工作图**（节点与依赖由工作决定，不是固定流水线）；
- 按工作图**派发多个子 Agent 并行工作**，子 Agent 可以继续向下递归派发，形成分支工作树；
- 每个节点走「领取 → 证据 → 独立审计 → 完成」，审计方不能是生产方；
- 相当于同时开很多个执行载体一起推进同一个任务，换来更高的并行吞吐。

**重要：它非常消耗 token。** 递归/并行会成倍放大成本；每个子 Agent 都是独立上下文与完整模型调用。启用前请设置预算、控制 `maxParallel` / `maxDepth`，并用观测看成本；不需要时保持停用。

## 成本与适用场景

- **适合**：工作量大、可拆分并行、需要独立审计/交叉验证的任务。
- **不适合**：小任务、低预算、必须严格串行或对延迟敏感的任务。
- **成本口径**：并行 Agent 数量 × 每轮上下文 × 递归深度。
- **建议**：先用小愿望试运行，设置 `maxParallel` / `maxDepth` 与 token 预算，观察 `graph_status` 的观测字段后再放大。

## 作者与许可

- **制作者**：weidujianchazhe（如天之星）
- **许可证**：MIT License，见 [LICENSE](LICENSE)
- 可自由使用、修改、分发、商用，需保留版权与许可声明；软件按「原样」提供，不附带担保。

## 仓库结构

```text
plugins/dsh-l0-control/      控制面 Host 插件（22 工具 + core / state / native / security / observability / a2a / bootstrap）
plugins/dsh-l0-control-ui/   侧边栏 + 主面板（AI集群工作协议）
presets/memory-first/        记忆优先 Agent 预设
schema/                     工作图与作用域请求 schema
fixtures/                   schema 校验用例
tools/                      fixture 检查脚本
```

## 安装

在 DSH 中通过 `plugin_manager install_bundle` 安装两个插件目录：

```text
plugins/dsh-l0-control
plugins/dsh-l0-control-ui
```

**部署注意**：包内 `cordis.patch.yml` 不写死 `workspaceRoot`；默认使用 DSH 的 `workingDirectory.defaultDirectory`，状态落在该目录的 `.l0-control/`。多工作区/独立状态请在 profile 里显式覆盖 `workspaceRoot` 与 `stateDir`，不要依赖进程 cwd。

## 主要能力

- **愿望 → 工作图**：`wish_submit` 只记录意图；`graph_plan` 零写入校验预览；`graph_commit` 落图（幂等，校验失败零写入）。
- **派活与租约**：`task_next` / `task_claim` / `task_heartbeat`。心跳绑定 `fencingToken` 能力凭证而**不绑定智能体身份**，任一载体持 token 即可续租；续租失败即停手。
- **证据与审计**：`evidence_submit`（产物须真实存在，带来源分级 `verified` / `inferred` / `assumed`，仅 `verified` 能支撑完成）、`verify_done`（生产方与审计方必须不同）、`pass_gate`。
- **子 Agent**：`agent_spawn`（三种组装策略）、`agent_message`、`agent_reap`（默认 dry-run，只释放/归档，不硬删记录）。
- **记忆优先**：`memory_load` 按需读管理区任务卡/状态/报告，`memory_writeback` 写回结论与下一步；启用协作的对话默认只保留最近 30 轮上下文。
- **可观测**：面板显示团队、活跃子 Agent、就绪节点、黑板事件；`graph_status` 支持分页，避免一次性回传整张图。

## 门禁

```powershell
node plugins/dsh-l0-control/scripts/build.mjs --check      # 构建产物与 src 同步
node plugins/dsh-l0-control/scripts/typecheck.mjs          # 类型检查（0 error）
node plugins/dsh-l0-control/scripts/selftest.mjs
node plugins/dsh-l0-control/scripts/contract.mjs
node plugins/dsh-l0-control/scripts/bootstrap-check.mjs
node plugins/dsh-l0-control/scripts/persistence-check.mjs
node plugins/dsh-l0-control/tests/e2e/conformance.mjs
node plugins/dsh-l0-control/tests/e2e/run.mjs
```

## 按对话启用

插件默认 `coordination=false`、`management=off`。在面板「插件开关」启用协作；「项目管理」里单独设置工作区管理（关闭 / 自动 / 开启）。

## 面板侧车

面板数据来自插件内置的只读侧车（默认 `127.0.0.1:47831`，可用 `uiHost` / `uiPort` 调整）。
跨源访问按**来源主机**判定：回环来源（`127.0.0.1` / `localhost` / `[::1]`）任意端口放行，
外部站点一律拒绝；如需反代或自定义域名，用 `uiAllowedOrigins`（逗号分隔）显式追加。

## 检查更新

`updateRepo` 默认 `weidujianchazhe/ai-cluster-protocol`，读取本仓库 `plugins/dsh-l0-control/package.json` 的 version 做比较；只有点击「检查更新」才请求，不自动更新。
