# dsh-l0-control（AI集群工作协议 · DSH 原生插件）

> 本文件只写**这个插件内部**：目录、构建、工具面、宿主依赖、硬约束。
> 项目级说明（是什么、架构、协作结构、性能、数据落点、成本）在**仓库根 README**。
> **按功能模块展开的细节在仓库根的 [`docs/`](../../docs/README.md)**——正文 `01`–`14` 递归编号（状态与日志、派发与闸门、租约、证据与审计、协调器、容量、存储、工具、测试、质量、协作图、编排感知、为什么做这个、组织因子），另有附录 `A1`（MoE 猜想）与 `A2`（已知问题台账）不占正文编号。

一个 `l0control` 服务 + **31 个工具**，复用宿主原生面（`agentTeams` / `subagents` / `sessionController` / `tools`）。

## 目录

```
src/
  index.ts        插件入口：name / inject / Config / apply → ctx.provide('l0control') + 工具注册
  config.ts       配置（schemastery 优先）
  capabilities.ts 工具面 → native / projection / self-built 分级 + 质量声明
  service.ts      l0control 服务（参数校验 / caller 取用 / journal / core 委派 / 环境体检）
  tools.ts        31 个工具定义
  core/           图 / ready / 证据 / 完成凭证 / 决策 / 租约 / 组成因子校验 / 组织审查 / 重规划 / 准入 / 预算 / 检查点
  dispatch/       派发循环（闸门优先级链、退避、队列、速率、派发视图）
  state/          canonical journal / 快照 / CAS / 恢复
  native/         子 Agent 组装（team / activation / provider）、worker 契约、失败分类
  security/       角色矩阵、令牌、授权闸门、调用者解析
  observability/  采样、健康、告警、脱敏导出
  a2a/            可选 A2A 传输层
  bootstrap/      project_init
  workspaces/     每工作区独立状态
  ui-server.ts    面板只读侧车
lib/              构建产物（**committed**，安装时直接加载）
tests/            验收链（见根 README「开发」）
```

## 构建

`lib/` 是**入库的**——`main` 指向 `lib/index.js`，别人 clone 后不用构建就能装。代价是**改了 `src/` 必须重新构建**：

```bash
node scripts/build.mjs            # src/**.ts → lib/**.js
node scripts/build.mjs --check    # 校验 lib 与 src 是否同步（本机自检用）
```

构建用 Node 内置 `module.stripTypeScriptTypes()`：只剥类型、不做类型检查。类型正确性由独立一步保证：

```bash
npm i                        # 装 devDependency typescript（只需一次）
node scripts/typecheck.mjs   # tsc --noEmit -p tsconfig.typecheck.json
```

### ⚠️ `--check` 是**本机自检**，不是跨环境验证工具

`stripTypeScriptTypes()` 的 emit 结果**随 Node 版本变化**（空白、注释、类型剥离细节）。所以：

| 场景 | 该用什么 |
|---|---|
| 你改了 `src`，想知道要不要重新 build | `--check` ✅ |
| 你拿到别人的包，想知道它**完不完整** | **`npm run verify`** ✅ |
| 用不同 Node 版本跑 `--check` | ⚠️ 会看到 `format-drift`（**仅格式差异，不判失败**） |

`--check` 已经区分两种不一致：

- **`stale`**：语义真的不同（改了源码没 build）→ **退出 1**
- **`format-drift`**：去掉空白后完全一致，只差排版（通常是 Node 版本不同）→ **不判失败**，但会打印出来

**验证一个包是否完整，看 `npm run verify` 能不能过（62 步），不要看 `--check`。**

要求 Node **>= 22.6.0**（`stripTypeScriptTypes` 自该版本起提供），已在 `package.json` 的 `engines` 声明。

`tsconfig.typecheck.json` 刻意保守：`strict` / `strictNullChecks` 关闭（先求接口、导入、返回值结构对得上），`allowImportingTsExtensions` 开启（源码用 `.ts` 后缀 import，构建期改写），`noEmit`。依赖缺失时该步**判失败而不是跳过**。

> `lib/` 是全量生成物：改了 `src/**` 必须重跑构建；**不要手改 `lib/*.js`**。

## 宿主依赖（有一条不在本仓库里）

本插件的 `inject` 只有 `['tools']`，其余能力全是运行时从宿主取的。**缺了不会报错，只会静默降级**——所以首次工具调用会自检一次并留 journal（`host_services_ok` / `host_service_missing`），`graph_status.capabilities.hostServices` 也直接可见。

| 宿主服务 | 谁来提供 | 缺了会怎样 |
|---|---|---|
| `subagents` | DSH 内置 | **完全派不出子会话** |
| `sessionController` | DSH 内置 | 无法续跑既有会话、无法转发消息 |
| `agentTeams` | **`@deepseek-ai/dsh-experimental-agent-team`（DSH 自带，需在 profile 启用）** | `agent_spawn` 全退回 activation（子实例**不能**当 TeamTask owner），`teamMemberLimit` 放开无效；其余功能正常 |

### 关于 Agent 预设：默认继承，不假设别人装了什么

`defaultAgentPreset` **默认是空串 = 子实例继承父会话的预设**。

不要把它设成某个具体名字（比如 `memory-first`），除非你确认那个包已装——宿主对「指定了但没注册的预设」是**直接抛 `PRESET_UNAVAILABLE`**，`agent_spawn` 会失败，**不是降级，是派不出去**：

```js
// @deepseek-ai/dsh-subagent/lib/types/child-agent.js
if (composition.agentPreset !== undefined) {
  const presets = childCtx.get('agentPresets');
  if (presets === undefined) throw new SubagentError('...', 'PRESET_UNAVAILABLE');
  return presets.mount(childCtx, composition.agentPreset);   // 未知名字在这里失败
}
```

而不传时宿主走 `selectedPreset ?? parent.composedPreset(parent)` —— 子实例继承父的预设，既不需要那个包存在，也不丢父会话的能力。

> 历史上这里硬编码过 `'memory-first'`（仓库 `presets/memory-first/` 提供的预设）。本机装了所以没暴露；**别人没装就会在第一次派发时失败**。

## 安装 / 启用 / 禁用

```bash
install_bundle  target=<REPO_ROOT>\plugins\dsh-l0-control
set_bundle      target=@local/dsh-l0-control enabled=false|true
```

验收点：`install_bundle → application: applied`；配置出现在 schema 清单里；工具可见；disable 后工具消失、journal 不再增长（append-only 文件保留）。

## 工具面（31）

**开工前**

| 工具 | 作用 |
|---|---|
| `env_check` | **环境体检**：宿主服务、数据落点与各盘空间、按实测速率推算的千级/万级占用、`suggestedMaxAgents`；`ready=false` 时 `blockers` 列出必须先解决的项 |

**建图与状态**

| 工具 | 作用 |
|---|---|
| `wish_submit` | 只记录愿望，返回 GraphSpec 模板与建图指令（不自动建图） |
| `graph_plan` | 工作图预览：零写入校验，返回 errors / warnings / `wouldBeReady` / 拓扑序 |
| `graph_commit` | 落图：校验通过才写节点与依赖；重复提交幂等；失败零写入 |
| `graph_status` | 读图状态：journal 摘要、快照、能力摘要、宿主服务视图、存储视图、节点最小投影（分页） |
| `graph_export` | 导出人读投影（能力清单 / 状态文件） |
| `graph_checkpoint` / `graph_recover` / `graph_resume_plan` | 分区检查点 / 恢复报告 / 恢复计划（recover-once、skip-completed） |
| `graph_replan` | **唯一改图的协调动作**：单事务增删节点/改依赖 + 递增 `graph_version`；`expectedGraphVersion` 必填做 CAS（版本不符 → `replan_stale_graph`，零写入）；终态不可删 |

**只读观测与组织协调**

| 工具 | 作用 |
|---|---|
| `organization_review` | 组织审查（**只读**）：集成契约状态、冲突路由、写域重叠、协调草案；`fingerprint` 同一 journal 可回放；不派活、不改图、不裁决 |
| `quality_report` / `collaboration_map` / `neighbor_digest` | 过程质量 / 谁读了谁（含 `delta`）/ 同分区邻域摘要——都只读、都不参与判定 |

**派活与租约**

| 工具 | 作用 |
|---|---|
| `dispatch` | 派活循环：off / interval / resident；默认 dry-run，不自动 claim |
| `task_next` / `task_claim` | 取下一个可执行节点 / 领取节点（落租约，带 `fencing_token`） |
| `task_heartbeat` | 续租：只认 `fencingToken` 能力凭证，不绑定智能体身份；续租失败即停手 |

**证据与治理**

| 工具 | 作用 |
|---|---|
| `evidence_submit` | 提交证据：产物须真实存在；带来源分级（仅 `verified` 能支撑完成）；须可确定生产实例 |
| `verify_done` | 置完成：生产方与审计方必须不同，审计方须为审计职务，未知不得通过 |
| `pass_gate` / `decision_record` | 五段阶段闸门 / L0–L2 决策记录 |

**子 Agent 与团队板**

| 工具 | 作用 |
|---|---|
| `agent_spawn` | 起子 Agent：Team member / activation / provider 三种组装；Team 满自动退回 activation |
| `agent_message` / `agent_reap` | 投消息 / 回收空闲子 Agent（默认 dry-run） |
| `team_status` | 读团队板与派生的子 Agent 实例（缺 caller 即拒） |
| `board_task_create` / `board_task_update` | 团队板任务（**投影**，非权威） |

**记忆与工程**

| 工具 | 作用 |
|---|---|
| `memory_load` / `memory_writeback` | 按需读任务卡与报告 / 写回结论与下一步 |
| `project_init` | 初始化工程区与管理区骨架（默认 dry-run，只 git init） |

## 硬约束

- `agentTeams` / `subagents` 的每个方法都要**活 Agent** 作 caller；工具入口取 `exec.agent`，缺失即 `caller-required` fail-closed。
- `src/core` 缺失时所有图操作返回 `core-unavailable`（不假装成功）。
- 不 fork 宿主、不替代宿主协议、不写第二份状态。
- **状态迁移只有一条入口**（`setStatus`），**改图只有一条入口**（`graph_replan`）；建成第二条路，两条必然漂移。
- **授权必须显式登记**。`ACTION_BY_TOOL` 未登记的动作会落到默认 `graph.read`——所以 `graph_replan` 必须写在表里成为 `graph.write`，否则只读角色也能改图。
- `stateDir` 相对 `workspaceRoot` 解析；**测试传 stateDir 必须用绝对路径**，否则会被重解释、清理钩子删不到（本仓库曾因此攒下 611 个残留目录）。
