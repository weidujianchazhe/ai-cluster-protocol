# 控制面 v1 · 参考实现

仅 **Python 3 标准库 + SQLite**；状态在库，Agent/planner 无状态；`done` 只能由证据事务触发。

## 模块

| 文件 | 职责 |
|---|---|
| `db.py` | SQLite schema（v4）：tasks / edges / decisions / evidence / artifacts / events / ledger / leases / lease_counters / stage_gates / replan_events / capabilities + 连接与迁移 |
| `events.py` | 只追加事件日志：append / iter / count（`EVT-000001` 自增） |
| `graph.py` | 节点/边/状态 CRUD，事务内写事件；`snapshot()` / `replay_snapshot()` |
| `scheduler.py` | ready 计算：**只由依赖 done 事件触发**；假 ready 降级；`bootstrap()` |
| `leases.py` | claim / renew / release / expire / takeover；fencing token 单调；过期需显式回收 |
| `decisions.py` | L0–L3 决策：L2 默认+超时（超时 chosen=default）、L3 硬闸门、override 留痕 |
| `evidence.py` | artifact / evidence / submit / **done 事务**（依赖+证据+覆盖+验证器）→ rejected→ready |
| `stages.py` | 阶段闸门（research/design/build/audit/deliver）+ replan 版本与事件 |
| `watchdog.py` | 预算 / 深度 / 并发 / 墙钟 / attempts / 全局止损；扫描留痕 |
| `capabilities.py` | 能力注册表、A2A Agent Card、人读导出（STATE/INDEX/tasks/decisions/capabilities） |
| `recovery.py` | 崩溃恢复：中间态退回 ready、完整证据保留、状态级一致性检查 |
| `demo_crud.py` | 端到端 CRUD Web 模拟 fixture |

## 命令

```bash
python -m unittest discover -s control_plane/tests -v     # 73 tests
python -m control_plane.demo_crud out/demo_crud           # 端到端模拟 + 导出
```

## 不变量（实现已机检）

1. `done` 只能由证据事务触发（生产方 `finish` 最多到 submitted）
2. `ready` 只能由依赖 `done` 事件触发（不轮询）
3. 租约需 fencing；过期先回收/接管，不可直接覆盖
4. L2 必须默认值+超时；超时 `chosen == default`；L3 必须显式确认
5. done 前阶段闸门必须 passed；replan 使 graph_version 递增
6. 预算/深度/并发/墙钟/attempts 超限即阻断或止损
7. 恢复只从已验证稳定点；事件重放与物化视图状态一致

## 最近验收

- 单元测试：**73 passed**（R11）
- 端到端 demo：全部节点 done、闸门全 passed、`DEC-003=timed_out`、`DEC-004=confirmed`、graph_version=2、**144 events**、导出 14 个文件
- 工程区 fixture：**23/23**（schema v2 + L1.1）
