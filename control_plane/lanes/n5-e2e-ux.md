# Lane N5 · e2e-ux · lane note

> 计划：`../AI集群工作协议-管理区/designs/_research/DSH原生插件-60轮长任务.md` P4（预算 6 轮）
> 任务卡：`task-14`（N5 · 端到端 CRUD 与 UX）
> 写域：`plugins/dsh-l0-control/src/e2e/`、`plugins/dsh-l0-control/tests/e2e/`、本文件
> **不改** `core/`、`state/`、入口（`index.ts` / `cordis.patch.yml`）

---

## R1 · 契约 + 夹具草案（已完成）

**依赖状态（开工时实测）**：`plugins/dsh-l0-control/` **尚不存在**；N1–N4 无产出物；`control_plane/` 侧基线为上一轮程序收口态（308 tests / 23 fixtures / 27 validate）。
→ 按 Lead 指令"先做设计/夹具草案，等依赖信号再联调"，本轮不做联调，先把**契约与断言**写死。

**产出**

| 文件 | 内容 |
|---|---|
| `src/e2e/README.md` | 设计草案：为什么契约优先、ControlPort 九动作、四条验收的机检口径、四个 UX 面（U1–U4）、依赖门 G1–G5、与 Python oracle 的差分口径 |
| `src/e2e/port.ts` | **纯类型**端口契约（无 import，不依赖 core）：`ControlPort` 9 动作 + `JournalPort` + `SpawnPort` + `Actor/Node/Graph/Evidence/Decision` 形状 + `Result<T>` 失败语义 |
| `tests/e2e/scenarios/crud_wish.json` | 主场景夹具：愿望 + 10 节点（按 5 段：research/design/build/audit/deliver）+ 实例计划（**CODE×2**）+ 逐节点认领分配 + 期望消息 + 5 条 forbidden |
| `tests/e2e/scenarios/failure_replan.json` | 失败场景夹具：审计首轮 fail → ready(attempts+1) → replan(+1 版本) → 仅重做 `NODE-TEST/AUDIT/DELIVER` → done；5 条断言 R1–R5 + 3 条 forbidden |
| `tests/e2e/README.md` | 断言口径（A1–A4 逐条）、运行方式与**四态退出码**（0 pass / 1 drift / 2 failed / 3 unknown）、依赖门 SKIP 政策（**SKIP 不得折算 pass**）、Oracle 差分四项 |

**设计要点（对后面几轮的影响）**
1. **A1 的判定靠 `actor.kind`，不靠日志措辞**——所以 `port.ts` 强制每个动作带 `actor`；这也是"命令不得推进节点状态"（forbidden F5）唯一可机检的落点。
2. **A2 拆成四条子断言**，其中"同一实例不得同时持有两个活跃节点"是用来暴露**实例复用串号**的关键一条（单靠"双认领被拒"抓不到）。
3. **A3 复用 Python 已有语义**（`audit_independence_violations` 三条规则），TS 侧只产同一份判据，不重写规则。
4. **A4 加了"未受影响节点 `updated_at` 不变"**——否则"replan"可能被实现成全量重做而看起来仍然通过。
5. **退出码与 A7 conformance 对齐**（0/1/2/3），便于主窗口把 e2e 与 conformance 放进同一张门禁表。

**阻塞**：无（本轮按设计先行，未触依赖）。

### R1 附记（本轮后半，依赖在写文档期间落地）

写文档期间 `plugins/dsh-l0-control/` 已由 N2/N3/N4 建出并编译（`src/` + `lib/` + `package.json` + `cordis.patch.yml` + `scripts/build.mjs`）。已核对的**契约对齐情况**：

| 我定义的 | 实际落地 | 结论 |
|---|---|---|
| `ControlPort` 9 动作 | `src/tools.ts` 注册 **wish_submit / graph_status / task_next / task_claim / evidence_submit / verify_done / decide / team_status / export** —— **9/9 同名** | ✅ 契约与工具面一致 |
| 服务门面 | `L0ControlService` 有 `wishSubmit / graphStatus / taskNext / taskClaim / evidenceSubmit / verifyDone / decide / teamStatus / exportProjection` | ✅ 同名（仅 `export` ↔ `exportProjection` 命名差） |
| 每个动作带 `graphId` | 服务方法**不带 graphId**（`taskNext({role})`、`graphStatus()`），即**单图/插件实例级** | ⚠️ **需在 R2 适配**：要么 port 去 graphId（v1 单图），要么服务加参数。我倾向前者（v1 单图，成本最低），R2 定 |
| `Actor` 必带 | 服务方法无 `actor` 入参；工具层拿 `exec.agent` | ⚠️ A1（无人工中继）需要 actor → R2 决定：工具层注入 actor 到 journal，port 从 journal 读 |
| `port.ts` 被编译进 `lib/e2e/port.js` | ✅ 我的类型文件已被构建流程纳入 | ✅ 无副作用（纯类型） |

**新增风险 R-01**：`service.core()` 返回 `CoreModule | null`——目前 core 可能还是桩（N3 在程）。因此 native 端口在 core 为空时必须返回 `unknown(3)` 而不是"看似通过"。这条已写进 `tests/e2e/README.md` §4 的 G4 行，R2 实现时按此判。

**下一轮（R2）入口**
- 写 `tests/e2e/run.mjs`（mock 端口）跑两场景；
- 按上表把 `port.ts` 收敛为单图 + actor 从 journal 取（2 处小改，仍不碰 core/state/入口）；
- 若 `service.core()` 已非空，同轮加 `--port native` 探测（不承诺通过，只报 `unknown` 或差异）。

---

## 轮次预算

| 轮 | 内容 | 状态 |
|---|---|---|
| R1 | 契约 + 夹具草案（本文件同上表） | ✅ |
| R2 | mock 端口驱动 `run.mjs` + 两场景跑通 | ✅ |
| R3 | A3 改 verifier→role 推导 + G5 恢复断言 + N4 形状 | ✅ |
| R4 | native 端口联调（graph/task_next 通、wish 未实现）+ G5 切真实 `lib/state` | ✅ |
| R5 | UX 面（U1/U3）+ conformance 摘要 + native 分支断言（core 已实现） | ✅ |
| R6 | native 链段：wish→next→claim→evidence→decide→export（闸门待 N2 桥接） | ✅ |
| R7 | native 全链驱动 + `pass_gate` 接入 + acceptance 语义 + oracle 四项差分 | ✅ **native:chain=pass** |
| R8 | **N6 工具改名适配**（14 工具）：`export→graph_export`、`decide→decision_record` + 新增 `agent_*/board_task_*` | ✅ 回归修复，conformance 复绿 |

---

## 收口 · 最终产物路径与门禁（task-14 关闭）

**三份产物（可复跑，均为 exit 0；已按 N6 改名后重生成）**

| 类别 | 脚本 | 机器可读结果 | 人读日志 |
|---|---|---|---|
| conformance 摘要 | `plugins/dsh-l0-control/tests/e2e/conformance.mjs` | `tests/e2e/artifacts/conformance.json` | `tests/e2e/artifacts/conformance.txt` |
| native 全链 | `plugins/dsh-l0-control/tests/e2e/native-chain.mjs` | `tests/e2e/artifacts/native-chain.json` | `tests/e2e/artifacts/native-chain.txt` |
| oracle 差分 | `plugins/dsh-l0-control/tests/e2e/oracle-diff.mjs` | `tests/e2e/artifacts/oracle-diff.json` | `tests/e2e/artifacts/oracle-diff.txt` |

**R8 改名适配要点（N6）**
- 工具面 **9 → 14**：`wish_submit, graph_status, task_next, task_claim, evidence_submit, verify_done, decision_record, pass_gate, team_status, agent_spawn, agent_message, board_task_create, board_task_update, graph_export`
- 回归根因：`lib/ux-contract.mjs` 的 `ALLOWED_COMMANDS` 仍把 `/export` 映射到旧名 `export`，`validateToolSurface` 校验"目标工具必须在工具面内"→ 找不到 → **U3- 失败** → 两个 mock 场景连带 FAILED。
- 修法：白名单改 `/export→graph_export`、`/decide→decision_record`，并补 `/team→team_status`。**服务方法名未变**（`svc.decide` / `svc.exportProjection` 保持），所以 `run.mjs` / `native-chain.mjs` 的调用无需改动。

支撑脚本（同目录）：
- `run.mjs`（mock 双场景 + native 分支 + U1/U3 UX 契约 + T1–T4 投影 + G5 mock 形状）
- `state-g5.mjs`（G5 真实 `lib/state`：8 条）
- `scenarios/crud_wish.json`、`scenarios/failure_replan.json`（夹具）
- `lib/ux-contract.mjs`（U1 prompt / U3 命令白名单唯一实现；工具改名只需改这里）

**复跑命令（任一条独立可跑）**
```
node plugins/dsh-l0-control/tests/e2e/conformance.mjs      # 7 项聚合，期望 state=pass exit=0
node plugins/dsh-l0-control/tests/e2e/native-chain.mjs     # 全链 6/6，期望 exit=0
node plugins/dsh-l0-control/tests/e2e/oracle-diff.mjs      # diff=0，期望 exit=0
node plugins/dsh-l0-control/tests/e2e/run.mjs --scenario crud_wish --port mock        # 35/35
node plugins/dsh-l0-control/tests/e2e/run.mjs --scenario failure_replan --port mock   # 23/23
node plugins/dsh-l0-control/tests/e2e/state-g5.mjs         # G5 真实 8/8
```

**最终判定（2026-10-29，R8 改名后复跑）**：conformance **7/7 PASS**（adapter **tools=14 / grades self-built 8 · native 3 · projection 3** ｜ crud_wish **35/35** ｜ failure_replan **23/23** ｜ g5 真实 **8/8** ｜ native:branch **15/15** ｜ native:chain **6/6 节点** ｜ oracle:diff **0**），**state=pass exit=0**。

**验收对照**：全链无人工中继 ✅｜同职务实例不串 ✅（A2×4）｜审计独立 ✅（A3×4 + native 分离）｜失败可 replan ✅（R1–R5）｜U1/U3 UX 契约 ✅｜G5 恢复 ✅｜oracle 四项差分 0 ✅

**待命**：Lane E/N5 转入待命；M10 总验收需要复跑时，直接跑上表命令即可（无需重新准备夹具）。

---

## R7 · native 全链跑通 + oracle 差分 = 0（收口达成）

**全链结果（`native-chain.mjs`，隔离 workspace）**：6/6 节点全 done，**exit 0**

| 阶段 | 结果 |
|---|---|
| research | `NODE-RESEARCH`：evidence → `pass_gate(passed)` → `verify_done(done)` |
| design | `NODE-PRD`、`NODE-CONTRACT` 同上 |
| build | `NODE-BUILD` 同上 |
| audit | `NODE-AUDIT` 同上（auditor=`ROLE-AUDIT_EVIDENCE-01` ≠ producer） |
| deliver | `NODE-DELIVER` 同上 |
| C0/C1/C7/C8/C9 | `pass_gate` 就位 ✅｜wish 6 节点 ✅｜decide ✅｜export ✅｜全链 6/6 ✅ |

**本轮修掉的三处（都是契约语义，不是脚本问题）**
1. **`acceptance` 必须显式**：不带 acceptance 且无 verdict 时，插件现返回 `acceptance-required`（此前 core 默认 pass，违反 unknown≠pass）。e2e 断言改为显式 `{kind:'exists'}`，并新增 **N15** 反向用例验证"缺判据必须被拒"。
2. **verifier 必须取节点允许清单**：wish 模板 `verifierIds=["verifier-ci"]`，用别的 verifier 会 `credential-unavailable`。这是 `credential-unavailable` 的真实原因（不是闸门）。
3. **链驱动改为 ready 集驱动**：原按 stage 分桶会盲 claim 未就绪节点（`lease_error`）；改成 `task_next → claim → evidence → pass_gate(stage) → verify_done` 循环，依赖序由 core 保证。

**别名归一化（N2 已修，已转为正向断言）**
- `producer_instance` / `producerInstance` 单写均识别（**N12 PASS**）
- `decide.options[].option_id` / `optionId` 单写均识别（**N12b PASS**）
- 我先前的两条"契约瑕疵"SKIP 已升级为 PASS 断言。

**native 分支**：15/15 PASS，exit 0（含 N15 acceptance 守卫、N16 闸门、N11 done）。

**Python oracle 四项差分（`oracle-diff.mjs`）：diff = 0，exit 0**

| 项 | Python oracle | TS 插件 | 一致 |
|---|---|---|---|
| done 无证据拒绝 | true | true | ✅ |
| done 有证据接受 | true | true | ✅ |
| ready 初始集合（语义：恰 1 个根） | 1 | 1 | ✅ |
| 审计独立（同实例→违规） | true | true | ✅ |
| graph_version replan 递增 | +1 | （native 侧由 mock/chain 覆盖） | ✅ |

**conformance 合计（7 项全 PASS，exit 0）**
adapter（10 工具 / grades 8-1-1）｜crud_wish 35/35｜failure_replan 23/23｜G5 真实 8/8｜**native:branch 15/15**｜**native:chain 6/6**｜**oracle:diff 0** → **state=pass**

**验收对照（task-14）**
- 全链路无人工中继：mock A1 ✅（native 侧 actor 恒为 plugin/agent）
- 2 个同职务实例不串：mock A2×4 ✅
- 审计独立：mock A3×4 + native auditor 分离 ✅
- 失败可 replan：mock R1–R5 ✅
- 每轮 send_message 并写 lane note ✅

**建议**：task-14 可 complete（native 全链 + oracle diff 0 + conformance 全绿）。

---

## R7（预备）· native 全链驱动已就位，只差 `pass_gate`

**产出**：`tests/e2e/native-chain.mjs`（隔离 workspace，跑完即删），按 Lead 指定顺序：
`wish_submit → 每阶段 pass_gate(stage,[evidenceId]) → task_next → claim → evidence_submit → verify_done → decide → export`

**当前实测（N2 尚未暴露 `pass_gate`，surface 仍 9 工具）**

| 步骤 | 结果 |
|---|---|
| C0 `pass_gate` 暴露 | **SKIP** — 仍 9 工具 |
| C1 `wish_submit` | PASS — 6 节点，ready=`NODE-RESEARCH` |
| research 阶段 claim + evidence | PASS — `EVD-NODE-RESEARCH-1-*` |
| research 阶段 gate | **阻塞 `gate-unavailable`**（不伪造通过、不越级） |
| C7 `decide` / C8 `export` | PASS |
| C9 全链完成 | SKIP（被闸门阻塞，**未折算**） |

→ **native:chain = drift, exit 1**；`native:branch` 同 drift。conformance 合计 **drift, exit 1**（adapter / 两场景 mock / G5 全 PASS）。

**设计取向**：闸门缺失时**不伪造** `pass_gate`、不越级推进——"跳过闸门"正是协议禁止的边（检验不可绕过），所以链停在 research 并如实报 drift。

**N2 落地后**：只要 `svc.passGate` 或 `pass_gate` 可用，跑同一条命令即可 → 预期 native drift→pass；随后补 Python oracle 四项差分。

**预算**：6/6 已用尽；本轮为 R7 预备（脚本已就位，不新增预算）。

---

## R6 · native 链路推进到 evidence/decide/export（已完成；验证闸门仍缺桥接）

**本轮 native 结果（隔离临时 workspace，跑完即删，不污染插件状态）**

| 断言 | 结果 |
|---|---|
| N1 `graph_status` 走 core | PASS |
| **N2 `wish_submit`** | **PASS** — 6 节点（research→PRD→contract→build→audit→deliver），`ready=[NODE-RESEARCH]`，version=1 |
| N3 `task_next` | PASS — `ready=["NODE-RESEARCH"]` |
| **N8 `task_claim`** | **PASS** — `fencing=1`、节点 `status=claimed` |
| N9 同节点被他人再认领 | PASS（guard）— `lease_held` |
| **N10 `evidence_submit`** | **PASS** — 节点 `→ submitted`，产物 sha 落账 |
| N11 `verify_done` | **SKIP** — `credential-unavailable`：**阶段闸门未桥接**（surface 9 工具无 `passGate`；`stages` 在 core 但未暴露） |
| N7 `decide` 创建 L0 | **PASS** — `status=auto`（`options[].option_id` 必须 snake） |
| N13 L2 缺 `defaultOptionId/timeoutSec` | PASS（guard）— `decision-params-required` |
| N14 `export` 投影 | **PASS** — 2 个文件 |
| N6 G5 真实 `lib/state` | PASS（8/8） |
| N12 / N12b | SKIP（契约瑕疵，见下） |

→ **native：10 pass / 3 skip → drift，exit 1**。差一步：`passGate` 未暴露 → `verify_done` 无法过闸门 → 全链不报 pass（符合"不折算"）。

**两个必须修的契约瑕疵（同一类：camel/snake 不一致）**
1. **`producer_instance`**：只传 snake → `producer-instance-required`；只传 camel → `producer-unknown`；**两种都传才过**。
2. **`decide.options[].option_id`**：用 camel `optionId` 会被误判"options 至少两项且 option_id 唯一"。
   → 建议 N2 在工具层做**双向归一化**（`optionId↔option_id`、`producerInstance↔producer_instance`、`auditorInstance↔auditor_instance`），否则模型按工具 schema 传参必踩坑。

**conformance 摘要**：adapter PASS｜A7 四态 PASS｜`crud_wish` 35/35 PASS｜`failure_replan` 23/23 PASS｜G5 8/8 PASS｜**native DRIFT** → **合计 drift，exit 1**。

**R7（若有余量）**：`passGate` 一暴露就跑完整链（每阶段 passGate → claim → evidence → verify_done → done），目标 native drift→pass；再补 Python oracle 四项差分。

---

## R5 · UX 契约 + conformance 摘要（已完成）

**① U1 prompt 注入（U1 / U1-）**
- 契约实现：`tests/e2e/lib/ux-contract.mjs`（唯一实现，`run.mjs` 直接 import）
- `buildPromptSection` 只产出五类指针：`node / role / stage / 证据 / 预算`
- 校验项：指针齐全、≤200 字符、≤2 行、单行 ≤160、**出现正文标记（`BEGIN`/```` ``` ````/`diff --git`/`PRD 正文`）即失败**
- 结果：正例 62 字符 PASS；反例（贴正文）被正确判失败（`超长 217>200；行数 3>2`）

**② U3 命令白名单（U3 / U3-）**
- 允许：`/wish→wish_submit`、`/status→graph_status`、`/next→task_next`、`/export→export`（全是"读/发起"类）
- 禁止形态：`/done`、`/set_status`、`/force*`、`/skip-evidence`、`/accept`（会绕过证据事务）
- 工具面校验：`lib/capabilities.js` 的 9 个工具**不含**任何 `set_status / force-done / skip-evidence` 形态
- 结果：`/status` 允许、`/force-done` 与 `/set_status` 均 `forbidden-pattern`；工具面 PASS

**③ conformance 摘要（U4）：`tests/e2e/conformance.mjs`**
一份机器可读摘要，把四处结果合成一个判定：

| 子项 | 结果 |
|---|---|
| adapter（8 工具 / grades `self-built 7 / native 1 / projection 1`） | PASS |
| A7 四态 `pass/drift/failed/unknown = 0/1/2/3` | PASS |
| e2e `crud_wish` | PASS（35/35） |
| e2e `failure_replan` | PASS（19/19） |
| G5 真实 `lib/state` | PASS（8/8） |
| native 分支 | DRIFT（`wish_submit` 仍 `core-not-implemented`） |
| **合计** | **state=drift, exit=1**（正确：链路未通不冒充 pass） |

**④ native 分支断言升级（N3-R3 落地后）**

| 断言 | 结果 |
|---|---|
| N1 `graph_status` 走 core | PASS |
| N2 `wish_submit` | SKIP（`core-not-implemented`，等 N3-R4） |
| N3 `task_next` | PASS |
| N4 `evidence_submit`（带 `producer_instance`） | **PASS — 分支已接线**（core 码 `node-not-found`） |
| N5 `verify_done`（带 `producer_instance`/`auditor_instance`） | **PASS — 分支已接线**（core 码 `node-not-found`） |
| N7 `decide` | **PASS — 分支已接线**（`decision_error：决策不存在`，说明 core.decide 语义是**更新既有决策**而非创建） |
| N6 G5 真实实现 | PASS（8/8） |

→ native 整体 **6 pass / 1 skip → drift, exit 1**。按 Lead 口径：`producer-unknown`/`auditor-required` 这类属**守卫生效的正面证据（guard-pass）**，但 happy path 未通，一律不折算。

**回归**：mock `crud_wish` **35/35**（新增 U1/U1-/U3/U3-）、`failure_replan` **19/19**，均 exit 0。

**R6 入口**：等 `wish_submit` 的 N3-R4 信号后跑**全链路 native**（wish → 图 → 认领 → 证据 → done），并把 G5 的 `SIGKILL` 场景接进 conformance；同时做 Python oracle 差分（done 接受/拒绝、ready 集合、审计独立、graph_version 递增）。

---

## R4 · native 端口联调 + G5 切真实实现（已完成）

**① native 端口跑通（`--port native`）**

| 断言 | 结果 |
|---|---|
| **N1** `graph_status` 走 core（`graph.result.ok === true`） | **PASS** — `version=1 nodes=0 journalSeq=0`（不再是 core-unavailable） |
| **N2** `wish_submit` 建图 | **SKIP** — `core-not-implemented`（hint：core.submitWish 在 N3-R4），**未折算 pass** |
| **N3** `task_next` 可用 | **PASS** |
| **N4** `evidence_submit` | **PASS（fail-closed 语义）** — 码 `producer-unknown`；断言的是"缺 live caller 时必须拒绝且码正确"，happy path 仍标未验 |
| **N5** `verify_done` | **PASS（fail-closed 语义）** — 码 `auditor-required`，同理 |
| **N6** G5 跑真实 `lib/state/recovery.js` | **PASS** — 8/8 |

整体：**state=drift（5 pass / 1 skip），exit 1**——因为 `wish_submit` 未实现，链路未能真跑通，**不报 pass**。

**② G5 已从 mock 切到真实实现**：新增 `tests/e2e/state-g5.mjs`，直接调用 N4 的 `Journal.open/append/verifyChain`、`recoverWithJournal`、`buildSnapshot/updateSnapshot/checkAnchor`、`StateError.code`。

| 断言 | 结果 |
|---|---|
| G5R-1 记录形状（seq +1 / eventId / prevHash） | PASS |
| G5R-2 `verifyChain` 通过 | PASS |
| G5R-3 无快照 → journal bootstrap（`source=journal+bootstrap`） | PASS |
| G5R-4 有快照 → 快路径（`source=snapshot+replay`） | PASS |
| G5R-5 锚按前缀比较（`journal-ahead`） | PASS |
| G5R-6 快照超前 → `STATE_SNAPSHOT_AHEAD` | PASS |
| G5R-7 journal 篡改 → `STATE_HASH_BREAK` | PASS |
| G5R-8 `fold(records)` 与 recover 同 revision | PASS |

**踩到并记录的两个真实约束**（对 N4 有用，非缺陷）：
1. 造"快照超前"用例时，只改 `meta.seq` 会在 `verifySnapshot` 处先被判 `STATE_DIVERGED`；**必须先重算 `meta.stateSha256`** 才能走到 `SNAPSHOT_AHEAD` 分支——说明"快照自校验 → 锚 → 超前"的判定顺序是有效的。
2. `Journal.open(stealIfStale:true)` 每次会追加 `writer_taken_over`，所以"journal 前进后旧锚仍有效"必须用**打开前的记录快照**比前缀，否则会误判为 diverged。

**回归**：mock 两场景仍 **31/31、19/19，exit 0**（native 改动未污染 mock）。

**下一轮（R5）入口**：UX 面 —— U1 prompt 注入断言（section 只放指针/摘要）、U3 命令白名单（命令不得推进状态）；顺带把三份摘要（adapter 8 项 / A7 四态 / e2e 结果）合成一份机器可读 conformance 摘要。

---

## R3 · A3 推导 + N4 形状 + G5 恢复（已完成）

**本轮三件事（按 Lead 指令）**

1. **A3 改为推导，不再注入 auditor**：`verifyDone` 现在从**全部 pass 证据**里解析 `verifier_id → {role, instanceId}`：
   - 无注册 → `AUDITOR_REQUIRED`（fail-closed）
   - 有注册但角色不以 `AUDIT` 开头 → `NOT_AN_AUDITOR_ROLE`
   - 审计实例 == 证据提交者/节点 assignee → `AUDIT_NOT_INDEPENDENT`
   → 与 N2 将补的 `producer_instance/auditor_instance` 可选参数兼容：有则用、无则推导。
2. **journal / 折叠 / 快照改为 N4 稳定形状**：`JournalRecord{seq,eventId,ts,kind,nodeId,payload,prevHash,hash}`、`StateDoc{revision,graphRevision,nodes}`、`SnapshotMeta` 三元锚（`journalBytes/journalHash` 比**前缀**）、错误码 `STATE_HASH_BREAK/SEQ_GAP/CORRUPT/SNAPSHOT_AHEAD/DIVERGED`。
3. **G5 恢复断言落地（不再 SKIP）**：6 条 —— 重放==状态、记录形状（seq 严格 +1、`EVT-%06d`、prevHash 链、hash 64 位）、三元锚自洽、锚前缀比较（journal 前进后旧快照仍有效）、四类篡改码全部命中、稳定点截断可重建。

**跑通结果**

| 场景 | 断言 | 结果 |
|---|---|---|
| `crud_wish` | 10 节点全链路 + A1 + A2×4 + A3-0..3 + U2 + T1–T4 + G5-1..6 | **31/31 PASS，exit 0** |
| `failure_replan` | R1/R2/R2b/R3/R5 + 3 节点局部重做 + U2 + T1–T4 + G5 | **19/19 PASS，exit 0** |
| `--port native` | core 仍 `core-unavailable` | **unknown，exit 3** |

关键明细：`A3-1 AUDIT_NOT_INDEPENDENT`（由 verifier 注册实例=生产者推出，未注入）、`A3-2 AUDITOR_REQUIRED`、`A2-4` kill 后 `P6 done@#21` 不变 / `P2→ready`、`G5-5` 四码全命中、`G5-4` `prefixSeq=55 / journalSeq=56` 仍有效。

**一处诚实偏差**：G5 是在 **mock 的 N4 形状**上验的（`run.mjs` 内自带 fold/snapshot/detect 实现），**不是**直接调用 N4 的 `recovery.ts`。原因：core 未就绪、`lib/state/*` 无稳定导出面给 e2e 单独调用。→ **R4 若 core 就绪，优先把 G5 切到真实 `lib/state/recovery.js`**，否则保留"同形状双实现"并在此注明（不假装是同一份实现验过）。

**下一轮（R4）入口**
1. core 一就绪 → `--port native` 跑 `wish_submit → graph_status`，G5 切真实 `recovery.js`；
2. UX 面：U1 prompt 注入断言（section 只放指针/摘要）、U3 命令白名单（命令不得推进状态）。

---

## R2 · mock 端口 runner 跑通（已完成）

**产出**：`tests/e2e/run.mjs`（约 600 行，纯 ESM 无依赖）+ `port.ts` 按三条裁决收敛 + `tests/e2e/README.md` 增「投影契约 / 真实面映射」两节。

**三条裁决的落地**
1. **v1 单图**：`port.ts` 所有动作去掉 `graphId`，改实例级。
2. **actor 从 journal 读**：动作签名不带 actor；`JournalPort.append(actor, kind, refs)` 承载，A1 断言只读 journal。
3. **`exportProjection` 主名 + `export` 别名**：两者都实现并测。

**跑通结果（可复现）**

| 场景 | 断言 | 结果 |
|---|---|---|
| `crud_wish` | 10 节点全链路 + A1 + A2×4 + A3×3 + U2 + T1–T4 | **24/24 PASS，exit 0** |
| `failure_replan` | R1/R2/R2b/R3/R5 + 3 节点局部重做 + U2 + T1–T4 | **13/13 PASS，exit 0** |
| `crud_wish --port native` | core 仍 `core-unavailable` | **unknown，exit 3**（符合 fail-closed，**未**折算 pass） |

退出码语义已按 A7 四态落地：0 pass / 1 drift（有 SKIP）/ 2 failed / 3 unknown。

**team_status 投影断言（Lead 指定）**
- 实测形状：`tasks[]` = `id / revision / subject / status / ownerName / ready / blockedBy`；`members[]` 另有 `context / diagnostics / provider / model`。
- **契约只锁 6 个标量**（`id/revision/subject/status/ownerName/ready`）；`blockedBy` 列容忍字段、必须是数组；`context`/`diagnostics` **显式排除**，出现即 fail（T2）。
- 另有 T3 断言"投影是只读派生视图"：读投影不改图、行数=节点数、状态可取——防止投影被写成第二事实源。

**本轮发现的真实面差异（R3 必处理）**
- `evidence_submit(nodeId, artifactPath, verifier, acceptance)` **不传** `producer_instance` / `verdict`；
- `verify_done(nodeId, acceptance)` **没有** auditor 参数。
→ 真实面上 A3 的取数是 `producer_instance`（证据提交者）× `verifier_id → role`（注册表角色），不是"传 auditor"。mock 暂留注入以便单测被拒路径，R3 改按 verifier-role 推导。

**跳过（如实记录，未折算）**：G5（journal 快照/恢复）仍无信号 → 恢复类断言未跑，R3 若 N4 给出 journal 形状再补，届时按 `SKIP` 计并让退出码落到 drift(1)。

**下一轮（R3）入口**
1. 若 N3 给出 core（`graph_status` 不再 `core-unavailable`）：切 `--port native` 真联调，先跑 `wish_submit → graph_status`，差异逐条记；
2. 无论 core 是否就绪：把 A3 的取数从 "auditor 注入" 改为 "verifier-role 推导"，让断言在真实面上同步成立；
3. 若 N4 给 journal 形状：补恢复类断言（否则保持 SKIP + drift）。
