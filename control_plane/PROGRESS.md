# 控制面 v1 · 进度日志

> 每轮追加；下一轮从「下一轮入口」继续。

## R1（2026-10-29）

- 建立包骨架与 SQLite schema：`control_plane/db.py`（meta/tasks/edges/decisions/evidence/artifacts/events/ledger/leases/stage_gates/replan_events/capabilities）。
- 连接与初始化助手：`connect()` / `init_db()` / `now_iso()` / json 辅助。
- 测试：`tests/test_db.py`（建库、表齐全、持久化、幂等初始化、schema_version）。
- 验收：`python -m unittest discover -s control_plane/tests -v` → **5 tests OK**。
- 下一轮入口：R2 事件日志 `events.py` + 工作图 `graph.py`（append/replay + 节点/依赖增删）。

## R2（2026-10-29）

- `events.py`：只追加日志（`append_event` / `iter_events` / `count`）；自动 `EVT-000001` 编号、可自定义 event_id/ts、按 seq 过滤。
- `graph.py`：节点 CRUD（add/get/list/remove/set_status）、边（blocks/artifact/review）、`dependencies()`、`snapshot()`、`replay_snapshot()`；每次变更在同一事务内写事件（node_added / edge_added / status_changed / node_removed）。
- 测试：`tests/test_events.py`（5）+ `tests/test_graph.py`（6）；含**快照 == replay**、**重开后 replay 正确**。
- 验收：`python -m unittest discover -s control_plane/tests -v` → **16 tests OK**。
- 下一轮入口：R3 `ready` 计算 + 依赖门控（由 done 事件触发，不轮询）。

## R3（2026-10-29）

- `scheduler.py`：`recompute_ready()`（先降级假 ready，再晋升依赖已满足的 planned）、`on_event()`（只有 `status_changed.to == done` 才触发重算）、`bootstrap()`（根节点入 ready）、`ready_set()`。
- 规则落地：**ready 不是轮询出来的**；不满足依赖的 ready 会被降回 planned；重算无变化时不写事件。
- 测试：`tests/test_scheduler.py`（5）——根节点晋升、依赖等待 done 事件、假 ready 降级、幂等、reason 留痕。
- 验收：**21 tests OK**。
- 下一轮入口：R4 租约（claim/renew/expire/takeover + fencing token）。

## R4（2026-10-29）

- `db.py` schema 升到 **v2**：新增 `lease_counters`（每节点 token 单调递增，release 后不回退）。
- `leases.py`：`claim` / `renew` / `release` / `expire` / `takeover` / `current_lease` / `assert_fencing`；错误类型 `LeaseHeld` / `LeaseExpired` / `FencingError`；claim 只接受 `ready`，过期必须先 `expire`/`takeover`。
- 测试：`tests/test_leases.py`（8）——双认领被拒、错误 token 被拒、过期续租被拒、过期回收 attempts+1、token 单调、未过期不得接管、接管后旧 owner 失效、release 后可再认领。
- 验收：**29 tests OK**。
- 下一轮入口：R5 决策 L0–L3（auto / L2 超时默认 / L3 硬闸门 + 账本）。

## R5（2026-10-29）

- `db.py` schema 升 **v3**：decisions 增 `created_at` / `deadline_at`（含轻量迁移）。
- `decisions.py`：`create_decision`（L0/L1 auto、L2 proposed+deadline、L3 blocked/confirmed）、`tick_l2`（超时→timed_out 且 chosen=default）、`confirm_l3`、`override`（推翻留痕）、`get/list`。
- 规则：L2 必须默认值+超时；L3 无 chosen 则 blocked；L0/L1 必须 chosen；事件 `decision_created / decision_decided / decision_blocked / decision_timed_out / decision_confirmed / decision_overridden`。
- 测试：`tests/test_decisions.py`（9）——auto、L2 参数校验、超时默认、L3 确认与重复拒绝、非法 confirm、override、选项/节点校验、账本过滤。
- 验收：**38 tests OK**。
- 下一轮入口：R6 证据 + done 事务 + rejected→ready。

## R6（2026-10-29）

- `evidence.py`：`add_artifact` / `add_evidence` / `list_evidence` / `submit`（需有效租约+fencing）/ `finalize`（done 事务）。
- done 事务校验：依赖全 done → 证据非空 → 全部 `pass` → 覆盖 `evidence_required` → 验证器在允许清单；任一项失败 → `rejected → ready` 且 `attempts+1`。
- done 成功后调用 `scheduler.on_event(done)`，**下游自动 ready**。
- 测试：`tests/test_evidence.py`（9）——成功 done、下游解锁、无证据/失败/缺类型/越权验证器/依赖未 done 驳回、fencing、artifact 校验。
- 验收：**47 tests OK**。
- 下一轮入口：R7 阶段闸门 + replan 事件（Root planner 桩）。

## R7（2026-10-29）

- `stages.py`：`set_gate/pass_gate/fail_gate/get_gate/list_gates`、`gate_allows_done`、`current_version`、`record_replan`（reason 白名单 + graph_version 递增 + events/replan_events）、`apply_replan`（先增删节点再记录）。
- `evidence.finalize` 增闸门检查：节点所在阶段闸门未 `passed` → `gate_not_passed` 驳回；驳回时**释放租约**并把节点回 `ready`（修复重复认领）。
- 测试：`tests/test_stages.py`（5）——闸门状态与校验、闸门阻断 done、通过后可 done、版本/重算记录、apply_replan 增删。
- 验收：**52 tests OK**。
- 下一轮入口：R8 看门狗（预算/深度/并发/墙钟/尝试上限/终止条件）。

## R8（2026-10-29）

- `watchdog.py`：`scan()` 统一执行租约回收、attempts/墙钟/预算阻断、深度/全局成本止损、并发告警；每次扫描写 `watchdog_scan` 事件。
- 阈值：`max_attempts=3`、`max_wall_sec=3600`、`max_depth=3`、`max_parallel=5`、`max_total_tokens/cost=None`（可覆盖）。
- 阻断动作：`node_blocked` + `status_changed → blocked`，释放租约；终止动作：`terminated + reason`。
- 测试：`tests/test_watchdog.py`（8）——attempts、墙钟、过期回收、深度、并发告警、节点预算、全局成本、扫描留痕。
- 验收：**60 tests OK**。
- 下一轮入口：R9 能力注册表 + A2A 预留 + 导出技能包格式。

## R9（2026-10-29）

- `db.py` schema 升 **v4**：capabilities 增 `description`（幂等迁移）。
- `capabilities.py`：`register_capability`（名称校验、upsert、事件）/ `get` / `list`；`agent_card()`（A2A 风格：skills/tags/inputModes）；`export_skill_format()`（STATE / INDEX / tasks/*.md / decisions.md / capabilities.md 人读投影）。
- 测试：`tests/test_capabilities.py`（5）——注册/更新事件、非法名、Agent Card 单/全量、导出文件与内容。
- 验收：**65 tests OK**。
- 下一轮入口：R10 端到端 CRUD Web 模拟 fixture（愿望→PRD→契约→生产→独立审计→交付）。

## R10（2026-10-29）

- `demo_crud.py`：端到端模拟——能力注册（4）→ 决策（L0/L1/L2 超时/L3 确认）→ 任务图（research→PRD→contract→DB→backend/frontend→integration→audit→deliver）→ replan 补 `NODE-DOCS` → 每节点 claim/submit/artifact/evidence/闸门/finalize → 看门狗扫描 → 导出人读投影。
- 修复：`finalize` 成功时释放租约；`leases.expire` 只把 `claimed/running` 回 ready（不再误改 done）。
- 持久化运行：`python -m control_plane.demo_crud out/demo_crud` → 全部节点 done、gates 全 passed、DEC-003 timed_out、DEC-004 confirmed、graph_version 2、**144 events**、watchdog 未终止、导出 14 个文件。
- 测试：`tests/test_demo_crud.py`（1）端到端断言。
- 验收：**66 tests OK**。
- 下一轮入口：R11 集成/恢复测试（崩溃恢复、从稳定点续、事件重放一致性）。

## R11（2026-10-29）

- `recovery.py`：`recover()`——回收过期租约、把 claimed/running 退回 ready（attempts+1）、submitted/verifying 仅在证据完整时保留；`last_done_event` / `stable_nodes`；状态级一致性检查（节点状态映射 + 边集合，避免 assignee/时间戳噪声）。
- 事件：`node_recovered` / `recovery_completed` / `recovery_mismatch`。
- 测试：`tests/test_recovery.py`（7）——快照/重放一致、running 退回、提交缺证据退回、完整证据保留、done 不受影响、幂等、关库重开后恢复。
- 验收：**73 tests OK**。
- 下一轮入口：R12 文档/总验收/管理区收尾（README、验证证据、STATE、check_fixtures + validate_workspace）。

## R12（2026-10-29 · 收尾）

- 文档：`control_plane/README.md`（模块/命令/不变量/验收）、工程区 `README.md` 增「控制面 v1」段、`ROADMAP.md` 完成状态表。
- 设计同步：Root 卡「验证证据」写入实现结果（12 模块 / 73 单测 / demo 144 events / 导出 14 文件）；预研总卡同步。
- 三套门禁：`unittest` **73 OK**；`tools/check_fixtures.py` **23/23**；`scripts/validate_workspace.py` **27 通过 / 0 问题 / 0 待核**。
- 结论：**控制面 v1 参考实现完成**（12 轮）；下一步可拆任务卡或接 DSH adapter。

