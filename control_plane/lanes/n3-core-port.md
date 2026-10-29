# Lane N3 · TS 核心不变量移植（`plugins/dsh-l0-control/src/core/`）

> 任务板：task-12 · 预算 16 轮 · 计划：`管理区/designs/_research/DSH原生插件-60轮长任务.md` §4 P2
> 写域：本目录（`src/core/`，N3 独占）+ 本文件。**不改** N2 的 package/入口、N4 的 state、Python `control_plane/`。
> 目的：把 Python 控制面冻结为 oracle，TS 侧重实现同一组不变量，用同一批夹具做差分。

---

## R1 · 核心骨架 + 状态机不变量（status / journal / store / evidence / graph）

**模块（全部纯 TS，无语义依赖、无 I/O、`node` 可直接执行）**

| 文件 | 内容 | 对应 Python |
|---|---|---|
| `errors.ts` | `ControlError` + Graph/Cycle/Credential/Evidence/DuplicateEvidence/Lease*/Decision/Replan/Stage 错误；每个带稳定 `code`（供差分断言） | 各模块异常类 |
| `types.ts` | 状态枚举（10 态）、`NodeRecord`/`Edge`/`Lease`/`Artifact`/`EvidenceRecord`/`DecisionRecord`/`EventRecord`/`DoneCredential`/`GraphSnapshot`、`Clock` 注入点 | `db.py` schema v4 |
| `status.ts` | `TRANSITIONS`（16 条跨状态边）、`TERMINAL_STATUSES={done}`、`GATED_STATUSES={done}`、`UNBLOCK_REASON_PREFIX`、`checkTransition()`、`allowedTransitions()`、`setTransitionEnforcement()`（`CP_TRANSITIONS_ENFORCE`，默认开） | `graph.TRANSITIONS` / R9 终态 / R10 白名单 |
| `journal.ts` | 只追加日志：`append()`（seq 从 1、`EVT-%06d`、同 ID 抛错）、`after()`、`validateStream()`（关键事件必备字段） | `events.py` |
| `store.ts` | 进程内状态表 + `atomically(fn)`：抛错回滚「状态 + 日志」（等价 Python `with conn:`），给 replan 用 | `db.py` + 事务语义 |
| `evidence.ts` | `addArtifact` / `addEvidence`（**append-only**：同 ID 抛 `duplicate_artifact`/`duplicate_evidence`）、`listEvidence`、`passEvidence` | `evidence.py` |
| `graph.ts` | `addNode`/`addEdge`/`setEdges`/`removeNode`（终态默认不可删，`allowTerminal` 逃生口）、写期环检测、`setStatus`（唯一入口）、`unblock`、`doneCredential`、`snapshot`/`replaySnapshot`/`replayMismatches` | `graph.py` R1–R10 |
| `selfcheck.ts` | 9 条不变量冒烟（`node src/core/selfcheck.ts`，输出 JSON，退出码 0/1） | （新）快速门禁 |
| `index.ts` | barrel 导出（供 N2 的 tools/service 引用） | — |

**`setStatus` 拒绝顺序（全部在任何写入之前）**

```
状态合法 → 节点存在 → 终态守卫 → 白名单（同状态豁免）→ 幂等短路 → done 凭证 → blocked 解除留痕 → 写入 + 事件
```

事件：`status_changed`（真实前态 + 后像 assignee/attempts/at/reason/evidence）+ `assignee_changed` + `attempts_changed`；
`replaySnapshot()` 应用三者后可完整重建，`replayMismatches()` 给逐字段差异。

**自检结果**（`node src/core/selfcheck.ts`）

```
ok: true | passed: 9 | failed: 0 | exit 0
cases: whitelist_shape / done_requires_credential / done_then_terminal / whitelist_rejects_probes
     / legal_chain_replay / cycle_rejected / evidence_append_only / terminal_remove_and_unblock / journal_audit
```

**已修的一个坑**（记下来避免 N2/N4 踩）：`setStatus({assignee: null})` 必须表示「清空」，
`options.assignee ?? UNSET` 会把 `null` 吞成「不修改」→ 改为 `=== undefined` 判定。

**R1 判定**：✅ 状态机唯一入口、done 凭证/终态、白名单、环检测、append-only 证据、replay 对齐在 TS 侧成立。

---

## R2 · ready 门控 + 租约 + 门面 8 动作 + 审计独立字段

**新增模块**

| 文件 | 内容 |
|---|---|
| `ready.ts` | `recomputeReady()`（先降级假 ready，再晋升依赖全 done；写 `ready_recomputed` 汇总事件）、`onEvent()`（**只有** `status_changed.to==="done"` 触发）、`bootstrap()`、`readySet()`、`installReadyHook(store)`（把 done 钩到 ready 重算，幂等，`WeakSet` 防重复） |
| `leases.ts` | `claim/renew/release/expire/takeover/assertFencing/currentLease`：只有 ready 可 claim、同刻单 owner、fencing 令牌单调（`leaseCounters`，release 不回退）、过期必须先 expire/takeover；状态变更全部经 `graph.setStatus`（事件后像一致） |
| `facade.ts` | N2 `service.ts` 约定的 8 个名字：`submitWish/graphStatus/nextTask/claimTask/submitEvidence/verifyDone/decide/exportProjection` + `configureCore/coreStore/resetCore/coreCapabilities` |

**门面实现度（诚实标注，不假装成功）**

| 动作 | 状态 | 说明 |
|---|---|---|
| `graphStatus` | ✅ | 节点/边/ready/计数 + journal 体检 |
| `nextTask` | ✅ | 先 `recomputeReady` 再按 `role→capability` 过滤取第一个 ready |
| `claimTask` | ✅ | 走租约（`ttlSec=600`，owner=`instanceId ?? role`），同 owner 重复领取幂等返回 |
| `exportProjection` | ✅ | 只返回投影数据（落盘归 N2），含 nodes/edges/ready/gates/journal |
| `submitWish` | ⏳ R4 | 返回 `{ok:false,error:"core-not-implemented",hint}` |
| `submitEvidence` | ⏳ R3 | 同上（缺 `nodeId`/`artifactPath` 先报参数错） |
| `verifyDone` | ⏳ R3 | 先做**只读探测**：`doneCredential` 不可用 → `credential-unavailable`；可用 → 仍报未实现（R3 走完整 done 事务） |
| `decide` | ⏳ R3 | 报未实现（L0/L1 自动、L2 默认值 + 超时） |

**审计独立（N5 e2e 取数依赖，Lead 转达）**

- `EvidenceRecord` 新增 **必填** `producer_instance`（提交者实例，如 `ROLE-CODE-01`）与可选 `auditor_instance`；**不使用 `actor` 字段**。
- `addEvidence` 缺 `producerInstance` → `EvidenceError(code="producer-instance-required")`，**不落账**；
  声明的审计方与提交者同实例/同职务（`roleOfInstance()` 取 `ROLE-XXX-NN` 的 `XXX`）→ `audit-not-independent`，同样不落账。
- `graph.validateDoneCredential` 二次校验：一组 pass 证据的 `auditIndependence()` 不通过 → `CredentialError`，凭证铸不出来。
- 事件 `evidence_added` payload 同步带 `producer_instance` / `auditor_instance`，便于投影与审计对账。

**自检**：`node src/core/selfcheck.ts` → **ok: true / passed: 15 / failed: 0**（新增 5 例：ready 门控与自动解锁、假 ready 降级、租约全流程 + 令牌单调 + replay、fencing 守卫、门面契约、审计独立）。

**⚠️ 交给 N2 的构建阻断（当前 service 必然 `core-unavailable`）**

1. `lib/` 是旧生成物，不包含 `ready/leases/facade` → 必须重跑 `node scripts/build.mjs`。
2. **即使重跑也会坏**：`build.mjs` 用 `stripTypeScriptTypes` 只剥类型，**不会把相对 `.ts` 说明符改写成 `.js`**，
   于是 `lib/core/index.js` 里仍是 `from "./types.ts"`，Node 直接报
   `ERR_MODULE_NOT_FOUND: ...lib/core/types.ts`（已实测）。修法（`scripts/build.mjs`，N2 写域）：

   ```js
   // 在 stripTypeScriptTypes(...) 之后、写盘之前加：
   output = output
     .replace(/(\bfrom\s*["'])(\.[^"']+)\.ts(["'])/g, "$1$2.js$3")
     .replace(/(\bimport\s*\(\s*["'])(\.[^"']+)\.ts(["'])/g, "$1$2.js$3");
   ```
   已验证：改写后 `lib/core/index.js` 里是 `from "./types.js"`。
3. 补完这两步后 `service.ts` 的 `import('./core/index.js')` 才会拿到 8 个名字（缺的仍是 `core-unavailable`，行为不变）。

---

## R3 · 决策 L0–L3 + `submitEvidence` + `verifyDone`

### 新增/改动

| 文件 | 内容 |
|---|---|
| `decisions.ts`（新） | `createDecision`（L0/L1 必须 chosen → `auto`；L2 必须 `default_option_id` + `timeout_sec>0` → `proposed` 且 `deadline_at=now+timeout`；L3 无 chosen → `blocked`）、`tickL2(now)`（到期 → `timed_out` 且 `chosen===default`）、`confirmL3`（只接受 `blocked/proposed`，chosen 必须在 options）、`overrideDecision`（`overridden` 留痕）、`chooseNow`（L2 提前定 → `confirmed`；其他 → 推翻）、`blockingDecisions`（**信息性**，不参与 done 判定，与 Python `evidence.finalize` 一致） |
| `io.ts`（新） | `CoreIo` 最小 I/O 适配（`exists/isFile/sha256/readText/resolve`）+ `nodeIo` 默认实现 + `configureIo()` 注入；core 其余模块保持纯函数 |
| `facade.ts` 改 | `submitEvidence` / `verifyDone` / `decide` 落地；新增 `tickDecisions` / `nodeGates`；`coreCapabilities()` 更新（只剩 `submitWish`） |

### `submitEvidence` 语义（顶层 `ok` 不撒谎）

1. 参数：`nodeId` + `artifactPath` 必填；`producerInstance` **必填**（缺 → `producer-instance-required`，不落账）；
   `auditorInstance` 可选（审计独立判定）。
2. 路径：`resolved` 优先，否则 `io.resolve`；不存在 → `artifact-missing`；非文件 → `artifact-not-file`。
3. sha256：`input.sha256` 优先，否则 `io.sha256(resolved)`。
4. 验收判定（**不允许**空 expected 假 pass）：
   | acceptance | 结论 |
   |---|---|
   | 缺省 | `pass`（调用方断言，`detail.policy=caller-asserts-pass`） |
   | `{kind:"exists"}` | `pass` |
   | `{kind:"sha256", expected}` | 合法 64 hex → 命中 `pass` / 不符 `fail`；非法 → `unknown` |
   | `{kind:"contains", expected}` | 空 expected → **`unknown`**（否则 `includes("")` 恒真）；否则 `pass`/`fail` |
   | 其他 kind | `unknown` |
5. artifact append-only：`ART-<node>-<sha8>` 已存在且 sha 相同 → 复用；不同 → `artifact-sha-conflict`；
   新 ID 写入走 `addArtifact`（同 ID 二次登记会抛 `duplicate_artifact`）。
6. evidence append-only：`attempt_no = 该节点证据数 + 1`；同 `evidenceId` 二次 → `duplicate_evidence`。
7. 推进：仅 `verdict==="pass"` 且节点为 `claimed/running` → `setStatus(submitted)`；
   `fail`/`unknown` 不推进，返回 `ok:false`（`error:"evidence-not-passed"`）。
8. 节点已 `done` → `evidence-after-done`（done 后不再接受新证据）。

### `verifyDone` 语义（先校验，后迁移；失败零写入）

1. `nodeId` 必填；节点不存在 → `node-not-found`；已 `done` → `{ok:true, alreadyDone:true}`。
2. 前态必须是 `submitted` / `verifying`，否则 `invalid-state`（附 `nodeStatus`）。
3. `doneCredential()` 不可用 → `credential-unavailable`（**状态与事件都不动**，自检断言事件计数不变）。
4. 通过后：`submitted → verifying`（`verify_started`）→ `verifying → done`（`evidence_ok`，`assignee=null`、`dropLease`）
   → done 钩子触发 `recomputeReady` → 返回 `promoted`（新解锁的下游）。
5. 终态守卫仍在：`done` 之后不可退出（R9 那套）。

### 自检：`node src/core/selfcheck.ts` → **ok: true / passed: 18 / failed: 0**

新增 3 例：`decisions_l2_l3_l0`（L2 缺默认值拒绝、未到期不推进、到期 `timed_out` 且 chosen=default；L3 `blocked`→确认→重复确认拒绝；L1 `auto`→`overridden`）、
`evidence_submit_paths`（缺 producer 拒绝、空 expected→unknown、sha 不符→fail、pass→submitted、`attempt_no` 递增、同 ID `duplicate_evidence`、同职务审计 `audit-not-independent`）、
`verify_done_and_failure_immutability`（done + 下游解锁 + replay 一致；无证据 `credential-unavailable` 且零写入）。

### 构建提醒（N2）

`src/core/` 新增了 `decisions.ts` / `io.ts` 并改了 `facade/index/graph/evidence`，**需要再跑一次 `node scripts/build.mjs`**
（N2 已修好 `.ts→.js` 说明符重写）；跑完后 `lib/core/index.js` 导出应为 101 个名字量级（含 `tickDecisions` / `nodeGates`）。

---

## R4 · `replan` 单事务 + `submitWish` + `decide` create-or-update + fixture 差分（收口）

### 新增/改动

| 文件 | 内容 |
|---|---|
| `replan.ts`（新） | `replan(store, {reason, add, remove, note, recompute})`：**单事务**（`Store.atomically`）内完成 add → remove → `graph_version+1` → `replan_events` 行 → `graph_replanned` 事件；任一步抛错整笔回滚；`remove` 含 `done` 节点**前置拒绝**；`EVT-R####` 事件号与 Python 一致；另有 `currentGraphVersion` / `listReplanEvents` / `REPLAN_REASONS` |
| `facade.ts` 改 | `submitWish` 落地（确定性 6 节点图 + 单事务 + 幂等拒绝 + `wish_submitted`/`graph_created` 事件 + bootstrap）；`decide` 改为 **create-or-update**；`coreCapabilities().pending` 清空 |
| `fixture-diff.ts`（新） | 读 `fixtures/manifest.json`，对 `fixtures/graph/*.json` 跑 TS 侧 schema-lite + 语义校验，与 Python oracle 的**同一份 manifest 期望**逐条比对；输出 `{cases, matched, diff, details}`，退出码 0 = 差分 0 |

### `submitWish`（确定性最小图）

- 节点固定：`NODE-RESEARCH → NODE-PRD → NODE-CONTRACT → NODE-BUILD → NODE-AUDIT → NODE-DELIVER`
  （stage：research/design/design/build/audit/deliver；capability：RESEARCH/DESIGN/DESIGN/CODE/AUDIT/OPS；
  每节点 `evidence_required=["artifact"]`、`verifier_ids=["verifier-ci"]`）。
- 单事务写入 + `wish_submitted`（含 text/maxParallel/budgetTokens）+ `graph_created`；`bootstrap()` 后只有 `NODE-RESEARCH` 是 ready。
- 同进程重复提交 → `{ok:false,error:"wish-already-submitted",existing:[...]}`（不静默建第二份图）；空愿望 → `wish-text-required`。

### `decide` 改为 create-or-update（N5 R5 契约歧义修复）

| 场景 | 行为 |
|---|---|
| `decisionId` 已存在 + `optionId` | 更新：L3 → `confirm`；L2 `proposed` → 提前 `confirmed`；其他 → `overridden`；返回 `{ok:true, updated:true}` |
| `decisionId` 已存在、无 `optionId` | 只读回显 `{ok:true, unchanged:true}` |
| `decisionId` 不存在 + 创建参数齐备 | 创建（L0/L1 带 chosen → `auto`；L2 带 default+timeout → `proposed`；L3 无 chosen → `blocked`），返回 `{ok:true, created:true}` |
| 创建参数缺失 | `{ok:false, error:"decision-params-required", missing:[...]}`（不静默、不猜默认值） |

### 差分结果（同夹具）

```
node src/core/fixture-diff.ts
{ "ok": true, "cases": 16, "matched": 16, "diff": 0, "details": [] }
```

- `fixtures/manifest.json` 共 23 条：**graph 16 条 | l11 7 条**。N3 的差分覆盖 graph 全 16 条（valid 3 + invalid 13），**diff = 0**；
  l11 属于 L1.1 作用域判据（E lane 的 `decide()`），不在「控制面核心不变量」范围，未纳入本 lane 差分。
- 修差分时补上的两处 TS 侧规则：`graph_id` 必须匹配 `^GRAPH-\d{8}-[0-9A-F]{6}$`（消息里带字面量，便于关键字比对）；
  `state_units[].scope` 必须是 `shareable|private|unlabeled`（`invalid_unknown_scope` 的非法值在 state_unit 上，不在 node 上）。

### 自检：`node src/core/selfcheck.ts` → **ok: true / passed: 21 / failed: 0**

新增 3 例：`wish_submit`（6 节点序列 / 只有根 ready / replay 一致 / 重复提交拒绝 / 空愿望拒绝）、
`replan_single_transaction`（版本+1 + `EVT-R####` + 补推 ready + 中途失败全回滚：节点/版本/事件/replan_events 都不变 + done 节点不可删 + 非法原因拒绝）、
`decide_create_or_update`（L0/L2/L3 创建 + L2 缺参明确报错 + L3 确认 + L0 推翻 + L2 提前定 + 缺参创建拒绝）。

### task-12 验收对照

| 验收项 | 状态 | 证据 |
|---|---|---|
| done 无证据拒绝 / 终态 | ✅ | `done_requires_credential`、`done_then_terminal`（R1） |
| ready 只由 done 事件 | ✅ | `ready_gate_and_auto_promote`、`fake_ready_demoted`（R2） |
| 证据 append-only | ✅ | `evidence_append_only`、`evidence_submit_paths`（R1/R3） |
| L2 默认值 + 超时 | ✅ | `decisions_l2_l3_l0`（R3） |
| 审计独立 | ✅ | `audit_independence`（R2） |
| replan 单事务 | ✅ | `replan_single_transaction`（R4） |
| 同夹具差分 = 0 | ✅ | `fixture-diff.ts`：graph 16/16，diff 0 |
| 反向测试齐全 | ✅ | 21 例中 12 例为拒绝路径 |
| 每轮报 Lead | ✅ | R1–R4 四次 send_message |

### ⚠️ 需要 N2 再跑一次 build

`src/core/` 新增 `replan.ts` / `fixture-diff.ts` 并改了 `facade.ts` / `index.ts` → `node scripts/build.mjs`。
build 后 `lib/core/index.js` 导出约 106 个名字，含 `replan` / `currentGraphVersion` / `WISH_PLAN`；
N5 的 `wish_submit` 可直接跑（`submitWish` 已绿）。

---

## 给 N5 的可跑信号

- `wish_submit({text, maxParallel?, budgetTokens?})` → `{ok:true, wishId, nodes[6], ready:["NODE-RESEARCH"], graph}`
- 之后链路：`task_next{role}` → `task_claim{nodeId,instanceId}` → `evidence_submit{nodeId,artifactPath,producerInstance,auditorInstance?,acceptance?}`
  → `verify_done{nodeId}`（返回 `promoted`）→ `decide{...}`（create-or-update）→ `export_projection`
- 阶段闸门：**R5 已补 `stages.ts`**（见下节），N5 全链路在 done 前调 `passGate(store, stage, [evidenceId])` 即可（research→design→build→audit→deliver）。

---

## R5 · `stages.ts` 阶段闸门（补 N5 全链路前置）

**问题**：wish 图每个节点都带 `stage`，而 `doneCredential` 要求该 stage 闸门 `passed`；此前 core 没有 stages API，
N5 只能手工改 `store.state.gates`，否则全链路必然卡在 `credential-unavailable`。

**新增 `stages.ts`**（只依赖 types/errors/store，不 import graph，避免循环）

| API | 语义 |
|---|---|
| `setGate(store, stage, status, {evidenceRefs, at})` | 校验 `stage ∈ research/design/build/audit/deliver` 与 `status ∈ pending/passed/failed`；写 `stage_gate_changed` 事件 |
| `passGate(store, stage, refs)` / `failGate(...)` | 便捷封装 |
| `getGate(store, stage)` / `listGates(store)` | 只读回显（`evidence_refs` 返回副本） |
| `gateAllowsDone(store, stage)` | **单一判定源**：无 stage → `true`；有 stage → 必须 `passed` |
| `blockedByGates(store, nodeIds?)` | 诊断：列出被闸门挡住的节点 |

**接线**：`graph.validateDoneCredential()` 改为调用 `gateAllowsDone()`（原来内联读 `state.gates`），
于是 `doneCredential()` / `verifyDone()` 与 stages API **同源**；`stage_gate_changed` 进入事件流。

**自检新增 `stage_gate_blocks_done`（双向）**

- 未设闸门 → `gateAllowsDone=false`、`doneCredential=null`、`verifyDone` 返回 `credential-unavailable`、节点停在 `submitted` 不前进；`blockedByGates()` 能列出该节点。
- `failGate` → 仍拒绝（failed 不放行）。
- `passGate` → 凭证可铸造、`verifyDone` 返回 `{ok:true,status:"done"}`、`listGates()` 恰好 1 道、replay 一致。
- 反向：`setGate(unknown stage)`、`setGate(build,"done")` → `stage_error`。
- 顺带把 R4 replan 用例里手写 `store.state.gates.set(...)` 换成 `passGate(...)`，确保走公开 API。

**门禁**：`node src/core/selfcheck.ts` → **ok: true / passed: 22 / failed: 0**；
`node src/core/fixture-diff.ts` → **16/16, diff 0**；`src/core/index.ts` 导出 **115** 个名字。

**需要 N2 再跑一次 build**：新增 `stages.ts` 并改了 `graph.ts` / `index.ts` → `node scripts/build.mjs`；
build 后 `lib/core/index.js` 带 `setGate/passGate/failGate/getGate/listGates/gateAllowsDone/blockedByGates`。

---

## R6 · 键名别名 + `foldEvents`/`rehydrate`（journal 权威的最后一环）+ 证据 verdict 裁决

### 1. 键名别名（`alias.ts`，新）

- `pickAlias(source, names)`：按顺序取第一个有值的键；**多键同时有值且不同 → `AliasError(code="alias-conflict")`**，不静默择一。
- `ALIASES` 单一事实源：`decision_id/decisionId`、`option_id/optionId/chosen_option_id/chosenOptionId`、
  `default_option_id/defaultOptionId`、`timeout_sec/timeoutSec`、`producer_instance/producerInstance`、
  `auditor_instance/auditorInstance`、`node_id/nodeId`、`artifact_id/artifactId`、`artifact_path/artifactPath`、
  `verifier_id/verifierId/verifier`、`evidence_id/evidenceId`、`attempt_no/attemptNo`、`instance_id/instanceId`。
- 落点：`evidence.addEvidence`、`decisions.createDecision`、`facade.{submitEvidence,decide,claimTask}`。
- 门面在公开入口处把 `AliasError` 转成 `{ok:false,error:"alias-conflict",keys}`（不让异常冒泡到 N2）；
  `evidence/decisions` 内部仍抛错（fail-closed）。
- **N5 的 evidence 全拒已修**：`producer_instance`（N2 归一化形状）现在能正常落账。

### 2. 证据 verdict 裁决（Lead 2026-10-29）

- 既无 `acceptance` 又无显式 `verdict` → **`unknown`**（此前是 `pass`/`caller-asserts-pass`，已删）。
- 只有「acceptance 命中」或「显式 `verdict:'pass'`」才 `pass`；显式 `fail` 与 acceptance 同时给时以更严格者为准。
- `unknown` 一律 `ok:false` 且不推进节点（`verdict` 同时支持 `verdict`/`evidenceVerdict`/`evidence_verdict` 别名）。

### 3. `fold.ts`（新）：journal → State

| API | 语义 |
|---|---|
| `foldEvents(events) -> State` | 纯函数，按 seq 折叠：nodes / edges / status+assignee+attempts / artifacts / evidence / leases+lease_counters / gates / decisions / replan_events / meta(graph_version,wish_*) |
| `rehydrate(store)` | 用自身 journal 重折 `store.state`（幂等，journal 不动） |
| `restoreFromEvents(store, events)` | **重开场景**：回灌日志 + 折叠状态（补上 N2 `restoreCoreJournal` 只回灌不折叠的缺口） |
| `facade.restoreCore({events?})` | 门面版：返回 `{ok, restored, counts}`；`rehydrateCore()` 只重折当前 journal |

**为 fold 补齐的事件字段**（append-only 兼容，老事件缺字段走默认值）：
`artifact_added`+`producer_node/verifier_ids/a2a_artifact_id`、`evidence_added`+`artifact_id/attempt_no/at`、
`lease_claimed|renewed|taken_over`+`heartbeat_at`、`decision_created`+完整 `decision`、`graph_replanned`+`event_id/at`。

### 4. 自检：`node src/core/selfcheck.ts` → **ok: true / passed: 24 / failed: 0**

新增 2 例：

- `alias_camel_and_snake`：全 snake_case 入参能落账（producer/auditor 落库正确）；camelCase 同样识别；
  **两键冲突 → `alias-conflict`**；snake_case 创建 L2（`default_option_id`+`timeout_sec`）→ `proposed`，snake_case 更新 → `confirmed`。
- `fold_events_restores_state`：wish→claim→evidence→gate→done→decision→replan 后，
  `foldEvents(journal)` 的 counts 与内存 state 一致、`snapshot` 完全相等；
  **重开**（新 store 只吃事件）→ nodes/evidence/gates/decisions 均非 0（N2 的 `counts={0,0,0,0}` 已修）、
  `replayMismatches == 0`、快照与原 store 一致；`rehydrate` 幂等。

证据相关既有用例同步更新：`evidence_submit_paths` 现在显式覆盖「无 acceptance 无 verdict → unknown」与「显式 verdict=pass → pass」，
`attempt_no` 断言改为 4（unknown×2 + fail + pass）。

### 5. 门禁

| 项 | 结果 |
|---|---|
| selfcheck | **24/24** |
| fixture 差分 | **16/16，diff 0** |
| `src/core/index.ts` 导出 | **120** 个名字（含 `foldEvents/rehydrate/restoreFromEvents/restoreCore/rehydrateCore`） |

**需要 N2 再跑一次 build**：新增 `alias.ts` / `fold.ts` 并改了 `evidence/decisions/facade/index` →
`node scripts/build.mjs`。build 后插件即可 `restoreCore({events})` 让重开 counts 非 0、`replay==snapshot`。

---

## R7（task-25 / N7a）· 统一身份 A：角色实例解析大小写不敏感

**口径**（用户选 A：角色实例与 Team member 同名）：核心侧必须同时接受
小写 `role-code-01` / `role-audit-code-01` 与旧大写 `ROLE-CODE-01` / `ROLE-AUDIT-CODE-01`。

**实现（`evidence.ts`）**

| 函数 | 语义 |
|---|---|
| `parseInstanceId(id) -> ParsedInstance \| null` | 正则 `^role-(.+)[-_](\d+)$/i`；返回 `{raw, canonical, role, index}`。`canonical` 为 `ROLE-<职务段大写连字符形态>-<序号>`（`role-audit-code-01` → `ROLE-AUDIT-CODE-01`）；`role` 为**连字符转下划线并大写**（`CODE` / `AUDIT_CODE`）；非实例 ID（如 `verifier-ci`）→ `null` |
| `roleOfInstance(id)` | 解析成功返回归一职务；非实例 ID **原样返回**（不猜测、不改写） |
| `sameInstance(a, b)` | 大小写/分隔符不敏感的同一性比较；两者不可解析时退回 `trim().toLowerCase()` 比较 |
| `auditIndependence(rows)` | 先判 `sameInstance`（→ `same-instance`），再判归一职务相等（→ `same-role`）；返回里附带 `producerRole/auditorRole` 便于诊断 |

**存储不变**：`EvidenceRecord.producer_instance` / `auditor_instance` **保留调用方原样字符串**
（小写就存小写），只在比较时归一 —— 因此 `snapshot` 不受身份解析影响（有断言）。

**自检新增 `identity_unified_roles`（25/25 中的一项）**

- 解析：`ROLE-CODE-01` 与 `role-code-01` → canonical 同为 `ROLE-CODE-01`、role `CODE`、index 1；
  `role-audit-code-01` 与 `ROLE-AUDIT-CODE-01` → 同一 canonical、role `AUDIT_CODE`。
- 非实例 ID：`parseInstanceId("verifier-ci")===null`、`roleOfInstance("verifier-ci")==="verifier-ci"`。
- 同一性：`role-code-01` ≡ `ROLE-CODE-01`（true），`role-code-01` ≠ `role-code-02`。
- 审计独立四态：跨大小写同实例 → `same-instance`；同职务（`role-code-01` vs `ROLE-CODE-02`）→ `same-role`；
  `AUDIT_CODE` 同职务 → `same-role`；`role-code-01` vs `role-audit-01` → 独立；空 producer → `missing-producer`（fail-closed）。
- 端到端：小写身份 `submitEvidence` 落账成功、记录保留原样、`doneCredential` 可铸造；
  解析/判定是纯读 → **`snapshot` 逐字节不变**。

**门禁**：selfcheck **25/25**；fixture 差分 **16/16 diff 0**；导出 122 个名字
（新增 `parseInstanceId` / `sameInstance`，`roleOfInstance` 语义升级）。

**需要 N2 再跑一次 build**：改了 `evidence.ts` / `index.ts` → `node scripts/build.mjs`；
build 后 `role-code-01` 这类小写成员名在 `evidence_submit`/`verify_done` 链路上可直接用。

---

## R8 · P1 修复：驳回必须释放租约（`rejectNode`）

**问题（O 在真实链复现）**：core 的验证失败路径此前「什么都不写」/不带 `dropLease`，于是节点回到
`ready` 但旧租约还在 → 后续 `claimTask` 报 `alreadyHeld`、`submitEvidence` 不推进、`verifyDone` 判
`invalid-state`，一次失败把节点卡死。

**改动**

- `graph.rejectNode(store, nodeId, reason, {detail, at})`（新，唯一驳回入口）：
  1. 仅允许 `submitted` / `verifying` 驳回（其它状态 `GraphError`）；
  2. 先写 `node_rejected` 事件（`{reason, detail, at}`）；
  3. 再 `setStatus(ready, {reason:"rejected:<原因>", assignee:null, attemptsDelta:1, dropLease:true})`
     —— **状态 / 释放租约 / attempts+1 / 留痕 一次做完**，等价 Python `evidence._reject`。
- `facade.verifyDone()` 凭证不可用分支改为调用 `rejectNode(..., "credential_unavailable")`，
  返回体带 `rejected:{nodeStatus, attempts, leaseDropped}`、`beforeStatus`、`nodeStatus`（实际后态）。
- `done` 成功路径本来就带 `dropLease:true`（已核对），无需改。

**自检（25/25）**

- `verify_done_and_reject_semantics`（原 `..._immutability` 更名）：无凭证 verify →
  `ok:false`、节点 `ready`、`attempts=1`、`currentLease === undefined`、`status_changed.reason` 以 `rejected:` 开头、replay 一致。
- `stage_gate_blocks_done` 扩成完整回环：
  1. 闸门未过 → 驳回为 ready + attempts 1 + 无租约；
  2. **立即 re-claim 成功且 fencing 令牌递增到 2**（不再 `alreadyHeld`）；
  3. `failGate` → 再提交 → 再驳回（attempts 2，租约同样清掉）；
  4. `passGate` → 再 claim + 提交 → `verifyDone` **done**（attempts 仍为 2，终态租约已释放）。

**门禁**：selfcheck **25/25**；fixture 差分 **16/16 diff 0**。

**需要 N2 再跑一次 build**：改了 `graph.ts` / `facade.ts` / `index.ts` → `node scripts/build.mjs`；
build 后 `rejectNode` 可从 `index` 直接用（N5/N7b 的失败重试链不会再有 stale 租约）。







