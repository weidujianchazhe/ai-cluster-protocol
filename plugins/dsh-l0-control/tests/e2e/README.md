# N5 · e2e 夹具与断言（tests/e2e）

> 写域：本目录（Lane N5）。设计草案全文见 `src/e2e/README.md`；端口契约见 `src/e2e/port.ts`。
> 现状：**尚未接线**（依赖 N2/N3/N4）。本目录当前只放**场景夹具 + 断言口径**，R2 起用 mock 端口先跑。

---

## 1. 文件

| 文件 | 作用 | 覆盖验收 |
|---|---|---|
| `scenarios/crud_wish.json` | 主场景：许愿 → 5 段图 → 两个 CODE 实例 → 独立审计 → 交付 | A1 / A2 / A3 |
| `scenarios/failure_replan.json` | 失败场景：审计 fail → ready → replan → 局部重做 → done | A4（+ A2/A3 复用） |
| `run.mjs`（**R2 建**） | 跑场景的驱动：mock 端口 → 断言 → 报告 | — |

---

## 2. 断言口径（逐条可机检，不靠肉眼）

### A1 全链路无人工中继
- journal 时间窗：`wish_submitted` → 交付事件之间。
- 判定：窗口内**不存在** `actor.kind === "human"` 的事件，**例外**只有 `decision.level === "L3"` 的确认。
- 附加：命令（`/wish` `/status` `/next` `/export`）记 `actor.kind="human"`，只允许出现在 `wishSubmit` 与 L3 确认两处；**任何命令都不得直接改节点状态**（`forbidden.F5`）。

### A2 两个同职务实例不串
四条子断言（缺一不可）：
1. `ROLE-CODE-01` 与 `ROLE-CODE-02` 不得同时持有同一节点租约（双认领被拒）。
2. 同一实例不得**同时**持有两个活跃节点（`forbidden.F2`）——用于暴露"实例复用导致的串号"。
3. 产物/证据的 `producer_instance` 必须与 `dispatch.assignments` 一致（`NODE-DB/BACKEND → CODE-01`，`NODE-FRONTEND → CODE-02`）。
4. kill `ROLE-CODE-01` 后：其节点回 `ready`，而 `ROLE-CODE-02` 名下节点的 `status` 与 `updated_at` **均不变**。

### A3 审计独立
1. 同一节点 `producer_instance !== auditor_instance`。
2. 复合实例（`roles` 含 `AUDIT_*`）不得充当该节点生产者（对齐 Python `audit_independence_violations`）。
3. 某节点缺 auditor → `verifyDone` 必须拒绝（fail-closed，返回 `code` 而非静默通过）。

### A4 失败可 replan
1. `evidence_fail` → 节点 `rejected → ready`，`attempts += 1`。
2. `replan` 事件存在，`graph_version` 单调 +1。
3. 只有 `replanned_nodes` 的 `updated_at` 变化；`untouched_nodes` 不得被重跑。
4. 重跑后审计实例仍 ≠ 生产者（A3 复检）。
5. 最终收敛到 `done`（不得停在 `ready`）；超 `max_attempts` 须 `blocked` 并升级（`forbidden.F7`）。

---

## 3. team_status 投影契约（稳定标量，不把嵌套结构当契约）

R2 起把 `team_status` 投影纳入断言（Lead 2026-10-29 指定）。**实测形状**（本会话 `team_status` 调用）：

| 来源 | 字段 | 处置 |
|---|---|---|
| `tasks[]` | `id / revision / subject / status / ownerName / ready` | ✅ **稳定契约（6 个标量）** |
| `tasks[]` | `blockedBy`（数组） | ⚠️ 容忍字段：存在则必须是数组，不进契约值比对 |
| `members[]` | `id / name / role / status` | ✅ 稳定标量（本 e2e 暂不断言成员） |
| `members[]` | `context / diagnostics / provider / model` | ❌ **不得当契约**：嵌套/实现细节，随实现变化 |

断言（`run.mjs` 的 T1–T4）：

- **T1** 每个 task 行含 6 个稳定标量且都是标量类型（string/number/boolean/null）。
- **T2** 嵌套 `context` / `diagnostics` 被当作契约字段即 fail。
- **T3** 投影是**只读派生视图**：读投影不改图、行数 = 节点数、每行 `status` 能在图里找到同值。
- **T4** `blockedBy` 若存在必须是数组。

> 只锁标量的理由：投影是"给人看 + 给别的 Agent 读"的接口；把 `context` 这类实现细节写进契约，N3/N4 每次内部调整都会变成"契约破坏"，最后只能改断言消灾。

---

## 4. 真实工具面 vs e2e 端口的两处映射（R3 已处理）

| 真实工具（N2 已注册） | 参数 | e2e 端口 | 处理 |
|---|---|---|---|
| `evidence_submit` | `nodeId / artifactPath / verifier / acceptance`（N2 将补可选 `producer_instance`） | `evidenceSubmit(evidence)` | 真实面不传 `verdict`（判定由 core/verifier 推导）；`producer_instance` 缺省取节点 `assignee` |
| `verify_done` | `nodeId / acceptance`（N2 将补可选 `auditor_instance`） | `verifyDone({nodeId, auditor_instance?})` | **不依赖注入**：由 `verifier_id → {role, instanceId}` 注册表推导审计实例 |

**A3 取数（R3 定稿）**
1. 在**全部 pass 证据**里解析 `verifier_id` 的注册信息；
2. 一个都没注册 → `AUDITOR_REQUIRED`（fail-closed）；
3. 有注册但角色不以 `AUDIT` 开头 → `NOT_AN_AUDITOR_ROLE`；
4. 审计实例 == 证据提交者/节点 `assignee` → `AUDIT_NOT_INDEPENDENT`。

---

## 5. G5 · journal / 快照 / 恢复断言（R3 起纳入，不再 SKIP）

形状按 `control_plane/lanes/n4-state-recovery.md` §2：

| 断言 | 判据 |
|---|---|
| **G5-1** 重放 == 图状态 | `foldRecords(journal).revision == 记录数`，节点数与图一致 |
| **G5-2** 记录形状 | `seq` 严格 +1、`eventId = EVT-%06d`、`prevHash` 链自洽、`hash` 64 位 |
| **G5-3** 三元锚自洽 | `seq == revision == 折叠 revision`，`graphRevision` 一致 |
| **G5-4** 锚按前缀比较 | journal 前进后旧快照仍有效（比前缀字节，不比全文） |
| **G5-5** 四类篡改码 | `STATE_HASH_BREAK / STATE_SEQ_GAP / STATE_CORRUPT / STATE_SNAPSHOT_AHEAD` |
| **G5-6** 稳定点重建 | 截断到 `seq-1` 仍可折叠且 `revision` 正确 |

> 恢复断言只验"形状与判定"，不重写 N4 实现：`recovery.ts` 归 N4，e2e 只验"同一批码是否真会触发"。

---

## 6. 运行方式（R2 起可运行，R3 起含 G5）

```
node plugins/dsh-l0-control/tests/e2e/run.mjs --scenario crud_wish --port mock --json
node plugins/dsh-l0-control/tests/e2e/run.mjs --scenario failure_replan --port mock --json
node plugins/dsh-l0-control/tests/e2e/run.mjs --scenario crud_wish --port native --json   # 依赖 G1–G5
```

退出码（沿用 A7 四态，便于和 conformance 对齐）：

| 码 | 含义 |
|---:|---|
| 0 | 全断言 pass |
| 1 | drift（能跑完但有差异/降级） |
| 2 | failed（断言失败） |
| 3 | unknown（依赖缺失/端口不可用，**不得当 pass**） |

---

## 4. 依赖门与 SKIP 政策

| 门 | 缺什么 | 缺时的行为 |
|---|---|---|
| G1 | `wishSubmit` / `graphStatus` | 用 mock 端口；native 模式判 `unknown(3)` |
| G2 | 真实 spawn | 断言"不串"逻辑仍跑（mock 伪造实例）；报告标 `SKIP(no-spawn)` |
| G3 | TeamTask 投影 | 跳过投影只读断言，标 `SKIP(no-projection)` |
| G4 | done 事务 | mock 实现"无证据拒 done"；native 缺则 `unknown` |
| G5 | journal / 快照 | 跳过恢复断言，标 `SKIP(no-journal)` |

**政策**：`SKIP` 必须在报告里计数并单列，**任何 SKIP 不得折算成 pass**（`unknown ≠ pass`）。

---

## 5. 与 Python oracle 的差分

同一场景在 Python oracle 上重放（`control_plane/`），比对四项可观测结果：done 接受/拒绝、ready 集合、审计独立违规、`graph_version` 递增。差分 > 0 → 阻塞 N5 并按计划 §6 报 Lead（附具体条目）。
