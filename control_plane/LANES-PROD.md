# 生产化与全自主 · 30 轮跟踪

> 计划：`../AI集群工作协议-管理区/designs/_research/生产化与全自主-30轮长任务.md`

| Lane | 内容 | 预算 | 已用 | 状态 | 最近报告 |
|---|---|---:|---:|---|---|
| 主 | 集成/门禁/验收 | 6 | 2 | done | M4 接线完成；全绿 |
| S `security-tenant` | 鉴权+多租户 | 6 | 6 | done | 62/62；task-27 complete |
| O `observability` | 指标/健康/告警 | 4 | 4 | done | 24/24；真实链；task-28 complete |
| A `autonomy` | 全 6 节点自主循环 | 7 | 7 | done | 7/7；6/6 worker 自驱 |
| P `a2a` | A2A 最小传输 | 5 | 5 | done | 33/33；task-30 complete |
| 缓冲 | 端口/契约返工 | 2 | 0 | — | — |

## 门禁

```
node plugins/dsh-l0-control/scripts/selftest.mjs
node plugins/dsh-l0-control/tests/e2e/conformance.mjs
python -m unittest discover -s control_plane/tests
```
