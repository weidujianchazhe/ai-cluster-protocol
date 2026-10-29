# DSH 原生插件 · 60 轮跟踪

> 计划：`../AI集群工作协议-管理区/designs/_research/DSH原生插件-60轮长任务.md`
> 权威：插件 journal（待建）；TeamTask 是投影；Python control_plane 冻结为 oracle。

| Lane | 内容 | 预算 | 已用 | 状态 | 最近报告 |
|---|---|---:|---:|---|---|
| 主 | 编排/集成/验收 | 12 | 10 | done | conformance 7/7；6 节点真链；MVP 验收 |
| N1 `native-spike` | agentTeams/subagents 原生调用 | 6 | 1 | done | 双路径通；投影/深度闸已修 |
| N2 `plugin-shell` | bundle/Config/服务/工具 | 10 | 12 | done | 14 工具；持久化 8/8；task-11 complete |
| N3 `core-port` | TS 核心不变量 | 16 | 6 | done | 24/24；stages/fold/alias；diff 0 |
| N4 `state-recovery` | journal/CAS/恢复 | 8 | 7 | done | 35/35；appendFromSeq；task-13 complete |
| N5 `e2e-ux` | 端到端/UX/conformance | 6 | 8 | done | 7/7 PASS；task-14 complete |
| N6 `native-team` | 真实 Agent 团队执行 | 12 | 3 | done | 6 节点全链；2 CODE+2 AUDIT；13/13 |
| 缓冲 | 原生失败/返工 | 2 | 0 | — | — |

## 合并门禁（每轮）

```
node plugins/dsh-l0-control/lib/selftest.mjs   # 待建
python -m unittest discover -s control_plane/tests   # oracle 回归
```
