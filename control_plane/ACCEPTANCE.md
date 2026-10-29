# 控制面 v1.1 · 验收记录（2026-10-29）

> 依据：`designs/_research/60轮并行分工与长任务.md`；本文件是工程区验收面，管理区交接见 `reports/2026-10-29_控制面v1.1并行交付_win-11e1a541.md`。

## 门禁

| 门禁 | 命令 | 结果 |
|---|---|---|
| 单测 | `python -m unittest discover -s control_plane/tests` | **308 tests OK**（默认白名单开；A 5/5、回滚 4/4） |
| schema fixture | `python tools/check_fixtures.py` | **23 / 23**，exit 0 |
| 管理区 | `python scripts/validate_workspace.py .` | **27 通过 / 0 问题 / 0 待核** |
| A7 conformance | `python -m control_plane.tests.integration.a7_conformance` | pass=0 / drift=1 / failed=2 / unknown=3 |
| 适配器 | `adapter_capabilities` / `adapter_spike` | 8 能力 / codeVersion 3 / spawn 双路径 true |
| 端到端 | `python -m control_plane.demo_crud out/final_demo` | 全节点 done；graph_version=2；events=155 |
| strict 冒烟 | `out/strict_demo_smoke.py` | demo 10 / engine 4 artifact；sha_ok=true；rejections=[] |

## 不变量（已机检）

1. `done` 只能由 `graph.done_credential()` + 证据事务进入；无凭证拒绝。
2. `done` 是终态：`done→任意状态` 拒绝；`remove_node`/`replan` 默认不能删 done。
3. 运行时迁移白名单 16 条；`planned→running`/`planned→verifying`/`verifying→submitted` 拒绝；`CP_TRANSITIONS_ENFORCE=0` 可回滚。
4. `ready` 只由依赖 done 事件重算；假 ready 降级；recover 补推下游。
5. 证据/产物 append-only（同 ID 覆盖拒绝、attempt 历史保留）；坏 sha/path、未注册验证器、跨节点复用拒绝；`unknown` fail-closed。
6. 9 处直写收敛为 `graph.set_status` 唯一入口；`blocked→ready` 必须 `unblocked:<原因>`。
7. `apply_replan` 单事务：失败零副作用（节点/版本/事件不变）。
8. 租约 fencing 单调；过期先回收/接管；缺 token/旧 token 被拒。
9. L2 超时自动 tick；`terminated` 阻断 claim/submit/finalize；并发超限拒绝；ledger 真实行触发预算。
10. DSH：spawn 双路径、call 输出收口、checkpoint 对账、takeover fencing、verify 三态、职务 8 生产/3 审计/复合、审计独立。

## 关键文件

- 核心：`control_plane/graph.py`、`evidence.py`、`engine.py`、`runtime.py`、`cli.py`、`ledger.py`、`watchdog.py`、`capabilities.py`
- 适配器：`plugins/dsh-l0-adapter/`（canonical；probe2 未动）
- 测试：`control_plane/tests/`（含 `integration/`）
- 计划/证据：`control_plane/LANES.md`、`lanes/*.md`、`out/final_demo/`、`out/engine_demo/`
- 设计：`designs/_research/60轮并行分工与长任务.md`、`WP10契约增量清单.md`、`问题态与失效传播-运行时可实施设计.md`、`L1-serving前置条件.md`、`M4复核-C3C6适配器差异清单.md`

## 已知边界 / 后置

- `evidence_strict` 默认 **0**；strict=1 作 CI 第二门禁（P1/P2/P3 已满足，demo 自注册）。
- checkpoint 是**对账锚点**，不是权威断点（未调 `sessions.flush`）。
- A2A 仅 DB→A2A 单向投影；`verifying→working` 有损。
- 未做：鉴权/多租户、真实 A2A 传输、WP-10 的 `unit_write`/`UNIT_TRANSITION`/`role_plan` 代码落点、生产化迁移框架（WP-13）。
- 适配器 `native` 分级定义、价格表全零时的 `estimated` 闸门、`same_model_only` 三态属 WP-10 文档项。
