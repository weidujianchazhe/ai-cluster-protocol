# Lane C · `runtime-meter`（运行时驱动 + 计量）

> 任务板：task-7 · 预算 7 轮 · 写域：`control_plane/{engine,runtime,cli,ledger}.py`（新）、`watchdog.py`、`tests/test_{watchdog,ledger,engine,runtime,cli}.py`、本文件
> 任务卡（只读）：TASK-20261029-DEBB0C / TASK-20261029-32F976
> 门禁：`python -m unittest discover -s control_plane/tests`、`python tools/check_fixtures.py`

---

## R1 · engine 门面 + runtime 循环 + CLI + ledger 写入 API

**新增模块**

| 文件 | 职责 | 关键 API |
|---|---|---|
| `control_plane/ledger.py` | 计量账本：写入 / 价目表 / meter / 预算判定 | `append()` `rows()` `totals()` `budget_check()` `Meter` `meter()` `estimate_cost()` `PRICE_TABLE` |
| `control_plane/engine.py` | 运行时门面：终止闸门 / 并发门 / 计量挂点 / 视图 | `Engine.open()` `claim/renew/submit/finalize` `scan() tick() run()` `terminate() resume()` `meter()` `usage()` `status()` `done_credential()` |
| `control_plane/runtime.py` | 一轮 `tick` = L2 到期 + expire + scan + recompute；`run()` 薄循环；`demo()` 单进程跑完小图 | `tick()` `run()` `demo()` |
| `control_plane/cli.py` | argparse 单进程 CLI（JSON 输出 + 退出码） | `main(argv)`，子命令 23 个 |

**设计要点**

- `terminated` **落 `meta['run_terminated']`**（不是内存标志）：跨进程可见，reopen 后仍拒；
  闸门覆盖 `claim / renew / takeover / submit / add_evidence / finalize / replan`，拒绝时写 `action_denied` 事件。
- **并发门**在 `Engine.claim`：在跑（claimed/running）数已达 `max_parallel` → `ConcurrencyExceeded`（写 `claim_denied`）；
  watchdog 侧仍保留 `concurrency_exceeded` warning（只告警不改状态），硬拒只在门面。
- **计量只追加**：`ledger` 表无 cost 列（列归 Lane B），成本在读取时按 `PRICE_TABLE` 折算；
  行内成本一致性的前提是读写用同一 `model/prices`。
- engine **不自拼 done 事件**：`finalize()` 只做「终止闸门 → 委派 `evidence.finalize()`」。

**测试**：R1 结束时 4 个新测试文件（ledger / engine / runtime / cli）全绿。

**下一轮入口**：R2 —— watchdog 预算改读 `ledger.totals()`，A/B 合并后对齐。

---

## R2 · watchdog 预算读真实账本 + A/B 合并对齐

**改动**

- `watchdog.py`：`_node_totals` → `ledger.totals(conn, nid)`；节点预算改调 `ledger.budget_check(totals, node["budget"])`；
  全局汇总改 `ledger.totals(conn)`（删除手写 SUM SQL 与 `ledger` 变量名遮蔽）；scan 结果新增 `usage` 明细。
- `ledger.rows(model=, prices=)`：读回成本支持价目覆盖，修 `test_ledger::test_meter_price_override_changes_cost`
  （写入口径 1000.0 vs 默认价目读到 0.28，两者都要能取到）。
- `engine.finalize` / `done_credential`：按 A R1 冻结契约对齐（只读透出 `graph.done_credential()`，不产生副作用）。

**测试**：`tests/test_watchdog.py` 新增 `TestWatchdogRealLedger`（4 例）——`ledger.append` 触发 token 预算、
`ledger.meter` 触发成本预算、scan `usage` 与 `ledger.totals` 一致、meter 跨调用累计。

**阻塞**：无（A1 已合并；A R1 冻结的 done 凭证契约已消化）。

**下一轮入口**：R3 —— A R2 / B 合并后的跨域对齐，全量门禁。

---

## R3 · A R2 + B 合并后跨域对齐（本轮）

**Lead 派的 3 处跨域修单**

1. `tests/test_runtime.py` 直写 `graph.set_status(done)` → 改冻结契约：`evidence.add_artifact/add_evidence`
   + `graph.done_credential()` + `set_status(done, credential=…, reason="evidence_ok", notify=False)`，保留「依赖 done → 下游 ready」原意。
2. CLI `--now` 被 argparse 拒：子命令 `claim/renew/submit/decision-l2/tick/scan/run` 加 `--now`
   （`default=argparse.SUPPRESS`，不覆盖全局 `--now`）。
3. `watchdog._block` 直写 status → 改走 `graph.set_status(conn, nid, "blocked", reason=…, assignee=None, at=…, drop_lease=True, notify=False, commit=False)`，
   删除手写 `DELETE FROM leases` 与 `status_changed`；`node_blocked` 事件保留在前。

**顺带修正（同属写域）**

- `test_cli` schema 断言改为 `db.SCHEMA_VERSION`（B 已升 v5）；`node-add --bootstrap` 返回晋升后的节点；
  并发/恢复用例补 `--bootstrap`（原先是节点还没 ready 的测试自身缺陷）。
- 新增 `cli credential --node-id`：只读查看节点能否进入 done（走 `graph.done_credential`），
  便于 Lead / D 分支核对凭证而不写库；`cli.py` 清理未用 import。

**门禁**

```
python -m unittest discover -s control_plane/tests   → Ran 209 tests ... OK   (exit 0)
python tools/check_fixtures.py                       → 通过 23 / 问题 0 / 待核 0 (exit 0)
python -m control_plane.cli demo --root out/engine_demo
  → nodes 全 done · terminated=false · DEC-L2=timed_out · ledger rows=4 · ticks=5 · events=74
```

**验收对照（Lane C 章程）**

| 验收项 | 证据 |
|---|---|
| 单进程 `engine run` 完成全图 | `runtime.demo()` / `cli demo`（exit 0，全 done，74 事件）；`test_runtime.TestDemo` |
| `terminated` 阻断 claim/submit/finalize | `test_engine.TestTerminatedGate`（4 例，含 reopen 持久化与 `action_denied` 计数） |
| 并发超限拒绝 | `test_engine.TestConcurrencyGate` + `test_cli.test_concurrency_denied_exits_4`（退出码 4） |
| L2 到期自动 tick | `test_runtime.test_tick_advances_l2_timeout`、demo 的 `DEC-L2=timed_out` |
| ledger 每次调用落行 | `test_ledger`（append/meter/rows/totals 共 20 例）+ `ledger_appended` 事件 |
| 预算由真实行触发 | `test_watchdog.TestWatchdogRealLedger`（4 例）+ `test_engine.test_scan_persists_termination_from_global_cost` |

**阻塞 / 待 Lead 串行**

1. **价目表口径**：`ledger.totals()` 默认用 `PRICE_TABLE["default"]`；若某节点写入时用了 `model=` 覆盖，
   watchdog 的全局成本按默认价目重算（`ledger` 表没有 model/cost 列）。要精确对账需要 B 在 schema 里加
   `model`（或 `cost`）列 —— 属 B 的列批次，C 只提需求不擅改。
2. **`evidence.finalize` 的 rejected 分支**仍用 `graph.set_status(...)` 回 ready（B 已改），C 侧无需动作；
   `engine.finalize` 的返回值语义保持「done / rejected」两态不变。
3. `LANES.md` 主表由 Lead 更新（C 只写本 note）。

**下一轮入口（R4 备选，若 Lead 需要）**

- 价目表按节点/模型对账（等 B 的列）；
- `engine.meter` 与 D 分支 adapter usage 归集对接（`instance_id` 已预留）；
- `runtime.run` 增加 `--until-done` 语义（按 done 事件驱动停止而非轮询空闲）。

---

## R3+ · 价目口径（Lead 判定不做对账后顺带落地的最小改动）

Lead 指示：R4「价目表按节点对账」不做（等 WP-10 schema 批次），故本轮只保留**不需要 schema 改动**的部分：

- `watchdog.scan(limits=…)` 支持 `limits["model"]` / `limits["prices"]`：预算折算与写入价目同口径（不改表结构）。
- `Engine.scan()` 自动把自身 `model/prices` 透给 watchdog；`runtime.tick()` 的 usage 改走 `engine.usage()`
  （原先直接 `ledger.totals(conn)` 用默认价目，与 `engine.meter(model=…)` 写入可能不一致）。
- 新增 2 例：`test_watchdog.test_price_table_in_limits_moves_budget_line`、
  `test_watchdog.test_model_price_in_limits_is_honored`。

**回退路径**：只需删掉 `limits` 里的 `model`/`prices` 传递（`watchdog.scan` 的两处 `model=`/`prices=` 参数与
`engine.scan` 的三行注入），无数据结构变化。

**门禁（终态）**：`Ran 211 tests … OK`；`check_fixtures` 23/23；`cli demo` 全 done。

**状态**：Lane C 验收完成，Lead 已确认；余 4 轮**待命**（M5 可能补 CLI export 扩展 / conformance Python 侧夹具）。

---

## R5 · 待命任务：`cli unblock` + `cli export` 证据投影（写域只加 cli.py）

**改动（全部在 `control_plane/cli.py` + `tests/test_cli.py`，未碰 graph / evidence / db）**

1. `cli unblock --node-id --reason [--note]`
   - 走 A 的 `graph.unblock(conn, nid, reason, note=…)`（`blocked → ready`，事件 reason 为 `unblocked:<reason>`）；
   - `reason` 在 CLI 侧先 `strip()`：空/空白 → `ValueError` → 退出码 **2**（A 的 `graph.unblock` 只判 `not reason`，`"   "` 会漏过，故在门面前置校验）；
   - 终止态先过 `Engine._gate("unblock")`：抛 `Terminated` → 退出码 **3**，并写 `action_denied` 事件；
   - 成功输出 `{ok, node, reason}`，退出码 **0**。
2. `cli export --root DIR`（保留 `--out` 别名）
   - 先 `capabilities.export_skill_format()`（STATE / INDEX / tasks / decisions / capabilities）；
   - 再调 B 的 `evidence.export_evidence_projection()` 追加 `evidence.md` / `artifacts.md` / `verifiers.md`；
   - **只读适配**：`getattr` 探测 + 两种调用形态（位置/关键字）+ `TypeError` 降级，
     投影失败不拖垮整体导出（返回 `projection.status = ok | unavailable | signature_mismatch | error`）；
   - 输出 `{ok, root, files[], projection{status, files}}`，退出码 0。

**测试（`tests/test_cli.py` +5）**

- `TestCliUnblock`：成功（状态回 ready、assignee 清空、事件含 `unblocked:预算已调整`）／空白 reason 拒绝（退出 2 且节点仍 blocked）／终止态拒绝（退出 3）。
- `TestCliExportProjection`：`STATE.md/INDEX.md/evidence.md/artifacts.md/verifiers.md` 均生成且分别含 `EVD-A` / `ART-A` / `verifier-ci`；`--out` 别名可用。

**门禁**：`Ran 272 tests … OK`（exit 0）；`check_fixtures` 23/23（exit 0）。

**实跑证据**：`out/cli_smoke/`（init → node-add → blocked → unblock → artifact → evidence → export）：
8 个导出文件，`export.projection.status = ok`；`credential` 命令对未过闸门的节点返回 `ready_for_done=false`。

---

## R6 · B M5 缺陷修复：CRLF sha 假账 + P1 验证器注册

### 1) CRLF sha 假账（真实缺陷，Windows 专属）

**根因**：`Path.write_text(text, encoding="utf-8")` 在 Windows 会把 `\n` 翻成 `\r\n`（newline 翻译），
而登记 sha 用 `text.encode("utf-8")`（`\n`）→ 登记值与落盘字节不一致；B 的 strict 复核
（`evidence.verify_artifact`）报 `sha_mismatch`。

**修法（统一口径：写盘字节 = sha 字节）**

| 文件 | 位置 | 改动 |
|---|---|---|
| `control_plane/runtime.py` | `_write_artifact` | `data = text.encode("utf-8")` → `write_bytes(data)`，sha 由同一 `data` 算 |
| `control_plane/demo_crud.py` | `_write_artifact` | 同上（Lead 授权的跨域一行修，属 demo 夹具缺陷） |
| `tests/test_engine.py` | `_artifact` | 同上 |
| `tests/test_runtime.py` | `_artifact` | 同上 |

**验证**（`out/verify_sha.py`：跑 demo 后逐条 `evidence.verify_artifact`）

```
demo_crud   : nodes=['done'] artifacts=10 sha_mismatch=0 all_ok=True
engine_demo : nodes=['done'] artifacts=4  sha_mismatch=0 all_ok=True
```

> `cli.py artifact-add` 一直用 `Path.read_bytes()` 现算 sha，天然一致，无需改；
> `capabilities` / `evidence` 的 md 投影不参与 sha，保持 `write_text`。

### 2) P1 验证器注册（strict=1 不再 `verifier_unregistered`）

- `tests/test_engine.py` / `tests/test_runtime.py`：`setUp` 统一
  `evidence.register_verifier(conn, "verifier-ci", kind="ci", role="ROLE-AUDIT-01")`，
  用常量 `WORKFLOW_VERIFIER` 引用，避免字面量漂移。
- `tests/test_cli.py`：`setUp` 先 `db.init_db(self.db)` + 注册（CLI 每次新开连接，必须先落库）。
- `tests/test_demo_crud.py`：`run_demo` 前预建库并注册 `verifier-ci`（demo 内部自建连接）。
- `verifier-1` 只存在于 B 的 `test_evidence` / `test_stages`，两边已各自注册，C 侧无需处理。
- **未切默认值**：`meta['evidence_strict']` 仍为 0；strict 只在
  `tests/test_engine.py::TestNodeFlowStrict` 内显式 `db.set_evidence_strict(conn, True)` 验证。

**新增 strict 回归 3 例**

| 用例 | 断言 |
|---|---|
| `test_strict_flow_reaches_done_with_registered_verifier` | 注册验证器 + 字节一致 sha → `done` |
| `test_strict_rejects_unregistered_verifier` | `add_evidence` 抛 `evidence.UnknownVerifier`（证据不落库）→ finalize `no_evidence` |
| `test_strict_detects_crlf_sha_mismatch` | 按 `\n` 算 sha 但落盘 `\r\n` → `rejected`，reason ∈ {`sha_mismatch`,`artifact_invalid`} |

**门禁**：`Ran 293 tests … OK`（exit 0）；`check_fixtures` 23/23（exit 0）。

**交回 Lead 的说明（R6 时）**：`demo_crud.py` 当时未自注册验证器，默认 permissive 可跑；
R7 已按 Lead 要求补上自注册（见下）。

---

## R7 · strict=1 demo 自洽（验证器自注册）

**改动（不切默认值：`meta['evidence_strict']` 仍为 0）**

| 文件 | 位置 | 改动 |
|---|---|---|
| `control_plane/demo_crud.py` | `run_demo()` 初始化后 | `evidence.register_verifier(conn, "verifier-ci", kind="ci", role="ROLE-AUDIT-01")` |
| `control_plane/runtime.py` | `demo()` `Engine.open` 后 | 同上（用 `engine.conn`） |

两者都在**产生任何证据之前**注册，strict=1 时 finalize 的身份校验即可通过。

**测试**

- `tests/test_demo_crud.py::test_strict_end_to_end_self_consistent`：预置 strict=1 → `run_demo` →
  全 done、`node_rejected` 为空、10 个 artifact 逐条 `verify_artifact` 全 ok；
  原 `test_end_to_end` 删掉前置注册，改为验证 demo **自注册**即可跑。
- `tests/test_runtime.py::TestDemo::test_demo_completes_under_strict_evidence`：预置 strict=1 → `runtime.demo` →
  全 done、4 个 artifact 复核全 ok、`node_rejected` 为空。

**冒烟（`out/strict_demo_smoke.py`：预置 strict=1 再跑 demo，随后逐条复核）**

```
demo_crud(strict=1)   -> nodes=['done']  {"strict": true, "artifacts": 10, "sha_ok": true, "rejections": []}
engine_demo(strict=1) -> nodes=['done']  {"strict": true, "artifacts": 4,  "sha_ok": true, "rejections": []}
```

**门禁**：`Ran 303 tests … OK`（exit 0）；`check_fixtures` 23/23（exit 0）；
默认（permissive）demo 复核仍 `sha_mismatch=0`。

---

## R8 · 适配 A 的 D2 迁移白名单（最后一轮）

**缺陷**：`test_runtime.test_tick_promotes_after_dependency_done` 走 `ready → done`，
不在 `graph.TRANSITIONS` 白名单内；白名单默认关闭时侥幸通过，A 切默认 1 后会红。

**修法（只改测试，不碰 graph）**：构造**合法前态 + 凭证**

```python
self.add("NODE-A", status="verifying")          # 前态：verifying（done 的唯一合法来源）
... 证据 + stages.pass_gate ...
graph.set_status(conn, "NODE-A", "done",
                 credential=graph.done_credential(conn, "NODE-A"),
                 reason="evidence_ok", notify=False)
```

去掉 `bootstrap()`（原先是为了把 NODE-A 推成 ready）；NODE-B / NODE-B2 仍从 `planned` 由
`tick()` 的 `recompute_ready` 晋升，断言语义不变（`promoted` 含 NODE-B，`ready == [NODE-B, NODE-B2]`）。

**门禁（默认白名单关）**：`Ran 308 tests … OK`（exit 0）；`check_fixtures` 23/23（exit 0）。

**预演（A 切默认 1）**：`CP_TRANSITIONS_ENFORCE=1` 下全量同样 **308 OK（exit 0）**、
`check_fixtures` 23/23 —— C 域（engine / CLI / runtime / demo / watchdog 全部夹具）没有其它非法迁移残留。


