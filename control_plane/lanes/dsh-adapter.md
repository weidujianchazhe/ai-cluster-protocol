# Lane D · dsh-adapter 工作记录

> 章程：`管理区/designs/_research/60轮并行分工与长任务.md` §3 D（17 轮）
> 任务卡：TASK-1278CF（骨架）· TASK-2E33C5（spawn/call）· TASK-10FB0A（状态/检查点）· TASK-65B648（职务编队）
> 写域：`plugins/dsh-l0-adapter/`（新）、`control_plane/capabilities.py`、`control_plane/tests/integration/`、`control_plane/lanes/dsh-adapter.md`

---

## R1 · 可调用性 spike（静态契约层）· 2026-10-29

**目标**：回答"`sessionController.prompt` / `subagents.startActivation` 在插件进程内是否可调"，
决定走插内原生实现还是外置 wrapper（从缓冲扣）。

**方法**：`cordis_inspect_query` 取 `Service` 精确契约（sessionController / subagents 两条），
再解包 `app.asar` 直读实现源码（`@Remote` 装饰器、service 类、provider 注册）。

**证据（源码级）**

| # | 结论 | 证据位置 |
|---|---|---|
| 1 | `@Remote` 只是**标记**：`remoteDecorator` → `addInitializer` → `mark(prototype, method, …)`，只往原型写一个 `REMOTE_METHOD_DESCRIPTOR`；**方法本体不动** | `dsh-typert-protocol/lib/index.js:364-471`（`Remote` / `mark` / `remoteMethods`） |
| 2 | `sessionController.prompt(request, source)` 是真实方法：`resolveAgent(sessionId)` → 附件/上传校验 → `agent.followup(message)`（`mode:'steer'` 走 `agent.steer`） | `dsh-api-session-controller/lib/index.js:925-964` |
| 3 | `subagents` 服务 = `class SubagentRuntime extends TypertRemoteService`，`super(ctx, 'subagents')`；`startActivation(spec)` 为公开方法 | `dsh-subagent/lib/index.js:2944 / 2993 / 3037` |
| 4 | spawn 后端 provider 名默认 `spawn`，能力 `{agentOptions, agentPreset, outputSchema, depthLimit}`，`prepareContinuable` 返回 `{}` | `dsh-subagent-spawn-in-process/lib/index.js`（整文件） |
| 5 | Host 插件契约 = `export const name / inject / Config / function apply(ctx, config)`，`Config` 用 `schemastery` | 同上包 + `skills/cordis-plugin-development/references/host-plugin.md` §Host plugin export forms |
| 6 | linked bundle 的模块解析会回落到 dsh 安装目录（profile `node_modules` 里没有 `@deepseek-ai/dsh-subagent`，但 `dsh-subagent-claude-code` 已 active 并 import 它） | profile `node_modules/@deepseek-ai/dsh-subagent-claude-code/lib/index.js:1-8` |

**契约要点（写进 adapter）**
- `SessionPromptRequest{requestId, sessionId, mode:'queue'|'steer', content: PromptContentPart[], clientTimeZone?}` → `{accepted:true}`；
  **不等执行完成**，结果要靠 `follow` / session 事件收。
- `SubagentActivationSpec{provider, label, request:{prompt, parent: Agent, signal, cwd?, agentPreset?, outputSchema?}, signal, delivery:'parent'|'caller'}`；
  `parent` 必须是**活的 Agent**（工具内 = `exec.agent`）。
- 结论：**插内实现可行，不切外置 wrapper**（外置 wrapper 保留为跨宿主备选，不动缓冲）。

**偏差记录**
- 写域 `tests/integration/`（章程原文）在工程区不存在，且验收门禁是 `python -m unittest discover -s control_plane/tests`；
  故集成夹具落 `control_plane/tests/integration/`（与任务板 writeScopes 一致），保证进标准门禁。

**阻塞**：无。

**下一轮（R2）**：`plugins/dsh-l0-adapter` 骨架（package.json + cordis.patch.yml + schemastery Config + `l0adapter` 服务 + `adapter_capabilities` 8 项 + `adapter_spike` 工具），`install_bundle` 后由 `adapter_spike` 出运行时证据。

---

## R2 · bundle 骨架 + Config + 服务 + 10 个工具 + 安装 · 2026-10-29

**新增**（写域内，未动 probe2）

| 文件 | 作用 |
|---|---|
| `package.json` | `dsh.bundle.patch` + exports（index / locale / icon） |
| `cordis.patch.yml` | 插入 entry `dsh-l0-adapter`，config 含 workspaceRoot / stateDir / provider / fencingTtlMs / priceSheet |
| `lib/config.js` | Config 单一 spec → schemastery 优先、Standard Schema 兜底 |
| `lib/store.js` | 单写者 + 临时文件 rename + 单调 version + 单调 fencing token + sha256 |
| `lib/service.js` | 8 能力声明 + spawn / call / state / checkpoint / takeover / verify / meter / report |
| `index.js` | `export name/inject/Config/apply`；`llm/stream` 计量；`system-prompt/assemble` 计数；10 个工具；`ctx.provide('l0adapter')` |
| `locale/{zh,en}.json`、`icon.svg` | 插件清单展示元信息 |

**三条实测教训（后续 lane 会踩）**

1. **link: 安装的 bundle 按真实路径解析模块** → 插件目录里 `import '@deepseek-ai/schemastery'` 直接 `ERR_MODULE_NOT_FOUND`（首次 install 即 `application: failed`）。修法：Config 通过 `DSH_PROFILE_DIR` / `DSH_HOME` / `~/.dsh/profiles/<name>` 动态 import schemastery，取不到就退 Standard Schema（cordis `resolveConfig` 只要求 `Config['~standard'].validate`）。
2. **`@deepseek-ai/cordis` 同样不可解析** → 不继承 `Service`，改 `ctx.provide('l0adapter', adapter)`（cordis 源码 `provide(name, value, check)` 接受任意 value）。
3. **`sessionController.prompt(request, signal)` 会读 `signal.throwIfAborted()`**，传 `undefined` 抛 `TypeError`；adapter 统一给 `liveSignal()`（永不 abort 的 AbortSignal）。

**Config 快照（安装前 / 后）**

| 时点 | `Config.listConfigs(name)` |
|---|---|
| 安装前 | 0 条（不存在 → absent） |
| 首版（schemastery 未解析、走兜底） | `status: unsupported` |
| 修后（schemastery 解析成功） | **`status: schema`**，`packageDir` 正常 |

**迭代手段（重要，避免重启宿主）**：linked 包改代码不进新模块代次。加开发用 shim 包
`plugins/dsh-l0-adapter-gen2`（稳定入口 + `?generation=<ts>` 动态 import `plugins/dsh-l0-adapter/index.js`），
disable/enable 即换代次。**交付物仍是 `plugins/dsh-l0-adapter`**，closeout 时移除 shim。

**阻塞**：无。

---

## R3 · spawn / call / usage / checkpoint / takeover 运行时证据 · 2026-10-29

| # | 动作 | 结果 | 证据 |
|---|---|---|---|
| 1 | `adapter_spike` | 全绿 | sessionController prompt/create/follow/cancel/inspect=true；subagents startActivation/sendMessage=true，providers=`spawn,fork,codex,claude-code`，providerCapabilities 4 项 |
| 2 | `adapter_capabilities` | 8/8 | `count: 8`，`quality.supports_whitebox=false`、`supports_prefix_cache='observable-only'` |
| 3 | spawn 路径 A（session） | ok | `ROLE-CODE-01 → session-06491248…`；`ROLE-CODE-02 → session-d13fed02…` |
| 4 | spawn 路径 B（activation） | ok | `ROLE-AUDIT-01 → 775de20d…`，messageId 回执；子 Agent 实跑后回 `PASS` |
| 5 | 两实例不串号 | 通过 | usage 分开：CODE-01 `calls=2/in=15078/out=6/cacheRead=8448`；CODE-02 `calls=2/in=1256/out=9/cacheRead=22272`；sessionId 一一对应 |
| 6 | `adapter_call`（activation 路径） | ok | sendMessage → messageId `f6122a16…`；usage 归到 ROLE-AUDIT-01 |
| 7 | `adapter_checkpoint` | ok | `CKPT-a2464162`，`lastSeq=24`（`sessionController.inspect` 冷读），`graphRevision=1`，stateVersion 7 |
| 8 | `adapter_takeover` | ok | token `1793278273588`，owner `lane-d-operator`，TTL 60s |
| 9 | 旧 token 写状态 | **被拒** | `{ok:false, error:'fenced', reason:'fenced-out', held:1793278273588, supplied:1}` |
| 10 | 新 token 写状态 | ok | `status: checkpointed`，version 11 |
| 11 | `adapter_verify` 三态 | pass/fail/unknown 齐 | exists→pass；错 sha→fail；缺文件→unknown；未知条目 `mystery`→unknown（**unknown 不当 pass**） |

**usage 口径**：`llm/stream` 按 `options.sessionId` 归集；实例级账本按 `state.instances[].sessionId` 索引；
宿主全局 total 会把本宿主所有会话（含其他 lane 的 Agent）都算进去，属预期——实例账本是 scoped 部分。

**阻塞**：无。**下一轮（R4）**：`control_plane/capabilities.py` 职务目录（8 编码/3 审计/复合）+ 审计独立约束 + `control_plane/tests/integration/` 夹具 + A7 四态退出码。

---

## R4 · 职务编队 + 审计独立 + A7 四态夹具 · 2026-10-29

**`control_plane/capabilities.py`（追加，不改既有函数）**

| 新增 | 说明 |
|---|---|
| `PRODUCER_ROLES`（8）/ `AUDITOR_ROLES`（3）/ `ROLE_CATALOG`（11 条） | 职务目录：kind / title / capability / audits / weight |
| `COMPOSITE_TEMPLATES` | FULLSTACK(CODE+TEST) / WRITER(CODE+DOC) / REVIEWER(AUDIT_CODE+AUDIT_EVIDENCE) / TRIAD(+EVIDENCE) |
| `instance_id` / `parse_instance_id` / `roles_of_instance` / `is_auditor_instance` | `ROLE-<职务>-<NN>` 编号与解析；复合实例角色集 |
| `plan_formation` | planner：按 task_units / 权重 / max_parallel / budget 决定 `count(role)`；**`role_count_default` 只是默认可覆盖值，不是硬配额**；并发上限只砍生产/复合实例，预算不足把生产压到 1 但**审计保留**（fail-closed） |
| `validate_formation` | ID 唯一、序号连续、审计恰好 1 实例、total 自洽 |
| `audit_independence_violations` / `assert_audit_independent` | 机检：① 同节点 producer ≠ auditor；② 复合实例含审计职务时不得充当该节点生产者；③ 不得缺 auditor |
| `formation_snapshot` | 可回放快照（instance / roles / kinds / composite 列表） |
| `record_formation_change` | 写 `replan_events`（reason=`formation`，`EVT-F####`）+ `formation_changed` 事件；**不 bump graph_version**（图版本属 A 写域） |

**A7 夹具（`control_plane/tests/integration/`）**

- `a7_conformance.py`：8 个黄金动作 + 质量声明对比 + 四态判定；CLI `python -m control_plane.tests.integration.a7_conformance --snapshot S`。
- 四态退出码：`pass=0`、`drift=1`、`failed=2`、`unknown=3`；`unknown` 一律 fail-closed。
- `fixtures/`：`capabilities.golden.json` + `snapshot.{pass,drift,failed,unknown}.json`（pass 取自 R3 实跑数据）。
- **对账口径写成断言**：`reconcile()` 的 `basis='instanceUsage'`、`hostTotalIgnored=true`；
  pass 夹具里宿主 `meter.total.calls=24`，实例之和=6，测试断言二者不等且判定只用 6 —— 防回退成"拿宿主 total 对账"。
- 实例缺 `usage` → `usage-basis-missing` → unknown（不当 pass）。

**测试**：`python -m unittest discover -s control_plane/tests` → **238 tests OK**（含本 lane 新增 27）；
`python -m unittest discover -s control_plane/tests/integration -t control_plane/tests` → 27 OK。

**canonical / gen2 一致性证据（M4 用）**

gen2 只是入口 shim（`new URL('../dsh-l0-adapter/index.js?generation=…')`），**不含实现副本**，
所以 canonical 文件在磁盘上就是 gen2 加载的那份。canonical 文件指纹（SHA256 前 16 位）：

```
a7ece6b0643828b4  dsh-l0-adapter/cordis.patch.yml
4b19dbfb35dbf07f  dsh-l0-adapter/icon.svg
0d1c3a93f7edbdb6  dsh-l0-adapter/index.js
92a90907dbf17576  dsh-l0-adapter/lib/config.js
cfb35d0c2a4d0f94  dsh-l0-adapter/lib/service.js
1a3a38d5f94fa3ef  dsh-l0-adapter/lib/store.js
69bfa0d304b32cd8  dsh-l0-adapter/locale/en.json
8e4fd41d4ea78efe  dsh-l0-adapter/locale/zh.json
b254b247093fdebc  dsh-l0-adapter/package.json
```

**实跑收尾**：ROLE-CODE-01 / ROLE-CODE-02 / ROLE-AUDIT-01 均已 `adapter_close`，`liveHandles: []`。

**阻塞**：无。**下一轮（R5）**：`adapter_call` 输出收口（follow 归集 assistant 文本）+ 预算拒绝路径 + 强杀恢复用例（checkpoint → 重启代次 → 按 lastSeq 对账）+ checkpoint/takeover 夹具落 tests/integration。

---

## R5 · P0 修复 + 输出收口 + 预算/恢复 + 夹具并入 · 2026-10-29

> A 的只读 conformance 清单报了两个 P0。**先写夹具暴露（红），再修到绿**。

### 红 → 绿

| 阶段 | 证据 |
|---|---|
| 红 | `node lib/selftest.mjs` 首跑直接 `SyntaxError: does not provide an export named 'CONFORMANCE'`；修完导出后 `fencing: 已接管时缺 token 必须拒绝` / `verify: contains 空 expected` 均 FAIL |
| 绿 | 同一命令 → **17/17 checks passed**；`python -m unittest discover -s control_plane/tests` → **280 tests OK** |

### 修了什么

1. **fencing fail-open（P0-1）**：`store.js fencingAccept`
   - 有接管/租约时**缺 token → `{ok:false, reason:'fenced'}`**（原先是 `no-fencing-supplied` 放行）；
   - 无 fencing 的初始写 → `{ok:true, reason:'initial-write-without-fencing'}`；
   - 旧 token → `fenced-out`；过期 → `lease-expired`。四态各有 selftest 用例。
2. **verify 假 pass（P0-2）**：`contains` 的 `expected` 缺失/空串/非字符串 → **`unknown`**（不再 `includes('')` 恒真）；
   `sha256` 的 expected 非 64 位十六进制 → `unknown`。
3. **verify 留痕**：每次判定写 `state.verifications`（`VER-0001` 递增），返回 `verificationId` —— `verifications` 不再恒空。
4. **usage totalTokens**：实例账本与全局 totals 都累计 `totalTokens`（此前恒 0）。
5. **`adapter_call` 输出收口**：`awaitOutput=true` 时先 `inspect` 取 baselineSeq → `prompt` → 轮询到 `turn/end`，回收 assistant 文本；**实跑** `baselineSeq=24 → turnEnd.seq=35 reason=completed text="DONE"`。
6. **预算门**：`budgetStatus()` + `call` 前置拒绝 `budget-exhausted`（不静默放行）。
7. **`adapter_recover`**：孤儿判定（running 但无活句柄）+ 最近检查点 + resumePlan（takeover → call → 写恢复点）。
8. **`CONFORMANCE` 映射**：`{pass:0, drift:1, failed:2, unknown:3}`、`reconciliationBasis='instanceUsage'`、`hostTotalIgnored=true`，
   同时出现在 `adapter_capabilities.conformance` 与 `a7_conformance.EXIT_CODES`，有测试断言两边一致。

### 新增夹具

- `control_plane/tests/integration/test_adapter_conformance.py`：跑插件自检（node 子进程），把 17 个 check 纳入 Python 门禁；fencing/verify 失败 → `failed`，usage/budget/recover → `drift`。
- `control_plane/tests/integration/test_adapter_state.py`：以实跑落盘的 `adapter-state.captured.json` 为契约样本，断言实例字段/closedAt/检查点字段/fencing 单调/verify 留痕/实例级对账（文件里没有宿主 total）。
- `a7_conformance.evaluate_selftest()`：把自检报告并入同一套四态判定（缺报告 → unknown）。

### 强杀恢复（restart 用例，真跑）

- 起点：状态文件里 `ROLE-CODE-07` 处于 running，检查点 `CKPT-restart / lastSeq=42 / graphRevision=3`；
- 模拟强杀：旧 service 丢弃、live 句柄为空，新实例只读状态文件；
- 结论：`orphaned=true`、`lastSeq=42`、`graphRevision=3`、resumePlan 2 步；
- 恢复后**必须**用新 fencing token 才能写状态（无 token 被拒、新 token 通过）。

### canonical / shim 结算（lead 要求的切换复测）

- 依次移除 `@local/dsh-l0-adapter-gen2/gen3/gen4`（gen3 出现过 `TypeError: Invalid effect`：**async apply 不被接受**，插件 `apply` 必须同步）；
- **enable canonical `@local/dsh-l0-adapter` → `adapter_capabilities` 复测通过**：count=8、codeVersion=3、`conformance` 段完整、`configSource=schemastery`；
- `Config.listConfigs` → `status: schema`；
- **无需宿主重启**：Loader 重新 import entry 时会拿到新代次（此前"代次陈旧"是 shim 在模块顶层捕获 impl 造成的，不是宿主缓存）；
- shim 目录已删除，`plugins/` 只剩 `dsh-l0-adapter`（+ 未动的 probe / probe2）。

### canonical 指纹（切换后）

```
a7ece6b0643828b4  cordis.patch.yml
4b19dbfb35dbf07f  icon.svg
e73c91486151d5ea  index.js
92a90907dbf17576  lib/config.js
62ced0af00f3919a  lib/selftest.mjs
0d7364123290ed27  lib/service.js
eb4ee2b395cc5096  lib/store.js
69bfa0d304b32cd8  locale/en.json
8e4fd41d4ea78efe  locale/zh.json
b254b247093fdebc  package.json
```

**阻塞**：无。**下一轮（R6）**：把 R3–R5 的运行时证据固化成一份可复跑的 `dsh-adapter` conformance 摘要（lane 收口报告），并补齐 checkpoint「非权威断点」语义在控制面的落点说明。

---

## R6 · Lane D 收口（验收对照 + 可复跑清单）· 2026-10-29

### 验收对照（章程 §3 D 验收项）

| 验收项 | 状态 | 证据 |
|---|---|---|
| bundle 可装 | ✅ | `install_bundle → application: applied`（canonical）；pnpm 退出码 0 |
| Config 不再 `absent` | ✅ | `Config.listConfigs(name=@local/dsh-l0-adapter)` → `status: schema` |
| `adapter_capabilities` 8 项 | ✅ | `count: 8`（spawn/call/artifact_io/state_cas/verify/meter/checkpoint/takeover）+ quality 4 条 |
| spawn/call 双实例不串号、usage 对账 | ✅ | R3 表；对账基准 = `instanceUsage`（宿主 total 明确 ignored） |
| checkpoint 后强杀可恢复 | ✅ | `CKPT-a2464162 lastSeq=24`；restart 用例 `lastSeq=42 / graphRevision=3 / orphaned=true` |
| 接管 fencing | ✅ | 旧 token `fenced-out`、缺 token `fenced`（P0 修复后）、新 token `ok` |
| 职务编队可重复/复合且审计独立 | ✅ | 8 生产 / 3 审计 / 4 复合模板；`audit_independence_violations` 三条规则 + 测试 |
| A7 夹具四态退出码 | ✅ | CLI 实跑 `pass=0 / drift=1 / failed=2 / unknown=3` |

### 可复跑清单（任何人可验）

```bash
cd <REPO_ROOT>
python -m unittest discover -s control_plane/tests                       # 280 tests OK
python -m unittest discover -s control_plane/tests/integration -t control_plane/tests   # 49 tests OK
node plugins/dsh-l0-adapter/lib/selftest.mjs                             # 17/17 checks
python -m control_plane.tests.integration.a7_conformance --snapshot control_plane/tests/integration/fixtures/snapshot.pass.json     # exit 0
python tools/check_fixtures.py                                           # 23/23（未受影响）
```

宿主侧（需在 DSH 会话内）：
`adapter_capabilities` → 8 项 + `conformance`；`adapter_spike` → session/subagents/store 全 true；
`adapter_spawn(mode=session|activation)` → 实例；`adapter_call(awaitOutput:true)` → `turnEnd.reason=completed` + 文本。

### checkpoint 的「非权威断点」语义（给控制面的落点）

- adapter 侧 checkpoint 只做两件事：`sessionController.inspect(sessionId)` 拿 **durable 末 seq**，把
  `(sessionId, lastSeq, graphRevision)` + 执行态快照落盘；**不调用 `sessions.flush`**（其入参是活 session 对象，不是 id）。
- 因此该检查点是**对账锚点，不是权威断点**：权威状态仍在控制面 SQLite（事件溯源）。
- 控制面接法（不在本 lane 写域，交给 Lead/C）：`recovery.recover()` 用 `graph_revision + lastSeq` 与事件流比对；
  一致 → 从该点续跑；不一致 → 走 replan（A 的 `graph.replan`），不要用快照覆盖图状态。

### 未做 / 移交

- `adapter_close → instance.status='closed'` 与控制面 `finalize` 的联动（跨 lane，等 Lead 裁决）。
- 双向 usage 对账（`llm/stream` 账本 vs session log 的 `assistant/message.usage`）：本 lane 只做了实例级归集（C 的 ledger 侧已有双源钩子位）。
- Client Slots / UI 面板：不在 Lane D 范围。

### 预算

R1–R6 共 6 个可验收轮（预算 17），未动缓冲。

---

## R7（补轮）· WP-10 D6：Agent Card 的职务维度 · 2026-10-29

**改了什么（仅 `capabilities.py`）**

- 新增 `roles_for_capability(capability)`：按 `ROLE_CATALOG[*]['capability']` **精确匹配**，匹配不到返回 `[]`（不猜）。
- 新增 `role_kinds_of(roles)`：职务类别集（producer / auditor）。
- `agent_card()` 的每个 skill 增三字段：
  - `roles`：如 `code → ["CODE"]`、`audit → ["AUDIT_CODE","AUDIT_DESIGN","AUDIT_EVIDENCE"]`；
  - `roleKinds`：`["producer"]` / `["auditor"]`；
  - `roleMapping`：`capability`（命中）或 `unmapped`（该能力暂无职务，显式标注而不是塞默认）。

**刻意不做**

- **不加 `role_count`**：数量是 planner 决策，`role_count_default` 只是可覆盖默认值（`plan_formation` 会按
  task_units / 并发 / 预算调整）。写进卡就是硬配额 —— 测试 `test_card_does_not_carry_role_count` 把这条钉成断言
  （卡里出现 `role_count` / `roleCount` / skill 内 `count` 即红）。

**测试**：新增 `control_plane/tests/integration/test_agent_card_roles.py`（8 用例）：
字段齐全、按能力映射、roles ⊆ catalog、未映射显式标注、单能力卡形状、卡内无 role_count、
`role_count_default` 仍可上调/可设 3、helper 边界（空串/未知职务）。
全量 `discover -s control_plane/tests` → **302 tests OK**。

**给 WP-10 的提案（只出提案，不落盘）**

若后续要表达"节点期望几个实例"，建议放**节点侧**而不是卡侧：

```jsonc
// node（work_graph.schema.json，待 WP-10 定）
"capability": "code",
"role_plan": { "CODE": 8, "AUDIT_CODE": 2 }   // 期望值，planner 可覆盖；非硬配额
```

理由：卡描述"这个能力由哪些职务承担"（静态契约），节点描述"这次要几个"（运行时决策）；
把数量写进卡会让同一能力的卡在不同任务下自相矛盾。schema 变更按约定走 WP-10 / B 的批次，本 lane 不动 `db.py` / schema。
