# AI集群工作协议 · DSH 原生集群工作插件

这是一个**许愿式集群工作协议**，不是普通单 Agent 工具：

- 你提交一个愿望，插件把它拆成工作图，**派发多个子 Agent 并行工作**；
- 子 Agent 还可以继续向下派发子 Agent，形成**递归、分支的工作树**；
- 相当于同时开很多个对话窗口，一起推进同一个任务；
- 换来的是**更高的工作量和并行吞吐**，代价是**每个子 Agent 都独立消耗模型上下文与 token**。

**重要：它非常消耗 token。** 递归/并行会成倍放大成本；工作量大、消耗也大。启用前请设置预算、控制 `maxParallel` / `maxDepth`，并用观测看成本；不需要时保持停用。

## 成本与适用场景

- **适合**：工作量大、可拆分并行、需要独立审计/交叉验证的任务。
- **不适合**：小任务、低预算、必须严格串行或对延迟敏感的任务。
- **成本口径**：并行 Agent 数量 × 每轮上下文 × 递归深度。递归子 Agent 不是“免费并发”，每个都是完整模型调用。
- **建议**：先用小愿望试运行，设置 `maxParallel`/`maxDepth` 和 token 预算，观察 `graph_status.observability` 后再放大。

## 作者与许可

- **制作者**：weidujianchazhe（如天之星）
- **许可证**：MIT License，见 [LICENSE](LICENSE)
- 你可以自由使用、修改、分发、商用，但需保留版权与许可声明；软件按“原样”提供，不附带担保。

## 仓库结构

```text
plugins/dsh-l0-control/      控制面 Host 插件（19 工具 + core/state/native/security/observability/a2a/bootstrap + 记忆优先）
plugins/dsh-l0-control-ui/   侧边栏 + 主面板（AI集群工作协议）
control_plane/               Python 行为 oracle 与验收资料（不随插件运行时加载）
```

## 安装

在 DSH 中通过 `plugin_manager install_bundle` 安装两个插件目录：

```text
plugins/dsh-l0-control
plugins/dsh-l0-control-ui
```

**部署注意**：包内 `cordis.patch.yml` 不再写死 `workspaceRoot`；默认使用 DSH 的 `workingDirectory.defaultDirectory`，状态落在该目录的 `.l0-control/`。如果你的部署有多工作区/独立状态需求，请在 profile 里显式覆盖 `workspaceRoot` 与 `stateDir`，不要依赖当前进程 cwd。

## 门禁

```powershell
node plugins/dsh-l0-control/scripts/selftest.mjs
node plugins/dsh-l0-control/scripts/contract.mjs
node plugins/dsh-l0-control/scripts/bootstrap-check.mjs
node plugins/dsh-l0-control/scripts/persistence-check.mjs
node plugins/dsh-l0-control/tests/e2e/conformance.mjs
python -m unittest discover -s control_plane/tests
```

## 按对话启用

插件默认 `coordination=false`、`management=off`。在面板「插件开关」启用协作；「项目管理」里单独设置工作区管理（关闭 / 自动 / 开启）。

## 检查更新

`updateRepo` 默认 `weidujianchazhe/ai-cluster-protocol`，读取本仓库 `plugins/dsh-l0-control/package.json` 的 version 做比较；只有点击「检查更新」才请求，不自动更新。

---

# L0 调用层 · schema 与 fixture（工程区原型）

本目录保留训练无关调用层的**可机检形状**——工作图 schema、L1.1 作用域请求 schema、fixture 与检查脚本。设计依据在独立管理区，不在本仓库内。

## 运行

```
python tools/check_fixtures.py
```

当前 **23 个用例全通过**（工作图 16 + L1.1 7），退出码 0。

只用 Python 3 标准库（自带一个 JSON Schema 2020-12 子集校验器 + 语义检查），退出码对齐管理区约定：

- `0` 全通过 · `1` 有 [问题] · `2` 仅 [待核]（缺 fixture）· `3` 脚本自身错误

## 结构

```
schema/
  work_graph.schema.json     工作图 v2（graph / node / edge / state_unit / artifact / event / ledger
                              + capability / stage / evidence_required / evidence / decision
                              + replan_events / stage_gates / A2A 预留）
  l1_scope.schema.json       L1.1 共享请求（units + scope + graph_version + revoke）
fixtures/
  graph/                     16 个正例/反例（schema 错误 + 语义错误：依赖环、accepted 无验证器、
                             L2 缺默认值、L2 超时偏离默认、done 缺证据/证据未通过、ready 依赖未 done）
  l11/                       7 个 L1.1 判定用例（allow / private / unlabeled / stale / 竞争 / 撤销污染 / 错标）
  manifest.json              用例 → 期望结果（valid/invalid、decision/reasons/contaminated）
tools/
  check_fixtures.py          校验器 + 语义检查 + 判定函数 + 三态输出
```

## 检查内容

**schema 层**：必填字段 / 类型 / 枚举 / 正则（GRAPH、NODE、UNIT、ART、EVT、ACC、DEC、EVD）/ 预算下限 / sha256 格式 / 决策与证据结构 / A2A 预留字段。
**语义层（schema 表达不了的）**：
1. id 唯一（node / unit / artifact / decision）
2. 依赖必须存在且无环（node.deps + blocks 边）
3. `accepted` / `done` 节点必须有 `verifier_ids`（产物必须自足、检验不可绕过）
4. artifact 的 producer 节点必须存在
5. **L0/L1 决策**必须有 chosen；**L2 决策**必须有默认值 + 超时，且 `timed_out` 时 chosen == 默认；**L3** 只能 `confirmed`/`blocked`
6. **done 只能由证据触发**：证据非空、全部 `pass`、覆盖 `evidence_required` 类型
7. **ready 只能由依赖 done 触发**：ready 节点的所有依赖必须已 done
8. **阶段闸门**：done 节点所在阶段闸门必须 `passed`；重算事件 `graph_version` 不得超前
9. L1.1 判定（见下）

## L1.1 判定规则（fail-closed）

顺序：**撤销 → 作用域 → 版本 → 竞争 → 验收 → 类型**

| 触发 | 结果 | 原因码 |
|---|---|---|
| `revoke=true` | invalidate + 污染清单（沿 deps 传递） | `REVOKED_UPSTREAM` |
| `scope` 缺失 | deny | `UNLABELED_SCOPE` |
| `scope=private` | deny | `PRIVATE_SCOPE` |
| `graph_version` 不一致 | invalidate | `STALE_UNIT` |
| `competing=true` | deny | `COMPETING_PATH` |
| `status != confirmed` | deny | `UNVERIFIED` |
| `kind ∈ {assumption, open_question}` | deny | `UNVERIFIED` |

任一项 deny → 整体 deny；任一项 invalidate → 整体 invalidate（v1 保守：先失效再重判）。

## 边界（本原型不做）

- 不实现真实推理调用 / 缓存 / 计费，只校验**数据结构与判定语义**；
- 不引入第三方依赖（无 jsonschema / pytest）；
- 工作图状态机只做「字段与终态守卫」的最小检查，迁移合法性待实现阶段补；
- L1.1 的审计抽样、污染二次扩散标记只在判定层留接口，未实现存储。

---

## 探针插件（plugins/）

用于实测 DSH 扩展点（详见管理区 `designs/_research/DSH扩展点实测清单.md` §7）：

| 包 | 状态 | 验证内容 |
|---|---|---|
| `plugins/dsh-probe2`（`@local/dsh-probe2`） | **已安装（active）** | 工具注册 `probe2_report` / `probe2_storage`；`llm/stream` usage（含 `cacheReadTokens`）；`system-prompt/assemble` 计数；`fs` 持久化 + CAS（`FS_STALE_VERSION`） |
| `plugins/dsh-probe`（v1） | 已安装但 `enabled=false` | 用于验证「新装 bundle 才热加载」；v1 修改后行为未变，v2 新装即生效 |

**安装 / 停用**（需 `plugin_manager` 授权；改 profile，影响所有会话）：

```
plugin_manager install_bundle  target=<绝对包目录>
plugin_manager set_bundle      target=@local/dsh-probe  enabled=false
```

**注意**

- 探针会写 `.probe-state.json`（可删），并给每次模型调用加一个透传监听（只读 usage，不改请求/输出）；
- 探针是**实验件**，不承载工作图；正式底座按「核心库 + host 适配插件」路线（见管理区 `底座接入方式-讨论稿.md`）。

---

## 控制面 v1（control_plane/）

Python 3 标准库 + SQLite 的**许愿式生产集群控制面**参考实现（2026-10-29 完成 12 轮迭代）：

```
python -m unittest discover -s control_plane/tests -v     # 73 tests
python -m control_plane.demo_crud out/demo_crud           # 愿望→PRD→契约→生产→审计→交付 + 导出
```

- 模块：工作图 / 事件日志 / ready 门控 / 租约与 fencing / 决策 L0–L3 / 证据绑定 done / 阶段闸门与 replan / 看门狗 / 能力注册表与 A2A / 崩溃恢复。
- 最近验收：**73 tests passed**；端到端 demo 全部节点 done、闸门全 passed、`DEC-003=timed_out`、`DEC-004=confirmed`、graph_version=2、**144 events**、导出 14 个文件。
- 细节与不变量见 [control_plane/README.md](control_plane/README.md)、[ROADMAP.md](control_plane/ROADMAP.md)、[PROGRESS.md](control_plane/PROGRESS.md)。
