/**
 * Lane O · 观测层单元测试。
 *
 * 运行：
 *   node --test src/observability/            # 直接跑 TS 源（Node 24 类型剥离）
 *   node --test src/observability/observability.test.mjs
 *
 * 覆盖验收四条：每工具调用产生指标 / 6 节点链后 token·成本·耗时·重试可见 /
 * 预算·租约·blocked·拒绝率告警触发 / JSON 导出（含脱敏 fail-closed）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  alertRuleIds,
  alertRules,
  applyJournal,
  createObservability,
  createMetrics,
  findSensitive,
  healthSnapshotOf,
  instrumentTool,
  journalRejectionRate,
  metricsFromEvents,
  nodeHealthRows,
  readGraphStatus,
  renderExport,
  sampleNode,
  sampleToolCall,
  withObservability,
} from "./index.ts";

const FIXED_AT = "2026-10-29T12:00:00.000Z";

function fixedObs(options = {}) {
  return createObservability({ clock: () => FIXED_AT, ...options });
}

/** 6 节点链：每节点 task_next → claim_task → verify_done，N3 被驳回后重试一次。 */
function runSixNodeChain(obs, { rejectNode = "N3" } = {}) {
  const nodes = ["N1", "N2", "N3", "N4", "N5", "N6"];
  nodes.forEach((nodeId, index) => {
    const attempt = nodeId === rejectNode ? 2 : 1;
    obs.sampleToolCall({ tool: "task_next", ok: true, wallMs: 5 });
    obs.sampleToolCall({ tool: "claim_task", nodeId, ok: true, wallMs: 8, attempt });
    obs.sampleToolCall({
      tool: "evidence_add",
      nodeId,
      ok: true,
      wallMs: 12,
      tokensIn: 40 * (index + 1),
      tokensOut: 20 * (index + 1),
      cost: 0.002 * (index + 1),
      attempt,
    });
    obs.sampleToolCall({
      tool: "verify_done",
      nodeId,
      ok: nodeId !== rejectNode,
      errorCode: nodeId === rejectNode ? "credential-unavailable" : null,
      wallMs: 40,
      tokensIn: 100 * (index + 1),
      tokensOut: 50 * (index + 1),
      cost: 0.01 * (index + 1),
      attempt,
    });
    obs.sampleNode({
      nodeId,
      status: "done",
      attempts: attempt - 1,
      tokensIn: 200,
      tokensOut: 100,
      cost: 0.02,
      wallMs: 500,
    });
  });
  return nodes;
}

test("每工具调用产生一条指标（ok/failed/tokens/cost/wallMs）", () => {
  const obs = fixedObs();
  obs.sampleToolCall({ tool: "graph_status", ok: true, wallMs: 12, tokensIn: 10, tokensOut: 5, cost: 0.001 });
  obs.sampleToolCall({ tool: "verify_done", ok: false, errorCode: "invalid-state", wallMs: 30 });

  const snapshot = obs.snapshot();
  assert.equal(snapshot.totals.calls, 2);
  assert.equal(snapshot.totals.ok, 1);
  assert.equal(snapshot.totals.failed, 1);
  assert.equal(snapshot.totals.tokens, 15);
  assert.equal(snapshot.totals.cost, 0.001);
  assert.equal(snapshot.totals.wallMs, 42);
  assert.equal(snapshot.totals.avgWallMs, 21);
  assert.equal(snapshot.byTool.length, 2);
  assert.equal(snapshot.byTool[0].tool, "graph_status");
  assert.equal(snapshot.byTool[0].rejectionRate, 0);
});

test("6 节点链后 token/成本/耗时/重试 全部可见", () => {
  const obs = fixedObs();
  const nodes = runSixNodeChain(obs);
  const snapshot = obs.snapshot();

  assert.equal(snapshot.totals.calls, 24); // 4 工具 × 6 节点
  assert.equal(snapshot.totals.failed, 1);
  assert.equal(snapshot.nodes.length, 6);
  assert.deepEqual(snapshot.nodes.map((n) => n.nodeId), nodes);

  for (const node of snapshot.nodes) {
    assert.ok(node.tokens > 0, `${node.nodeId} 应可见 token`);
    assert.ok(node.cost > 0, `${node.nodeId} 应可见成本`);
    assert.ok(node.wallMs > 0, `${node.nodeId} 应可见耗时`);
    assert.equal(node.lastStatus, "done");
  }

  const retried = snapshot.nodes.find((n) => n.nodeId === "N3");
  assert.ok(retried.retries >= 1, "重试应可见");
  assert.equal(retried.lastErrorCode, "credential-unavailable");

  const projection = obs.projection();
  assert.equal(projection.retries.total, snapshot.totals.retries);
  assert.ok(projection.retries.total >= 1);
  assert.deepEqual(
    projection.retries.byNode.map((row) => row.nodeId),
    ["N3"],
  );
  assert.equal(projection.window.nodes, 6);
  assert.equal(projection.window.samples, snapshot.totals.samples);
});

test("projection 形状固定（graph_status.observability 契约）", () => {
  const obs = fixedObs();
  obs.sampleToolCall({ tool: "graph_status", ok: true, wallMs: 1 });
  const projection = obs.projection({ blocked: ["N9"], nodeBudgets: { N1: 100 } });
  assert.deepEqual(Object.keys(projection), [
    "ok",
    "generated_at",
    "window",
    "health",
    "totals",
    "retries",
    "byNode",
    "byTool",
    "alerts",
    "limits",
    "source",
  ]);
  assert.deepEqual(projection.source, { blocked: ["N9"], lease_expired: 0 });
  assert.equal(projection.generated_at, FIXED_AT);
  assert.equal(typeof projection.ok, "boolean");
});

test("withObservability 返回新对象且不改入参", () => {
  const obs = fixedObs();
  obs.sampleToolCall({ tool: "graph_status", ok: true, wallMs: 2 });
  const original = { ok: true, version: 3, counts: { nodes: 1 } };
  const frozen = JSON.stringify(original);
  const merged = withObservability(original, obs.projection());

  assert.notEqual(merged, original);
  assert.equal(JSON.stringify(original), frozen, "入参不得被修改");
  assert.equal(merged.observability.generated_at, FIXED_AT);
  assert.equal(merged.version, 3);
});

test("四条必备告警规则都在表里", () => {
  const ids = alertRuleIds();
  for (const required of ["budget-exceeded", "lease-expired", "node-blocked", "rejection-rate"]) {
    assert.ok(ids.includes(required), `缺少规则 ${required}`);
  }
  assert.equal(alertRules.length, ids.length);
  assert.ok(alertRules.every((rule) => typeof rule.evaluate === "function"));
});

test("预算告警：全局 token 超限 → critical", () => {
  const obs = fixedObs({ limits: { maxTokens: 100 } });
  obs.sampleToolCall({ tool: "verify_done", nodeId: "N1", ok: true, wallMs: 1, tokensIn: 80, tokensOut: 40 });
  const health = obs.health();
  assert.equal(health.status, "critical");
  assert.equal(health.ok, false);
  const hit = health.alerts.find((a) => a.rule === "budget-exceeded");
  assert.ok(hit, "应触发 budget-exceeded");
  assert.equal(hit.severity, "critical");
  assert.equal(hit.value, 120);
  assert.equal(hit.limit, 100);
});

test("预算告警：单节点 token 预算（来自 graphStatus）→ 定位到节点", () => {
  const obs = fixedObs();
  obs.sampleToolCall({ tool: "verify_done", nodeId: "N2", ok: true, wallMs: 1, tokensIn: 200, tokensOut: 100 });
  const health = obs.health({ nodeBudgets: { N2: 250 } });
  const hit = health.alerts.find((a) => a.rule === "budget-exceeded");
  assert.ok(hit);
  assert.equal(hit.nodeId, "N2");
  assert.equal(hit.value, 300);
});

test("预算告警：成本超限 → critical", () => {
  const obs = fixedObs({ limits: { maxCost: 0.5 } });
  obs.sampleToolCall({ tool: "verify_done", ok: true, wallMs: 1, cost: 0.75 });
  const hit = obs.health().alerts.find((a) => a.rule === "budget-exceeded");
  assert.ok(hit);
  assert.equal(hit.limit, 0.5);
});

test("租约过期告警：1 次 warn，3 次升级 critical", () => {
  const one = fixedObs();
  one.recordLeaseExpired(1);
  const warn = one.health();
  assert.equal(warn.alerts.find((a) => a.rule === "lease-expired").severity, "warn");
  assert.equal(warn.status, "degraded");

  const many = fixedObs();
  many.recordLeaseExpired(3);
  const critical = many.health();
  assert.equal(critical.alerts.find((a) => a.rule === "lease-expired").severity, "critical");
  assert.equal(critical.status, "critical");
});

test("blocked 告警：1 个 warn，3 个 critical", () => {
  const obs = fixedObs();
  obs.sampleToolCall({ tool: "graph_status", ok: true, wallMs: 1 });
  assert.equal(obs.health({ blocked: ["N1"] }).alerts.find((a) => a.rule === "node-blocked").severity, "warn");
  const critical = obs.health({ blocked: ["N1", "N2", "N3"] });
  const hit = critical.alerts.find((a) => a.rule === "node-blocked");
  assert.equal(hit.severity, "critical");
  assert.equal(hit.value, 3);
});

test("拒绝率告警：小样本不报，超阈值报，≥50% 升级 critical", () => {
  const small = fixedObs({ limits: { maxRejectionRate: 0.1, minSamplesForRate: 5 } });
  small.sampleToolCall({ tool: "verify_done", ok: false, wallMs: 1 }); // 1/1 失败但样本不足
  assert.deepEqual(small.health().alerts.filter((a) => a.rule === "rejection-rate"), []);

  const warn = fixedObs({ limits: { maxRejectionRate: 0.1, minSamplesForRate: 5 } });
  for (let i = 0; i < 5; i += 1) {
    warn.sampleToolCall({ tool: "verify_done", ok: i !== 0, wallMs: 1 }); // 1/5 = 20%
  }
  const hit = warn.health().alerts.find((a) => a.rule === "rejection-rate");
  assert.ok(hit);
  assert.equal(hit.severity, "warn");

  const critical = fixedObs({ limits: { maxRejectionRate: 0.2, minSamplesForRate: 4 } });
  for (let i = 0; i < 4; i += 1) {
    critical.sampleToolCall({ tool: "verify_done", ok: i < 2, wallMs: 1 }); // 50%
  }
  assert.equal(
    critical.health().alerts.find((a) => a.rule === "rejection-rate").severity,
    "critical",
  );
});

test("健康=healthy 时 checks 全 ok（区分「没告警」与「规则没跑」）", () => {
  const obs = fixedObs();
  obs.sampleToolCall({ tool: "graph_status", ok: true, wallMs: 1 });
  const health = obs.health();
  assert.equal(health.status, "healthy");
  assert.equal(health.ok, true);
  assert.equal(health.alerts.length, 0);
  assert.equal(health.checks.length, alertRules.length);
  assert.ok(health.checks.every((check) => check.ok && check.detail === "ok"));
});

test("readGraphStatus 抽出 blocked / 节点预算（不改入参）", () => {
  const status = {
    ok: true,
    graph: {
      nodes: [
        { node_id: "N1", status: "done", budget: { maxTokens: 1000 } },
        { node_id: "N2", status: "blocked", budget: { max_tokens: 500 } },
        { node_id: "N3", status: "ready" },
      ],
      edges: [],
    },
  };
  const before = JSON.stringify(status);
  const read = readGraphStatus(status);
  assert.deepEqual(read.blocked, ["N2"]);
  assert.deepEqual(read.nodeBudgets, { N1: 1000, N2: 500 });
  assert.equal(read.nodeCount, 3);
  assert.equal(read.done, 1);
  assert.equal(JSON.stringify(status), before);
});

test("journal 派生：重试 / 驳回 / 租约过期 / blocked", () => {
  const events = [
    { seq: 1, kind: "node_added", node_id: "N1", payload: { node: { node_id: "N1", status: "ready", attempts: 0 } } },
    { seq: 2, kind: "status_changed", node_id: "N1", payload: { from: "ready", to: "verifying", reason: "verify_started" } },
    { seq: 3, kind: "status_changed", node_id: "N1", payload: { from: "verifying", to: "ready", reason: "rejected:no_evidence" } },
    { seq: 4, kind: "attempts_changed", node_id: "N1", payload: { from: 0, to: 1 } },
    { seq: 5, kind: "lease_expired", node_id: "N1", payload: { owner: "agent-A" } },
    { seq: 6, kind: "status_changed", node_id: "N2", payload: { from: "ready", to: "blocked", reason: "budget_exceeded" } },
    { seq: 7, kind: "status_changed", node_id: "N1", payload: { from: "verifying", to: "done", reason: "evidence_ok" } },
  ];
  const derived = metricsFromEvents(events);
  assert.equal(derived.events, 7);
  assert.equal(derived.retries, 1);
  assert.equal(derived.rejected, 1);
  assert.equal(derived.leaseExpired, 1);
  assert.deepEqual(derived.blocked, ["N2"]);
  assert.deepEqual(derived.done, ["N1"]);
  assert.equal(derived.verifyStarts, 1);
  assert.equal(journalRejectionRate(derived), 1);

  const metrics = createMetrics({ clock: () => FIXED_AT });
  applyJournal(metrics, derived);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.leaseExpired, 1);
  assert.equal(snapshot.nodes.find((n) => n.nodeId === "N2").lastStatus, "blocked");
  assert.equal(snapshot.nodes.find((n) => n.nodeId === "N1").lastStatus, "done");
});

test("脱敏：meta 里的密钥类键被替换，指标键不被误伤", () => {
  const obs = fixedObs();
  obs.sampleToolCall({
    tool: "adapter_call",
    nodeId: "N1",
    ok: true,
    wallMs: 5,
    tokensIn: 7,
    tokensOut: 3,
    meta: {
      apiKey: "sk-live-abcdef123456",
      password: "hunter2",
      authorization: "Bearer abcdefgh123456",
      note: "x".repeat(400),
      keep: { tokensIn: 7, label: "ok" },
    },
  });

  // meta 只在有界样本里（不出口到 projection）；先看脱敏结果
  const sample = obs.metrics.recentSamples(1)[0];
  assert.equal(sample.meta.apiKey, "[redacted]");
  assert.equal(sample.meta.password, "[redacted]");
  assert.equal(sample.meta.authorization, "[redacted]");
  assert.equal(sample.meta.keep.tokensIn, 7, "指标键不应被误伤");
  assert.ok(sample.meta.note.length <= 201, "长文本应截断");
  assert.ok(sample.meta.note.endsWith("…"));

  // 指标值本身照常可见
  const projection = obs.projection();
  assert.equal(projection.totals.tokensIn, 7);
  assert.equal(projection.totals.tokensOut, 3);

  const json = renderExport(projection).json;
  assert.ok(!json.includes("sk-live-abcdef123456"), "密钥值不得出现");
  assert.ok(!json.includes("hunter2"), "口令不得出现");
  assert.ok(!json.includes("Bearer abcdefgh"), "Bearer 不得出现");
  assert.equal(findSensitive(json), null);
});

test("导出：JSON + JSONL 落盘，内容可复核且无敏感串", () => {
  const obs = fixedObs({ limits: { maxTokens: 50 } });
  runSixNodeChain(obs);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-export-"));
  const result = obs.exportTo(dir);

  assert.ok(fs.existsSync(result.jsonPath));
  assert.ok(fs.existsSync(result.logPath));
  const projection = JSON.parse(fs.readFileSync(result.jsonPath, "utf8"));
  assert.equal(projection.generated_at, FIXED_AT);
  assert.equal(projection.window.nodes, 6);
  assert.ok(projection.alerts.length > 0, "6 节点链 + 低预算应触发告警");

  const lines = fs.readFileSync(result.logPath, "utf8").trim().split("\n");
  assert.equal(lines.length, result.logLines);
  const parsed = lines.map((line) => JSON.parse(line));
  assert.equal(parsed[0].t, "summary");
  assert.ok(parsed.some((row) => row.t === "alert"));
  assert.ok(parsed.some((row) => row.t === "node" && row.nodeId === "N1"));
  assert.equal(findSensitive(JSON.stringify(parsed)), null);
});

test("导出 fail-closed：投影里混进疑似密钥时拒绝落盘", () => {
  const obs = fixedObs();
  obs.sampleToolCall({ tool: "graph_status", ok: true, wallMs: 1 });
  const projection = obs.projection();
  projection.alerts.push({
    rule: "manual",
    severity: "info",
    message: "leaked sk-live-abcdef123456",
    nodeId: null,
    value: null,
    limit: null,
    at: FIXED_AT,
  });
  assert.throws(() => renderExport(projection), /sensitive value matched/);
});

test("instrumentTool：计时 + 成功/失败采样 + 原样抛出", async () => {
  const obs = fixedObs();
  let clock = 1000;
  const tool = {
    name: "graph_status",
    execute: async (input) => ({ ok: true, usage: { tokensIn: 3, tokensOut: 4, cost: 0.001 }, trace: input }),
  };
  const wrapped = instrumentTool(tool, obs, { now: () => clock });

  clock = 1000;
  const result = await wrapped.execute({ nodeId: "N1" });
  clock = 1025;
  assert.equal(result.ok, true);

  const snapshot = obs.snapshot();
  assert.equal(snapshot.totals.calls, 1);
  assert.equal(snapshot.totals.tokens, 7);
  assert.equal(snapshot.nodes[0].nodeId, "N1");
  assert.ok(snapshot.totals.wallMs >= 0, "耗时应被记录（注入时钟下为 0 也合法）");

  const failing = {
    name: () => "verify_done",
    execute: async () => {
      const error = new Error("boom");
      error.code = "invalid-state";
      throw error;
    },
  };
  const wrappedFail = instrumentTool(failing, obs, { toolName: "verify_done" });
  await assert.rejects(() => wrappedFail.execute({ node_id: "N2" }), /boom/);
  const after = obs.snapshot();
  assert.equal(after.totals.failed, 1);
  const n2 = after.nodes.find((n) => n.nodeId === "N2");
  assert.equal(n2.lastErrorCode, "invalid-state");
  assert.equal(after.byTool.find((t) => t.tool === "verify_done").failed, 1);
});

test("函数式入口 sampleNode / sampleToolCall / healthSnapshotOf 可用", () => {
  const metrics = createMetrics({ clock: () => FIXED_AT });
  sampleToolCall(metrics, { tool: "verify_done", nodeId: "N1", ok: false, wallMs: 9 });
  sampleNode(metrics, { nodeId: "N2", status: "blocked", tokensIn: 5, tokensOut: 5 });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.totals.calls, 1);
  assert.equal(snapshot.nodes.length, 2);
  assert.equal(snapshot.totals.tokens, 10);

  const health = healthSnapshotOf(snapshot, { limits: { minSamplesForRate: 1, maxRejectionRate: 0.1 } });
  assert.ok(health.alerts.some((a) => a.rule === "rejection-rate"));
  assert.equal(nodeHealthRows(snapshot.nodes).find((row) => row.nodeId === "N2").status, "blocked");
});

test("数值护栏：NaN/Infinity/负数不进导出", () => {
  const obs = fixedObs();
  obs.sampleToolCall({
    tool: "weird",
    ok: true,
    wallMs: Number.NaN,
    tokensIn: Number.POSITIVE_INFINITY,
    tokensOut: -5,
    cost: Number.NaN,
  });
  const projection = obs.projection();
  const json = renderExport(projection).json;
  assert.ok(!json.includes("NaN"));
  assert.ok(!json.includes("Infinity"));
  assert.equal(projection.totals.tokensIn, 0);
  assert.equal(projection.totals.tokensOut, 0);
  assert.equal(projection.totals.cost, 0);
  assert.equal(projection.totals.wallMs, 0);
});

test("重复快照幂等：同一时钟下两次投影完全一致", () => {
  const obs = fixedObs();
  runSixNodeChain(obs);
  const first = renderExport(obs.projection()).json;
  const second = renderExport(obs.projection()).json;
  assert.equal(first, second);
});
