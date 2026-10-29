# Lane O · `observability`（指标 / 健康 / 告警）

> 任务板：task-28 · 预算 4 轮 · 计划：`designs/_research/生产化与全自主-30轮长任务.md` §O
> 写域：`plugins/dsh-l0-control/src/observability/`、`control_plane/lanes/`。**不改** core / state / service / entry。

---

## R1 · 模块骨架 + `graph_status.observability` 形状 + JSON 导出

**新增文件（`plugins/dsh-l0-control/src/observability/`）**

| 文件 | 职责 |
|---|---|
| `types.ts` | 采样/聚合/告警/投影类型 + `DEFAULT_LIMITS`（`0` = 不限） |
| `redact.ts` | 脱敏（密钥类键 → `[redacted]`、长文本截断、深层最多 4 层）+ 数值护栏（NaN/∞/负数） |
| `metrics.ts` | `Metrics`：`recordToolCall` / `recordNode` / `recordLeaseExpired` / `snapshot()`；聚合单调、样本环形缓冲（默认 500） |
| `alerts.ts` | `alertRules` 六条（四条必备 + slow-call + retry-heavy）、`evaluateAlerts`、`normalizeLimits` |
| `health.ts` | `healthSnapshot`：status ∈ healthy/degraded/critical、counts、**逐规则 checks**、alerts |
| `projection.ts` | `observabilityProjection`（`graph_status.observability` 形状）、`withObservability`（不改入参）、`readGraphStatus`、JSON/JSONL 渲染 |
| `export.ts` | `writeObservabilityExport`：落 `observability.json` + `observability.log`；**fail-closed 脱敏**（命中密钥模式拒绝落盘） |
| `from-events.ts` | `metricsFromEvents`：从 journal 派生重试（`attempts_changed` 增量）、驳回（`rejected:` 前缀）、租约过期、blocked；`applyJournal` 灌回 `Metrics` |
| `index.ts` | 门面 `createObservability()`（`sampleToolCall`/`sampleNode`/`health`/`projection`/`exportTo`）+ 函数式 `sampleNode`/`sampleToolCall`/`healthSnapshotOf` + `instrumentTool`（工具包装，计时/成功失败/usage 采集） |
| `observability.test.mjs` | 21 例（node:test） |

**`graph_status.observability` 形状（冻结）**

```ts
{
  ok, generated_at,
  window:   { samples, nodes, tools },
  health:   { status: "healthy"|"degraded"|"critical", checks: [{rule, ok, detail}] },
  totals:   { samples, calls, ok, failed, rejectionRate, tokensIn, tokensOut, tokens, cost,
              wallMs, avgWallMs, maxWallMs, retries, nodes, tools },
  retries:  { total, byNode: [{nodeId, retries}] },
  byNode:   [{nodeId, calls, ok, failed, tokensIn/Out/tokens, cost, wallMs, avgWallMs, maxWallMs,
              retries, lastStatus, lastErrorCode, lastAt}],
  byTool:   [{tool, calls, ok, failed, rejectionRate, wallMs, avgWallMs, tokens, cost}],
  alerts:   [{rule, severity, message, nodeId, value, limit, at}],
  limits:   {...normalizeLimits},
  source:   { blocked: [...], lease_expired }
}
```

**告警规则（`alertRules`，`id` 即 `alerts[].rule`）**

| rule | 触发 | 严重度 |
|---|---|---|
| `budget-exceeded` | 全局 token / 全局成本 / 单节点 token（节点预算来自 `graphStatus.graph.nodes[].budget.maxTokens`，兼容 `max_tokens`） | critical |
| `lease-expired` | 窗口内 `lease_expired` ≥1；≥3 升级 | warn → critical |
| `node-blocked` | blocked 节点 ≥1；≥3 升级 | warn → critical |
| `rejection-rate` | 拒绝率 > 阈值且样本 ≥ `minSamplesForRate`；≥50% 升级 | warn → critical |
| `slow-call` | 单节点最慢调用 > `maxWallMs` | warn |
| `retry-heavy` | 单节点重试 > `maxRetries` | warn |

**设计要点**

- **不改 core/state/entry**：`withObservability(status, projection)` 返回新对象；`instrumentTool` 是可选包装（service 接线时 `ALL_TOOLS.map(t => instrumentTool(t, obs))` 即可，不改 tools.ts）。
- **两路数据源**：① 每工具调用采样（token/成本/耗时/拒绝）；② journal 派生（重试/驳回/租约/blocked）。两者可同时用，口径在 `totals` 与 `source` 分开标注。
- **fail-closed 脱敏**：观测投影本身**不含** `spec`/`title`/愿望文本/prompt；`meta` 里密钥类键替换为 `[redacted]`；导出前再扫一遍 `sk-*` / `Bearer …` / 明文 password，命中即拒绝落盘。
- **数值护栏**：`NaN`/`Infinity`/负数在采样入口收敛为 0，导出永不含非法 JSON 数字。

**门禁（R1）**

```
node --test src/observability/observability.test.mjs      → 21 pass / 0 fail
node out/build_observability.mjs                          → lib/observability/*.js (9 个)
node -e "import('./lib/observability/index.js')…"         → 构建产物可加载
node scripts/contract.mjs                                 → exit 0（9 工具形状未被影响）
node scripts/build.mjs --check                            → 仅剩他人 stale：a2a/router.js（本 lane 0 drift）
```

> 为什么不跑全量 `scripts/build.mjs`：基线已有别的 lane 的 stale 产物（`a2a/router.js` 等），全量构建会重写他人中间态。
> 局部构建脚本：`out/build_observability.mjs`（只碰 `src/observability/**`）。

**遗留**

- `scripts/selftest.mjs` 的 `build: lib 与 src 同步` 这一项仍在挂（a2a/router.js、security/guard.js stale，属他人 lane，R1 之前就红）。
- service 接线（`graph_status` 里塞 `observability`、工具包 `instrumentTool`）不在本 lane 写域，等主窗口接线；
  接线示例已写进 `src/observability/README.md`。

---

## R2 · 真实 core 6 节点链验证（`observability.chain.test.mjs`）

**做法**：`resetCore()` → `submitWish()`（`WISH_PLAN` 正好 6 节点）→ 逐节点
`claimTask →（制造真实失败）→ submitEvidence → passGate → verifyDone`，
再把 `store.journal.raw()` 喂给 `metricsFromEvents` + `applyJournal`，最后
`withObservability(graphStatus(), obs.projection(readGraphStatus(...)))`。

**真实失败注入（都是核心自身产生的真实事件，不 mock）**

| 节点 | 注入 | 真实结果 |
|---|---|---|
| `NODE-CONTRACT` | 短租约（30s）后 `expire(now=expires_at+1)` | `lease_expired` 事件 + `attempts_changed` 0→1 + 重新认领 |
| `NODE-BUILD` | ① 认领后立刻 `verifyDone` ② 提交证据但闸门未过再 `verifyDone` ③ `setStatus(ready, reason="rejected:credential-unavailable", dropLease:true)` | `invalid-state` / `credential-unavailable` 两次真实失败 + `rejected:` 迁移 + 重试 |

**数字（`node out/chain_report.mjs`，真实链）**

```
graph:   done=6 / nodes=6 / ready=0
journal: events=100  lease_expired=1  rejected=1  retries=2  done=6
totals:  calls=26  failed=2  rejectionRate=7.69%  tokens=20500 (in 13700 / out 6800)
         cost=0.137  wallMs=230  avg 8.85ms  max 18ms  retries=2  nodes=6  tools=4
byNode:  BUILD calls=5 tokens=9000 cost=0.06 wall=43ms retries=1 lastError=credential-unavailable
         CONTRACT tokens=2700 cost=0.018 wall=35ms retries=1
         RESEARCH/PRD/AUDIT/DELIVER 各自 tokens/cost/wall 均 > 0，retries=0
alerts:  critical:budget-exceeded ×2（tokens 20500>1000、cost 0.137>0.01）
         warn:lease-expired；warn:rejection-rate
导出:     out/observability_demo/observability.json (5834B) + observability.log (11 行 JSONL)
```

**测试**：`node --test src/observability/*.test.mjs` → **24 pass / 0 fail**（21 聚合 + 3 真实链）。

**顺带修正（R2 发现的口径缺陷）**

- 重试原按「attempt>1 的调用条数」计数，会把同一件事数三遍（claim/submit/verify 各 1）。
  改为 `max(工具采样 attempt-1, 节点 attempts)`，与 journal 的 `retries=2` 对齐。
- 核心侧观察（**未改 core，交回主窗口判断**）：驳回迁移若不带 `dropLease:true`，会留下 stale 租约，
  之后 `claimTask` 返回 `alreadyHeld` 但节点仍是 `ready`，`submitEvidence` 无法推进到 `submitted`。
  本 lane 在测试里按 Python `_reject` 语义显式传了 `dropLease:true`。建议 core 的 reject 帮助函数固化这一点。
- 第二个核心侧观察（**未改 core**）：core 的 rejected 路径**自己**会落 `attempts_changed`（0→1），
  调用方若再传 `attemptsDelta: 1` 会把同一次重试记成两次（观测口径上 `retries` 会 2 倍）。
  本 lane 的夹具已改为只传 `reason` + `dropLease`，让 core 独占 attempts 计数。
  建议 N3 把「reject 语义」收到一个帮助函数里（`dropLease` + `attempts_changed` 一起做），供 A/native 复用。

**R3/R4 候选（若需要）**：service 接线 patch（需扩写域到 `src/service.ts`）、
`healthSnapshot` 进 `selfcheck` 断言、`--json` 形式的 CLI 导出。

---

## R3 · `graph_status` / service 接线 exact patch（**本次不改 service**，主窗口 M4 落地）

> 目标：`graph_status` 顶层出现 `observability`；每工具调用（core 委派口径）自动产出一条指标。
> 全部改动集中在 `src/service.ts` 的 4 个 hunk + 1 个可选 hunk，**不动 tools.ts / core / entry**，
> 9 工具契约（`scripts/contract.mjs`）不变。

### hunk 1 · imports

```diff
@@ import 区
 import { CorePersistence } from './persistence.js';
 import { NativeTeam } from './native/team.js';
+import {
+  applyJournal,
+  createObservability,
+  metricsFromEvents,
+  readGraphStatus,
+} from './observability/index.js';
 import type { L0ControlConfig } from './config.js';
```

### hunk 2 · 类字段（放在 `// ── 9 个工具的实现 ──` 之上）

```diff
+  /**
+   * 观测层（Lane O）：工具调用采样 + graph_status.observability。
+   * 阈值按部署改；0 = 不限。`maxRejectionRate` 只在样本 ≥ `minSamplesForRate` 时判定。
+   */
+  readonly observability = createObservability({
+    limits: { maxTokens: 500_000, maxCost: 20, maxRejectionRate: 0.2, minSamplesForRate: 5 },
+  });
+
   // ── 9 个工具的实现 ─────────────────────────────────────────
```

### hunk 3 · `withCore()` 埋点（所有 9 个工具的 core 委派都走这里）

```diff
   private async withCore(
     action: string,
     fn: (core: CoreModule) => unknown | Promise<unknown>,
   ): Promise<unknown> {
+    const startedAt = Date.now();
+    const record = (ok: boolean, errorCode?: string | null) => {
+      this.observability.sampleToolCall({
+        tool: action,
+        ok,
+        errorCode: errorCode ?? null,
+        wallMs: Date.now() - startedAt,
+      });
+    };
     const core = await this.core();
     if (!core) {
+      record(false, 'core-unavailable');
       return {
         ok: false,
         error: 'core-unavailable',
         action,
         hint: 'src/core 归 N3；core 缺失时插件不得假装成功',
         stateAuthority: 'plugin-journal',
       };
     }
     try {
       const result = await fn(core);
       const rejected = Boolean(result && typeof result === 'object' && (result as { ok?: unknown }).ok === false);
       if (rejected) {
         const typed = result as { error?: string; hint?: string };
+        record(false, typed.error ?? 'core-rejected');
         return {
           ok: false,
           action,
           error: typed.error ?? 'core-rejected',
           result,
           ...(typed.hint ? { hint: typed.hint } : {}),
           persistence: await this.persist(),
         };
       }
+      record(true);
       return { ok: true, action, result, persistence: await this.persist() };
     } catch (error) {
+      record(false, 'core-failed');
       return { ok: false, action, error: 'core-failed', detail: errorInfo(error), persistence: await this.persist() };
     }
   }
```

### hunk 4 · `graphStatus()` 挂 `observability`（`graph_status.observability` 形状）

```diff
   async graphStatus() {
     const journal = this.journalSummary();
     const coreResult = await this.withCore('graph_status', (core) =>
       core.graphStatus ? core.graphStatus() : Promise.resolve({ delegated: false, reason: 'core.graphStatus 未实现' }),
     );
     const persistence = await this.persistence();
     const persistenceView = persistence ? { ... } : { ... };
+    // journal 派生（重试 / 驳回 / 租约过期 / blocked）：优先用 core 的权威事件流
+    const core = await this.core();
+    const store = core?.coreStore ? (core.coreStore() as { journal?: { raw?: () => unknown[] } }) : null;
+    const events = (store?.journal?.raw?.() ?? []) as Parameters<typeof metricsFromEvents>[0];
+    if (events.length) applyJournal(this.observability.metrics, metricsFromEvents(events));
+    const coreView = (coreResult ?? {}) as Record<string, unknown>;
+    const hints = readGraphStatus(coreView);   // blocked[] + 节点 budget.maxTokens
     return {
       ok: true,
       journal,
       stateDir: this.stateDir,
       snapshotExists: fs.existsSync(this.snapshotPath),
       capabilities: capabilitiesDigest(),
       persistence: persistenceView,
-      graph: coreResult,
+      graph: coreView,
+      observability: this.observability.projection(hints),
     };
   }
```

> 若某版本 core 不导出 `coreStore`，`events` 为空数组 → 观测退化为「只含工具采样」，不会报错
> （`applyJournal` 只在 `events.length` 时调用）。`blocked` 与节点预算仍能从 `coreView.graph.nodes` 读到。

### hunk 5（可选）· 导出方法（**不是工具**，9 工具契约不变）

```diff
+  /** 导出观测 JSON + JSONL（fail-closed 脱敏）；dir 相对 workspaceRoot。 */
+  async observabilityExport(dir: string) {
+    return this.observability.exportTo(path.resolve(this.workspaceRoot, dir));
+  }
```

### M4 落地后的预期（来自真实链数据）

```jsonc
// graph_status 顶层新增
"observability": {
  "ok": false,
  "generated_at": "...",
  "window": { "samples": 32, "nodes": 6, "tools": 4 },
  "health": { "status": "critical", "checks": [ /* 6 条规则 */ ] },
  "totals": { "calls": 26, "failed": 2, "rejectionRate": 0.0769, "tokens": 20500,
              "cost": 0.137, "wallMs": 230, "retries": 2, "nodes": 6, "tools": 4 },
  "retries": { "total": 2, "byNode": [{ "nodeId": "NODE-BUILD", "retries": 1 }] },
  "byNode": [ /* 6 项，含 tokens/cost/wallMs/retries/lastErrorCode */ ],
  "byTool": [ /* graph_status/task_claim/... 各自 calls/failed/rejectionRate/wallMs */ ],
  "alerts": [ /* budget-exceeded / lease-expired / rejection-rate ... */ ],
  "limits": { /* normalizeLimits 结果 */ },
  "source": { "blocked": [], "lease_expired": 1 }
}
```

**为什么接在 `withCore` 而不是 `tools.ts`**：9 个工具的 core 委派都过这里 —— 一处埋点即全覆盖，
且 `ok:false` 的语义拒绝（core 返回 `ok:false`）会被记为失败，拒绝率口径与
`graph_status` 的顶层 `ok` 一致；`tools.ts` 侧无需改动。

### ② 保留真实链导出 + 脱敏断言（R3 已加固）

`observability.chain.test.mjs` 第 3 例现在断言（真实链跑完后）：

- `observability.json`：`window.nodes=6`、`byNode.length=6`、`alerts.length ≥ 1`；
- `observability.log`：行数 = `1 + alerts + 6`，首行 `t:"summary"` 且 `tokens` 与 JSON 一致，
  node 行恰好 6 条；
- 两份文本都过 `findSensitive()`（`sk-*` / `Bearer …` / 明文 password）→ `null`；
- 两份文本都**不含** `WISH_PLAN` 的节点标题（无敏感内容）。

导出产物仍在 `out/observability_demo/`（`observability.json` 5834B / `observability.log` 11 行），
由 `node out/chain_report.mjs` 复现。


