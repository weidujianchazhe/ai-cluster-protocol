# Lane A · `p0-correctness`（P0 正确性）

> 任务板：task-5 · 预算 8 轮 · 写域：`control_plane/{graph,events,leases,scheduler,recovery}.py`、`tests/test_{graph,events,leases,scheduler,recovery}.py`、本文件
> 任务卡（只读）：TASK-20261029-BB1228 / TASK-20261029-673064 / TASK-20261029-BA8213
> 门禁：`python -m unittest discover -s control_plane/tests`（基线 73 → 现 86）

---

## R1 · 状态机唯一入口 `graph.set_status`（模板已落地）

**改动**

- `graph.py` 重写为状态机唯一入口形态：
  - `set_status(conn, node_id, status, *, reason, assignee=UNSET, attempts_delta, credential,
    at, drop_lease, notify, commit, extra)`：状态 + assignee + attempts 一次落库，同事务写事件；
    同状态且无 assignee/attempts 变化 → 幂等返回、不写事件。
  - `done` 需证据凭证：`credential` 缺失/为空/引用不存在证据/证据非 pass/不属本节点/
    未覆盖 `evidence_required`/验证器不在允许清单/依赖未 done/阶段闸门未过 → `CredentialError`（拒绝前不落库）。
    新增 `graph.done_credential(conn, nid)` 按库内证据铸造凭证（不满足条件返回 None）。
  - `status_changed` 事件写**真实前态** `from` + **后像**（`to`/`assignee`/`attempts`/`at`/`reason`/`evidence`）；
    另发 `assignee_changed`、`attempts_changed` 审计事件（WP-02 事件化）。`commit=False` 可加入调用方事务。
  - 写期环检测：`add_node(deps=…)`（自依赖）、`add_edge(kind="blocks")`、`set_edges()` 写入前 `CycleError`；
    `detect_cycles()` 提供全图体检；非 blocks 边不参与环判定。
  - `snapshot()` / `replay_snapshot()` 同口径：deps 由 blocks 边规范化，replay 应用状态后像与
    `assignee_changed`/`attempts_changed`/`edge_removed`；新增 `replay_mismatches()` 逐字段差异明细。
  - `set_status(done)` 默认 `notify=True`：自动调 `scheduler.on_event` 解锁下游（唯一入口不依赖调用方记得通知）；
    `notify=False` 保留显式事件驱动路径（测试两种都覆盖）。
- `tests/test_graph.py`：新增 `TestStatusMachine`（14 个反向/正向用例：无凭证拒绝、失败证据拒绝、
  类型缺失、外部验证器、依赖未完成、空/伪造凭证、真实前态 + 后像 replay 对齐、幂等无事件、
  非法状态、环拒绝、`set_edges` 环拒绝与 replay 对齐）。
- `tests/test_recovery.py` / `tests/test_scheduler.py`：done 改为凭证路径；新增
  `test_done_single_entry_auto_promotes`。

**测试**：`Ran 86 tests ... OK`（基线 73，新增 13）。

**阻塞**：无。

**下一轮入口**：R2 —— 收敛 `leases.py` 的 2 处直写（`_set_status` 与 `expire` 内联 UPDATE）到
`graph.set_status`，claim/renew/release/expire/takeover 后 `snapshot == replay`。

**遗留（需 Lead 串行化，超出 Lane A 写域）**：`evidence.py` 4 处、`watchdog.py` 1 处仍直写
`UPDATE tasks SET status`；已备好改法（见 R3 交接段）。

---

## done 凭证 API 契约（B / C / D 共用，冻结）

> 目的：`done` 只能带凭证进入。Lane A 已把约束落在 `graph.set_status` 内，**不放宽**。

```python
from control_plane import graph

cred = graph.done_credential(conn, node_id)      # 按库内证据铸造；不满足条件返回 None（不抛）
if cred is None:                                 # 证据不够 → 走 reject 分支，不要伪造凭证
    ...
node = graph.set_status(
    conn, node_id, "done",
    credential=cred,                             # 唯一合法来源：done_credential()
    reason="evidence_ok",
    assignee=None,                               # 终态清空 assignee
    drop_lease=True,                             # 同事务删租约（可选）
)
```

**签名（graph.py）**

| 函数 | 参数 | 语义 |
|---|---|---|
| `done_credential(conn, node_id) -> dict \| None` | — | 取该节点 `verdict='pass'` 证据，校验覆盖 `evidence_required` / 验证器白名单 / 依赖 done / 阶段闸门后铸造 `{node_id, evidence[], verifier_ids[], minted_at}`；不满足返回 `None` |
| `set_status(conn, node_id, status, *, reason=None, assignee=UNSET, attempts_delta=0, credential=None, at=None, drop_lease=False, notify=True, commit=True, extra=None) -> node` | 见上 | 唯一状态入口；`status="done"` 时 `credential` 必填 |
| `replay_mismatches(conn) -> list[dict]` | — | snapshot vs replay 逐字段差异（空列表=完全一致） |
| `detect_cycles(conn) -> list[list[str]]` | — | 全图 blocks 环体检 |

**凭证校验不通过时的异常**：`graph.CredentialError`（`GraphError` 子类，`ValueError` 孙类）；
拒绝发生在任何写入之前 —— 节点状态与事件计数不变。

**谁签发**：只有 `graph.done_credential()`。`evidence.finalize()`（Lane B 写域）后续应改为
「校验 → `done_credential()` → `set_status(done, credential=cred, ...)`」，不再自己拼 `done` 事件；
在那之前 `evidence.finalize` 的直写仍能跑，但**不带凭证的 `set_status(done)` 一定被拒**。

**测试写法**（A 已用的统一 helper，B/C/D 可直接抄）：

```python
evidence.add_artifact(conn, artifact_id="ART-X", path="p", sha256=SHA, producer_node=nid)
evidence.add_evidence(conn, evidence_id="EVD-X", node_id=nid, kind="artifact",
                      artifact_id="ART-X", verifier_id="verifier-ci", verdict="pass")
cred = graph.done_credential(conn, nid)
```

**状态**：R1 结束时 `test_recovery`（2 个）与 `test_scheduler`（2 个）已改到凭证路径，
全量 86 tests OK —— Lead 报的 4 红是 R1 中间态快照，现已收敛。

---

## R2 · `leases.py` 直写收敛（claim / renew / release / expire / takeover）

**改动**

- 删除 `_set_status()` 里的 `UPDATE tasks SET ...`；四个写点全部改为
  `graph.set_status(..., reason=…, assignee=…, attempts_delta=…, at=ts, notify=False, commit=False)`，
  与租约行写入共用同一事务（`with conn:`）。
- 删除 claim / release / expire / takeover 里手写的 `status_changed` 事件（唯一入口已发），
  避免同一次迁移写两条 `from/to` 事件；租约审计事件（`lease_claimed` / `lease_renewed` /
  `lease_released` / `lease_expired` / `lease_taken_over`）保留。
- `expire()`：`from` 取真实前态（`running` 节点过期时不再写成字面量 `claimed`）；
  `attempts_delta=1`、`assignee=None` 由唯一入口完成；不再内联 `attempts=attempts+1`。
- `release()`：先取节点再回退，`from` 真实前态。
- `renew()`：只续租约，不产生状态事件（护栏测试断言事件数不变）。
- 模块 docstring 声明「本模块不直接写 tasks.status」，配 `test_no_direct_status_write_in_leases`
  静态护栏（扫源码断言无 `UPDATE tasks SET`）。

**测试**（`tests/test_leases.py` 新增 6 个）

- `test_claim_replay_aligned_and_real_from` / `test_release_replay_aligned` /
  `test_takeover_replay_aligned`：`snapshot == replay`、`replay_mismatches()==[]`、真实 `from`。
- `test_expire_from_running_is_real_prev_status`：running 过期 → `("running","ready")`、attempts=1、assignee 清空。
- `test_renew_does_not_disturb_state`、`test_no_direct_status_write_in_leases`（护栏）。

**测试结果**：`test_leases + test_graph + test_scheduler + test_recovery + test_db + test_stages +
test_capabilities + test_decisions + test_demo_crud` → **Ran 75, OK**。
全量（含 B/C 在改的文件）当前红点全在跨 lane 域：`test_evidence`（B 严格模式/验证器身份，在改）、
`test_cli`（C 的 `--now` 解析）、`test_runtime:84`（**C 的测试仍无凭证调 `set_status(done)`** ← 需 C 按凭证契约改）。

**阻塞**：无（跨 lane 红点已列给 Lead）。

**下一轮入口**：R3 —— `scheduler.py`（2 处）与 `recovery.py`（1 处 + 字面量 `from="intermediate"`）
收敛到唯一入口；recover 的 `_state_consistent` 升级为全量对齐（含 assignee / attempts）。

---

## R3 · `scheduler.py` + `recovery.py` 直写收敛（原始 9 处直写清零）

**改动**

- `scheduler.recompute_ready()`：降级（ready→planned, reason=`deps_not_done`）与晋升（planned→ready,
  reason=调用方 reason）两处 `UPDATE tasks SET status` 删除，改
  `graph.set_status(..., notify=False, commit=False)`；手写的两条 `status_changed` 删除；
  `ready_recomputed` 汇总事件保留。
- `recovery._reset_to_ready()`：删除内联 UPDATE 与 `DELETE FROM leases`，改
  `graph.set_status(..., "ready", reason="recovered:"+reason, assignee=None, attempts_delta=1,
  at=ts, drop_lease=True, notify=False, commit=False)`；顺带修掉 **`from` 写死 `"intermediate"`** 的缺陷，
  现在取真实前态（claimed / running / submitted / verifying）。
- `recovery._state_consistent()` 升级为全量对齐：`graph.replay_mismatches(conn) == []`
  （状态 + assignee + attempts + updated_at + 边集合），不再只比状态映射。
- `recover()` 返回新增 `mismatch_detail`，`recovery_mismatch` 事件 payload 带逐字段差异（不静默）。

**测试**（新增 5 个）

- `test_recover_uses_real_prev_status`：running 中断恢复 → `("running","ready")`、attempts=1、assignee 空、reason=`recovered:crash_intermediate`。
- `test_recover_replay_aligned`：过期 + 运行中断混合场景，`mismatch=False`、`snapshot==replay`。
- `test_recover_detects_and_reports_mismatch`：外部篡改 attempts → `mismatch=True` 且 `mismatch_detail` 含 attempts 字段 + 留痕事件。
- `test_recompute_goes_through_single_entry_and_replays`（scheduler）：降级/晋升真实 `from` + replay 对齐。
- `test_scheduler_module_has_no_direct_status_write`、`test_recovery_module_has_no_direct_status_write`：静态护栏。

**测试结果**：`test_graph/test_events/test_leases/test_scheduler/test_recovery/test_demo_crud` → **Ran 51, OK**。

**直写账（原始 9 处）**：evidence 4（B 已完成）+ leases 2（R2）+ scheduler 2 + recovery 1（R3）→ **9/9 清零**。
域外剩 `watchdog.py` 1 处（C 的 patch 文本已发 Lead）。

**阻塞**：无。

**下一轮入口**：R4 —— `recover()` 补推 ready（WP-04 第一半）。

---

## R4 · `recover()` 补推 ready（WP-04）

**问题**：崩溃前「上游 done、下游 planned」的推进事件可能丢失；`recover()` 只做退回 ready，
不重算 ready，下游会一直卡在 planned 等下一次 done 事件（永远等不到）。

**改动**

- `recover()` 在退回中间态之后调用 `scheduler.recompute_ready(conn, reason="recovery")`，
  返回新增 `promoted`；`recovery_completed` 事件带 `promoted`，`recovered` 或 `promoted` 非空即记事件。
- 同一次调用顺带降级「依赖未满足的假 ready」，恢复后图处于自洽的 ready 集合。
- 幂等：第二次 recover 无变化 → 无 `promoted`、无新事件（沿用 R3 的全量对齐口径）。

**测试**（新增 3 个）

- `test_recover_promotes_downstream_ready`：A done + B planned → `promoted==["NODE-B"]`、B 变 ready、
  `ready_recomputed.reason=="recovery"`、`snapshot==replay`。
- `test_recover_keeps_downstream_blocked_when_dep_pending`：依赖未完成 → 不误推。
- `test_recover_twice_is_idempotent_with_promoted`：二次 recover 事件数不变。

**测试结果**：`test_recovery/test_scheduler/test_demo_crud/test_graph` → **Ran 41, OK**。

**阻塞**：无。

**下一轮入口**：R5 —— `apply_replan` 单事务（WP-04 第二半）：`graph.replan()` 内建事务 +
版本递增 + replan_events + 失败回滚，附原子性反向用例。

---

## R5 · `graph.replan()` 单事务（WP-04）

**问题**：`stages.apply_replan()` 是「先逐笔增删节点（每笔各自提交），再 `record_replan()`」——
中途失败会留下半个图 + 没有版本记录；崩溃窗口内 `graph_version` 与图内容不一致。

**改动**（`graph.py`，均在我的写域；`stages.py` 未改）

- `add_node(..., commit=False)` 与 `remove_node(..., commit=False)` 拆出 `_apply()`，可加入调用方事务。
- 新增 `graph.replan(conn, *, reason, add=[...], remove=[...], note=None, recompute=True)`：
  1. 前置校验：reason ∈ `REPLAN_REASONS`、add 的 node_id 不重复/不冲突、remove 的节点必须存在；
  2. **单事务** `with conn:` 内完成「add → remove → 版本递增 → `replan_events` 行 → `graph_replanned` 事件」，
     任一步抛错整笔回滚（图 / 版本 / 事件 / replan_events 全部不变）；
  3. 事务外 `recompute=True` 时补一次 `scheduler.recompute_ready(reason="replan")`，返回 `promoted`。
- `replan_events.event_id` 沿用 `EVT-R%04d` 格式（与 `stages.record_replan` 一致，导出/夹具不受影响）。
- 新增 `graph.current_graph_version()`（读 meta）。
- 交接：`stages.apply_replan()` 后续改为 `return graph.replan(...)` 一行委托（stages.py 不在我写域，patch 待 Lead 串行）。

**测试**（`TestReplanAtomic`，5 个）

- `test_replan_success_records_version_and_promotes`：版本 +1、`EVT-R%04d`、replan_events 行、新节点 promoted 到 ready、replay 对齐。
- `test_replan_rolls_back_midway_failure`：第二笔 add 依赖不存在 → 第一笔也不落库、版本不变、无 replan_events、事件数不变。
- `test_replan_rollback_on_remove_failure_keeps_added`：add + 非法 remove → 两者都回滚、版本仍为 1。
- `test_replan_remove_replays`、`test_replan_rejects_illegal_reason_and_existing_node`。

**测试结果**：`test_graph` → **Ran 23, OK**。

**阻塞**：无。

**下一轮入口**：R6 —— 事件流体检（`events.validate_stream`）接入 `recover()`，补全生命周期
（claim → renew → submit → reject → recover → done → replan）replay 对齐的端到端用例。

---

## R6 · 事件流体检 + 全生命周期 replay 对齐（WP-02 收口）

**改动**

- `events.validate_stream(conn)`：逐条校验 seq 单调、`event_id`/`ts` 非空、关键事件必备 payload 字段
  （`REQUIRED_FIELDS`：`status_changed` 需 from/to/at；`node_added`/`node_removed` 需 node；
  `edge_added`/`edge_removed` 需 from/to/kind；`assignee_changed`/`attempts_changed` 需 to）。
  返回 `{"ok", "events", "issues"}`，不抛异常（坏事件留痕而不是静默进 replay）。
- `recover()`：恢复前跑一次体检，不通过则写 `event_stream_invalid` 事件（带 issues），
  返回新增 `event_stream_ok` / `event_stream_issues`。

**测试**（`test_events.py` 新增 4 个）

- `TestValidateStream`：干净流 ok；手工插入 `payload_json='{}'` 的 status_changed → 检出
  `missing_payload_fields: [from, to, at]`；空 ts → `missing_ts`。
- `TestLifecycleReplayAlignment.test_full_lifecycle_stays_aligned`：9 个检查点
  （add_nodes / claim / renew / recover_expired / submit / reject / done / replan / final_recover）
  每步都断言 `snapshot == replay`、`replay_mismatches == []`、`validate_stream.ok`；
  并覆盖 done 自动解锁下游、replan 补推新节点、末次 recover 无 mismatch。

**测试结果**：`test_events` → **Ran 9, OK**；**全量 `Ran 209 tests ... OK`**；
`tools/check_fixtures.py` → 23 通过 / 0 问题。

**阻塞**：无。

---

## D0 裁决记录（Lead 2026-10-29 拍板，可逆默认）

- **`add_node(status="done")` 保留为建图期导入 / 夹具例外**：`add_node` 是建图动作，不是运行期状态迁移；
  运行期任何状态迁移（含 done）一律 `graph.set_status(..., credential=done_credential(...))`。
- 复查点：**M5** 评估是否给 `add_node` 加显式 `fixture=True` 标志把例外写成显式契约；
  在此之前不改 `test_capabilities.py` 夹具（跨 lane）。
- 明确不加的限制：不因为「怕被绕过」给 `add_node` 上凭证闸门——导入/夹具需要建终态节点。

---

## 验收对照（Lane A 章程）

| 验收项 | 状态 | 证据 |
|---|---|---|
| `set_status(done)` 无凭证拒绝 | ✅ | `test_done_without_credential_rejected` + 6 个凭证反向用例（空/伪造/失败证据/缺类型/外部验证器/依赖未完成） |
| claim / renew / release / expire / takeover 后 snapshot==replay | ✅ | `test_claim_replay_aligned_and_real_from`、`test_release_replay_aligned`、`test_takeover_replay_aligned`、`test_renew_does_not_disturb_state` |
| recover 后 snapshot==replay | ✅ | `test_recover_replay_aligned`、`test_recover_uses_real_prev_status`、`test_full_lifecycle_stays_aligned@final_recover` |
| 恢复后下游 ready | ✅ | `test_recover_promotes_downstream_ready`、`test_recover_keeps_downstream_blocked_when_dep_pending`、幂等用例 |
| 9 处直写收敛 | ✅ 9/9 | evidence 4（B）+ leases 2（R2）+ scheduler 2 + recovery 1（R3）；三条静态护栏测试 |
| 写期环检测 | ✅ | `test_edge_cycle_rejected_at_write_time`、`test_set_edges_rejects_cycle_and_keeps_graph`、`detect_cycles()` |
| apply_replan 单事务 | ✅ | `TestReplanAtomic`（含 2 个回滚反向用例） |
| 状态迁移表可执行契约 | ✅ R8 | `control_plane/tests/test_transitions.py`（20 行 / 五层检查 / 15 tests） |
| `blocked → ready` 留痕解除 | ✅ R8 | `graph.unblock()` + 守卫 + 6 例（3 个反向） |
| unittest 全绿 + 新增反向用例 | ✅ | Lane A 五套件 + 迁移表套件全绿；本 lane 累计新增用例 54 个 |
| 每轮 lane note + 报 Lead | ✅ | R1–R8 各段 + 8 次 send_message |

---

## 跨 lane 交接（我不越域改的文件）

| 文件 | 现状 | 需要谁做 | patch |
|---|---|---|---|
| `evidence.py` 4 处直写 | ✅ B 已收敛到 `graph.set_status`（646/679/715/816） | — | — |
| `watchdog.py` `_block` | ✅ C 已收敛（`watchdog.py:74` 调 `graph.set_status`，不再直写、不自拼 status_changed） | — | — |
| `stages.apply_replan()` | ✅ Lead 已落一行委托：`return graph.replan(...)`（单事务） | — | — |
| `tests/test_runtime.py:84` | ✅ C 已改为凭证路径（全量绿） | — | — |

**R7 复核后状态**：直写收敛已从「9/9 + 域外 1 处」变为**全部收敛**（`grep "UPDATE tasks SET" control_plane/*.py` 除 `graph.py` 唯一入口外无命中）；三处跨 lane 交接全部关闭。

---

## Lane A 结论

- WP-01 状态机唯一入口、WP-02 事件重放全量对齐、WP-04 恢复补推 + replan 原子性：**全部落地并有反向用例**。
- 写域内无遗留阻塞；跨 lane 三项已在「交接」表里点名。
- 预算：6 / 8 轮（R7/R8 留作返工缓冲，未使用）。

---

## R7 · WP-10 节点状态迁移表：可执行 fixture 草案（待命任务 ②）

> 状态：**草案**，只读产出，未写 `fixtures/`（不在我写域）。可执行性已实测（见下方输出）。

### 表（19 行，从 R1–R5 的实现反推，不是抄设计稿）

| # | from → to | reason | 触发点 | 关键副作用 / 守卫 |
|---:|---|---|---|---|
| 1 | planned → ready | `bootstrap` / `dependency_done` / `replan` / `recovery` / `recompute` | `scheduler:recompute_ready` | 依赖全 done 才允许 |
| 2 | ready → planned | `deps_not_done` | `scheduler:recompute_ready` | 假 ready 降级 |
| 3 | ready → claimed | `lease_claimed` | `leases:claim` | assignee=owner、写租约、fencing+1 |
| 4 | claimed → ready | `lease_released` | `leases:release` | assignee=None、删租约 |
| 5 | claimed → ready | `lease_expired` | `leases:expire` | assignee=None、attempts+1 |
| 6 | running → ready | `lease_expired` | `leases:expire` | 同上 |
| 7 | claimed → claimed | `takeover` | `leases:takeover` | assignee=新 owner、fencing+1 |
| 8 | claimed → submitted | `submitted` | `evidence:submit` | 需有效 fencing |
| 9 | running → submitted | `submitted` | `evidence:submit` | 同上 |
| 10 | submitted → verifying | `verify_started` | `evidence:finalize` | — |
| 11 | verifying → ready | `rejected:<reason>` | `evidence:_reject` | assignee=None、attempts+1、删租约 |
| 12 | verifying → done | `evidence_ok` | `evidence:finalize` | **凭证有效** + 证据全 pass 覆盖 + 验证器白名单 + deps done + 闸门 passed；随后解锁下游 |
| 13–16 | claimed / running / submitted / verifying → ready | `recovered:crash_intermediate` / `recovered:incomplete_evidence` | `recovery:_reset_to_ready` | assignee=None、attempts+1、删租约 |
| 17–19 | ready / claimed / running → blocked | `<watchdog_reason>` | `watchdog:_block` | assignee=None、删租约 |

### 三层检查（validator 已跑通）

- **A 静态**：表内状态 ⊆ `graph.STATUSES`；每个 `site` 模块里确实存在该 status 与 reason 字面量
  （`reason_mode="any"` 处理 scheduler 的参数化 reason；`<...>` 占位符跳过字面量检查）。
- **B 覆盖**：凡出现 `graph.set_status(` 的模块必须在表里有条目 —— 新代码加了迁移却没登记会被报出来
  （`engine` 登记为 passthrough：`Engine.finalize()` 委派 `evidence.finalize()`，自身不写状态）。
- **C 语义**：临时库里真跑三条路径 —— ① claim→expire→ready（attempts=1 / assignee=None / `from` 真实 / replay 对齐）；
  ② 无凭证 done 必须 `CredentialError`，有凭证 done 成功并解锁下游；③ `recover()` 补推 `N-C` 且 mismatch=False。

### 实跑结果（`python wp10_transition_check.py` → exit=2，仅警告）

```
table_rows 19
writers    ["evidence","leases","recovery","scheduler","watchdog"]
reachable  ["blocked","claimed","done","planned","ready","submitted","verifying"]
unreachable["accepted","rejected","running"]
blocking   []          ← 表与当前实现无冲突
semantic   ["探针通过：expire 回收 / done 凭证闸门 / recover 补推 三条语义路径"]
warnings
  · 不可达状态（生产代码无入口）：accepted、rejected、running
  · blocked 无出边：看门狗阻断后没有解除路径（recover 也不解除）
```

### 三条要 Lead 裁决的契约缺口（不是 bug，是契约未定）

1. **`running` 无人写**：`claimed → running` 在生产代码里没有调用点（只有测试写）。要么 WP-05 的 engine
   在真正开工时补 `set_status("running", reason="agent_started")`，要么从 `STATUSES` 删掉，避免「状态存在但永不可达」。
2. **`accepted` / `rejected` 是死状态**：节点级 `rejected` 从未被写（驳回实际走 `verifying → ready`），
   `accepted` 无任何入口。二选一：删枚举，或指定写入方与语义（当前无 owner）。
3. **`blocked` 是黑洞**：`watchdog._block` 只进不出，`recovery.recover()` 不解除，`cli resume` 只解除全局终止（meta）。
   建议表里补 `blocked → ready`（reason=`unblocked:<原因>`，人工/策略触发，必须留痕）。

### 落地路径（均在写域外，需放行）

- 提升为门禁脚本：`tools/check_transitions.py`（与 `tools/check_fixtures.py` 并列，退出码 0/1/2 同语义）；
- 或提升为单测：`control_plane/tests/test_transitions.py`（进标准 discover 门禁）；
- 草案源码当前在 `%TEMP%\wp10_transition_check.py`，放行后我按上述路径原样落盘。

---

## R7 附 · 待命任务 ①：D 的 adapter conformance 夹具风险清单（只读）

> D 当前只到 R2（骨架 + 8 项 capabilities + spike），**A7 conformance 夹具尚未建**；
> 因此这里是「基于现有实现的只读复核 + 建夹具时必须覆盖的风险」，不是对已成夹具的复检。

**证据**：live `adapter_capabilities`（contractVersion 1.0.0 / 8 项 / quality 6 项）、
`.l0-adapter/adapter-state.json`（version 15，3 个实例已 closed，`verifications: {}`）、
`plugins/dsh-l0-adapter/lib/{store.js,service.js}` 源码。

| # | 风险 | 证据 | 影响 | 夹具用例 |
|---|---|---|---|---|
| R1 | **fencing fail-open**：写状态不传 token 一律放行 | `store.js fencingAccept`：`if (token === undefined \|\| token === null) return { ok: true, reason: 'no-fencing-supplied' }` | 旧 owner 漏传 token 即可覆盖新 owner 状态，takeover 语义被绕过 | `state.write` 不带 token → 必须 `ok:false / fenced-out`（或明确「首次写」例外并单独立证） |
| R2 | `verify` 的 `contains` **空 expected 假 pass** | `service.js`：`text.includes(String(acceptance.expected ?? ''))` → `includes('')===true` → `pass` | 验收条目漏填 expected 时「验什么都通过」，违反 unknown 不得当 pass | `{kind:'contains'}` 无 expected → 必须 `unknown`（当前 `pass`） |
| R3 | 源码中文二次编码损坏，且一处模板字符串丢了 `$` | `service.js`：`缂哄け`、`浜х墿涓嶅瓨鍦`、`` `涓嶆敮鎸佺殑楠屾敹鏉＄洰锛?{kind}` ``（应为 `${kind}`） | 错误信息不可读；`{kind}` 变字面量，断言/排障踩坑 | 断言 verify unknown 的 message 含真实 kind；CI 加源文件 UTF-8 合法性检查 |
| R4 | usage `totalTokens` 恒 0 | state：`calls 2 / input 15078 / output 6 / totalTokens 0` | WP-06 计量对账拿 totalTokens 比 ledger 会当成「无用量」 | 一致性断言：`totalTokens == input+output`（或显式声明语义含缓存并单独对账） |
| R5 | checkpoint 的 `lastSeq` 依赖 inspect、未 flush；状态文件里的 flush 原因是乱码 | `checkpoints[...].flush: "not-attempted: …闇€瑕佹椿 session 瀵硅薄"` | 强杀恢复只能靠控制面事件溯源对账，`lastSeq` 不可当权威断点 | 强杀用例：kill 后按 checkpoint 恢复，断言事件不丢、seq 对得上 |
| R6 | `verifications` 持久化为空 | state：`"verifications": {}` | verify/acceptance 路径从未真正跑过，R2 类假 pass 不会被发现 | 夹具必须落 `verifications` 记录（含 verdict + acceptance 原文） |
| R7 | A7 四态退出码只在控制面定义，adapter 侧无映射 | `cli.py`：0/2/3/4（成功/参数错/terminated/并发超限） | 两套退出码体系无对照表，跨层用例无法断言 | 夹具带「控制面退出码 ↔ adapter {ok,error}」映射表，四态各一例 |

**建议**：conformance 至少 10 例（spawn 双实例不串号 / call 收口 / artifact sha 不符 / verify 三态含空 expected /
takeover fencing 含漏传 token / checkpoint 强杀恢复 / usage 对账 / 四态退出码映射）。
R1、R2 是「先修再立夹具」还是「立夹具暴露」需 Lead 定 —— 我建议**立夹具暴露**，这两条正是 A7 该抓的。

---

## Lane A 最终结论

- WP-01 / WP-02 / WP-04 全部收口：全量 **238 tests OK** + fixtures **23/23**（R7 复核时点）。
- 直写收敛终态：`control_plane/*.py` 里除 `graph.py` 唯一入口外，**已无任何 `UPDATE tasks SET` 命中**。
- R7 追加两份只读产出：WP-10 迁移表可执行草案（19 行 / 三层检查 / exit=2 仅警告）、
  D 的 conformance 风险清单（7 条，含 2 条建议先修项）。
- 预算：7 / 8 轮；R8 待命。

---

## R8 · 迁移表落门禁 + `blocked → ready` 补口（Lead 裁决执行，Lane A 8/8 收口）

### 1. `blocked → ready`（真空洞补齐）

**改动**（`graph.py`）

- 新增常量 `UNBLOCK_REASON_PREFIX = "unblocked:"`。
- `set_status` 增加守卫：`prev == "blocked" and status == "ready"` 时
  **必须** `reason` 以 `unblocked:` 开头且后缀非空，否则 `GraphError`（拒绝发生在任何写入前）。
- 新增便捷入口 `graph.unblock(conn, node_id, reason, *, note=None, at=None, notify=True)`：
  自动补前缀、清 assignee、可带 `unblock_note`，事件仍由唯一入口统一发。
- 只约束 `blocked → ready` 这一条：其它迁移（含 `ready → planned` 降级）不受影响。

**测试**（`TestUnblock`，6 个）

| 用例 | 断言 |
|---|---|
| `test_unblock_helper_succeeds_and_audits` | ready、assignee=None、`status_changed.from=="blocked"`、`reason=="unblocked:…"`、`unblock_note` 落 payload、`snapshot==replay` |
| `test_set_status_with_prefixed_reason_allowed` | 直接调 `set_status` 带正确前缀也可解除 |
| `test_missing_reason_rejected`（**反向**） | 不带 reason → `GraphError`，节点仍 blocked，事件数不变 |
| `test_wrong_prefix_rejected`（**反向**） | `manual` / `unblock` / `release` / `unblocked` / `""` 全拒 |
| `test_empty_unblock_reason_rejected`（**反向**） | `unblocked:` 空前缀、`unblock(reason="")` 全拒 |
| `test_unblock_does_not_touch_other_transitions` | 解除后 `ready → planned` 仍可降级（守卫不外溢） |

### 2. 迁移表落 `control_plane/tests/test_transitions.py`（进 discover）

- 20 行表（原 19 行 + R8 的 `blocked → ready`），字段：`frm/to/reason/site/guards/effects/events`
  （`reason` 支持 `a|b` 或集、`<...>` 占位段跳过字面量检查、`reason_mode="any"` 处理参数化 reason）。
- 五层检查，全部为断言：

| 层 | 测试 | 作用 |
|---|---|---|
| A 静态 | `test_states_are_declared` / `test_sites_and_literals_exist` / `test_terminal_has_no_outgoing` | 表外状态、site 不存在、字面量漂移、终态出边 |
| B 覆盖 | `test_every_writer_is_in_table` | 有人新增 `set_status` 调用但没登记迁移 → 红（`engine` 记为 passthrough 委派） |
| C 语义 | `test_expire_path` / `test_done_requires_credential_and_unlocks_downstream` / `test_recover_promotes` | 真库跑过期回收、凭证闸门、恢复补推 |
| D 保留态 | `test_reserved_states_match_table` / `test_all_tables_states_reachable_from_planned_or_reserved` | 不可达集合必须**恰好等于** `["accepted","rejected","running"]`；谁让它们可达就要同步更新表 → 漂移即红（当前绿 = reserved 身份确认，不阻塞） |
| E 解除 | `TestUnblock` 6 例 | 见上 |

- 结果：`python -m unittest control_plane.tests.test_transitions` → **Ran 15, OK**。

### 3. 门禁复核（R8 时点）

| 项 | 结果 |
|---|---|
| Lane A 五套件（graph/events/leases/scheduler/recovery） | **全绿** |
| 新迁移表套件 | **15 tests OK** |
| 全量 `discover` | **Ran 262 tests**，1 error：`control_plane.tests.integration.test_adapter_conformance.test_conformance_mapping_matches_fixture`（`KeyError: 'map'`，**D 的写域**，见我上一条转 Lead 的定位） |
| `tools/check_fixtures.py` | 23 通过 / 0 问题 / 0 待核 |

### 4. 收口声明

- Lead 裁决 1（迁移表进 `test_transitions.py`、reserved 不阻塞、`blocked→ready` 补口）**已全部执行**；
  CLI `unblock` 命令按裁决归 C，未越域。
- Lead 裁决 2（不改 D 的插件）**遵守**：R8 未触碰 `plugins/`，风险清单仍为只读产出。
- Lane A **8/8 收口**，不再接新域。

---

## R9 · P0 hotfix：`done` 是运行时终态（E 的 M4 探针）；附 strict 验证器注册补口

### 1. 终态守卫（graph.py）

**问题（E 探针）**：`planned → done`（有凭证）→ `done → planned` → `done` 全部被接受 ——
即 `done` 不是终态，证据凭证只拦“进入”，不拦“退出”。

**改动**

- 新增 `TERMINAL_STATUSES = frozenset({"done"})`。
- `set_status` 加守卫（**在幂等判断与任何写入之前**）：
  `prev ∈ TERMINAL_STATUSES 且 status != prev` → `GraphError("终态不可退出：…")`；
  拒绝时状态、事件计数、replay 均不变。`done → done` 仍走幂等短路（不写事件）。
- `remove_node(..., allow_terminal=False)`：终态节点默认不可删；`allow_terminal=True` 只留给导入/夹具迁移脚本。
- `graph.replan()` **前置校验**：`remove` 里含终态节点 → 写入前 `GraphError`（不靠 remove_node 事后兜底），
  同一次 replan 的 `add` 也不得落库、`graph_version` 不变、事件数不变。

**测试**

| 文件 | 用例 | 断言 |
|---|---|---|
| `test_graph.py::TestTerminalGuard`（6） | `test_probe_done_to_planned_rejected` | 复刻 E 探针：`done → planned` 拒绝、状态仍 done、事件数不变 |
| | `test_all_exits_from_done_rejected` | 9 个目标状态（planned/ready/claimed/running/submitted/verifying/rejected/accepted/blocked）全拒 |
| | `test_exit_rejected_even_with_side_effects_requested` | 带 `assignee` / `attempts_delta` / `drop_lease` 的“退出”同样拒（不能绕过） |
| | `test_done_to_done_is_idempotent` | `done → done` 幂等、不写事件 |
| | `test_remove_node_rejects_terminal` | `remove_node(done)` 拒；`allow_terminal=True` 才可清理 |
| | `test_replan_cannot_remove_terminal` | replan 删 done 拒，且 add 未落库、版本/事件不变、replay 对齐 |
| `test_transitions.py::TestTerminalGuard`（2） | `test_table_and_code_agree_on_terminal` | 迁移表无终态出边 **且** 代码拒绝 `done → planned/ready/blocked/claimed` |
| | `test_terminal_node_survives_recover` | `recover()` 不动 done 节点，无 mismatch |

### 2. strict 模式的验证器注册（Lead 转 B 的 M5 发现）

- `test_events.TestLifecycleReplayAlignment.setUp`：`evidence.register_verifier(conn, "verifier-ci", kind="ci", role="ROLE-AUDIT-01")`。
- `test_stages.setUp`：`evidence.register_verifier(conn, "verifier-1", kind="ci", role="ROLE-AUDIT-01")`。
- 新增回归用例 `test_verifier_is_registered_for_strict_mode`：`resolve_verifier` 可解析；strict=1 下
  `add_evidence` 不再抛 `UnknownVerifier`，`finalize` 的拒绝理由**不再是** `verifier_unregistered`。
- **未改默认值**（`db.set_evidence_strict` 默认仍是 0），只在用例内临时开/关。

### 3. 遗留（strict=1 完整通过的剩余差异，归 B）

实测（`verifier-1` 场景，`out/x` 为假路径）：注册后 strict=1 的拒绝理由从
`verifier_unregistered` 变成 `artifact_invalid / path_missing` —— 即 **strict 还会复核 artifact 实体**
（`verify_artifact` 的 root 为 cwd，夹具里的假路径过不了）。这是 B 的 strict 语义/夹具路径问题，
Lane A 不改（本轮只做终态 + 注册）。

### 4. 门禁（R9 时点）

| 项 | 结果 |
|---|---|
| Lane A 套件（graph/events/leases/scheduler/recovery/transitions） | 全绿（graph 29、transitions 17、events 10、stages 5） |
| 全量 `discover` | **Ran 293 tests, OK** |
| `tools/check_fixtures.py` | 23 通过 / 0 问题 / 0 待核 |

---

## R10 · D2：迁移表 → `graph.set_status` 运行时白名单（P1，Lane A 最后一个补口）

### 1. 白名单落地（graph.py）

- 新增 `TRANSITIONS: frozenset[tuple[str, str]]`（16 条跨状态边，与 `test_transitions.py` 的 20 行表一一对应；
  4 行是同状态/终态相关，不入边集）。
- 守卫位置：**状态合法性 → 终态守卫（P0）→ 白名单 → 幂等短路 → 凭证 → 写入**。
  白名单与终态守卫同层，全部发生在任何 SQL/事件之前。
- 同状态迁移不走白名单（`verifying→verifying`、`done→done` 等仍是幂等/后像更新路径）。
- 新增 `allowed_transitions()`（邻接表只读视图）。
- `notify/commit/assignee/attempts_delta/drop_lease` 语义**未改**；`done` 仍只凭证进（新增用例专门回归）。

### 2. 单一事实源（防漂移）

`TestWhitelistRuntime.test_table_equals_runtime_whitelist` 断言
`{(row.frm,row.to)} == set(graph.TRANSITIONS)` —— 任一侧改了不同步就红。

### 3. 新增用例（`test_transitions.py`，22 个）

| 用例 | 断言 |
|---|---|
| `test_e_probe_three_edges_rejected` | **E 探针三条**：`planned→running`、`planned→verifying`、`verifying→submitted` 全拒（另加 `planned→claimed/submitted/done`、`verifying→planned/claimed/running/blocked`），拒绝时事件数不变、状态不变 |
| `test_legal_edges_still_pass` | 白名单内的链 `planned→ready→claimed→submitted→verifying→ready→planned` 全通、replay 对齐 |
| `test_enforcement_can_be_switched_off_as_rollback` | 关掉强制后旧路径可走，再打开立即恢复拒绝（回滚点可用性） |
| `test_done_credential_path_unchanged` | 合法边 `verifying→done` 仍需凭证；无凭证 `CredentialError` 且不写入 |
| `test_table_equals_runtime_whitelist` | 表 ↔ `TRANSITIONS` 完全相等 |

### 4. 历史用例改法（逐条走合法路径，未放宽白名单）

| 文件 | 原写法 | 改为 | 原因 |
|---|---|---|---|
| `test_graph.py` | `planned→running`（2 例） | `planned→ready` | running 不在白名单（reserved） |
| `test_graph.py::TestStatusMachine`（6 例） | 节点 `ready` 直接 `→done` | 构造 `verifying` 节点再 `→done`，断言 `from=="verifying"` | done 的合法前态只有 verifying |
| `test_graph.py::TestReplanAtomic` / `TestTerminalGuard` | `ready→done` | 节点构造为 `verifying` | 同上 |
| `test_scheduler.py`（3 例） | `running→done` | 节点构造为 `verifying` | 同上 |
| `test_recovery.py`（6 例） | `ready→done`；`claimed→running` | done 侧构造 `verifying`；running 侧改「构造 `running` + 直接落一行租约」复现崩溃 | 不为测试放宽 `claimed→running` |
| `test_leases.py`（1 例） | `claimed→running` 后过期 | 构造 `running` 节点 + 直接落租约行 | 同上 |
| `test_transitions.py`（3 例） | `ready→done` | 构造 `verifying` | 同上 |

### 5. 开关与回滚点

- `_ENFORCE_TRANSITIONS = os.environ.get("CP_TRANSITIONS_ENFORCE", "1") == "1"` —— **默认开（R11 收口）。**
- 回滚命令（任选其一）：
  ```powershell
  # 进程级：本次运行关闭白名单
  $env:CP_TRANSITIONS_ENFORCE = '0'; python -m unittest discover -s control_plane/tests
  ```
  ```python
  # 运行期：单进程关闭（生产排障用；不改变默认值）
  from control_plane import graph
  graph.set_transition_enforcement(False)
  graph.transition_enforcement()   # -> False
  ```
- 关闭后仍生效的硬约束：**终态守卫（P0）+ done 凭证**；只有跨状态白名单不生效。
- 归零前置（已闭环）：C 的 `test_runtime.test_tick_promotes_after_dependency_done` 已改为合法路径，
  `ready→done` 捷径不再存在，故默认值可以切 1。

### 6. 门禁（R11 最终记录，串行跑，`enforce = True` / `edges = 16`）

| 运行 | 命令 | 结果 |
|---|---|---|
| A | `python -m unittest discover -s control_plane/tests` | **Ran 308 tests, OK** |
| B | 同上（第二次连跑） | **Ran 308 tests, OK** |
| 稳定性补充 | 默认模式累计连跑 5 次 | 5/5 OK |
| 回滚开关 | `$env:CP_TRANSITIONS_ENFORCE='0'` 后全量累计 4 次 | 4/4 OK（回滚路径可用且不红） |
| fixtures | `python tools/check_fixtures.py` | **23 通过 / 0 问题 / 0 待核** |
| 运行时自检 | `graph.transition_enforcement()` | `True`；`len(graph.TRANSITIONS)` = 16 |

- 观察到一次 **不可复现** 的 `FAILED (failures=1)`（回滚模式、与 Lead 并行跑测试同一时段）：随后 8 次串行运行
  （默认 5 次 + 回滚 4 次，含该次后紧接的 3 次）全部 OK，未见 `WinError 32` 或用例 teardown 泄漏；
  所有新增用例均为 `conn.close()` → `TemporaryDirectory.cleanup()` 顺序。
- 结论：**Lane A 收口条件满足** —— 308 tests OK / 0 error、fixtures 23/23、白名单默认开启、回滚命令可用。







