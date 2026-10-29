# Lane N6 · 真实 DSH Agent 团队执行

> 任务板：task-16（预算 12 轮）
> 写域：`plugins/dsh-l0-control/src/native/`（新）、`plugins/dsh-l0-control/tests/e2e/native-real/`（新）、本文件

---

## R1 · 原生执行层 + 真实 3 实例 e2e · 2026-10-29

### 新增

| 文件 | 内容 |
|---|---|
| `src/native/team.ts` | `NativeTeam`：`spawnAgent`（`subagents.startActivation`，parent=caller、带 `maxDepth`）、`sendMessage`（`subagents.sendMessage`）、`createTeamTask` / `updateTeamTask`（`agentTeams.createTask/updateTask`）；实例表 `instanceId ↔ childSessionId`，可从 journal 的 `agent_spawned` 行回放 |
| `src/service.ts` | 4 个方法 + `nativeStatus()`；`spawnAgent/sendMessage/createTeamTask/updateTeamTask` 每次调用落审计行（`agent_spawned / agent_message_sent / team_task_created / team_task_updated`）；`team_status` 增 `nativeInstanceCount` + `nativeInstances` |
| `src/tools.ts` | 4 个新工具（见下表）；工具总数 10 → 14 |
| `src/config.ts` | `nativeProvider`（默认 `spawn`）、`nativeMaxDepth`（默认 2） |
| `tests/e2e/native-real/` | `run-20261029T1407Z.json`（真实执行记录）、`check.mjs`（8 条断言）、`README.md` |

### 工具命名：**必须避让宿主同名工具**

实测两次踩坑：注册 `send_message` 后调用直接命中宿主 Team 通信工具（报 `missing required property "target"`），
注册 `team_task_create` 后调用返回宿主 `TeamTaskView` 原对象而不是本插件的投影包装。宿主同名工具优先，插件侧工具被遮蔽。

| 本插件工具 | 宿主已有同名 | 处理 |
|---|---|---|
| `agent_spawn` | `spawn_agent` | 改名 |
| `agent_message` | `send_message` | 改名 |
| `board_task_create` / `board_task_update` | `team_task_create/update` | 改名 |
| `graph_export` | `export` | 改名 |
| `decision_record` | `decide` | 改名 |

其余保持原名：`wish_submit / graph_status / task_next / task_claim / evidence_submit / verify_done / pass_gate / team_status`。

### 真实执行（不是模拟）

| 步骤 | 证据 |
|---|---|
| `agent_spawn` ×3 | `ROLE-CODE-01 → a7b9ad87…`、`ROLE-CODE-02 → fe35cdfa…`、`ROLE-AUDIT_CODE-01 → 4f7a1b1d…`；三者 `sessionId` 互不相同 |
| 真实回执 | `ROLE-CODE-01` 回 **`CODE-01 ECHO`** —— 对应 `agent_message` 的 followup（初始任务回的是 `CODE-01 READY`），证明消息投递到正确实例 |
| `task_claim` | `NODE-RESEARCH` 被 `ROLE-CODE-01` 领取，`fencing_token=1`，状态 `claimed` |
| `evidence_submit` | `EVD-NODE-RESEARCH-1-f0aafc94`、`sha256=f0aafc94…`、`verdict=pass`、`advancedFrom=claimed → submitted` |
| `verify_done` | 审计 `ROLE-AUDIT_CODE-01`（producer `ROLE-CODE-01`）→ `status=done`、`promoted=[NODE-PRD]`、`revision 27` |
| 投影 | `board_task_create` → `task-18`（`nodeId=NODE-RESEARCH`，rev1）→ claim（rev2）→ complete（rev3）；`team_status` 里 `task-18 completed`，与图 `done` 同源 |
| `team_status` | `nativeInstanceCount=3`，`nativeInstances` 三条（role / sessionId / mode=activation） |

### e2e 断言

`node tests/e2e/native-real/check.mjs` → **8/8**：
实例 ID/sessionId 唯一、2 CODE + 1 AUDIT_CODE、回执对应 followup、producer≠auditor、auditor 职务属审计职务、
证据只带 producer（审计在 verify 阶段）、状态链 `claimed→submitted→done`、投影 `nodeId` 与图终态一致。
退出码：`0` / `1` / `3`（记录不可读 → fail-closed）。

### 其它套件

`selftest 15/15`（新增「native: 缺 caller 一律 fail-closed」4 条断言）、`contract 19/0`、`persistence 6/6`。

### 已知限制 / 移交

- `agentTeams.spawnTeammate` 需要 **Lead** 身份；本轮用已证可用的 `subagents.startActivation`（parent=caller），未硬碰权限；
- `board_task_*` 的 owner 目前是 caller（`dsh-adapter`）；如需登记成 `ROLE-CODE-01`，用 `action=reassign` + `owner`；
- 子 Agent 是被动的（收到 `agent_message` 才动），控制面若要"等回执"需要 `sessionController.inspect` 轮询（N2 的 `awaitOutput` 已在 adapter 层实现，可平移到本插件）。

**预算**：R1（12 轮内）。**阻塞**：无。

---

## R2 · 等回执 + 两节点真实链 + 投影约束 · 2026-10-29

### 1) `awaitOutput` 平移到 native 层

`NativeTeam.sendMessage(..., {awaitOutput, timeoutMs})`：
先 `sessionController.inspect` 取 baselineSeq → `subagents.sendMessage` → 轮询 inspect 到 `turn/end`，
回收 assistant 文本；`usage` 走 adapter 的实例累计（`ctx.get('l0adapter').report()`）。

**实跑**
| 实例 | baselineSeq | turn/end | 文本 | 收敛 |
|---|---|---|---|---|
| ROLE-CODE-01 | 33 | seq 45 / completed | `CODE-01 R2` | ✅ |
| ROLE-CODE-02 | 22 | seq 34 / completed | `PRD-DRAFT-OK` | ✅ |

`agent_message{awaitOutput:true}` 现在返回 `{messageId, baselineSeq, output{settled,turnEnd,text,lastSeq,timedOut}, usage}`，
审计行同时记 `settled / turnEndReason / replyText`。

### 2) 投影 owner：**遇到真实权限边界**

`agentTeams.updateTask` 的 `reassign` **只有 Team Lead 能调**（teammate 侧实测被拒）：
- `board_task_create{ownerInstance:ROLE-CODE-02}` → 建任务成功，但再解析 `reassigned:{ok:false, error:'only the Team Lead can reassign tasks'}`；
- 因此投影 owner 暂时是 caller（`dsh-adapter`），**与图 assignee 不同源**；
- 另外：**未 claim 的投影任务不能 complete**（`TEAM_TASK_UNAUTHORIZED: task mutation requires its owner or Team Lead`），
  正确流程是 `create → claim → complete`（本轮已按此走通）。

结论：owner 同源要么由 **Lead 侧**调 reassign（N5 有 Lead 入口），要么接受"投影 owner=协调者"。
工具侧保留 `ownerInstance` 参数并**把拒绝如实回传**（不假装成功），check.mjs 有断言盯这条。

### 3) 两节点真实链（NODE-RESEARCH + NODE-PRD）

| 节点 | claim | evidence | done | 投影 |
|---|---|---|---|---|
| NODE-RESEARCH | ROLE-CODE-01（token 1） | `EVD-NODE-RESEARCH-1-f0aafc94` pass → submitted | producer CODE-01 / auditor AUDIT_CODE-01，解锁 NODE-PRD | task-18 rev3 completed |
| NODE-PRD | ROLE-CODE-02（token 1） | `EVD-NODE-PRD-1-f0aafc94` pass → submitted | producer CODE-02 / auditor AUDIT_CODE-01，解锁 NODE-CONTRACT | task-19 rev3 completed |

闸门：`research=passed`、`design=passed`；core 持久化 `revision 39`。

### 4) e2e 断言

`node tests/e2e/native-real/check.mjs`（缺省取最新 run）→ **11/11**：
实例唯一 + 2 CODE/1 AUDIT、awaitOutput 收敛且回执与记录一致（无串号）、每节点 producer≠auditor、
auditor 职务合法、状态链 `claimed→submitted→done`、证据 producer 与 claim owner 一致、
两节点 producer 不同、投影与图逐节点同源、**reassign 被拒必须显式记录**。

其它套件：`selftest 15/15`、`contract 19/0`、`persistence 6/6`。

### 已知限制（移交）

- `awaitOutput` 默认 120s 超时；长时间任务的回执需调用方传 `timeoutMs` 或改用 follow 流；
- 真跑消耗真实子 Agent 轮次（本轮 2 次 agent_message 等回执）；
- 投影 owner 同源依赖 Lead 权限（见上）。

**预算**：R1–R2。

---

## R3 · 六节点全链真实跑通 · 2026-10-29

**ready 集驱动**：`task_next` → 逐个 ready 节点 `task_claim → evidence_submit → verify_done`（配 `pass_gate`）+ `board_task_*` 投影。

| 节点 | 阶段 | claim（producer） | evidence | auditor | 结果 |
|---|---|---|---|---|---|
| NODE-RESEARCH | research | ROLE-CODE-01 | `EVD-NODE-RESEARCH-1-f0aafc94` | AUDIT_CODE-01 | done → 解锁 PRD |
| NODE-PRD | design | ROLE-CODE-02 | `EVD-NODE-PRD-1-f0aafc94` | AUDIT_CODE-01 | done → 解锁 CONTRACT |
| NODE-CONTRACT | design | ROLE-CODE-01 | `EVD-NODE-CONTRACT-1-dc5d4ed1` | AUDIT_CODE-01 | done → 解锁 BUILD |
| NODE-BUILD | build | ROLE-CODE-02 | `EVD-NODE-BUILD-1-562ebab1` | AUDIT_CODE-01 | done → 解锁 AUDIT |
| NODE-AUDIT | audit | ROLE-AUDIT_CODE-01 | `EVD-NODE-AUDIT-1-4070ca59` | **ROLE-AUDIT_CODE-02**（交叉复核） | done → 解锁 DELIVER |
| NODE-DELIVER | deliver | ROLE-CODE-01 | `EVD-NODE-DELIVER-1-76c85775` | AUDIT_CODE-01 | done（终态） |

- `graph_status`：`counts {nodes:6, edges:5, done:6, blocked:0}`、`ready:[]`；五段闸门 `research/design/build/audit/deliver` 全 passed；
- 投影：每节点一条 TeamTask（task-18…task-23），逐个 `create → claim → complete`（rev1→3），`nodeId` 与图一一对应；
- evidence 全部 `acceptance:{kind:'exists'}` + `verifier:'verifier-ci'`（节点 `verifierIds` 允许清单）。

**实例**：`ROLE-CODE-01/02` + `ROLE-AUDIT_CODE-01/02`。
审计节点自身必须有**两个不同审计实例**（producer AUDIT-01、auditor AUDIT-02），否则被审计独立门禁拒；
这是"2 CODE + 1 AUDIT"在 6 节点图下唯一需放宽处，本轮按事实扩到 **2 CODE + 2 AUDIT**。

**e2e 断言**：`node tests/e2e/native-real/check.mjs`（自动取最新 `run-20261029T1415Z.json`）→ **13/13**：
实例唯一、≥2 CODE 且审计节点有 ≥2 审计实例、awaitOutput 收敛且回执无串号、每节点 producer≠auditor、
auditor 职务合法、状态链 `claimed→submitted→done`、证据归属与 claim owner 一致、CODE 节点由两个 CODE 实例分担、
逐节点投影同源、reassign 被拒显式记录、**六节点全 done + ready 空**、**五段闸门全 passed**。

### 如实记录的限制

1. **投影 owner 未同源**：`reassign` 仅 Team Lead 可用（teammate 被拒），投影 owner 仍是 caller（`dsh-adapter`）；
   工具保留 `ownerInstance` 并如实回传拒绝。
2. **node 模式持久化在 R3 中途停住**：`records` 停在 39（调用返回 `persistence:null`）。根因：`restoreCore` 后
   core seq 与 N4 `store.revision` 基准相差 12（恢复 27 条、N4 已有 39 条），`persistCoreEvents` 的
   `seq === revision+1+i` 断言不成立 → 需 N3/N4 对齐"恢复后 seq 基准"。内存图不受影响，但**重载会退回 revision 39 快照**。
3. 审计节点扩了第二个审计实例（见上）。

**预算**：R1–R3（12 轮内）。task-16 = complete（MVP：真实 6 节点全链，限制已记录）。

---

## R4 · 接 N4 `appendFromSeq` 游标口径 · 2026-10-29

### 改动（`src/persistence.ts`）

- `open`：改用 **async `restoreCoreJournal(store, core.journal, {adoptCursor:true, cursorName:'core'})`**
  → `{restored, coreSeq, revisionBefore, revision, cursor, adopted}`，再 `rehydrate(core)` 折 state；
  `persistedSeq` 以 N4 游标为基准，不再用 `core.journal.count()` 硬猜。
- `persist()`：基准取 `store.cursorOf('core')?.coreSeq`（回退本地），调
  `persistCoreEvents(store, events, {baseSeq, cursorName:'core'})` → `{baseSeq, baseRevision, appended, revisionAfter, cursorAfter}`；
  返回 `{appended, revision, cursor, baseRevision, adopted}`。
- `snapshot()` 增 `coreCursor` / `adopted`。

### 数字

| 门禁 | 结果 |
|---|---|
| `persistence-check`（**扩成 6 节点全链 + 重载**，node 模式） | **8/8** |
| `selftest` | 15/15 |
| `contract` | 19 / 0 failed |
| `native-real check`（6 节点真实链记录） | 13/13 |

`persistence-check` 8 条：全链六步齐、每步真落盘（appended>0 且 revision 单调）、gen1 `counts {6,5,6,0}`、
fingerprint 前后一致、gen2 `counts {6,5,6,0}`、`replay==snapshot`（replayed=6）、五段闸门恢复、
`coreCursor === cursorOf('core').coreSeq`。

### 真宿主 node 模式复测

- 重开后 `restored:39 / coreCursor:39 / adopted:true`、`restoredCounts {nodes:6, edges:5, evidence:2, gates:2}`；
- 逐节点 CONTRACT→BUILD→AUDIT→DELIVER **每次都落盘**：
  `claim appended:3 rev45 cursor42` → `gate +1 rev47` → `evidence +3 rev51` → `verify +5 rev59` → … → `AUDIT verify +5 rev89 cursor75`；
- 图状态 `counts {6,5,6,0}`、五段闸门全 passed。**持久化不再整体停摆**（此前每次调用都 `persistence:null`）。

### 残留问题（如实记录）

真宿主**最后两步**（DELIVER 的 `evidence_submit` / `verify_done`）仍返回 `persistence:null`：
N4 `coreCursor` 停 **78**（core 已 84 事件）、revision 93，DELIVER 在 N4 投影里还是 `claimed`。
即"恢复后基准错位"已从"整体停摆"缩到"末两步复发"，怀疑 ready-promotion 钩子在这两步插入了非连续 seq →
`STATE_SEQ_GAP`（错误被吞，未见 code）。临时目录的 8/8 全链+重载不受影响；真宿主重载后会显示 `done=5`。
下一步：把 persist 的 `error.code/message` 透出到 `graph_status.persistence.error` 再定位。

---

## R5 · persist 抗乱序 + 错误透出（末两步修复）· 2026-10-29

### 改动（`src/persistence.ts` / `src/service.ts`）

1. **错误透出**：`persist()` 不再吞异常 —— 返回 `{appended, revision, cursor, baseRevision, deferred, error:{code,message}|null}`，
   `service.persist()` 把 `code/message` 记进 `persistenceError`，`graph_status.persistence.error` 直接可见。
2. **抗乱序**：取事件后 `filter(seq > cursor)` + **按 seq 升序排序**，只落**从 `cursor+1` 起的连续前缀**；
   缺口留在下一轮（返回 `deferred>0`）。缺口在队首 → `SEQ_GAP_AT_HEAD`；尾部有缺口 → `SEQ_GAP_TAIL`（都不是静默）。
3. **每次工具调用都 persist**：`spawnAgent / sendMessage / createTeamTask / updateTeamTask / exportProjection`
   也在返回前 `persist()`（此前只有 `withCore` 分支落盘，原生层的尾部事件会漏）。

### 真宿主复测（同一份 workspace 状态）

- 恢复后 DELIVER 仍是 `claimed`（cursor 78），重跑两步：
  `evidence → {appended:3, revision:97, cursor:81, deferred:0, error:null}`、
  `verify   → {appended:3, revision:101, cursor:84, deferred:0, error:null}`；
- **重载后**：`counts {6,5,6,0}`、`ready:[]`、`restored:84`、`restoredCounts {nodes:6, edges:5, evidence:6, gates:5}`、
  `coreCursor:84` == core journal `events:84`、`replayEqualsSnapshot:true`、`diverged:false`、`error:null`、
  `fingerprint f8a19708…`。**done=5 的问题消除**。

> 口径说明：`cursor`（core seq，84）与 `revision`（N4 journal 记录数，101）是不同的计数器 ——
> 前者对齐 core 事件数（84==84），后者含 N4 诊断事件。断言用 `cursor == core.journal.count()`，不用 `cursor==revision`。

### 数字

| 门禁 | 结果 |
|---|---|
| `selftest` | 15/15（构建后重跑） |
| `contract` | 19 / 0 failed |
| `persistence-check`（6 节点全链 + 重载） | 8/8 |
| `native-real check` | 13/13 |

**结论**：末两步 persist 失败已修；`STATE_SEQ_GAP` 未再出现（若出现会以 `error.code` 显式暴露并只落连续前缀）。
N4 无需放宽断言。

---

## R6 · 切到 N4 最终口径（renumber + raw + incomplete/gapAt）· 2026-10-29

### 接线（按 Lead 给的写法，去掉本地过滤/排序）

```ts
// open()
const restoredJournal = await restoreCoreJournal(opened, core.journal);   // renumber 默认 true
rehydrate(core);
// persist()
const outcome = await persistCoreEvents(this.state, this.core.journal.raw(), { cursorName: 'core' });
```

- 本地不再 `filter/sort/切连续前缀` —— 排序、连续前缀、缺口识别都交给 N4；
- `incomplete === true` 时最多再补两轮（每轮推进到下一个缺口）；仍不完整则记
  `PERSIST_INCOMPLETE`（含 `gapAt/remaining`）并由 `graph_status.persistence.error` 透出，**不静默**；
- `snapshot()` 增 `renumbered / incomplete / gapAt`。

### 真宿主 node 模式（同一 workspace 状态）

| 断言 | 实际 |
|---|---|
| `counts {6,5,6,0}`、`ready:[]` | ✅ |
| `restored` | 84（`restoredCounts {nodes:6, edges:5, evidence:6, gates:5}`） |
| `renumbered` | **true**（稀疏 seq 已重编号 = 根因修复生效） |
| `coreCursor` vs core 事件数 | **84 == 84** |
| `incomplete / gapAt / error` | **false / null / null** |
| `replayEqualsSnapshot`、`diverged`、`anchor` | true / false / **in-sync**（snapshot `updated:false`，无需重写） |
| `fingerprint` | `f8a19708…`，与重载前一致 |

> 口径：`cursor`（core seq=84）与 `revision`（N4 journal 记录数=101，含诊断事件）是不同计数器；
> 断言用 `coreCursor == core.journal.count()`（84==84），不是 `cursor==revision`。

### 数字

| 门禁 | 结果 |
|---|---|
| `selftest` | 15/15 |
| `contract` | 19 / 0 failed |
| `persistence-check`（6 节点全链 + 重载） | **8/8** |
| `native-real check` | 13/13 |

**结论**：真宿主末两步持久化 + 重载全绿，`done=5` 问题彻底关闭；N4 无需放宽断言。
投影 owner 同源（Lead-only reassign）仍是唯一已知限制。

---

## R7 · 双路径 spawn/message（Team member ↔ subagent）· 2026-10-29

### 改动（`src/native/team.ts`）

**spawnAgent（双路径）**
- caller 是 **Lead**（`agentTeams.membership(caller).role === 'lead'`）且 `spawnTeammate` 可用 →
  走 `agentTeams.spawnTeammate(caller, {name: role-<role>-<nn>, description, prompt, context:'fresh', provider, signal})`，
  返回 `{via:'spawnTeammate', instanceId, sessionId: member.id, memberName}`，实例表 `mode:'teammate'`；
- 否则（非 Lead / 无 spawnTeammate / spawnTeammate 抛错）→ 回退 `subagents.startActivation(parent=caller, maxDepth)`，
  `mode:'activation'`；spawnTeammate 抛错时把原因放进 `teammateError` 一并返回（不静默）。

**sendMessage（双路径）**
- 目标是 Team member 名（`role-xxx-nn`，经 `listMembers` 命中，或实例记录的 `memberName`）→
  `agentTeams.sendMessage(caller, {target, content, signal})`，`via:'agentTeams.sendMessage'`；
- 否则按实例登记表 → `subagents.sendMessage(caller, sessionId, content)`，`via:'subagents.sendMessage'`。

### 测试

| 套件 | 结果 |
|---|---|
| `selftest` | **16/16**（新增 fake：Lead→spawnTeammate、非 Lead→startActivation、member→agentTeams.sendMessage、非 member→subagents） |
| `contract` | 19 / 0 failed |
| `persistence-check`（6 节点全链 + 重载） | 8/8 |
| `native-real check` | 13/13 |

**真宿主验证**：`agent_message{instanceId:'role-code-01'}` → `via:'agentTeams.sendMessage'`，
`memberName:'role-code-01'`，`messageId:'035f518c…'` —— 原生 Team 通信打通（该 member 是 Lead 侧 spawn 的 `role-code-01`）。

**限制**：我这一侧是 teammate，`spawnTeammate` 只有 Lead 能调，所以 **spawnTeammate 路径由 fake 测试覆盖**
（真实调用需 Lead 侧执行；Lead 已实测 `role-code-01` + `reassign` 成功）。

---

## R8（task-26 / N7b）· 统一身份 `role-<role>-<nn>` · 2026-10-29

用户选 **A（统一身份）**，且 N3 task-25 已让 core 支持小写解析（`parseInstanceId('role-audit-code-01')`
→ `{canonical:'ROLE-AUDIT-CODE-01', role:'AUDIT_CODE', index:1}`）。

### 改动（`src/native/team.ts`）

- `roleInstanceId(role,index)` → **小写** `role-<slug>-<nn>`，角色内 `_` 转 `-`：`AUDIT_CODE → role-audit-code-01`；
- `INSTANCE_RE` 只认小写统一格式；`parseInstanceId` 回读时把 `-` 还原成 `_` 并大写，得到 `AUDIT_CODE`；
- `memberName(role,index)` **就是** `roleInstanceId`（同名，不再两套命名）；
- `spawnAgent` Lead 路径返回 `{via:'spawnTeammate', instanceId, memberName, sessionId, ownerCapable:true}`；
  非 Lead 回退 activation 用**同一 ID**，返回 `{via:'startActivation', instanceId, ownerCapable:false, hint:'activation 实例不是 Team member，不能作 TeamTask owner…'}`；
- `sendMessage` 目标名即实例 ID：命中 Team member → `agentTeams.sendMessage`，否则 `subagents.sendMessage`。

### 验证

**真宿主（4 个真实实例，统一 ID）**
| 实例 | via | ownerCapable | sessionId |
|---|---|---|---|
| `role-code-11` | startActivation | false | `0694edf7…` |
| `role-code-12` | startActivation | false | `42dc321c…` |
| `role-audit-code-11` | startActivation | false | `7b32cb0e…` |
| `role-audit-code-12` | startActivation | false | `df997129…` |

真实回执：`agent_message{role-code-11, awaitOutput}` → `via:'subagents.sendMessage'`、`turnEnd.seq=33 completed`、文本 `ID-CODE-11-ECHO`。

**统一 ID 下的 6 节点全链**（`tests/e2e/native-real/chain-unified.mjs`，临时 state、node 模式）：
`role-code-01/02` 生产、`role-audit-code-11/12` 审计（AUDIT 节点交叉），全链 `done=6`、
审计独立、所有 ID 均 `^role-[a-z0-9-]+-\d{2,}$`、落盘 `appended>0 & incomplete=false` → **6/6**。

### 数字

| 门禁 | 结果 |
|---|---|
| `selftest`（含统一 ID + Lead/非 Lead 双路径 fake） | **16/16** |
| `contract`（conformance） | **19 / 0 failed** |
| `persistence-check`（6 节点全链 + 重载） | **8/8** |
| `native-real`（identity 记录，4 实例） | **7/7** |
| `native-real`（历史 6 节点链记录，旧大写格式回归） | **13/13** |
| `chain-unified`（统一 ID 6 节点全链） | **6/6** |

### 记录与限制

- 新记录：`tests/e2e/native-real/run-20261029T1435Z-identity.json`（`kind:'identity'`，4 实例 + 回执 + board owner 说明）；
  `check.mjs` 按 `kind` 分流：identity → 7 条身份断言；chain → 13 条全链断言。
- **board owner**：Lead 侧已用 `reassign(owner=role-code-01)` 打通（rev2 ownerName=role-code-01）；
  本侧 activation 实例 `ownerCapable=false`，投影 owner 仍需 Lead spawn 的 memberName。
- 历史全链记录（`run-20261029T1415Z.json`）保留旧大写 ID，作为回归样本；统一 ID 的全链证据见 `chain-unified.mjs`。
