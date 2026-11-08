# dsh-l0-control（AI集群工作协议 · DSH 原生插件）

> 许愿式集群工作插件：派发多个子 Agent 并行工作，子 Agent 可继续递归派发；高吞吐，但 **token 消耗显著更高**。

## 它是什么

把 **AI集群工作协议** 做成 DSH 原生插件：一个 `l0control` 服务 + 22 个工具，直接复用宿主原生面（`agentTeams` / `subagents` / `sessionController` / `tools`）。

**集群工作方式**：一个愿望 → 由 AI 按需求组装工作图 → 多个 Agent 并行；子 Agent 还能继续向下派发，形成递归/分支工作树。

**成本**：每个子 Agent 都是独立模型上下文；并行与递归会成倍放大 token 消耗。请设置预算、限制 `maxParallel` / `maxDepth`，不需要时保持停用。

**权威边界**：插件 journal（append-only）是权威；团队板任务是投影；会话记录是执行证据，不是图状态。

## 目录

```
src/
  index.ts        插件入口：name / inject / Config / apply → ctx.provide('l0control') + 工具注册
  config.ts       配置（schemastery 优先）
  capabilities.ts 工具面 → native / projection / self-built 分级 + 质量声明
  service.ts      l0control 服务（参数校验 / caller 取用 / journal / core 委派）
  tools.ts        22 个工具定义
  core/           图 / ready / 证据 / 完成凭证 / 决策 / 租约 / 组成因子校验
  state/          canonical journal / 快照 / CAS
  native/         子 Agent 组装（team / activation / provider）与 worker 契约
  security/       角色、令牌、门禁
  observability/  采样、健康、告警、脱敏导出
  a2a/            可选 A2A 传输层
  bootstrap/      project_init
  workspaces/     每工作区独立状态
  ui-server.ts    面板只读侧车
lib/              构建产物（committed，安装时直接加载）
```

## 构建

```bash
node scripts/build.mjs            # src/**.ts → lib/**.js
node scripts/build.mjs --check    # 校验 lib 与 src 是否同步（CI 用）
```

构建用 Node 内置 `module.stripTypeScriptTypes()`：只剥类型、不做类型检查。类型正确性由独立一步保证：

```bash
npm i                        # 装 devDependency typescript（只需一次）
node scripts/typecheck.mjs   # tsc --noEmit -p tsconfig.typecheck.json（有错退出 1）
```

`tsconfig.typecheck.json` 刻意保守：`strict` / `strictNullChecks` 关闭（先求接口、导入、返回值结构对得上），`allowImportingTsExtensions` 开启（源码用 `.ts` 后缀 import，构建期改写），`noEmit`。依赖缺失时该步**判失败而不是跳过**。

> `lib/` 是全量生成物：改了 `src/**` 必须重跑构建；不要手改 `lib/*.js`。

## 安装 / 启用 / 禁用

```bash
install_bundle  target=<REPO_ROOT>\plugins\dsh-l0-control
set_bundle      target=@local/dsh-l0-control enabled=false|true
```

验收点：`install_bundle → application: applied`；配置出现在 schema 清单里；工具可见；disable 后工具消失、journal 不再增长（append-only 文件保留）。

## 工具面（22）

| 工具 | 作用 |
|---|---|
| `wish_submit` | 只记录愿望，返回 GraphSpec 模板与建图指令（不自动建图） |
| `graph_plan` | 工作图预览：零写入校验，返回 errors / warnings / `wouldBeReady` / 拓扑序 |
| `graph_commit` | 落图：校验通过才写节点与依赖；重复提交幂等；失败零写入 |
| `graph_status` | 读图状态：journal 摘要、快照、能力摘要、节点最小投影（分页） |
| `dispatch` | 派活循环：off / interval / resident；默认 dry-run |
| `task_next` / `task_claim` | 取下一个可执行节点 / 领取节点（落租约） |
| `task_heartbeat` | 续租：只认 `fencingToken` 能力凭证，不绑定智能体身份 |
| `evidence_submit` | 提交证据：产物须真实存在；带来源分级；须可确定生产实例 |
| `verify_done` | 置完成：生产方与审计方必须不同，审计方须为审计职务，未知不得通过 |
| `pass_gate` / `decision_record` | 阶段闸门 / L0–L2 决策记录 |
| `memory_load` / `memory_writeback` | 按需读任务卡与报告 / 写回结论与下一步 |
| `team_status` | 读团队板与派生的子 Agent 实例（缺 caller 即拒） |
| `agent_spawn` / `agent_message` / `agent_reap` | 起子 Agent / 投消息 / 回收空闲子 Agent（默认 dry-run） |
| `board_task_create` / `board_task_update` | 团队板任务（投影） |
| `graph_export` | 导出人读投影（能力清单 / 状态文件） |
| `project_init` | 初始化工程区与管理区骨架（默认 dry-run，只 git init） |

## 建图：只有组成因子，没有固定流水线

工作图**不提供**「固定节点数 / 固定角色架构」。可组合因子：

- **Node**：`nodeId`、`title`、`spec`（做什么/边界/约束）、`capability`（自由标签）、`stage`（research / design / build / audit / deliver，**阶段不是岗位**）、`deps`、`evidenceRequired`、`verifierIds` / `acceptance`、`budget`，可选 `writeScopes` / `contextRefs` / `risk`。
- **Edge**：只表达「完成先后 + 证据依赖」，不表达组织层级。
- **GraphSpec**：`{version, wish, nodes[], policies{maxParallel,maxDepth,budgetTokens}, notes[]}`。

建图步骤：① 分析需求 / 风险 / 可并行点 → ② 只挑因子拼节点（数量由工作决定）→ ③ `graph_plan` 预览 → ④ 确认后 `graph_commit` 落图。**每个节点必须可验收**；能并行才并行，强依赖必须显式 `deps`。

## 硬约束

- `agentTeams` / `subagents` 的每个方法都要**活 Agent** 作 caller；工具入口取 `exec.agent`，缺失即 `caller-required` fail-closed。
- `src/core` 缺失时所有图操作返回 `core-unavailable`（不假装成功）。
- 不 fork 宿主、不替代宿主协议、不写第二份状态。
