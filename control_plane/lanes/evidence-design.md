# Lane B · evidence-design（证据不可变 + 设计契约）

> 预算 7 轮（已用 4）· 任务卡 TASK-20261029-3406F3 / TASK-20261029-F5A98E
> 写域：`control_plane/db.py`、`control_plane/evidence.py`、`control_plane/tests/test_evidence.py`、本文件。
> 只读：`graph.py`、`engine.py`、`cli.py`、`capabilities.py`、`plugins/`、管理区 `designs/`、管理区 `tasks/`。
> 门禁：`python -m unittest discover -s control_plane/tests`。

---

## R1 · schema v5 立项 + 列批次通知（2026-10-29）

**动作**
- 读：Lane 章程 `60轮并行分工与长任务.md` §3-B；管理区任务卡 `证据不可变与归属.md`、`设计契约补齐.md`（均为空模板，实质要求以任务板 task-6 描述为准）；`db.py`、`evidence.py`、`graph.py`、`stages.py`、`tests/test_evidence.py`、`tests/test_db.py`、`tests/test_stages.py`、`demo_crud.py`、`schema/work_graph.schema.json`。
- 基线：`python -m unittest discover -s control_plane/tests` → **73 tests OK**。
- 已 `send_message` 报备 db.py 列批次（v5）；Lead 批准并追加：ledger 加 `role`/`estimated`、strict=1 必须有测试、`INSERT OR REPLACE` 改为纯 INSERT、给 `capabilities.py` 留验证器注册钩子（不改本体）。

**决策（D0 可逆默认）**
1. `SCHEMA_VERSION 4 → 5`；`_migrate` 只加列/加表/加触发器，不删列、不改语义；二次 init 幂等（`db._migrate` 返回新增列清单，供测试断言空列表）。
2. append-only 双保险：API 层同 ID 直接报错（可读原因），DB 层触发器 `BEFORE UPDATE/DELETE → RAISE(ABORT)` 兜底。
3. `meta['evidence_strict']` 默认 `'0'`（兼容既有夹具 / demo / test_stages）；`init_db(..., strict=True)` 或 `db.set_evidence_strict()` 切 `'1'`。
4. `verdict='unknown'` 两模式都 fail-closed，finalize 细分原因 `evidence_unknown`。
5. 跨节点复用：无 `a2a_artifact_id` → 拒绝；有 → 放行并写 `artifact_uses`。

**新增表**：`verifiers`、`evidence_attempts`、`artifact_checks`、`artifact_uses`。
**新增列**：`evidence(attempt_no, identity)`、`artifacts(sha_algo, note, created_at)`、`ledger(role, estimated)`。

---

## R2 · db.py v5 + evidence.py 落地

**db.py**
- `SCHEMA_VERSION = 5`；`META_EVIDENCE_STRICT = "evidence_strict"`。
- 新表：`verifiers(verifier_id PK, kind, role, identity_json, active, created_at, revoked_at)`、`evidence_attempts(seq, evidence_id, node_id, kind, artifact_id, verifier_id, verdict, attempt_no, outcome, reason, at, detail_json)`、`artifact_checks(seq, artifact_id, node_id, ok, actual_path, actual_sha256, reason, at)`、`artifact_uses(seq, artifact_id, node_id, evidence_id, via, at)`。
- 触发器：`trg_evidence_no_update/no_delete`、`trg_artifacts_no_update/no_delete`、`trg_evidence_attempts_no_update/no_delete`。
- `_add_columns()` / `_migrate()` 幂等补列，写 `meta.migrated_at`、`meta.migrated_to`；`get_meta/set_meta/evidence_strict/set_evidence_strict`。
- ledger 并入 v5：`role TEXT`、`estimated INTEGER NOT NULL DEFAULT 0`（按 Lead 要求，C 可直接用）。

**evidence.py**
- 错误层级：`EvidenceError` → `ArtifactError` / `ArtifactImmutable` / `DuplicateEvidence` / `CrossNodeArtifact` / `NodeTerminal`。
- 产物：`add_artifact` 纯 INSERT（同 ID → `ArtifactImmutable`）；`get_artifact` / `list_artifacts` / `sha256_file`。
- 复核：`verify_artifact(conn, artifact_id, *, root=None, node_id=None)` 重算 sha + 归属 + `root` 越界检查，结果写 `artifact_checks`；`list_artifact_checks`。reason 枚举：`artifact_missing_row / unsupported_algo / path_outside_root / path_missing / not_a_file / sha_mismatch / cross_node`。
- 证据：`add_evidence` 纯 INSERT；被拒路径同样落 `evidence_attempts`（`rejected_duplicate / rejected_cross_node / rejected_invalid / rejected_terminal`）；跨节点 + a2a → `artifact_uses`（via=`a2a:<id>`）。
- 身份：`register_verifier / revoke_verifier / get_verifier / resolve_verifier / list_verifiers / set_identity_hook / get_identity_hook`。解析顺序 钩子 → 注册表；钩子抛错视为解析不出（fail-closed）。**给 D 的职务编队钩子**：`evidence.register_verifier(conn, "verifier-role-code-03", kind="role", role="ROLE-CODE-03")`（capabilities.py 本体未改）。
- finalize：状态机唯一入口化 —— `verifying` 与 `done` 都走 `graph.set_status()`；done 前先 `graph.done_credential(conn, node_id)` 铸凭证（None → `credential_unavailable` 拒绝），再 `set_status(..., "done", reason="evidence_ok", credential=cred, drop_lease=True, notify=False, commit=False)`，并在同一事务里追加 `node_done` 审计事件；事务提交后 `scheduler.on_event()` 解锁下游。驳回路径同样走 `set_status("ready", attempts_delta=1, drop_lease=True)`，并保留 `node_rejected` 事件。
- 导出投影（导出清单缺口补齐）：`export_evidence_projection(conn, out_dir)` → `evidence.md`（证据链 + attempt 历史）、`artifacts.md`（产物 + sha 前缀 + 复核 ok/总 + 跨节点复用）、`verifiers.md`（注册表）。
- 检查顺序（固定，供其它 lane 依赖）：依赖 done → **有证据** → 阶段闸门 → 验证器 allowlist → （strict）验证器身份 → unknown → fail → 必需 kind → （strict/显式）artifact 复核 → 铸凭证 → done。
  - 与 C 的 engine strict 用例对齐后的两条接口契约：① strict 下未注册验证器在 **add_evidence 写入前**抛 `UnknownVerifier`（不留脏证据），finalize 仍保留纵深防御检查；② artifact 复核失败顶层 `reason=artifact_invalid`，具体原因放 `detail.artifacts[].reason`（`sha_mismatch` / `path_missing`），纯跨节点场景为 `artifact_cross_node`。

---

## R3 · 反向用例（38 个，全绿）

`tests/test_evidence.py` 由 9 → **38** 个用例，新增覆盖：

| 验收项 | 用例 |
|---|---|
| 同 ID 覆盖被拒 + attempt 历史保留 | `test_duplicate_evidence_rejected_and_history_kept`、`test_attempt_no_tracks_rejections` |
| DB 层不可改不可删 | `test_sql_update_and_delete_blocked`、`test_duplicate_artifact_rejected_and_immutable` |
| 非法 verdict 留痕 | `test_bad_verdict_rejected_and_logged` |
| artifact path/sha 复核 | `test_verify_ok / sha_mismatch / path_missing / path_outside_root / unknown_artifact` |
| **坏 artifact 不能 done**（strict） | `test_strict_tampered_artifact_blocks_done`、`test_strict_missing_artifact_file_blocks_done` |
| strict 正常路径 | `test_strict_good_artifact_done` |
| done 后追加证据 | `test_strict_rejects_evidence_after_done`、`test_permissive_allows_late_evidence_but_keeps_history` |
| 跨节点复用拒绝 / A2A 放行 | `test_cross_node_reuse_rejected`、`test_a2a_reuse_allowed_and_logged`、`test_cross_node_without_a2a_blocks_done` |
| **未注册验证器被拒**（strict） | `test_unregistered_verifier_rejected_when_strict`、`test_identity_hook_failure_is_unresolved` |
| 注册 / 撤销 / 钩子 | `test_registered_verifier_passes`、`test_revoked_verifier_rejected`、`test_identity_hook_resolves_and_unknown_fails_closed` |
| unknown fail-closed（两模式） | `test_unknown_fail_closed_permissive`、`test_unknown_fail_closed_strict` |
| **迁移幂等** | `test_migration_adds_columns_and_is_idempotent`（旧 v4 库 → v5，旧行保留、新列默认值、触发器就位、二次 init `_migrate` 返回 `[]`）、`test_strict_flag_follows_init_argument_and_meta`、`test_ledger_role_estimated_writable` |
| 导出投影 | `test_export_evidence_projection` |

**测试结果**
- `python -m unittest control_plane.tests.test_evidence` → **38 OK**。
- 本 lane 触及面 + 相邻未动 lane：`test_evidence test_db test_stages test_demo_crud test_events test_leases test_capabilities test_decisions test_watchdog` → **93 OK**。
- 全量 `unittest discover` → **189 tests，182 绿 / 7 红**，7 红全部来自 A/C 在飞的状态机凭证适配与 CLI 断言，见下「跨 lane 阻塞」。

**跨 lane 阻塞（不属 Lane B 写域，已在消息里报 Lead）**
1. `test_cli.TestCliBasics.test_init_returns_schema_version` 断言 `schema_version == 4`，v5 后应为 `db.SCHEMA_VERSION`（C 的 `test_cli.py`）。
2. `test_cli` 三个用例 `--now` 参数位置 / bootstrap 断言失败（C 的 cli.py 在飞）。
3. `test_runtime.test_tick_promotes_after_dependency_done` 直接 `graph.set_status(done)` 无凭证（C 的测试待适配 A 的冻结契约）。
4. （R2 已报）`test_recovery` ×2、`test_scheduler` ×2 同类问题，A 正在修。

---

## R4 · 设计契约补齐（TASK-20261029-F5A98E 交付）

> 依据：`designs/Root编排与控制面.md`（R1 目标/不变式、R7 拍板、R8 职务编队）、`designs/_research/L0调用层-设计细化.md` §1–§10、`schema/work_graph.schema.json` v2、以及本版代码事实（`graph.py`/`stages.py`/`leases.py`/`evidence.py`/`capabilities.py`）。**代码事实优先于文档描述**，冲突处标「偏差」。

### 4.1 状态集（canonical）

| 对象 | 状态集 | 权威实现 | 迁移守卫 / 说明 |
|---|---|---|---|
| node | `planned → ready → claimed → running → submitted → verifying → done`；侧路 `ready`（驳回）/ `blocked`；预留 `accepted` / `rejected` | `graph.STATUSES`（10 值）、`graph.set_status` 唯一入口 | claim 需租约 + fencing；submit 需 claimed/running；**done 仅在 `GATED_STATUSES={"done"}` 且持 `graph.done_credential()` 时放行**；驳回 → ready 且 attempts+1 |
| instance | `spawned → attached → active → released / expired → replaced` | `leases`（owner / fencing_token / heartbeat_at / expires_at） | 过期必须 expire/takeover，不可直接覆盖；接管从进度锚点续作（L0 §3） |
| graph | `draft → active → closing → closed` | `stages.current_version` + `replan_events` | closing 需全部节点终态或显式放弃（v1 未强制） |
| gate | `pending / passed / failed` | `stages.GATE_STATUSES` | **只有 passed 放行 done**；缺行 = 不放行 |
| decision | `proposed / auto / timed_out / confirmed / overridden / blocked` | `decisions`（CHECK level L0–L3） | L2 必须带默认值 + 可逆 + 超时（schema 已约束）；只有 L3 允许停 |
| evidence verdict | `pass / fail / unknown` | `evidence.py` | **unknown fail-closed**：永不参与 done，finalize 报 `evidence_unknown` |
| lease | `active / expired` | `leases` | fencing token 单调递增，release 不回退 |

偏差/风险：`accepted`、`rejected`、`blocked` 在 schema 与 `STATUSES` 中存在，但主链未使用（驳回直接回 `ready`）；L0 §2 的 `accepted ≠ merged`、`node done ≠ graph closed` 目前只在语义层，没有 graph 终态机制。

### 4.2 阶段与闸门

- 阶段序：`research → design → build → audit → deliver`（`stages.STAGES`）。
- 闸门判定：`gate_allows_done(conn, stage)`，`stage=None` → **放行**（兼容性豁免）。
- 节点 done 的前置：依赖全 done → 阶段闸门 passed → 证据齐备（类型/验证器/复核）。
- replan 原因枚举（5）：`gate_failed / evidence_insufficient / scope_change / decision_override / failure_retry`；每次 replan 递增 `graph_version` 并落 `replan_events`。
- **建议（交 Lead）**：v5.1 起把「无 stage 节点」改为必须显式 `stage_exempt=true`，否则闸门缺失即拒绝，避免绕过 audit 闸门。

### 4.3 阈值（可执行清单）

| 项 | 阈值 | 出处 | 现状 |
|---|---|---|---|
| token / 调用 / 墙钟 / 成本预算 | `max_tokens ≥ 1`、`max_calls ≥ 1`、`max_wall_min ≥ 0.1`、`max_cost ≥ 0` | schema `budget` | 字段已校验；**账本真实行触发**由 C 的 ledger/engine 落实 |
| 预算预警 / 硬停 | 80% 预警；100% 硬停（降并行、停 spawn、保留未完成 node） | L0 §8 | 未在 control_plane 强制，依赖 C |
| 并发上限 | 并行实例 ≤ 5 | Root 卡不变式 | engine `--max-parallel`（C） |
| 深度上限 | 依赖深度 ≤ 3 | Root 卡不变式 | engine `--max-depth`（C） |
| 尝试上限 | 由 `--max-attempts` 控制；每次驳回 attempts+1 | 卡 + `evidence._reject` | B 侧计数已落，终止判定在 C |
| 租约 | ttl 由 claim 指定；心跳写 `heartbeat_at`；过期可接管 | leases | 已实现 |
| fencing | 每次 claim/takeover token 单调 +1，写前校验 | leases | 已实现 |
| L2 决策 | `timeout_sec`（0=不超时）+ `deadline_at`；到期按默认值推进记 `timed_out` | decisions | 已实现 |
| 验证器 trust | `deterministic / cited / human / model_judge`；`model_judge` 不得单独作为 done 依据 | L0 §7 | **缺口**：v5 `verifiers.kind` 未约束 trust 枚举 |
| 上下文组包预算 | 系统 10% / 项目 20% / 任务 20% / 问题态 20% / 证据 20% / 影响标记 10% | L0 §4 | 实验起点，未实现 |
| 超时 / 崩溃 | 超时 = unknown；verifier 崩溃 = unknown + 事件 | L0 §7 | 需验证器执行器落地（后续 WP） |

### 4.4 能力契约与职务编队

- **能力条目 = 职务契约**（不是常驻 Agent）：`capabilities(name, description, input_contract, output_contract, tools[], acceptance_template, cost_profile)`；name 必须匹配 `^[a-z][a-z0-9_]{1,63}$`。
- **A2A Agent Card ≈ skill 投影**：`capabilities.agent_card(conn, name)`，只读导出。
- **职务可重复 / 可复合**（R8）：实例 ID `ROLE-<职务>-<序号>`（如 `ROLE-CODE-03`）；账本按实例 + 职务聚合（v5 `ledger.role` 已备）；编队变更写 `replan_events`。
- **审计独立约束**：同一节点的生产职务与审计职务不得由同一实例承担 —— **机制缺口**：无 `role_slots_json` / 无交叉校验落点（需 `graph.add_node` 增列，A 写域 + schema v6）。
- **验证器身份钩子（B 已提供，D 接线）**：`evidence.register_verifier(conn, verifier_id, kind=, role=, identity=)`；strict 模式下未注册 / 已撤销 / 钩子解析失败 → `verifier_unregistered`；钩子签名 `hook(conn, verifier_id) -> dict|None`（`evidence.set_identity_hook`）。

### 4.5 A2A 方向（v1：只出不进）

| L0 概念 | A2A 概念 | 落点 | 方向 |
|---|---|---|---|
| capability | Agent Card / skill | `capabilities` + `agent_card()` | DB → A2A 导出 |
| node | Task | `tasks` + 预留 `node.a2a_task_id` | DB → A2A 导出 |
| artifact | Artifact | `artifacts` + `a2a_artifact_id`（v5 保留原列）+ `artifact_uses`（v5 新增） | DB → A2A；跨节点引用需显式 a2a 声明 |
| event / message | Message | `events`（`influence_marks` 只标「受外部影响」不记内容） | DB → A2A 导出 |
| 验证器 | — | `verifiers`（v5） | 仅内部；不外发判定 |

不变式：**A2A 侧不得回写** `tasks` / `evidence` / `artifacts`（无 inbound 通道）；a2a 字段不参与 done 判定；导出为投影，权威在 DB。合规性由 v5 的 `artifact_uses`（via=`a2a:<id>`）+ `evidence_attempts` 审计留痕。

### 4.6 导出清单

**现有（`capabilities.export_skill_format`）**：`STATE.md`、`INDEX.md`、`tasks/<NODE>.md`（每节点一份）、`decisions.md`、`capabilities.md` —— demo 共 14 个人读文件（2 + 9 + 3）。
**B 补齐（v5，`evidence.py`）**：`evidence.md`、`artifacts.md`、`verifiers.md`（`export_evidence_projection`）。
**缺口（后续 lane）**：`state_units`（问题态，E 域）、`ledger` 明细与成本摘要（C 域）、`replan_events` 人读视图。
**权威约定**：DB 唯一权威，导出是投影；导出只读 DB、不写回；`meta.schema_version=5` + `meta.migrated_to` 标记版本。

### 4.7 契约缺口与建议（交 Lead 裁决）

| # | 缺口 | 影响 | 建议 | 分级 |
|---|---|---|---|---|
| G1 | `test_cli` 断言 `schema_version==4` | C 的测试红 | 改 `db.SCHEMA_VERSION`（C 执行，B 不碰） | D0 |
| G2 | `role_count` / 复合职务 / 审计独立无 DB 落点 | R8 无法机检 | schema v6：`tasks.role_slots_json` + finalize 阶段做「生产者实例 ≠ 审计实例」校验（A 域） | D1 |
| G3 | `capabilities` 缺 verifier 的 trust / version / 可否自选 | L0 §7 要求「不可由生产者自选」 | v5 `verifiers` 加 `trust` 枚举与 `verifier_version`（B 可在下一轮加列） | D1 |
| G4 | 无 stage 节点绕过闸门 | audit 可被跳过 | 强制 stage 或显式豁免字段 | D1 |
| G5 | 导出无 state_units / ledger | 追溯链不完整 | E / C 各自补投影，B 已定接口形态 | D0 |

### 4.8 **M5 复查**（Lead 指定）

`evidence_strict` 默认 `'0'` 是**兼容性默认**，原因：既有夹具的产物路径多为占位字符串（如 `out/x.txt`），且历史验证器未注册；强制复核会误杀。
**M5 复查结论**：见 §4.10 —— v1 保持默认 0 + `strict=1` 作 CI 第二门禁，**可行**；直接切默认 1 会红 12 例（11 例验证器未注册 + 1 例默认值断言）。

### 4.9 缺口裁决（Lead D0 · 2026-10-29）

| # | 裁决 | 落点 |
|---|---|---|
| G1 `test_cli` 断言 `schema_version==4` | 已由 C 修为 `db.SCHEMA_VERSION`，全量已绿 | C |
| G2 `role_count` / 复合职务 / 审计独立 | **defer WP-10/D**；本轮不加 schema v6。职务用 `ledger.role` + `verifiers.role` 注册；审计独立性在**编队分配层（D）**强制（生产者实例 ≠ 审计实例） | D / WP-10 |
| G3 `verifiers` trust / version | **defer WP-10**，不占余轮 | WP-10 |
| G4 `stage=None` 绕过闸门 | v1 记为「非交付 / 夹具例外」；WP-10 加显式 `stage_exempt`；本轮不改代码 | WP-10 |
| G5 导出缺 `state_units` / `ledger` | C/D 接 CLI 导出时补（B 已定接口形态与投影写法） | C / D |

> 结论：Lane B 交付面冻结。余 3 轮待命（M5 复查 strict 默认 / 复核 E 的 WP-10 契约清单）。

### 4.10 M5 复查报告（2026-10-29 · 余轮 1 · 只读，未改代码、未改默认值）

**方法**：不落盘改任何源文件，改动只存在于探针进程内存：
- 口径 2「strict=1」= patch `db.init_db`，默认传 `strict=True`（等价于把库默认切 1）；
- 隔离实验 A = strict 关闭、仅强制 `verify_artifacts=True`（隔离 artifact 复核）；
- 隔离实验 B = strict=1 且 `resolve_verifier` 全部可解析（隔离验证器注册）。

| 口径 | 结果 | 说明 |
|---|---|---|
| 1. 默认 `strict=0` | `unittest discover` → **280 tests OK**；`tools/check_fixtures.py` → **23 通过 / 0 问题 / 0 待核** | 交付基线，零破坏 |
| 2. `strict=1` | **280 tests → 12 红（9 F + 3 E）** | 见下归因 |
| A. 仅强制 artifact 复核 | **9 红（6 F + 3 E）** | 验证器问题屏蔽后暴露的 artifact 问题 |
| B. strict=1 + 验证器全解析 | 13 红 | = A 的 9 例 + 我 3 个 strict 负例（被「全解析」打掉，属实验副作用）+ 默认值断言 1 例 |

**口径 2 归因（12 红）**

| 类别 | 例数 | 用例 | 原因 |
|---|---:|---|---|
| 未注册验证器 | 11 | `test_demo_crud.test_end_to_end`、`test_runtime.TestDemo` ×2、`test_cli.test_demo_command_completes_graph`、`test_engine.TestNodeFlow.test_full_flow_…`、`test_events.test_full_lifecycle_stays_aligned`、`test_evidence.TestEvidence` ×4、`test_stages.test_done_blocked_until_gate_passes` | `reason=verifier_unregistered`：`verifier-ci`（demo/runtime/cli/engine/events）与 `verifier-1`（evidence/stages 旧夹具）从未 `register_verifier` |
| 默认值语义断言 | 1 | `test_evidence.TestMigrationV5.test_new_db_reports_v5_and_strict_off` | 断言新库默认 off，切 1 必然反转（测试写死默认值，应改为常量/入参断言） |

**隔离实验 A 归因（9 红）—— 即「验证器都注册后还剩什么」**

| 类别 | 例数 | 用例 | 具体原因 |
|---|---:|---|---|
| 占位路径 | 4 | `test_evidence.test_done_transaction_success` / `test_done_unlocks_downstream`（`out/x.txt`）、`test_stages.test_done_blocked_until_gate_passes`（`out/x`）、`test_events.test_full_lifecycle_stays_aligned`（`out/a.txt`） | `path_missing` |
| 真实文件 sha_mismatch | 4 | `test_demo_crud.test_end_to_end`、`test_runtime` ×2、`test_engine.test_full_flow_…` | `sha_mismatch` |
| 连带失败 | 1 | `test_cli.test_demo_command_completes_graph`（exit 2） | demo 被上面的 sha_mismatch 打断 |

**sha_mismatch 是真缺陷（strict 的价值证明，不是夹具噪声）**：`demo_crud.py:38-39`、`runtime.py:132-133`、`tests/test_engine.py` 的 `_artifact()` 都写成
`p.write_text(text, encoding="utf-8")` + `sha256(text.encode())`。Windows 下 `write_text` 把 `\n` 翻成 `\r\n`，落盘字节 ≠ 被哈希字节 ⇒ 登记的 sha 从第一天起就是「假」的。Linux CI 不暴露；修法：`write_bytes(text.encode("utf-8"))` 或 `write_text(..., newline="")`。

**结论**
1. **v1 保持默认 `0` 可行**：默认 0 下 280 单测 + 23 fixture 全绿，零破坏。
2. **`strict=1` 作 CI 第二门禁可行**，但不能今天直接开：需先付 P1–P3，否则 12 红。
3. 建议门禁形态：主 job = 默认 0 全量；第二 job = `strict=1`，先跑 `test_evidence.py`（现 39 例，strict 口径 0 红）+ demo/runtime 冒烟，绿后接全量。

**启用前置条件清单**

| # | 前置 | 具体动作 | 归属 | 状态 |
|---|---|---|---|---|
| P1 | 验证器注册全覆盖 | demo/runtime/cli/engine/events 夹具统一 `evidence.register_verifier(conn, "verifier-ci", kind="ci", role="ROLE-AUDIT-01")`；`verifier-1` 同样注册或改 id 归一 | C/D 夹具（B 的 API 已就绪） | B 侧已完成（test_evidence 夹具） |
| P2 | artifact 真实路径 | 占位 path（`out/x.txt`、`out/x`、`out/a.txt`）改为 tmp 真实文件 | A/C 夹具 | B 侧已完成（test_evidence 全改真实文件） |
| P3 | 落盘字节 = 登记 sha | `demo_crud.py:38-39`、`runtime.py:132-133`、`tests/test_engine.py::_artifact` 改 `write_bytes` / `newline=""` | C | 待 C |
| P4 | 默认值断言改常量 | 已改 `test_strict_flag_follows_init_argument_and_meta`：断言与 `init_db(strict=…)` 入参 / meta 一致，不写死 | B | ✅ 完成 |
| P5 | 门禁接线（可选） | 第二 job 用 `DSH_EVIDENCE_STRICT=1`（需 B 在 `init_db` 读环境变量，小改、需 Lead 批）或直接用 `init_db(strict=True)` 的入口脚本 | B / C | 待批 |

> 本轮只读：未改 `db.py` / `evidence.py` / 默认值 / 任何测试；探针脚本放 `%TEMP%`，不落工作区。

### 4.11 M5 后续修正（Lead 指派的两件小事 + C 接口对齐）

| 改动 | 内容 | 结果 |
|---|---|---|
| 夹具验证器注册 | `TestEvidence.setUp` 注册 `verifier-ci`（kind=ci, role=ROLE-AUDIT-01）与 `verifier-1`（kind=ci）；strict 负例（TestVerifierIdentity / TestStrictDone）语义不变 | strict 口径下不再误杀 |
| P2（域内） | `TestEvidence` 的 `out/x.txt`、`out/y.txt` 换成 tmp 真实文件（`write_bytes` + `read_bytes` 计 sha） | strict 口径 0 红 |
| P4 | `test_new_db_reports_v5_and_strict_off` → `test_strict_flag_follows_init_argument_and_meta`：断言 strict 开关与 `init_db(strict=True/False/None)` 入参 / meta 一致，另测 `strict=None` 不改写既有设置 | 不再写死默认值 |
| 接口对齐（C 的 `test_engine.TestNodeFlowStrict`） | ① strict 下未注册验证器改为 **add_evidence 写入前**抛 `UnknownVerifier`（新增异常类，仍属 `EvidenceError`），finalize 保留纵深防御；② artifact 复核失败顶层 `reason=artifact_invalid` + `detail.artifacts[].reason`；③ 检查顺序调整为「依赖 → 有证据 → 阶段闸门 → …」（无证据时 `no_evidence` 比 `gate_not_passed` 更能解释失败） | C 的 3 个 strict 用例全绿 |

**测试**：`test_evidence` **39 OK**（默认口径）；strict 口径探针 **39/39 绿（0 红）**，且 4 个 strict 负例仍按预期拒绝；`test_engine` 全绿；全量 `unittest discover` → **293 tests OK**。默认值仍为 `evidence_strict=0`（未改）。


---

## 预算与状态

| 轮 | 内容 | 状态 |
|---|---|---|
| R1 | schema v5 立项 + 列批次通知 + 基线 | ✅ |
| R2 | db.py v5 + evidence.py（append-only / 复核 / 身份钩子 / 凭证消费） | ✅ |
| R3 | 反向用例 38 个（strict / append-only / 迁移幂等 / 导出） | ✅ |
| R4 | 设计契约补齐（6 类契约 + 缺口 + M5 复查） | ✅ |
| R5 | 缺口裁决归档 + 交付冻结（task-6 complete，199 tests OK） | ✅ |
| R6 | M5 复查（两口径 + 隔离实验 + 前置清单） | ✅ |
| R7 | M5 后续修正：夹具注册 verifier / 真实 artifact 路径 / P4 去硬编码 / 与 C 的 strict 用例接口对齐（293 tests OK） | ✅ |
| 余 1 轮 | 待命：复核 E 的 WP-10 契约清单 / P5 门禁接线（需批） | 待命 |
