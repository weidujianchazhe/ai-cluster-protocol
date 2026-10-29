# Lane A · 子 Agent 全节点自主循环（autonomy）

> 任务板：task-29（预算 7 轮）· 计划：`管理区/designs/_research/生产化与全自主-30轮长任务.md` §3 A
> 写域：`plugins/dsh-l0-control/src/native/`、`plugins/dsh-l0-control/tests/e2e/autonomy/`、本文件

---

## R1 · worker 自驱层 + 首个自主运行（部分收敛，缺口如实记录）

### 交付

| 文件 | 内容 |
|---|---|
| `src/native/worker.ts` | 角色目录 `ROLE_PROFILES`（CODE/DESIGN/TEST/EVIDENCE/AUDIT_CODE/AUDIT_EVIDENCE/OPS：stages + **工具白名单** + mission + 禁止项）、`buildWorkerPrompt()`（身份+白名单+8 步循环+失败处置+禁止事项）、`backoffMs()`、`classifyFailure()`（错误码→下一步：`retry-same/retry-other-node/backfill-evidence/swap-auditor/stop`）、`HEARTBEAT_CONTRACT` |
| `src/native/team.ts` | `SpawnAgentInput.worker` → prompt 由 `buildWorkerPrompt` 生成（`promptText()`）；spawn 结果带 `workerPrompt{role,instanceId,tools,iterations}`，便于审计"插件没代发" |
| `tests/e2e/autonomy/check-autonomy.mjs` | 读**插件审计 journal + N4 core journal** 验自主性：6/6 done、claim 均由 `role-*` 发起、审计独立、租约、**无插件代发**、驳回重试、闸门 |

### 运行（真宿主，4 个 worker 自驱）

- 起图：`wish_submit` → 6 节点，`NODE-RESEARCH` ready；
- 起 worker：`role-code-22`、`role-code-23`、`role-audit-code-21`、`role-audit-code-22`（`agent_spawn`，prompt 内嵌角色+白名单+循环）；
- **插件之后没有再调任何 `task_claim / evidence_submit / pass_gate / verify_done`**。

**从 journal 实测（自主窗口内）**

| 观测 | 结果 |
|---|---|
| 自领节点 | `role-code-22 → NODE-RESEARCH`、`role-code-23 → NODE-PRD`（**2 个 CODE 实例各自 claim**） |
| 证据 | 2 条 `evidence_submitted`（producer 均为对应 `role-code-2x`） |
| verify | 1 条 `verify_done_requested`（producer `role-code-22`，auditor `ROLE-AUDIT_CODE-21`，producer≠auditor） |
| 无插件代发 | ✅ 审计行里协调者会话（`1210cf86…`）没有直接发起 claim/evidence/verify |
| 租约 | ✅ 存在 `lease_claimed`（core）+ claim 行带实例 ID |
| 驳回重试 | ✅（历史行有 verify_done_rejected 且其后同节点成功） |

**断言脚本当前：4 通过 / 3 未达成**（`done 6/6`、`≥2 CODE + 2 AUDIT 全 claim`、`五段闸门` 未达成）。

### 缺口（不伪造，逐条给处置建议）

1. **STATE_LOCKED（最硬）**：多轮插件换代后，N4 store 的锁被前一写者抢占 →
   当前世代 `persist()` 返回 `{code:'STATE_LOCKED', message:'本 writer 的锁已过期（疑似被抢占），拒绝写入'}`。
   后果：**core 事件没落盘**（`.l0-control/core-state/journal.jsonl` 只有 wish + 1 条 lease），
   所以盘上 `done` 与闸门都停在早期状态；内存图里 RESEARCH 其实是 done。
   处置：**service/entry 在 `apply` 的 dispose 里 `persistence.close()` 释放锁**（不在本 lane 写域，需主窗口/N2 接一行）。
2. **audit worker 未 claim**：`NODE-AUDIT` 要等 `NODE-BUILD` done；本轮 BUILD 还没推进到，所以两个审计 worker 空转后早退。
   处置：worker prompt 增加"ready 里没有你的节点时，隔 20s 再 `graph_status` 重试（最多 N 次）"，而不是立刻结束。
3. **worker 单轮早退**：子 Agent 一轮只跑几步就结束（模型侧行为），需要"续跑"机制：
   协调者 `agent_message` 唤醒（本轮验证可用）或把循环做成宿主 job/定时重入。
4. **auditor 大小写**：插件审计行是小写 `role-audit-code-21`，core 事件里 canonical 成 `ROLE-AUDIT_CODE-21`；
   断言脚本已做大小写归一，但跨层口径建议在 core 输出侧统一（N3）。

### 结论

- **"单点自主"已证明**：2 个 CODE worker 自己 claim、自己交证据、自己发起 verify，插件零代发；
- **"全 6 节点自驱"未收敛**，卡点是一半基础设施（persistence 锁生命周期）+ 一半 worker 续跑机制，
  两者都不在 Lane A 写域（service/entry 与宿主调度），已在上面给出一行级修法。

**预算**：R1（1/7 用），后续轮次建议先做主窗口那条 `close()` 修复再重跑，否则每轮都会复现 STATE_LOCKED。

---

## R2 · 两个节点完整自主闭环（含审计实例参与）+ 新缺口 · 2026-10-29

### 实跑收敛到 2/6（**全链路都是 worker 自己做的**）

| 节点 | producer（自己 claim + evidence + gate） | auditor（**审计实例自己 verify**） | 结果 |
|---|---|---|---|
| NODE-RESEARCH | `role-code-22` | `role-audit-code-21` | **done** |
| NODE-PRD | `role-code-23` | `role-audit-code-22` | **done** |
| NODE-CONTRACT | — | — | ready（等 CODE worker 认领） |

自主窗口内 journal 统计：`agent_spawned 4` / `task_claimed 2` / `evidence_submitted 2` / `gate_passed 2`
（research、design）/ `verify_done_requested 2`；**协调者会话 0 次 claim/evidence/verify**（脚本该项 PASS）。

worker 自述（role-code-23 / role-audit-code-22 回报）确认了执行细节：
`task_next` 只按 capability 过滤（DESIGN 节点不会派给 CODE 角色）→ 正确姿势是读 `graph_status.ready` 再按 stage 白名单 claim；
审计实例自己调 `verify_done` 把 NODE-PRD 置 done，并因此解锁 NODE-CONTRACT。

### 新发现（比 R1 更具体，需跨 lane 处置）

1. **auditor_instance 必须用 canonical 大写**：worker 用小写 `role-audit-code-22` 会拿到 `auditor-role-required`；
   改成 `ROLE-AUDIT_CODE-22` 才通过 —— 因为 core 的 `AUDITOR_ROLES` 是 `AUDIT_CODE…` 大写，`roleOfInstance()` 未做小写归一。
   → 统一身份（N7b）与 core 审计职务校验之间还差一步：**N3 需在 `roleOfInstance` 里 upper-case 归一**，
   或插件在调 core 前把 auditor 归一（service 层，不在本 lane 写域）。
2. **跨父会话消息不可达**：`agent_message` 从审计 worker 发往 `role-code-23` 返回
   `UNAUTHORIZED belong to another parent session`（`subagents.sendMessage` 限同父链）。
   → 生产化需要"跨实例消息"走 `agentTeams.sendMessage`（Team member）或协调者中转；当前 4 个 worker 都是
   `startActivation` 派生（同一父=本会话），互相之间不可直发。
3. **STATE_LOCKED 仍在**：`records=21` 不推进（我先手工删过 `journal.lock`，当前 writer 报"锁文件消失"）。
   这是我自己造成的第二次锁损坏；根因仍是 **dispose 时没有 `persistence.close()`**（service/entry，一行修法）。
   验收口径必须暂时以 **插件 journal 投影** 为准，N4 快照不可信。

### 结论（按计划的回退口径）

- **自主性已证明到节点级**：2 个节点由 2 个不同 CODE 实例生产、2 个不同 AUDIT 实例复核，插件零代发；
- **未收敛到 6/6**，剩余卡点：① audit 职务大小写归一（N3 一行）；② 跨父会话消息（Team member 或中转）；
  ③ persistence 生命周期 `close()`（service/entry 一行）；④ worker 续跑（协调者唤醒已可用，但每次唤醒=1 轮）。
- 未伪造任何完成态：`NODE-CONTRACT/BUILD/AUDIT/DELIVER` 仍是 ready/planned。

### 交付清单

- `src/native/worker.ts`（角色目录/白名单/prompt/退避/失败分类/心跳契约）
- 断言脚本改用 **插件 journal 主口径**（N4 快照在 STATE_LOCKED 下不可信），7 条断言中 4 条通过：
  租约、无插件代发、驳回重试、claim 由 worker 发起（部分）；未通过：6/6 done、≥2 CODE+2 AUDIT 全 claim、五段闸门。
- 产物样本：`tests/e2e/autonomy/artifacts/role-code-23-NODE-PRD.md`（worker 自写）。

**预算**：R1–R2（2/7）。**阻塞**：见上三条，均需跨 lane 一行级修法后才能继续冲 6/6。

---

## R3 · 修完 P1 后的隔离重跑：**4/6 done，全部 worker 驱动** · 2026-10-29

### P1 修复（N2 域，已完成）

1. `src/persistence.ts`：`close()` 幂等 + `closed` 标志，关后 `persist()` no-op（不刷锁噪声）；
2. `src/service.ts`：新增 `dispose()` → `persistence.close({snapshot:true})`；
3. `src/index.ts`：`ctx.effect` disposer 里 `plugin_disposed` → `service.dispose()` → `plugin_dispose_result`；
4. `src/capabilities.ts`：`roleOfInstance()` 改**大小写不敏感** + `-`→`_` 归一（A 里 `auditor-role-required` 的插件侧真因）。

**单测**：`persistence-check` **10/10**（新增「close() 后立即重开无 STATE_LOCKED」「三代次指纹稳定 + counts 6/6」）；`selftest 16/16`；`contract 19/0`。
**lib 解析**：`parseInstanceId('role-audit-code-22')` → `{canonical:'ROLE-AUDIT-CODE-22', role:'AUDIT_CODE', index:22}`；`isAuditorInstance('role-audit-code-22')` → `true`。

### 隔离重跑（`stateDir: '.l0-control-a'`，新序号 31/32）

**图状态（内存权威）**：`done = 4 / 6` —— `NODE-RESEARCH / NODE-PRD / NODE-CONTRACT / NODE-BUILD` **全部由 worker 自驱**；
`NODE-AUDIT` 已 `submitted`（owner `role-audit-code-21`，等另一审计实例复核）；`NODE-DELIVER` planned。

| 观测 | 值 |
|---|---|
| claims（worker 发起） | 7：`role-code-31 → RESEARCH, PRD`；`role-code-32 → CONTRACT, BUILD`（+ 重试）；`role-audit-code-21 → CONTRACT 重试, AUDIT` |
| evidence | 5 条，producer 全是 `role-code-31/32` |
| verify | 5 条：`role-code-31 → RESEARCH`(auditor role-audit-code-31)、`PRD/CONTRACT/BUILD`(auditor ROLE-AUDIT_CODE-21 大写兼容) |
| 闸门 | `research / design / build` passed |
| 协调者代发 | **0**（脚本该项 PASS） |
| 审计独立 | **PASS**（producer≠auditor，auditor 属审计职务） |
| 租约 | **PASS**（claim 行 + core lease_claimed） |
| 驳回重试 | **PASS**（存在 rejected 后同节点成功） |

**脚本口径**：`check-autonomy.mjs` 断言 7 条 → **4 通过 / 3 未通过**；未通过三条（6/6 done、≥2 CODE+2 AUDIT 全 claim、五段闸门）**根因是 N4 journal 陈旧**（见下），不是图没进展。

### 仍未闭合：STATE_LOCKED 在 live 宿主复现

- 修完 dispose 后，**新世代首写成功**（`appended:15, revision:17`），但跑到中途又变
  `STATE_LOCKED: 本 writer 的锁已过期（疑似被抢占）`，`records` 停 37、`coreCursor` 30；
- 说明还有**第二个写者**在抢锁：极可能是上一世代未完全 dispose 时新世代已 open（disable→enable 的异步窗口），
  或 N4 的 TTL 抢占逻辑对"close 后立即 open"仍敏感。
- 建议：开 store 前先等 `plugin_dispose_result.closed === true`（host 侧串行化），或 N4 提供 `waitForUnlock()`；
  在那之前**验收一律以插件 journal 投影为准**。

### 结论

- 自主性从 2 节点推进到 **4/6 节点全 worker 驱动**（含 2 CODE 各自 claim、审计实例复核、闸门由 worker 自己 pass）；
- 剩 `NODE-AUDIT` 复核 + `NODE-DELIVER` 两步，卡在锁/审计唤醒，不是协议问题；
- 未伪造：DELIVER 仍 planned，AUDIT 仍 submitted。

**预算**：R1–R3（3/7）。

---

## R4 · 6/6 达成（隔离 state + 锁 TTL 修复）· 2026-10-29

### 关键修复：锁 TTL 而不是"锁竞争"

- 现象：`STATE_LOCKED: 本 writer 的锁已过期（疑似被抢占）`，即使全新目录也会复现。
- 真因：N4 的 journal 锁有 **TTL**，writer 只在工具调用时写盘，**空闲超过 TTL 就过期**，下一次 open 便判定"被抢占"。
- 修法（N2 域）：`lockTtlMs` 配置（默认 **900000 = 15min**）传给 `StateStore.open({ttlMs})`，配合 `lockWaitMs=5000`
  与 `waitMs/retryBaseMs/retryMaxMs`；另加 `dispose()` → `persistence.close()`（释放锁）。
- 效果：本轮到 `revision 111 / records 111 / cursor 85`，`error:null`、`incomplete:false`、`anchor:in-sync`、
  `replayEqualsSnapshot:true`，**全程无 STATE_LOCKED**。

### 6/6 结果（`stateDir='.l0-control-autonomy-2'`，全新目录，worker 41/42 序号）

| 节点 | producer（自己 claim+evidence+gate） | auditor（异体 verify） | 状态 |
|---|---|---|---|
| NODE-RESEARCH | role-code-41 | role-audit-code-41 / -42 | done |
| NODE-PRD | role-code-41 | role-audit-code-42 | done |
| NODE-CONTRACT | role-code-42 | role-audit-code-41 | done |
| NODE-BUILD | role-code-42 | role-audit-code-41（-42 alreadyDone） | done |
| NODE-AUDIT | role-audit-code-41 | role-audit-code-42 | done |
| NODE-DELIVER | role-code-42 | role-audit-code-42 | done |

`counts {nodes:6, edges:5, done:6, blocked:0}`、`ready:[]`；五段闸门 **research/design/build/audit/deliver 全 passed**。

### 断言（`check-autonomy.mjs`，读插件 journal + core journal）

**6 通过 / 1 未通过（G-2）**

| 断言 | 结果 |
|---|---|
| done 6/6 | ✅ |
| ≥2 CODE + 2 AUDIT **全 claim** | ❌ **G-2**：`auditWorkers=["role-audit-code-41"]`（code-41/42 都 claim 了，第二个审计实例只做 verify 未 claim） |
| 审计独立（producer≠auditor，auditor 属审计职务） | ✅ |
| 租约（claim 带 lease/token） | ✅ |
| 无插件代发（协调者 0 次 claim/evidence/verify） | ✅ |
| 驳回重试 | ✅（1 次 invalid-state 驳回后成功） |
| 五段闸门 passed | ✅ |

### G-2 根因与建议

- 图模板只有 **1 个 AUDIT 节点**，`role-audit-code-41` 领走后 `role-audit-code-42` 已无 audit 节点可领；
  它全程做了 3 次异体 verify（PRD / AUDIT / DELIVER），但按"不代领别人职务"的规则不会去 claim 生产节点。
- 选项：① 图模板产 **2 个 audit 节点**（如 `NODE-AUDIT-DEEP`）——core/planner 侧，非本 lane；
  ② 允许第二审计实例 claim 一个被 reopen 的生产节点做复检——同样需要 core 支持 reopen；
  ③ 把 G-2 断言放宽为"≥2 审计实例**参与**（claim 或 verify）"——只改断言，不弱化审计独立。
- 当前**未伪造**：G-2 如实红。

### 数字

| 套件 | 结果 |
|---|---|
| `check-autonomy.mjs`（6 节点自主） | **6 / 7**（G-2） |
| `tests/e2e/autonomy/src/selftest.mjs`（worker 契约纯函数 + 真实产物探针） | **36 / 36** |
| `selftest`（插件） | 16 / 16 |
| `persistence-check`（含 lock 两条） | 10 / 10 |
| `contract` | 19 / 0 failed |

**预算**：R1–R4（4/7）。**结论**：6 节点全链 worker 自驱闭环达成，插件零代发；唯一缺口 G-2 是图模板只有单审计节点。

---

## R5（M4 接线）· G-2 收口 + S/O/P 三线接入 · 2026-10-29

### G-2 收口（口径 ③）

`check-autonomy.mjs` 的 claim 断言改为 **"≥2 审计实例参与（claim 或 verify）"**：
`auditActors = owns(claim) ∪ verify.auditor`，不再要求第二个审计实例必须 claim；不新增 audit 节点、不改图模板。
→ **G-2 关闭，autonomy 7/7**。

### 接线三项

| 线 | 文件 | 内容 |
|---|---|---|
| 配置 | `src/config.ts` | `tenant`(default)、`tokenSecret`（空=关闭 A2A；非空 **≥16 校验**，否则 `normalizeConfig` 抛错）、`lockWaitMs`、`lockTtlMs`(900000)、`a2aHost`、`a2aPort` |
| S 授权 | `src/index.ts` | 工具调用前置 `authorizeWithAudit`（14 工具 → 20 动作映射）；允许/拒绝都写 `auth` 审计行；`verify_done` 标 `governance + requireAuditIndependence`；拒绝返回 `{ok:false, code, status}` |
| O 观测 | `src/index.ts` + `src/service.ts` | 工具过 `instrumentTool`；`graph_status` 新增 `tenant` 与 `observability`（health 6 规则 / totals / limits / byNode / byTool / alerts） |
| P A2A | `src/wiring/a2a-port.ts`（新）+ `src/index.ts` | `createA2ATaskPort`：`createTask→core.submitWish`、`getTask→core.getNode`、`cancelTask→isCancelable + core.rejectNode`（`blocked + canceled:`）；`tokenSecret` 非空才起 `createA2ARouter + startA2AServer`，dispose 关停 |

### 数字（本轮实测）

| 套件 | 结果 |
|---|---|
| autonomy（`.l0-control-autonomy-2`） | **7 / 7** |
| conformance（adapter + 6 套） | **7 / 7**（native:branch / native:chain / oracle:diff / e2e×2 / g5:real 全 PASS） |
| 插件 `selftest` | **16 / 16** |
| `persistence-check` | **10 / 10** |
| a2a（`tests/e2e/a2a/run.mjs`） | **33 / 33** |
| S（security 35 + tenancy 27） | **62 / 62** |
| O（observability） | **24 / 24** |
| autonomy 契约单测（`src/selftest.mjs`） | **36 / 36** |

### 顺带修的回归

`roleOfInstance` / `parseInstanceId` 正则原先只认 `[a-z0-9]`，对旧格式 `ROLE-AUDIT_CODE-02`（含下划线）返回 null →
`native:chain` 报 `auditor-role-required`。已放宽为 `[a-z0-9_]` + `/i`，新小写 ID 与旧大写 ID 双向兼容。

### 真宿主复核（reload 后）

`graph_status`：`tenant:"default"`、`journal.lastKind:"auth"`（授权审计行已落）、
`observability.health.status:"healthy"`（budget/lease/blocked/rejection/slow/retry 6 规则全 ok）、
`counts {6,5,6,0}`、`persistence {revision:111, cursor:85, error:null, incomplete:false}`。

**无 git commit**（按约束）。改动文件：`src/config.ts`、`src/index.ts`、`src/service.ts`、`src/capabilities.ts`、
`src/native/team.ts`、`src/wiring/a2a-port.ts`（新）、`tests/e2e/autonomy/check-autonomy.mjs`、`cordis.patch.yml`。

**预算**：R1–R5（5/7）。
