# 控制面 v1 · 12 轮路线图

> 目标：Python 3 标准库 + SQLite 的可运行参考实现；每轮以可运行/可复核增量结束。
> 状态文件：本目录 `PROGRESS.md`（每轮追加）；管理区 `STATE.md` 同步进展。

| 轮 | 交付 | 验收 |
|---|---|---|
| R1 | 包骨架 + SQLite schema（tasks/edges/decisions/evidence/artifacts/events/ledger/leases/gates/capabilities）+ 单元测试 | `python -m unittest discover -s tests` 通过 |
| R2 | 事件日志（append/replay）+ 工作图 CRUD | 事件可重放；节点/依赖增删正确 |
| R3 | ready 计算 + 依赖门控（由 done 事件触发） | ready 只依赖 done；不轮询 |
| R4 | 租约/认领/续租/过期接管 + fencing token | 双写被拒；过期可接管 |
| R5 | 决策 L0–L3（auto / L2 超时默认 / L3 硬闸门） | 决策账本可查；超时按默认 |
| R6 | 证据 + done 事务 + rejected→ready | 证据缺失/未通过即拒绝 |
| R7 | 阶段闸门 + replan 事件（Root planner 桩） | 闸门未过不得 done；replan 版本正确 |
| R8 | 看门狗：预算/深度/并发/墙钟/尝试上限/终止条件 | 超限即止损 |
| R9 | 能力注册表 + A2A 预留 + 导出技能包格式 | 能力可枚举；导出可读 |
| R10 | 端到端 CRUD Web 模拟 fixture（愿望→…→交付） | 全链路一次通过 |
| R11 | 集成/恢复测试（崩溃恢复、从稳定点续） | 不重放已完成 activity |
| R12 | 文档 + 管理区验证证据/STATE 收尾 + 总验收 | `check_fixtures` + `validate_workspace` 均 0 |

## 约束

- 仅 Python 3 标准库（sqlite3 / json / unittest / argparse），无第三方依赖。
- 状态只在 SQLite 与文件；Agent 无状态；`done` 只能由证据事务触发。
- 每轮结束更新 `PROGRESS.md`：轮次 / 做了什么 / 测试结果 / 下一轮入口。

## 完成状态（2026-10-29）

| 轮 | 状态 | 累计测试 |
|---|---|---|
| R1 db | ✅ | 5 |
| R2 events/graph | ✅ | 16 |
| R3 scheduler | ✅ | 21 |
| R4 leases | ✅ | 29 |
| R5 decisions | ✅ | 38 |
| R6 evidence/done | ✅ | 47 |
| R7 stages | ✅ | 52 |
| R8 watchdog | ✅ | 60 |
| R9 capabilities | ✅ | 65 |
| R10 demo | ✅ | 66 |
| R11 recovery | ✅ | 73 |
| R12 docs/验收 | ✅ | 73 |

端到端：`python -m control_plane.demo_crud out/demo_crud` → 全节点 done、闸门 passed、graph_version=2、144 events、导出 14 文件。
