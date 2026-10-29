# LANES · 60 轮并行执行跟踪

> 预算口径见 `../AI集群工作协议-管理区/designs/_research/60轮并行分工与长任务.md`。
> 分支只写自己的 lane note；主窗口每轮更新本表。

| Lane | 内容 | 预算 | 已用 | 状态 | 最近报告 |
|---|---|---:|---:|---|---|
| 主 | 编排/集成/验收 | 12 | 4 | done | M11 验收：308 tests / 23 fixtures / 27 validate |
| A `p0-correctness` | 状态机→重放→恢复 | 8+1 | 10 | done | 终态守卫 + 16 条白名单默认开 |
| B `evidence-design` | 证据不可变+设计契约 | 7 | 5 | done | schema v5；strict 前置 P1/P2/P4 |
| C `runtime-meter` | engine/CLI+计量 | 7 | 8 | done | CRLF 修复；白名单适配；strict demo |
| D `dsh-adapter` | 骨架→spawn→状态→编队 | 17 | 7 | done | canonical；A7；agent_card roles |
| E `research-l1` | 问题态+L1 前置 | 7 | 7 | done | 两文档 + WP-10 + M4 差异 |
| 缓冲 | 返工/spike | 2 | 0 | — | — |

## 合并门禁（每轮）

```
python -m unittest discover -s control_plane/tests
python tools/check_fixtures.py
python scripts/validate_workspace.py ..\AI集群工作协议-管理区
```
