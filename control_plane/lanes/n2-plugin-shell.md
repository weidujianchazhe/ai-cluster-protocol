# Lane N2 · dsh-l0-control 插件壳（bundle / Config / 服务 / 9 工具）

> 计划：`管理区/designs/_research/DSH原生插件-60轮长任务.md` §P1（N2，预算 10 轮）
> 任务板：task-11
> 写域：`plugins/dsh-l0-control/`（`src/core` 归 N3、`src/state` 归 N4、`src/e2e` 归 N5）+ 本文件

---

## R1 · 骨架 + 构建链 + 注册面 · 2026-10-29

**新增文件**

| 文件 | 说明 |
|---|---|
| `package.json` | `@local/dsh-l0-control`，`main/exports → lib/index.js`，`dsh.bundle.patch → cordis.patch.yml`，`scripts.build/verify` |
| `cordis.patch.yml` | 插入 entry `dsh-l0-control`，config：workspaceRoot / stateDir / journalFile / snapshotFile / sandboxMode / maxParallel / defaultBudgetTokens / projectionEnabled / toolPrefix |
| `tsconfig.json` | 给外部 `tsc` 用（本机无 tsc，见构建边界） |
| `scripts/build.mjs` | `src/**.ts → lib/**.js`；用 Node 内置 `module.stripTypeScriptTypes()`；`--check` 做同步校验 |
| `scripts/selftest.mjs` | stub-ctx 自检（10 项），不依赖宿主 |
| `src/config.ts` | Config：schemastery 优先（按 profile 目录动态 import）+ Standard Schema 兜底 |
| `src/capabilities.ts` | 9 工具面 → `native` / `projection` / `self-built` 分级 + quality（`supports_whitebox=false`） |
| `src/service.ts` | `l0control` 服务：参数校验 / caller 取用 / journal 追加 / core 委派（缺失即 fail-closed） |
| `src/tools.ts` | 9 个工具定义 |
| `src/index.ts` | `name/inject/Config/apply` → `ctx.provide('l0control')` + 注册 9 工具 |
| `locale/{zh,en}.json`、`icon.svg`、`README.md` | 展示元信息与交付说明 |

**构建边界（写进 README）**：本机没有 TypeScript 编译器，构建只**剥类型不检查**；
`lib/` 是**全量**生成物（含 N3/N4/N5 的 `src/**`），任何 lane 改 `src` 都要重跑 `node scripts/build.mjs`。

**自检**：`node scripts/selftest.mjs` → **10/10 checks**（构建同步 / 9 工具 / 服务 / 前缀 /
team_status 无 caller / 图操作无 core / 证据缺产物 / export 真写 / capability 分级 / disposer）。

---

## R2 · 安装 / Config / 原生通达 / 禁用零残留 · 2026-10-29

| # | 动作 | 结果 |
|---|---|---|
| 1 | `install_bundle(target=plugins/dsh-l0-control)` | `application: applied`；pnpm 退出码 0 |
| 2 | `Config.listConfigs(name=@local/dsh-l0-control)` | **`status: schema`** |
| 3 | 工具可见 | 9 个（wish_submit / graph_status / task_next / task_claim / evidence_submit / verify_done / decide / team_status / export） |
| 4 | `team_status`（原生通道） | `native:true`，caller 解析为本会话 `1210cf86…`；membership = `{role:'teammate', name:'dsh-adapter'}`；**9 个成员 / 15 个任务**真实读出 |
| 5 | `graph_status` | capabilities 摘要：`grades {self-built:7, native:1, projection:1}`、`supports_whitebox:false`；graph 段 `core-unavailable`（N3 未交付，按契约 fail-closed） |
| 6 | `set_bundle enabled=false` | `applied`；随后调用 `team_status` → **`unknown tool "team_status"`**（零残留）；journal 只留 `plugin_applied / plugin_disposed` |
| 7 | `set_bundle enabled=true` | `applied`；工具回归；journal 追加 `plugin_applied`（append-only 不覆盖） |
| 8 | `export(outDir=.l0-control/export)` | 真写 `capabilities.json` + `STATE.md`；core 段 `core-unavailable` |

**修的一个真问题**：`team_status` 首版把 `TeamMembership`（内含 `Agent` 句柄）原样返回，
宿主拒绝：`tool "team_status" returned invalid output: value is not lossless JSON`。
修法：`toPlain()` 结构投影 + 显式字段白名单（rootId/id/role/name、members 只留 id/name/role/status/provider/model/diagnostics、tasks 只留 id/revision/subject/status/ownerName/ready/blockedBy）。

---

## 给其他 lane 的契约（重要）

**`service.ts` 期望 `./core/index.js`（即 `src/core/index.ts`）导出这些函数**（默认导出或具名均可）：

```ts
submitWish?({ text, maxParallel?, budgetTokens? })
graphStatus?()
nextTask?({ role? })
claimTask?({ nodeId, role?, instanceId? })
submitEvidence?(input)          // input 已含 resolved（绝对路径）
verifyDone?(input)
decide?(input)
exportProjection?(outDir)
```

缺失或抛错时的行为：`{ok:false, error:'core-unavailable' | 'core-failed', action, detail}` —— **不假装成功**。
`evidence_submit` 在进 core 之前就会拒掉不存在的产物（`artifact-missing`），避免"证据没有产物"。

**N4**：`service.journalSummary()` 目前直接读 `journal.jsonl` 行数；`appendJournal()` 是唯一写入口，
升级成带 revision 的权威日志时请保持这两个函数名。

**N5**：`team_status` 是唯一原生只读通道，端到端演示可直接用它断言"投影板与图同源"。

---

## 验收对照（task-11）

| 验收项 | 状态 | 证据 |
|---|---|---|
| `install_bundle → applied` | ✅ | R2 行 1 |
| Config `status=schema` | ✅ | R2 行 2 |
| 工具可见（9） | ✅ | R2 行 3 + 宿主工具清单 9 条 schema |
| disable 后零残留 | ✅ | R2 行 6（unknown tool） |
| 能力声明含 `supports_whitebox=false` 与 native 分级 | ✅ | `src/capabilities.ts` + `graph_status.capabilities` 实跑 |

**预算**：R1–R2 用 2 轮（配额 10）。**阻塞**：无（N3 core 未交付属计划内，插件已 fail-closed 就位）。

---

## R3 · N1 反馈三项 + 工具契约加参（D0 可逆）· 2026-10-29

### 1) `team_status` lossless 投影（按 N1 实测重写）

首版把 `TeamMembership`（内含 `Agent` 句柄）与 `context`/`diagnostics` 原样返回，宿主拒收
`invalid output: value is not lossless JSON`。现改为：

- member 只留标量 `{id,name,role,status,model,provider}`；task 只留 `{id,revision,subject,status,ownerName,ready,blockedByCount}`；
- membership → `{rootId,id,role,name}`；另加 `memberCount` / `taskCount`；
- 最后 `JSON.parse(JSON.stringify(v))` 兜底；任何一步失败返回 `{ok:false, error:'projection-failed'}`，不把原值抛给宿主。

**复测**：`team_status` → `ok:true, native:true, caller=<本会话>, membership{role:teammate,name:dsh-adapter}, memberCount=9, taskCount=15`。

### 2) 工具契约加参（N5 在真工具面发现缺参）

| 工具 | 新增可选参数 | 门禁（fail-closed） |
|---|---|---|
| `evidence_submit` | `producer_instance`、`verdict` | 两者都无 → **`producer-unknown`**；产物缺失 → `artifact-missing`；`verdict` 非法 → `verdict-invalid` |
| `verify_done` | `producer_instance`、`auditor_instance` | 缺 auditor → **`auditor-required`**；缺 producer → `producer-required`；`producer === auditor` → **`audit-independence-violated`**（不放宽）；auditor 职务不属 `AUDIT_*` → `auditor-role-required` |

- `caller` 绑定实例的解析方式：`ctx.get('l0adapter').report()` 按 `sessionId` 反查 `instanceId`（同宿主进程内可取）；
  取不到就必须显式传，否则门禁拒绝。
- `verdict` 缺省由 `acceptance` 判定（`exists` / `sha256` / `contains`）；判定不了 → `unknown`，**绝不当 pass**。
- 审计职务清单在 TS 侧镜像 `AUDITOR_ROLES = [AUDIT_CODE, AUDIT_EVIDENCE, AUDIT_DESIGN]`；
  N3 core 落地后以 core 为准（插件这层只做门禁前置检查）。

**实跑（真工具面）**

| 调用 | 结果 |
|---|---|
| `evidence_submit{producer_instance:ROLE-CODE-01, acceptance:contains:"AI集群"}` | 过门禁 → `core-unavailable`（fail-closed）；journal 记 `evidence_submitted producer=ROLE-CODE-01 verdict=pass(source=acceptance)` |
| `verify_done{producer=auditor=ROLE-AUDIT_CODE-01}` | `audit-independence-violated`；journal 记 `verify_done_rejected reason=audit-independence` |
| `verify_done{producer=ROLE-CODE-01, auditor=ROLE-CODE-02}` | `auditor-role-required`（auditorRole=CODE） |
| `evidence_submit{无 producer_instance}` | `producer-unknown` |

### 3) 工具输出契约夹具

`scripts/contract.mjs`：stub ctx 跑 9 条工具路径 + 4 条门禁负例，逐字段校验类型、
断言 JSON 往返 lossless、并验证脏值被投影掉；`--write` 落 `fixtures/tool-outputs.json`（13 个样本）。
结果：**14 checks / 0 failed**，纳入 `scripts/selftest.mjs`（现 11/11）。

### 4) 共享目录注意（给 N3/N4/N5）

`lib/` 是全量生成物：并发改 `src/**` 后必须重跑 `node scripts/build.mjs`，
否则 selftest 的「lib 与 src 同步」会红（不是 bug，是并发写入窗口）。

**预算**：R1–R3 用 3 轮（配额 10）。

---

## R4（P0 修复）· 构建器不改写 `.ts` 说明符 → core 永远 `core-unavailable` · 2026-10-29

### 故障

`stripTypeScriptTypes()` **只剥类型，不改写说明符**：`lib/core/index.js` 里仍是
`from "./types.ts"`，而 `lib/` 只有 `types.js` → `ERR_MODULE_NOT_FOUND`；
`service.core()` 的 `catch` 吞掉异常 → 所有图操作恒返回 `core-unavailable`。

### 修法（`scripts/build.mjs`）

1. 剥类型后立刻改写静态与动态说明符：
   ```js
   output = output
     .replace(/(\bfrom\s*["'])(\.[^"']+)\.ts(["'])/g, '$1$2.js$3')
     .replace(/(\bimport\s*\(\s*["'])(\.[^"']+)\.ts(["'])/g, '$1$2.js$3');
   ```
2. **残留闸**：改写后再扫 `from "./x.ts"` / `import("./x.ts")`，仍有残留 → `status:'error'` 并让构建失败（防半修）。
3. 报告带 `specifiersRewritten` 计数；`--check` 走同一套逻辑（否则同步校验会假红/假绿）。

### 验证

| # | 验证项 | 结果 |
|---|---|---|
| 1 | `import('./lib/core/index.js')` | 成功；导出 **100 个名字**，`graphStatus/nextTask/claimTask/exportProjection/submitWish/submitEvidence/verifyDone/decide` 全为 `function` |
| 2 | `lib/**` 残留 `.ts` 说明符 | **0** |
| 3 | `graph_status`（真工具面） | **不再 `core-unavailable`**：`graph.result = {ok:true, version:1, ready:[], counts:{nodes:0,edges:0,done:0,blocked:0}, journal:{events:0,lastSeq:0,ok:true}}` |
| 4 | `task_next`（真工具面） | core 处理：`{ok:true, action:'task_next', result:{ok:true, role:'CODE', ready:[], task:null}}` |
| 5 | `verify_done`（真工具面） | core 语义拒绝**冒泡到顶层**：`{ok:false, error:'node-not-found', result:{…}}`（此前会被包成 `ok:true`） |
| 6 | `evidence_submit` | core 侧仍 N3 stub：`{ok:false, error:'core-not-implemented', hint:'core.submitEvidence 将在 N3-R3 落地…'}` |
| 7 | `scripts/selftest.mjs` | **11/11 checks** |
| 8 | `scripts/contract.mjs` | **14 checks / 0 failed**（9 工具 + 4 门禁负例 + 投影硬化） |

**顺带修**：`withCore()` 把 core 的 `{ok:false,error}` 冒泡成顶层 `ok:false`（附带 `result`），
避免调用方把 `{ok:true, result:{ok:false}}` 当成功。

### 给 N4 / N5 的接线说明

- **同一模块实例**：`service.core()` 用固定 URL `import('./core/index.js')`，N4 只要在这实例上调
  `configureCore({ store })`（N3 facade 已提供），插件侧立刻生效，无需重启插件。
- **`lib/` 是全量生成物**：任何 lane 改 `src/**` 后重跑 `node scripts/build.mjs`；`--check` 因并发写入窗口报 stale 属预期。
- **N5 可切 native 端口**：`graph_status / task_next / claimTask / verify_done` 已走 core；
  `wish_submit / evidence_submit` 等 N3 补齐 stub 后自动通，插件无需再改。

---

## R5（排队中 · 等 Lead 信号）· core ↔ state 桥接 · 2026-10-29

**状态**：Lead 已同意「等 N3 R3（evidence/decisions/verifyDone）落地后再焊」，收到信号即执行。
**本轮只落计划，不改行为、不改 N4 `src`。**

### 已核实的两个 Store 不是同一个类

| 侧 | 类 | 构造方式 |
|---|---|---|
| N3 core | `Store({clock?, journal?, state?})` | 直接 `new`，持有图状态 + journal |
| N4 state | `Store` | **构造函数私有**，只能经 `openAndRecover(...)` / `recoverWithJournal(...)` |

桥已在 N4 侧提供：`bridge.restoreCoreJournal(coreStore, records)`、`bridge.persistCoreEvents(stateStore, events)`、
`bridge.toCoreNode/Edge/Graph`、`bridge.toEventRecords`。

### 接线四步（收到信号后实现）

1. `const opened = openAndRecover({ stateDir, fsPort: new MemoryFsPort() /* 先内存跑通 */ })` → N4 store + 恢复报告；
2. `const core = new CoreStore({})` → `restoreCoreJournal(core, opened.records)`；
3. `configureCore({ store: core })`（facade 已提供，同一模块实例，插件无需重启）；
4. 每个工具调用收尾 `persistCoreEvents(opened.store, core.journal.drain())`（drain 语义按 N3 实际 API 对齐）。

### 验收（届时）

- `graph_status` 增 `recoveryReport` + `journalFingerprint`；`counts` 与恢复后的图一致；
- 同一愿望在两代次（重启插件）后 `journalFingerprint` 不变（重放==快照）；
- `contract.mjs` 增 `graph_status#persistence` 断言；`selftest` 增「恢复后 graph_status 带 recoveryReport」；
- 先 `MemoryFsPort`（不落盘），绿了再切 `NodeFsPort` / `DshFsPort`。

**预算**：R1–R4 用 4 轮（配额 10）。

---

## R6 · N3-R3 落地后的工具→core 冒烟（桥接仍等 R4）· 2026-10-29

### 构建

`node scripts/build.mjs` → `ok:true`；`lib/core/index.js` 导出 **101** 个名字，
新增的 5 个全部为 `function`：`submitEvidence / verifyDone / decide / tickDecisions / nodeGates`；
我依赖的 8 个（`submitWish / graphStatus / nextTask / claimTask / submitEvidence / verifyDone / decide / exportProjection`）齐。

### 真工具面冒烟（node 不存在 → 走失败路径，正是「零写入」要验的）

| 调用 | 结果 |
|---|---|
| `evidence_submit{nodeId:N-LIVE-2, producer_instance:ROLE-CODE-01, acceptance:contains:"AI集群"}` | `{ok:false, action:'evidence_submit', error:'node-not-found', result:{…}}` —— **不再是 `core-not-implemented`** |
| `verify_done{producer:ROLE-CODE-01, auditor:ROLE-AUDIT_CODE-01}` | `{ok:false, error:'node-not-found'}` —— 过独立性/职务门禁后由 core 拒绝 |
| `decide{decisionId:DEC-N2-SMOKE, level:L0}` | `{ok:false, error:'decision_error', message:'决策不存在：DEC-N2-SMOKE'}` —— core 逻辑可达 |

### 失败零写入（前后对比）

| 观测点 | 两次失败调用前 | 后 |
|---|---|---|
| core `version` | 1 | **1** |
| core `counts` | nodes 0 / edges 0 / done 0 / blocked 0 | **不变** |
| core `journal.events` | 0 | **0** |
| plugin 审计 journal | 23 | 29（新增 `evidence_rejected` / `verify_done_rejected`） |

**口径**：失败只在**插件审计 journal** 留一行拒绝记录（append-only 审计，不是图状态）；core 图状态与事件流**零变化**。

### 顺带改（本轮）

core 语义拒绝时审计行从 `*_requested` 改为 `*_rejected + reason`，消除"请求过但不知结果"的歧义：
- `evidence_rejected | reason=node-not-found | verdict=pass`
- `verify_done_rejected | reason=node-not-found | producer=… | auditor=ROLE-AUDIT_CODE-01`

### 测试

`selftest 11/11`、`contract 14 checks / 0 failed`（构建后重跑，绿）。

**已知限制**：core 当前无节点（`submitWish` 仍 N3-R4），evidence/verify 的**成功写入**路径尚无法端到端验；
等 R4 的 `submitWish`/replan 落地后与桥接一起做。

**预算**：R1–R6 用 6 轮（配额 10）。**阻塞**：无。

---

## R7 · 桥接落地 + 第 10 个工具 pass_gate + 键名归一化 · 2026-10-29

### 构建

`node scripts/build.mjs` → `ok:true`；`lib/core/index.js` 导出 **115** 个名字。
N3 stages 的 7 个全为 function：`setGate / passGate / failGate / getGate / listGates / gateAllowsDone / blockedByGates`；
`submitWish / replan / currentGraphVersion` 亦在（`WISH_PLAN` 为 array）。

### 桥接（按 Lead 四步）

`src/persistence.ts` 的 `CorePersistence.open({dir, mode, owner})`
= `StateStore.open({dir, fs, owner})`（内含 openAndRecover）→ `new CoreStore` → `restoreCoreJournal(stateStore, coreStore.journal)` → `configureCore({store})`；
每个工具收尾 `persistCoreEvents(stateStore, core.journal.after(persistedSeq))`。

- 默认 `persistence='memory'`（MemoryFsPort）；`persistenceDir='core-state'`（相对 stateDir，避免与插件审计 journal 抢同一文件）；
- `service.core()` **先开桥再返回 core**，保证 `configureCore` 在任何 core 调用之前；
- `graph_status` 新增 `persistence` 块：`{mode, dir, revision, fingerprint, records, restored, recoveryReport}`。

**实跑数字**

| 调用 | 结果 |
|---|---|
| `wish_submit{...}` | 6 节点 / 5 边 / `NODE-RESEARCH` ready；`persistence {appended:15, revision:15}` |
| `pass_gate{stage:'research', evidence_refs:['README.md']}` | `{ok:true, result:{gate:{stage:'research', status:'passed', decided_at}}}`；`persistence {appended:1, revision:16}` |
| `graph_status` | `persistence {mode:'memory', revision:16, records:16, fingerprint:'20d6adde…', restored:0, recoveryReport:{ok:true, source:'journal+bootstrap', replayEqualsSnapshot:true, snapshot:{existed:false, updated:true}}}`；`counts {nodes:6, edges:5}`；`gates.research.status='passed'`；`toolCount=10` |

### 新增第 10 个工具 `pass_gate`

- 参数：`stage`（5 段枚举 research/design/build/audit/deliver）、`evidence_refs[]`；
- 行为：本地枚举校验（非法 → `stage-invalid` + `allowed[]`）→ `core.passGate(store, stage, refs)`；
- **不允许直改节点状态**：节点推进仍只能走 `verify_done`；`TOOL_SURFACE.pass_gate` 标 `self-built`。

### 输入键名归一化（D0）

同时接受 `producer_instance/producerInstance`、`auditor_instance/auditorInstance`、`option_id/optionId`、
`default_option_id/defaultOptionId`、`timeout_sec/timeoutSec`、`evidence_refs/evidenceRefs`。

- 目标侧对齐 core：evidence/verify/gate → **snake**；decide → core 的 **camel**；
- 两侧都传且值不同 → `key-conflict`（不"两种都传才过"，也不悄悄取一个）；
- 单侧 camel 会被归一化（测试用 `producerInstance` 走通到 core）。

### 测试

| 套件 | 结果 |
|---|---|
| `scripts/selftest.mjs` | **13/13**（新增：pass_gate 合法/非法、键名归一化+冲突、工具数 10） |
| `scripts/contract.mjs` | **18 checks / 0 failed**（10 工具 + 6 门禁/别名负例 + 投影硬化） |

### 已知限制（给 N3/N4/N5）

**MemoryFsPort 掉电即失**；切 `persistence:'node'` 可落盘，但**重启后 core 图状态不会自动重建**：
`restoreCoreJournal` 只回灌 journal，**不回折 state**（实测：重开后 `records=16 / restored=16 / fingerprint 一致`，但 `graphStatus().counts = {0,0,0,0}`）。
要做到"重放==快照"需 N3 暴露 `foldEvents(events) → State`（或 `rehydrate(store)`），插件侧接一行即可。
在此之前 N5 端到端请用默认 `memory`（单进程内一致）。

---

## R8（先红）· 持久化恢复验收脚本 · 2026-10-29

新增 `scripts/persistence-check.mjs`（`npm run persistence`）：两个**进程代次**验证 node 模式恢复。

**当前基线（N3 foldEvents/rehydrate 未落地 → 预期红）**

| 检查 | 结果 |
|---|---|
| gen1: wish_submit 建出 6 节点 | PASS |
| gen1: 事件已落盘（revision>0） | PASS |
| gen2: journalFingerprint 与关闭前一致 | PASS（journal 未被改写） |
| gen2: 重开后 counts 非 0 | **FAIL**（counts 仍是 0） |
| gen2: replay == snapshot（无 mismatch） | **FAIL** |
| gen2: 阶段闸门随 journal 恢复 | PASS |

即：**磁盘持久化本身是通的**（`records` 一致、fingerprint 一致），缺的只有「回灌 journal 后把 state 回折」。
N3 补 `foldEvents/rehydrate` 后本脚本应 6/6 变绿；届时按 Lead 口径切 `persistence:'node'` 复测
「重开 counts 非 0、fingerprint 一致、replay==快照」。

**预算**：R1–R8 用 8 轮（配额 10）。

---

## R9 · 别名回归修复（归并不再丢别名）· 2026-10-29

### 根因

`normalizeKeys(input,'snake')` 把 camel 拼写**删掉**，而 core `facade.ts/evidence.ts` 读 `producerInstance`（camel）
→ 三种拼写（snake / camel / 两者）都拿不到生产实例，全被拒。

### 修法（Lead 方案 1：合并保留）

- `normalizeKeys(input, target='merge')`：默认**两套拼写都保留**，只有同时存在且**值不同**才 `key-conflict`；
- 新增 `withAliases(obj)`：调 core 前补齐两套拼写（`producer_instance`+`producerInstance`、`auditor_*` 等），
  **让 core 自己挑**（core 读 camel，Python 侧读 snake）；
- `evidence_submit / verify_done` 调 core 前统一 `withAliases(...)`；`decide / pass_gate` 也走 merge；
- 工具 schema 仍用单一拼写（只是边界宽容，不改变契约形状）。

### 实跑（真工具面）

| 调用 | 结果 |
|---|---|
| `evidence_submit{producer_instance:ROLE-CODE-01}` | `{ok:true, evidenceId:'EVD-NODE-RESEARCH-1-f0aafc94', attemptNo:1, producerInstance:'ROLE-CODE-01'}` |
| `evidence_submit{producerInstance:ROLE-CODE-01}`（camel） | `{ok:true, evidenceId:'EVD-NODE-RESEARCH-2-f0aafc94', attemptNo:2}` —— **别名等价** |
| `evidence_submit{producer_instance:A, producerInstance:B}` | `{ok:false, error:'key-conflict', detail:'key-conflict:producer_instance!=producerInstance'}` |
| `verify_done{producer:ROLE-CODE-01, auditor:ROLE-AUDIT_CODE-01}` | `{ok:false, error:'invalid-state', nodeStatus:'ready'}` —— 已到 core 状态机，不再是键名问题 |

### 需要 Lead/N3 裁决的观察（未擅自改）

`evidence_submit` **不传 acceptance** 时，core 记 `acceptance:{kind:'none', policy:'caller-asserts-pass'}` → `verdict='pass'`
（上面两条 evidenceId 即此路径）。这与"unknown 不得 pass"冲突。建议二选一：
① core 在 `kind==='none'` 时要求显式 `verdict`，否则 `unknown`；② 插件层拒收"既无 acceptance 又无 verdict"（`acceptance-required`）。
**暂未实现**——N5 native-chain 可能依赖"无 acceptance 提交证据"，等裁决。

### 测试

`selftest 13/13`、`contract 18 checks / 0 failed`；`persistence-check` 仍 4/6（等 N3 foldEvents/rehydrate）。

---

## R10 · 「无 acceptance 不得 pass」门禁（裁决落地）· 2026-10-29

**裁决**（Lead）：② 插件层拒收「既无 acceptance 又无 verdict」→ `acceptance-required`；N3 同步把 core 的 `kind:'none'` 改 unknown。

### 实现

`evidenceSubmit` 门禁顺序：normalize（`key-conflict`）→ producer（`producer-unknown`）→ artifact（`artifact-missing`）
→ **判据（`acceptance-required`）** → verdict（`verdict-invalid` / `unknown`）。

- 无 `acceptance` 且无 `verdict` → `{ok:false, error:'acceptance-required', hint, producer_instance}`，审计落 `evidence_rejected reason=acceptance-required`；
- 显式 `verdict` 可替代 acceptance；`verdict='unknown'` 允许记录但不作为 pass 依据（审计记 `evidence_recorded_unknown`）；
- 默认值一个没动（`defaultBudgetTokens / maxParallel / persistence` 均保持）。

### 实跑（真工具面）

| 调用 | 结果 |
|---|---|
| `evidence_submit{node, artifact, producer_instance}`（无判据） | `{ok:false, error:'acceptance-required', producer_instance:'ROLE-CODE-01'}` |
| `evidence_submit{..., acceptance:{kind:'exists'}}` | `{ok:true, evidenceId:'EVD-NODE-RESEARCH-1-f0aafc94', verdict:'pass', acceptance:{kind:'exists'}, attemptNo:1}` —— core 侧 policy 已是 `exists`，不再是 `caller-asserts-pass` |

### 测试

| 套件 | 结果 |
|---|---|
| `scripts/selftest.mjs` | **14/14**（新增「无 acceptance 且无 verdict → acceptance-required」，并断言显式 verdict 放行） |
| `scripts/contract.mjs` | **19 checks / 0 failed**（新增 `evidence_submit#acceptance-required` 负例） |

### N5 调用形状（必须同步）

```jsonc
// ✅ 有判据
{ "nodeId": "NODE-RESEARCH", "artifactPath": "README.md", "producer_instance": "ROLE-CODE-01",
  "acceptance": { "kind": "exists" } }     // 或 sha256 / contains
// ✅ 显式判定
{ …, "verdict": "pass" }
// ❌ 两者都没有 → acceptance-required
```

**预算**：R1–R10 用满 10 轮。**剩余（等 N3）**：`foldEvents/rehydrate` 落地后切 `persistence:'node'`，
`npm run persistence` 冲 6/6 并纳入 CI 门禁。

---

## R11 · node 模式恢复闭环（N3 R6 落地后）· 2026-10-29

### 桥接改法（按 Lead 指定）

`CorePersistence.open` 现在走 **`restoreCore({events})`** 而不是只 `restoreCoreJournal`：

```ts
configureCore({ store: core });
const events = toEventRecords(opened.journal.records());   // N4 camel → core snake
restoreCore({ events });        // = journal.restore + rehydrate（回灌 + 折 state 一次完成）
const state = rehydrate(core);  // 取折好的 state 供 snapshot 报告
```

老 core 无 `restoreCore` 时回退到 `restoreCoreJournal + rehydrate`（向后兼容）。
`PersistenceSnapshot` 增加 `restoredCounts {nodes, edges, evidence, gates}`。

### 验证

| 套件 | 结果 |
|---|---|
| `npm run persistence`（node 模式，两代次） | **6/6** —— counts 非 0、fingerprint 一致、replay==snapshot、阶段闸门随 journal 恢复 |
| `selftest` | **14/14** |
| `contract` | **19 checks / 0 failed** |

### 真宿主 node 模式（`persistence:'node'`）复测

`cordis.patch.yml` 加 `persistence: 'node'` + `persistenceDir: 'core-state'`，插件重载后：

| 观测点 | 值 |
|---|---|
| 磁盘产物 | `.l0-control/core-state/{journal.jsonl 7800B, snapshot.json 5475B, journal.lock}` |
| 首次建图 | `wish_submit` → 6 节点 / 5 边；`persistence {appended:15, revision:15}`；`pass_gate(research)` → revision 16 |
| **重载后（新代次）** | `restored: 16`、`restoredCounts {nodes:6, edges:5, evidence:0, gates:1}`、`counts {nodes:6, edges:5}`、`gates.research.status='passed'`、`recoveryReport {source:'snapshot+replay', anchor:'journal-ahead', replayEqualsSnapshot:true, diverged:false}`、`fingerprint 4c4330e2…` |

即：**重开一个代次后图与闸门都从磁盘回来了**，不再出现 `counts={0,0,0,0}`。

**收口**：task-11 保持 complete。剩余可选项（不在 N2 预算内）：把 `npm run persistence` 纳入 CI 门禁、
`/l0 graph` 之类的命令入口。
