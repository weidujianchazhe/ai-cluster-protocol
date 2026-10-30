# dsh-l0-control（AI集群工作协议 · DSH 原生插件）

> 许愿式集群工作插件：派发多个子 Agent 并行工作，子 Agent 可继续递归派发；高吞吐，但 **token 消耗显著更高**。

## 它是什么

把 **AI集群工作协议** 做成 DSH 原生插件：一个 `l0control` 服务 + 19 个工具，直接复用宿主原生面
（`agentTeams` / `subagents` / `sessionController` / `tools`），Python `control_plane/` 退为行为 oracle。

**0.1.1 记忆优先**：新会话可选 `memory-first` preset；启用插件的会话在 `agent/pre-step` 只保留最近 30 个用户轮次；`memory_load` 按需读取管理区任务卡/STATE/报告；子 Agent 继承 access、记忆 prompt 与 context pack。

**集群工作方式**：一个愿望 → 工作图 → 多个 Agent 并行；子 Agent 还能继续向下派发子 Agent，形成递归/分支工作树。
**成本**：每个子 Agent 都是独立模型上下文；并行和递归会成倍放大 token 消耗。请设置预算、限制 `maxParallel`/`maxDepth`，不需要时保持停用。

**权威边界**：插件 journal（append-only）是权威；TeamTask 是投影；DSH Session log 是执行证据，不是图状态。

## 目录

```
src/
  index.ts        插件入口：name / inject / Config / apply → ctx.provide('l0control') + 9 工具
  config.ts       schemastery 优先、Standard Schema 兜底的 Config
  capabilities.ts 9 个工具面 → native / projection / self-built 分级 + quality 声明
  service.ts      l0control 服务（参数校验 / caller 取用 / journal / core 委派）
  tools.ts        9 个工具定义
  core/           （N3 写域）图 / ready / evidence / done / decisions / leases
  state/          （N4 写域）canonical journal / CAS
  e2e/            （N5 写域）端到端脚本
lib/              构建产物（committed，安装时直接加载）
```

## 构建

```bash
node scripts/build.mjs            # src/**.ts → lib/**.js
node scripts/build.mjs --check    # 校验 lib 与 src 是否同步（CI 用）
```

**构建边界（重要）**：本机没有 TypeScript 编译器，构建用 Node 内置
`module.stripTypeScriptTypes()` —— **只剥类型，不做类型检查**。所以要靠
`tsconfig.json` + 审查保证类型正确；一旦环境有 `tsc`，改成 `tsc -p .` 即可，产物路径不变。

> 共享目录提醒：`lib/` 是**全量**生成物。任何 lane 改了 `src/**` 都要重跑构建；
> 不要手改 `lib/*.js`（下一次构建会被覆盖）。

## 安装 / 启用 / 禁用

```bash
# 在 DSH 会话里用 plugin_manager
install_bundle  target=<REPO_ROOT>\plugins\dsh-l0-control
set_bundle      target=@local/dsh-l0-control enabled=false|true
```

验收点：`install_bundle → application: applied`；`Config.listConfigs(name=@local/dsh-l0-control)` → `status: schema`；
9 个工具可见；disable 后工具消失、journal 不再增长（append-only 文件保留）。

## 工具面（17）

| 工具 | 分级 | 底层 |
|---|---|---|
| `wish_submit` | self-built | journal：**只记录愿望**，返回 GraphSpec 模板 + 建图指令（`graphPlanRequired`），**不自动建图** |
| `graph_plan` | self-built | core/graphspec：校验 GraphSpec（ID 唯一/依赖存在/无环/stage 合法/每节点可验收/预算）→ errors/warnings/ready，**零写入** |
| `graph_commit` | self-built | core/graphspec：校验通过后落节点/依赖并算 ready；同一份图重复提交幂等；校验失败零写入 |
| `graph_status` | self-built | journal/快照投影 + capabilities 摘要 |
| `task_next` | self-built | core.nextTask（ready 门控） |
| `task_claim` | self-built | journal + core.claimTask（租约） |
| `evidence_submit` | self-built | 产物存在性 → core.submitEvidence（append-only） |
| `verify_done` | self-built | core.verifyDone（unknown 不得 done） |
| `decide` | self-built | core.decide（L0–L2 账本） |
| `team_status` | **native** | `agentTeams.membership/listMembers/listTasks`（caller=`exec.agent`） |
| `export` | projection | fs 写 `capabilities.json` / `STATE.md` + core 导出 |

> 其余工具（`pass_gate` / `agent_spawn` / `agent_message` / `board_task_*` / `project_init`）见 `src/capabilities.ts`。

## 建图：只有组成因子，没有固定流水线

工作图**不提供**"固定 6 节点 / 固定角色架构"。可组合因子：

- **Node**：`nodeId`（稳定 ID）、`title`、`spec`（做什么/边界/约束）、`capability`（自由标签）、
  `stage`（research/design/build/audit/deliver，**阶段不是岗位**）、`deps`、`evidenceRequired`、
  `verifierIds` / `acceptance`、`budget`（maxTokens/maxParallel），可选 `writeScopes`/`contextRefs`/`risk`。
- **Edge**：只表达"完成先后 + 证据依赖"，不表达组织层级。
- **GraphSpec**：`{version, wish, nodes[], policies{maxParallel,maxDepth,budgetTokens}, notes[]}`。

AI 建图步骤：① 分析需求/风险/可并行点 → ② 只挑因子拼节点（数量由工作决定）→ ③ `graph_plan` 预览
（errors/warnings/ready，零写入）→ ④ 确认后 `graph_commit` 落图。**每个节点必须可验收**；能并行才并行，强依赖必须显式 `deps`。

`capabilities.supports_whitebox = false`：L1 白盒不在宿主插件可达范围（见 `_research/DSH扩展点实测清单.md`）。

## 硬约束

- `agentTeams` / `subagents` 的每个方法都要**活 Agent** 作 caller；`apply(ctx)` 本身不是 Agent，
  所以工具入口取 `exec.agent`，缺失即 `caller-required` fail-closed。
- `src/core` 缺失时所有图操作返回 `core-unavailable`（不假装成功）。
- 不 fork DSH、不替代宿主协议、不写第二份状态。
