/**
 * Lane O · 真实 core 6 节点链上的观测验证（R2）。
 *
 * 与 `observability.test.mjs` 的区别：那边用合成采样验证聚合正确性；这里跑**真实 core**
 * （`submitWish` 生成的 `WISH_PLAN` 正好 6 节点），把真实 journal 喂给 `metricsFromEvents`，
 * 再用真实节点 id 采样 adapter usage，验证验收口径：
 *   - 每工具调用产生指标；
 *   - 6 节点链后 token / 成本 / 耗时 / 重试**在同一条真实链上**可见；
 *   - 拒绝（verify 失败 + rejected 迁移）与租约过期（真实 `lease_expired`）都能触发告警；
 *   - 导出 JSON 不含节点标题/愿望文本（无敏感内容）。
 *
 * 只读用 core（不修改 core/state/service）：`resetCore()` + 真实门面调用 + `coreStore().journal`。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WISH_PLAN,
  claim,
  claimTask,
  coreStore,
  currentLease,
  expire,
  graphStatus,
  passGate,
  resetCore,
  setStatus,
  submitEvidence,
  submitWish,
  verifyDone,
} from "../core/index.ts";
import {
  alertRuleIds,
  applyJournal,
  createObservability,
  findSensitive,
  metricsFromEvents,
  readGraphStatus,
  withObservability,
} from "./index.ts";

const FIXED_AT = "2026-10-29T12:00:00.000Z";

/** 每节点模拟一次 adapter usage（真实链本身不产 token，token 由 adapter 上报）。 */
const USAGE = {
  "NODE-RESEARCH": { tokensIn: 1200, tokensOut: 600, cost: 0.012 },
  "NODE-PRD": { tokensIn: 2400, tokensOut: 1200, cost: 0.024 },
  "NODE-CONTRACT": { tokensIn: 1800, tokensOut: 900, cost: 0.018 },
  "NODE-BUILD": { tokensIn: 6000, tokensOut: 3000, cost: 0.06 },
  "NODE-AUDIT": { tokensIn: 1500, tokensOut: 700, cost: 0.015 },
  "NODE-DELIVER": { tokensIn: 800, tokensOut: 400, cost: 0.008 },
};

function writeArtifact(dir, nodeId) {
  const file = path.join(dir, `${nodeId}.txt`);
  fs.writeFileSync(file, `artifact for ${nodeId}\n`, "utf8");
  return file;
}

/** 跑真实 6 节点链：中间制造 1 次租约过期（真实重试）+ 1 次 verify 失败/驳回。 */
function runRealChain(obs) {
  resetCore();
  const store = coreStore();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-chain-"));

  const wish = submitWish({ text: "六节点链：观测与告警", maxParallel: 2, budgetTokens: 12000 });
  assert.equal(wish.ok, true);
  assert.deepEqual(wish.nodes, WISH_PLAN.map((spec) => spec.nodeId));

  const chain = [];
  for (const spec of WISH_PLAN) {
    const nodeId = spec.nodeId;
    const instanceId = `ROLE-${spec.capability}-01`;
    const usage = USAGE[nodeId];

    // ① 认领（真实 claimTask → lease）；NODE-CONTRACT 先短租约让它真实过期再重认领
    let claimed;
    if (nodeId === "NODE-CONTRACT") {
      claim(store, nodeId, instanceId, { ttlSec: 30, now: store.nowMs() });
      const lease = currentLease(store, nodeId);
      assert.ok(lease, "应有租约");
      expire(store, { now: lease.expires_at + 1 }); // → lease_expired + attempts_changed
      claimed = claimTask({ nodeId, instanceId });
    } else {
      claimed = claimTask({ nodeId, instanceId });
    }
    assert.equal(claimed.ok, true, `claim ${nodeId}`);

    // ③ NODE-BUILD 走真实失败 + 驳回 + 重试：
    //    A. 太早 verify（invalid-state）
    //    B. 已提交证据但阶段闸门未过 → credential-unavailable
    //    C. 真实驳回迁移（清租约 + attempts+1 + rejected:）→ 重认领
    let rejectedOnce = false;
    if (nodeId === "NODE-BUILD") {
      const early = verifyDone({ nodeId });
      assert.equal(early.ok, false, "认领后立刻 verify 必须失败");
      assert.equal(early.error, "invalid-state");
      obs.sampleToolCall({
        tool: "verify_done",
        nodeId,
        instanceId,
        ok: false,
        errorCode: String(early.error),
        wallMs: 3,
      });

      const earlyEvidence = submitEvidence({
        nodeId,
        artifactPath: writeArtifact(workDir, nodeId),
        producerInstance: instanceId,
        verifier: "verifier-ci",
        verdict: "pass",
      });
      assert.equal(earlyEvidence.ok, true, "证据本身应可提交");
      const gateFail = verifyDone({ nodeId });
      assert.equal(gateFail.ok, false, "闸门未过时 verify 必须失败");
      assert.equal(gateFail.error, "credential-unavailable");
      obs.sampleToolCall({
        tool: "verify_done",
        nodeId,
        instanceId,
        ok: false,
        errorCode: String(gateFail.error),
        wallMs: 5,
      });

      // 真实驳回迁移（Python `_reject` 同义：清租约 + `rejected:` 原因）。
      // 注意：core 的 rejected 路径**自己**会落 `attempts_changed`（0→1），
      // 这里不能再传 attemptsDelta，否则会把同一次重试记成两次。
      setStatus(store, nodeId, "ready", {
        reason: "rejected:credential-unavailable",
        assignee: null,
        dropLease: true,
      });
      rejectedOnce = true;
      const retry = claimTask({ nodeId, instanceId });
      assert.equal(retry.ok, true, `retry claim ${nodeId}`);
    }

    // ④ 真实提交证据（sha 由 core 现算）
    const artifactPath = writeArtifact(workDir, nodeId);
    const evidence = submitEvidence({
      nodeId,
      artifactPath,
      producerInstance: instanceId,
      verifier: "verifier-ci",
      verdict: "pass",
    });
    assert.equal(evidence.ok, true, `evidence ${nodeId}: ${JSON.stringify(evidence)}`);

    // ⑤ 阶段闸门 → ⑥ done
    passGate(store, spec.stage, [evidence.evidenceId]);
    const done = verifyDone({ nodeId });
    assert.equal(done.ok, true, `verify ${nodeId}: ${JSON.stringify(done)}`);

    // ⑦ 工具调用采样（真实工具名 + 真实节点 id + adapter usage）
    const attempt = rejectedOnce || nodeId === "NODE-CONTRACT" ? 2 : 1;
    obs.sampleToolCall({ tool: "task_next", ok: true, wallMs: 2 });
    obs.sampleToolCall({ tool: "claim_task", nodeId, instanceId, ok: true, wallMs: 6, attempt });
    obs.sampleToolCall({
      tool: "submit_evidence",
      nodeId,
      instanceId,
      ok: true,
      wallMs: 18,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      cost: usage.cost,
      attempt,
    });
    obs.sampleToolCall({ tool: "verify_done", nodeId, instanceId, ok: true, wallMs: 11, attempt });

    chain.push({ nodeId, attempts: attempt });
  }

  return { store, workDir, chain };
}

test("真实 core 6 节点链：token/成本/耗时/重试 全部可见", () => {
  const obs = createObservability({ clock: () => FIXED_AT, limits: { maxTokens: 5000 } });
  const { store, chain } = runRealChain(obs);

  // 真实链确实 6/6 done
  const status = graphStatus();
  assert.equal(status.counts.done, 6, JSON.stringify(status.counts));
  assert.deepEqual(status.ready, []);

  const snapshot = obs.snapshot();
  assert.equal(snapshot.nodes.length, 6);
  for (const node of snapshot.nodes) {
    assert.ok(node.tokens > 0, `${node.nodeId} token 不可见`);
    assert.ok(node.cost > 0, `${node.nodeId} 成本不可见`);
    assert.ok(node.wallMs > 0, `${node.nodeId} 耗时不可见`);
  }

  // journal 派生：租约过期 + 驳回都来自真实事件
  const derived = metricsFromEvents(store.journal.raw());
  applyJournal(obs.metrics, derived);
  assert.equal(derived.leaseExpired, 1, "真实 lease_expired 应被计入");
  assert.ok(derived.rejected >= 1, "真实 rejected: 迁移应被计入");
  assert.equal(derived.done.length, 6);
  assert.ok(derived.retries >= 1, "attempts_changed 应产生重试计数");

  // 重试在节点级可见（NODE-CONTRACT 过期重认领 / NODE-BUILD 驳回重试）
  const after = obs.snapshot();
  const contract = after.nodes.find((node) => node.nodeId === "NODE-CONTRACT");
  const build = after.nodes.find((node) => node.nodeId === "NODE-BUILD");
  assert.ok(contract.retries >= 1, "NODE-CONTRACT 应有重试");
  assert.ok(build.retries >= 1, "NODE-BUILD 应有重试");
  assert.equal(build.lastErrorCode, "credential-unavailable");

  const projection = obs.projection({ blocked: readGraphStatus(status).blocked });
  assert.equal(projection.retries.total, after.totals.retries);
  assert.ok(projection.retries.byNode.some((row) => row.nodeId === "NODE-BUILD"));
  assert.equal(projection.source.lease_expired, 1);
  assert.ok(projection.totals.tokens > 0);
  assert.ok(projection.totals.cost > 0);
  assert.ok(projection.totals.wallMs > 0);
  assert.equal(chain.length, 6);
});

test("真实链上告警触发：预算 + 租约过期 + 拒绝率", () => {
  const obs = createObservability({
    clock: () => FIXED_AT,
    // 预算设得很低，6 节点链必然超；拒绝率阈值 5%、样本门槛 5
    limits: { maxTokens: 1000, maxCost: 0.01, maxRejectionRate: 0.05, minSamplesForRate: 5 },
  });
  const { store } = runRealChain(obs);
  applyJournal(obs.metrics, metricsFromEvents(store.journal.raw()));

  const health = obs.health();
  const rules = new Set(health.alerts.map((alert) => alert.rule));
  assert.ok(rules.has("budget-exceeded"), "应触发预算告警");
  assert.ok(rules.has("lease-expired"), "应触发租约过期告警");
  assert.ok(rules.has("rejection-rate"), "应触发拒绝率告警（真实 verify 失败）");
  assert.equal(health.status, "critical");
  assert.equal(health.ok, false);

  // 逐规则 checks 必须覆盖全部规则（含未触发的）
  assert.equal(health.checks.length, alertRuleIds().length);
  assert.ok(health.checks.some((check) => check.rule === "node-blocked" && check.ok));
});

test("真实链观测挂到 graph_status 上：形状不破、无标题/愿望文本泄漏", () => {
  const obs = createObservability({ clock: () => FIXED_AT });
  const { store, workDir } = runRealChain(obs);
  applyJournal(obs.metrics, metricsFromEvents(store.journal.raw()));

  const status = graphStatus();
  const hints = readGraphStatus(status);
  const merged = withObservability(status, obs.projection(hints));

  assert.equal(merged.ok, true);
  assert.equal(merged.counts.done, 6);
  const observation = merged.observability;
  assert.equal(observation.window.nodes, 6);
  // 真实链里有 1 次租约过期 → 只有 lease-expired warn，没有 critical
  assert.equal(observation.health.status, "degraded");
  assert.deepEqual([...new Set(observation.alerts.map((alert) => alert.rule))], ["lease-expired"]);
  assert.deepEqual(observation.source.blocked, []);

  const exported = JSON.stringify(observation);
  for (const spec of WISH_PLAN) {
    assert.ok(!exported.includes(spec.title), `不应泄漏节点标题：${spec.title}`);
  }
  assert.ok(!exported.includes("愿望"), "不应泄漏愿望文本片段");
  assert.ok(!exported.includes(workDir), "不应泄漏产物绝对路径");

  const outDir = path.join(workDir, "obs");
  const written = obs.exportTo(outDir);
  const json = fs.readFileSync(written.jsonPath, "utf8");
  const parsed = JSON.parse(json);
  assert.equal(parsed.window.nodes, 6);
  assert.equal(parsed.byNode.length, 6);
  assert.ok(parsed.alerts.length >= 1, "真实链应至少带 1 条告警（租约过期）");
  assert.ok(json.includes("\"window\""));
  assert.ok(!json.includes(WISH_PLAN[0].title));

  // JSONL：summary 1 行 + alerts + 6 个 node 行；每行都是合法 JSON 且无敏感串
  const logText = fs.readFileSync(written.logPath, "utf8");
  const lines = logText.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 1 + parsed.alerts.length + 6);
  assert.equal(lines[0].t, "summary");
  assert.equal(lines[0].tokens, parsed.totals.tokens);
  assert.equal(lines.filter((row) => row.t === "node").length, 6);
  assert.equal(findSensitive(json), null);
  assert.equal(findSensitive(logText), null);
  for (const spec of WISH_PLAN) {
    assert.ok(!logText.includes(spec.title), `日志不应泄漏标题：${spec.title}`);
  }
});
