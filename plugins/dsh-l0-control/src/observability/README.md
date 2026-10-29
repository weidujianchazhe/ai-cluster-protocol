# `observability/`（Lane O）

指标 / 健康 / 告警的可插拔观测层。**不改 core / state / service / entry**：本目录只提供函数与类型，
接线由 service 侧一行完成（见下）。

## 接线（service 侧示例，本次不改 service）

```ts
import { createObservability, instrumentTool, readGraphStatus, withObservability }
  from "../observability/index.ts";

const obs = createObservability({
  limits: { maxTokens: 500_000, maxCost: 20, maxRejectionRate: 0.2, minSamplesForRate: 5 },
});

// ① 每工具调用产生一条指标（不改 tools.ts，只包一层）
const tools = ALL_TOOLS.map((tool) => instrumentTool(tool, obs));

// ② graph_status 带上 observability（不改 core/status，返回新对象）
const status = await core.graphStatus();
const hints = readGraphStatus(status);           // blocked[] + nodeBudgets{}
return withObservability(status, obs.projection(hints));

// ③ adapter usage 归集（可选）：拿到 token/成本就补一条节点采样
obs.sampleNode({ nodeId, instanceId, tokensIn, tokensOut, cost, wallMs, attempts });

// ④ journal 派生（重试/驳回/租约过期/blocked 已经在日志里）
applyJournal(obs.metrics, metricsFromEvents(store.journal.raw()));

// ⑤ 导出（脱敏 fail-closed）
obs.exportTo("out/observability");  // observability.json + observability.log
```

## 数据形状（`graph_status.observability`）

```jsonc
{
  "ok": true,
  "generated_at": "2026-10-29T12:00:00.000Z",
  "window": { "samples": 32, "nodes": 6, "tools": 4 },
  "health": { "status": "critical", "checks": [{ "rule": "node-blocked", "ok": true, "detail": "ok" }] },
  "totals": {
    "samples": 32, "calls": 26, "ok": 24, "failed": 2, "rejectionRate": 0.0769,
    "tokensIn": 13700, "tokensOut": 6800, "tokens": 20500,
    "cost": 0.137, "wallMs": 230, "avgWallMs": 8.846, "maxWallMs": 18,
    "retries": 2, "nodes": 6, "tools": 4
  },
  "retries": { "total": 2, "byNode": [{ "nodeId": "NODE-BUILD", "retries": 1 }] },
  "byNode": [{ "nodeId": "NODE-BUILD", "calls": 5, "tokens": 9000, "cost": 0.06,
               "wallMs": 43, "retries": 1, "lastStatus": "done",
               "lastErrorCode": "credential-unavailable" }],
  "byTool": [{ "tool": "verify_done", "calls": 8, "failed": 2, "rejectionRate": 0.25 }],
  "alerts": [{ "rule": "budget-exceeded", "severity": "critical", "value": 20500, "limit": 1000 }],
  "limits": { "maxTokens": 1000, "maxCost": 0.01, "maxWallMs": 120000,
              "maxRejectionRate": 0.05, "minSamplesForRate": 5,
              "maxRetries": 3, "defaultNodeMaxTokens": 0 },
  "source": { "blocked": [], "lease_expired": 1 }
}
```

`byNode` / `byTool` / `totals` 里**没有** `title` / `spec` / 愿望文本 / 产物路径 —— 观测只描述代价与健康，
不搬业务正文（`observability.chain.test.mjs` 对此有断言）。

## 告警规则

| rule | 触发条件 | 严重度 |
|---|---|---|
| `budget-exceeded` | 全局 tokens > `maxTokens`；全局 cost > `maxCost`；单节点 tokens > `nodeBudgets[node]`（缺省 `defaultNodeMaxTokens`） | critical |
| `lease-expired` | 窗口内 `lease_expired` ≥ 1；≥ 3 升级 | warn → critical |
| `node-blocked` | blocked 节点 ≥ 1；≥ 3 升级 | warn → critical |
| `rejection-rate` | `failed/calls` > `maxRejectionRate` 且 `calls ≥ minSamplesForRate`；≥ 50% 升级 | warn → critical |
| `slow-call` | 单节点最慢调用 > `maxWallMs` | warn |
| `retry-heavy` | 单节点重试 > `maxRetries` | warn |

`health.checks` 会列出**全部**规则的结论（`ok` 或命中原因），用于区分「健康」与「规则没跑」。

## 口径说明

- **重试**：`max(工具采样 attempt-1, 节点 attempts)` —— 两个来源取 max，避免同一件事被数两遍
  （`journal.attempts_changed` 与 `attempt=2` 的调用采样描述的是同一次重试）。
- **拒绝率**：工具调用口径（`failed/calls`）。journal 口径的「驳回次数 / 验收尝试数」用
  `journalRejectionRate(metricsFromEvents(events))` 交叉验证。
- **成本**：由调用方按自身价目表折算后作为 `cost` 传入；本层不猜价目。
- **数值**：`NaN` / `Infinity` / 负数在入口被收敛为 0，导出永不含非法 JSON 数字。

## 安全

- `meta` 里密钥类键（`secret|password|authorization|apiKey|cookie|bearer|credential|...`）→ `[redacted]`；
  长文本截断到 200 字符；深层最多 4 层、最多 50 键。
- 导出前再扫一遍整段 JSON（`sk-*` / `Bearer …` / 明文 password）：命中则**拒绝落盘**并抛错。
- 指标键（`tokensIn` / `tokens` / `tokenBudget`）**不受**脱敏影响。

## 测试

```bash
node --test src/observability/observability.test.mjs        # 21 例：聚合/告警/形状/脱敏/导出
node --test src/observability/observability.chain.test.mjs  # 3 例：真实 core 6 节点链
```

真实链断言（`WISH_PLAN` 6 节点，含 1 次真实租约过期 + 1 次真实驳回重试）：
`done=6`、`totals.tokens=20500`、`cost=0.137`、`wallMs=230`、`retries=2`（BUILD/CONTRACT 各 1）、
告警命中 `budget-exceeded` ×2 + `lease-expired` + `rejection-rate`。

## 构建

本 lane 只局部构建（避免覆盖他人 stale 产物）：

```bash
node out/build_observability.mjs   # 仅 src/observability/** → lib/observability/**
```

全量 `node scripts/build.mjs` 由主窗口在 S/A/P 收工后统一跑。
