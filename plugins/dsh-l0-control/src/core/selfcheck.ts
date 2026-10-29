/**
 * N3 自检：核心不变量冒烟（不依赖测试框架/包配置，`node src/core/selfcheck.ts` 直接跑）。
 *
 * 输出 JSON：{ ok, passed, failed, cases:[{name, ok, error?}] }
 * 退出码：0 = 全过；1 = 有失败。
 */
import { Store } from "./store.ts";
import { addArtifact, addEvidence, auditIndependence, parseInstanceId, roleOfInstance, sameInstance } from "./evidence.ts";
import {
  addEdge,
  addNode,
  doneCredential,
  getNode,
  removeNode,
  replayMismatches,
  replaySnapshot,
  setStatus,
  snapshot,
  unblock,
} from "./graph.ts";
import { bootstrap, installReadyHook, recomputeReady } from "./ready.ts";
import { claim, currentLease, expire, release, renew, takeover } from "./leases.ts";
import {
  claimTask,
  configureCore,
  coreCapabilities,
  decide,
  exportProjection,
  graphStatus,
  nextTask,
  resetCore,
  submitEvidence,
  submitWish,
  verifyDone,
} from "./facade.ts";
import { confirmL3, createDecision, getDecision, overrideDecision, tickL2 } from "./decisions.ts";
import { currentGraphVersion, listReplanEvents, replan } from "./replan.ts";
import { foldEvents, rehydrate, restoreFromEvents } from "./fold.ts";
import {
  blockedByGates,
  failGate,
  gateAllowsDone,
  getGate,
  listGates,
  passGate,
  setGate,
} from "./stages.ts";
import { configureIo } from "./io.ts";
import { allowedTransitions, setTransitionEnforcement, TRANSITIONS } from "./status.ts";
import type { Clock } from "./types.ts";

const SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** 确定性时钟：固定秒级 ISO，便于差分（与 Python 夹具对齐时可注入）。 */
function fixedClock(startMs = 1_700_000_000_000): Clock {
  let t = startMs;
  return {
    nowIso: () => new Date(t).toISOString(),
    nowMs: () => t,
  };
}

/** 便捷：把 ready 节点走完整证据链进入 done（送凭证）。 */
function graphSetReadyAndDone(store: Store, nodeId: string): void {
  if (getNode(store, nodeId)?.status === "ready") {
    claim(store, nodeId, "agent-done", { ttlSec: 600, now: 2000 });
    setStatus(store, nodeId, "submitted", { reason: "submitted", notify: false });
    setStatus(store, nodeId, "verifying", { reason: "verify_started", notify: false });
  }
  const credential = doneCredential(store, nodeId);
  if (!credential) throw new Error(`凭证不可用：${nodeId}`);
  setStatus(store, nodeId, "done", { credential, reason: "evidence_ok" });
}

interface CaseResult {
  name: string;
  ok: boolean;
  error?: string;
}

const results: CaseResult[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: (error as Error).message });
  }
}

function expectError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    const actual = (error as { code?: string }).code;
    if (actual !== code) throw new Error(`期望错误码 ${code}，实际 ${String(actual)}（${(error as Error).message}）`);
    return;
  }
  throw new Error(`期望抛出 ${code}，但没有抛错`);
}

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error(message);
}

function newStore(): Store {
  return new Store({ clock: fixedClock() });
}

function mint(store: Store, nodeId: string, kind = "artifact"): void {
  addArtifact(store, {
    artifactId: `ART-${nodeId}`,
    path: `out/${nodeId}.txt`,
    sha256: SHA,
    producerNode: nodeId,
  });
  addEvidence(store, {
    evidenceId: `EVD-${nodeId}`,
    nodeId,
    kind,
    artifactId: `ART-${nodeId}`,
    verifierId: "verifier-ci",
    producerInstance: "ROLE-CODE-01",
    verdict: "pass",
  });
}

// ── 1. 白名单 / 终态形状 ───────────────────────────────────────────────
check("whitelist_shape", () => {
  assert(TRANSITIONS.size === 16, `白名单应有 16 条边，实际 ${TRANSITIONS.size}`);
  const adj = allowedTransitions();
  assert(JSON.stringify(adj.blocked) === JSON.stringify(["ready"]), "blocked 只能到 ready");
  assert(!adj.done, "done 不应有任何出边");
  assert(adj.verifying.includes("done"), "verifying → done 必须存在");
});

// ── 2. done 无凭证拒绝，且不写事件 ─────────────────────────────────────
check("done_requires_credential", () => {
  const store = newStore();
  addNode(store, { nodeId: "N1", title: "t", spec: "s", status: "verifying" });
  const before = store.journal.count();
  expectError(() => setStatus(store, "N1", "done"), "credential_required");
  assert(getNode(store, "N1")?.status === "verifying", "状态不应改变");
  assert(store.journal.count() === before, "拒绝时不得写事件");
});

// ── 3. done 有凭证成功；终态不可退出 ───────────────────────────────────
check("done_then_terminal", () => {
  const store = newStore();
  addNode(store, {
    nodeId: "N1",
    title: "t",
    spec: "s",
    status: "verifying",
    evidenceRequired: ["artifact"],
    verifierIds: ["verifier-ci"],
  });
  mint(store, "N1");
  const cred = doneCredential(store, "N1");
  assert(cred, "凭证应可铸造");
  setStatus(store, "N1", "done", { credential: cred, reason: "evidence_ok" });
  assert(getNode(store, "N1")?.status === "done", "应进入 done");
  const before = store.journal.count();
  expectError(() => setStatus(store, "N1", "ready"), "graph_error");
  expectError(() => setStatus(store, "N1", "planned"), "graph_error");
  assert(getNode(store, "N1")?.status === "done", "终态不可退出");
  assert(store.journal.count() === before, "终态拒绝不得写事件");
  assert(replayMismatches(store).length === 0, "终态用例后 replay 应一致");
});

// ── 4. 白名单拒非法边（E 探针三条） ─────────────────────────────────────
check("whitelist_rejects_probes", () => {
  setTransitionEnforcement(true);
  const store = newStore();
  addNode(store, { nodeId: "N1", title: "t", spec: "s", status: "planned" });
  const before = store.journal.count();
  for (const target of ["running", "verifying", "claimed", "submitted"] as const) {
    expectError(() => setStatus(store, "N1", target), "graph_error");
  }
  assert(store.journal.count() === before, "拒绝不得写事件");
  addNode(store, { nodeId: "N2", title: "t2", spec: "s", status: "verifying" });
  expectError(() => setStatus(store, "N2", "submitted"), "graph_error");
});

// ── 5. 合法链 + replay 对齐（含 assignee / attempts） ──────────────────
check("legal_chain_replay", () => {
  const store = newStore();
  addNode(store, { nodeId: "N1", title: "t", spec: "s", status: "planned" });
  setStatus(store, "N1", "ready", { reason: "bootstrap" });
  setStatus(store, "N1", "claimed", { assignee: "agent-A", reason: "lease_claimed" });
  setStatus(store, "N1", "submitted", { reason: "submitted" });
  setStatus(store, "N1", "verifying", { reason: "verify_started" });
  setStatus(store, "N1", "ready", { reason: "rejected:no_evidence", assignee: null, attemptsDelta: 1 });
  const node = getNode(store, "N1");
  assert(node?.status === "ready", "应回到 ready");
  assert(node?.attempts === 1, `attempts 应为 1，实际 ${node?.attempts}`);
  assert(node?.assignee === null, "assignee 应清空");
  assert(replayMismatches(store).length === 0, `replay 应一致：${JSON.stringify(replayMismatches(store))}`);
  assert(JSON.stringify(snapshot(store)) === JSON.stringify(replaySnapshot(store)), "snapshot 应等于 replay");
});

// ── 6. 写期环检测 ──────────────────────────────────────────────────────
check("cycle_rejected", () => {
  const store = newStore();
  addNode(store, { nodeId: "A", title: "a", spec: "s" });
  addNode(store, { nodeId: "B", title: "b", spec: "s", deps: ["A"] });
  expectError(() => addEdge(store, "B", "A", "blocks"), "cycle");
  expectError(() => addEdge(store, "A", "A", "blocks"), "cycle");
  addEdge(store, "B", "A", "artifact"); // 非 blocks 边不受限
  assert(replayMismatches(store).length === 0, "环用例后 replay 应一致");
});

// ── 7. 证据 append-only ───────────────────────────────────────────────
check("evidence_append_only", () => {
  const store = newStore();
  addNode(store, { nodeId: "N1", title: "t", spec: "s", status: "verifying" });
  addArtifact(store, { artifactId: "ART-1", path: "out/a", sha256: SHA, producerNode: "N1" });
  expectError(
    () => addArtifact(store, { artifactId: "ART-1", path: "out/a", sha256: SHA, producerNode: "N1" }),
    "duplicate_artifact",
  );
  addEvidence(store, {
    evidenceId: "EVD-1",
    nodeId: "N1",
    kind: "artifact",
    artifactId: "ART-1",
    verifierId: "verifier-ci",
    producerInstance: "ROLE-CODE-01",
    verdict: "pass",
  });
  expectError(
    () =>
      addEvidence(store, {
        evidenceId: "EVD-1",
        nodeId: "N1",
        kind: "artifact",
        artifactId: "ART-1",
        verifierId: "verifier-ci",
        producerInstance: "ROLE-CODE-01",
        verdict: "pass",
      }),
    "duplicate_evidence",
  );
});

// ── 8. 终态不可删 / blocked 解除需留痕 ────────────────────────────────
check("terminal_remove_and_unblock", () => {
  const store = newStore();
  addNode(store, {
    nodeId: "N1",
    title: "t",
    spec: "s",
    status: "verifying",
    evidenceRequired: ["artifact"],
    verifierIds: ["verifier-ci"],
  });
  mint(store, "N1");
  setStatus(store, "N1", "done", { credential: doneCredential(store, "N1"), reason: "evidence_ok" });
  expectError(() => removeNode(store, "N1"), "graph_error");
  removeNode(store, "N1", { allowTerminal: true });
  assert(getNode(store, "N1") === undefined, "allowTerminal 应可清理");

  const store2 = newStore();
  addNode(store2, { nodeId: "N2", title: "t", spec: "s", status: "ready" });
  setStatus(store2, "N2", "blocked", { reason: "budget_exceeded", assignee: null });
  expectError(() => setStatus(store2, "N2", "ready"), "graph_error");
  unblock(store2, "N2", "人工复核");
  const node = getNode(store2, "N2");
  assert(node?.status === "ready", "解除后应 ready");
  const last = store2.journal.all().filter((e) => e.kind === "status_changed").pop();
  assert(last?.payload.reason === "unblocked:人工复核", "解除原因必须留痕");
  assert(replayMismatches(store2).length === 0, "解除后 replay 应一致");
});

// ── 9. 事件流体检 ──────────────────────────────────────────────────────
check("journal_audit", () => {
  const store = newStore();
  addNode(store, { nodeId: "N1", title: "t", spec: "s" });
  setStatus(store, "N1", "ready", { reason: "bootstrap" });
  const report = store.journal.validateStream();
  assert(report.ok, `事件流体检失败：${JSON.stringify(report.issues)}`);
  assert(store.journal.count() === report.events, "事件计数应一致");
});

// ── 10. ready 门控：只有依赖全 done 才晋升；done 事件自动解锁下游 ───────
check("ready_gate_and_auto_promote", () => {
  const store = newStore();
  installReadyHook(store);
  addNode(store, { nodeId: "A", title: "a", spec: "s" });
  addNode(store, { nodeId: "B", title: "b", spec: "s", deps: ["A"] });
  const boot = bootstrap(store);
  assert(JSON.stringify(boot) === JSON.stringify(["A"]), `bootstrap 应只晋升 A，实际 ${JSON.stringify(boot)}`);
  assert(getNode(store, "B")?.status === "planned", "B 依赖未 done，仍应 planned");

  addArtifact(store, { artifactId: "ART-A", path: "out/a", sha256: SHA, producerNode: "A" });
  addEvidence(store, {
    evidenceId: "EVD-A",
    nodeId: "A",
    kind: "artifact",
    artifactId: "ART-A",
    verifierId: "verifier-ci",
    producerInstance: "ROLE-CODE-01",
    verdict: "pass",
  });
  graphSetReadyAndDone(store, "A");
  assert(getNode(store, "A")?.status === "done", "A 应 done");
  assert(getNode(store, "B")?.status === "ready", "done 事件应把 B 解锁为 ready");
  assert(replayMismatches(store).length === 0, "ready 用例后 replay 应一致");
});

// ── 11. 假 ready 降级 ─────────────────────────────────────────────────
check("fake_ready_demoted", () => {
  const store = newStore();
  addNode(store, { nodeId: "A", title: "a", spec: "s", status: "running" });
  addNode(store, { nodeId: "B", title: "b", spec: "s", deps: ["A"], status: "ready" });
  const change = recomputeReady(store, { reason: "recompute" });
  assert(JSON.stringify(change.demoted) === JSON.stringify(["B"]), "假 ready 应被降级");
  assert(getNode(store, "B")?.status === "planned", "降级后应回 planned");
});

// ── 12. 租约全流程 + 令牌单调 + replay ────────────────────────────────
check("leases_flow", () => {
  const store = newStore();
  addNode(store, { nodeId: "N1", title: "t", spec: "s", status: "ready" });
  const lease1 = claim(store, "N1", "agent-A", { ttlSec: 10, now: 1000 });
  assert(lease1.fencing_token === 1, "首个令牌应为 1");
  assert(getNode(store, "N1")?.status === "claimed", "claim 后应 claimed");
  assert(getNode(store, "N1")?.assignee === "agent-A", "assignee 应为 owner");
  renew(store, "N1", "agent-A", 1, { ttlSec: 10, now: 1005 });
  const expired = expire(store, { now: 1020 });
  assert(JSON.stringify(expired) === JSON.stringify(["N1"]), "过期回收应返回 N1");
  const after = getNode(store, "N1");
  assert(after?.status === "ready" && after?.attempts === 1, "过期后应 ready + attempts 1");
  assert(after?.assignee === null, "过期后 assignee 应清空");
  const lease2 = claim(store, "N1", "agent-B", { ttlSec: 10, now: 1030 });
  assert(lease2.fencing_token === 2, "再次 claim 令牌应递增到 2");
  const taken = takeover(store, "N1", "agent-C", { ttlSec: 10, now: 1100 });
  assert(taken.fencing_token === 3 && taken.owner === "agent-C", "takeover 应换 owner 并递增令牌");
  release(store, "N1", "agent-C", 3);
  assert(currentLease(store, "N1") === undefined, "release 后租约应消失");
  assert(getNode(store, "N1")?.status === "ready", "release 后应 ready");
  assert(
    replayMismatches(store).length === 0,
    `租约用例后 replay 应一致：${JSON.stringify(replayMismatches(store).slice(0, 3))}`,
  );
});

// ── 13. fencing / 过期语义 ───────────────────────────────────────────
check("leases_fencing_guards", () => {
  const store = newStore();
  addNode(store, { nodeId: "N1", title: "t", spec: "s", status: "ready" });
  claim(store, "N1", "agent-A", { ttlSec: 10, now: 1000 });
  expectError(() => claim(store, "N1", "agent-B", { now: 1005 }), "lease_held");
  expectError(() => renew(store, "N1", "agent-A", 99, { now: 1005 }), "fencing");
  expectError(() => renew(store, "N1", "agent-A", 1, { now: 1011 }), "lease_expired");
  expectError(() => takeover(store, "N1", "agent-B", { now: 1005 }), "lease_held");
});

// ── 14. 门面契约（N2 约定的 8 个动作） ─────────────────────────────────
check("facade_contract", () => {
  resetCore();
  const store = new Store({ clock: fixedClock() });
  configureCore({ store });
  installReadyHook(store);
  addNode(store, {
    nodeId: "N1",
    title: "t",
    spec: "s",
    capability: "CODE",
    evidenceRequired: ["artifact"],
    verifierIds: ["verifier-ci"],
  });
  bootstrap(store);

  const status = graphStatus() as Record<string, unknown>;
  assert(status.ok === true, "graphStatus 应 ok");
  assert(Array.isArray(status.ready), "graphStatus 应带 ready 列表");

  const next = nextTask({ role: "CODE" }) as { task?: { node_id?: string } };
  assert(next.task?.node_id === "N1", "nextTask 应按职务取到 N1");

  const claimed = claimTask({ nodeId: "N1", instanceId: "ROLE-CODE-01" }) as {
    ok?: boolean;
    lease?: { fencing_token?: number };
  };
  assert(claimed.ok === true && claimed.lease?.fencing_token === 1, "claimTask 应成功并拿到令牌");

  const projection = exportProjection("out/export") as {
    ok?: boolean;
    projection?: { nodes?: unknown[] };
  };
  assert(projection.ok === true && Array.isArray(projection.projection?.nodes), "exportProjection 应返回投影");

  // R4 起 8 个动作全部落地（coreCapabilities().pending 应为空）
  const caps = coreCapabilities() as { pending?: string[] };
  assert(Array.isArray(caps.pending) && caps.pending.length === 0, "R4 后不应再有 pending 动作");
  const emptyDecide = decide({}) as Record<string, unknown>;
  assert(emptyDecide.ok === false, "decide 缺参数不得成功");
  resetCore();
});

// ── 15. 审计独立：producerInstance 必填 + 同实例/同职务拒绝 ─────────────
check("audit_independence", () => {
  const store = newStore();
  addNode(store, {
    nodeId: "N1",
    title: "t",
    spec: "s",
    status: "verifying",
    evidenceRequired: ["artifact"],
    verifierIds: ["verifier-ci"],
  });
  addArtifact(store, { artifactId: "ART-1", path: "out/a", sha256: SHA, producerNode: "N1" });

  // 缺提交者实例 → fail-closed，不落账
  expectError(
    () =>
      addEvidence(store, {
        evidenceId: "EVD-noprod",
        nodeId: "N1",
        kind: "artifact",
        artifactId: "ART-1",
        verifierId: "verifier-ci",
        verdict: "pass",
      }),
    "producer-instance-required",
  );
  assert(!store.state.evidence.has("EVD-noprod"), "被拒证据不得落库");

  // 同实例（自审自证）→ 拒绝
  expectError(
    () =>
      addEvidence(store, {
        evidenceId: "EVD-same",
        nodeId: "N1",
        kind: "artifact",
        artifactId: "ART-1",
        verifierId: "verifier-ci",
        producerInstance: "ROLE-AUDIT-01",
        auditorInstance: "ROLE-AUDIT-01",
        verdict: "pass",
      }),
    "audit-not-independent",
  );

  // 同职务不同实例 → 拒绝（ROLE-CODE-01 给 ROLE-CODE-02 背书）
  expectError(
    () =>
      addEvidence(store, {
        evidenceId: "EVD-samerole",
        nodeId: "N1",
        kind: "artifact",
        artifactId: "ART-1",
        verifierId: "verifier-ci",
        producerInstance: "ROLE-CODE-01",
        auditorInstance: "ROLE-CODE-02",
        verdict: "pass",
      }),
    "audit-not-independent",
  );

  // 不同职务 → 通过，且凭证可铸造
  addEvidence(store, {
    evidenceId: "EVD-ok",
    nodeId: "N1",
    kind: "artifact",
    artifactId: "ART-1",
    verifierId: "verifier-ci",
    producerInstance: "ROLE-CODE-01",
    auditorInstance: "ROLE-AUDIT-01",
    verdict: "pass",
  });
  const record = store.state.evidence.get("EVD-ok");
  assert(record?.producer_instance === "ROLE-CODE-01", "producer_instance 应落账");
  assert(record?.auditor_instance === "ROLE-AUDIT-01", "auditor_instance 应落账");
  assert(!("actor" in (record as object)), "证据记录不得使用 actor 字段");
  const credential = doneCredential(store, "N1");
  assert(credential, "独立审计的证据应可铸造 done 凭证");
});

// ── 16. 决策：L2 默认值 + 超时推进；L3 硬闸门；L0/L1 自动 ──────────────
check("decisions_l2_l3_l0", () => {
  const store = newStore();
  expectError(
    () =>
      createDecision(store, {
        decisionId: "DEC-BAD",
        level: "L2",
        question: "q",
        options: [{ option_id: "a" }, { option_id: "b" }],
      }),
    "decision_error",
  );
  const l2 = createDecision(store, {
    decisionId: "DEC-L2",
    level: "L2",
    question: "库选型？",
    options: [{ option_id: "a" }, { option_id: "b" }],
    defaultOptionId: "a",
    timeoutSec: 60,
    now: 1000,
  });
  assert(l2.status === "proposed" && l2.chosen_option_id === null, "L2 初始应 proposed 且未选");
  assert(tickL2(store, { now: 1059 }).length === 0, "未到期不应推进");
  const timedOut = tickL2(store, { now: 1060 });
  assert(JSON.stringify(timedOut) === JSON.stringify(["DEC-L2"]), "到期应按默认值推进");
  const afterTick = getDecision(store, "DEC-L2");
  assert(afterTick?.status === "timed_out", "L2 超时状态应为 timed_out");
  assert(afterTick?.chosen_option_id === afterTick?.default_option_id, "超时 chosen 必须等于默认值");

  const l3 = createDecision(store, {
    decisionId: "DEC-L3",
    level: "L3",
    question: "是否对外发布？",
    options: [{ option_id: "yes" }, { option_id: "no" }],
    impact: "high",
    reversible: false,
  });
  assert(l3.status === "blocked", "L3 无 chosen 应 blocked");
  expectError(() => confirmL3(store, "DEC-L3", "maybe"), "decision_error");
  assert(confirmL3(store, "DEC-L3", "yes").status === "confirmed", "确认后应 confirmed");
  expectError(() => confirmL3(store, "DEC-L3", "no"), "decision_error");

  const l1 = createDecision(store, {
    decisionId: "DEC-L1",
    level: "L1",
    question: "UI 风格？",
    options: [{ option_id: "a" }, { option_id: "b" }],
    chosenOptionId: "a",
  });
  assert(l1.status === "auto" && l1.chosen_option_id === "a", "L1 应 auto");
  assert(overrideDecision(store, "DEC-L1", "b").status === "overridden", "推翻应留痕 overridden");
  assert(store.journal.validateStream().ok, "决策事件流应体检通过");
});

// ── 17. 证据提交：sha 判定 + append-only + producer 必填 ────────────────
check("evidence_submit_paths", () => {
  resetCore();
  configureIo({
    exists: () => true,
    isFile: () => true,
    sha256: () => SHA,
    readText: () => "hello world",
    resolve: (p: string) => `/virtual/${p}`,
  });
  const store = new Store({ clock: fixedClock() });
  configureCore({ store });
  installReadyHook(store);
  addNode(store, { nodeId: "A", title: "a", spec: "s", evidenceRequired: ["artifact"] });
  addNode(store, { nodeId: "B", title: "b", spec: "s", deps: ["A"] });
  bootstrap(store);
  claimTask({ nodeId: "A", instanceId: "ROLE-CODE-01" });

  const noProducer = submitEvidence({ nodeId: "A", artifactPath: "a.txt" }) as Record<string, unknown>;
  assert(noProducer.ok === false && noProducer.error === "producer-instance-required", "缺 producer 必须拒绝");

  // 裁决：既无 acceptance 又无显式 verdict → unknown（不得 pass）
  const noAcceptance = submitEvidence({
    nodeId: "A",
    artifactPath: "a.txt",
    producerInstance: "ROLE-CODE-01",
    auditorInstance: "ROLE-AUDIT-01",
  }) as Record<string, unknown>;
  assert(
    noAcceptance.ok === false && noAcceptance.verdict === "unknown",
    `无 acceptance 无 verdict 必须 unknown：${JSON.stringify(noAcceptance)}`,
  );
  assert(getNode(store, "A")?.status === "claimed", "unknown 不得推进节点");

  const unknownVerdict = submitEvidence({
    nodeId: "A",
    artifactPath: "a.txt",
    producerInstance: "ROLE-CODE-01",
    acceptance: { kind: "contains" },
  }) as Record<string, unknown>;
  assert(
    unknownVerdict.ok === false && unknownVerdict.verdict === "unknown",
    "空 expected 必须是 unknown 且 ok:false",
  );

  const shaFail = submitEvidence({
    nodeId: "A",
    artifactPath: "a.txt",
    producerInstance: "ROLE-CODE-01",
    acceptance: { kind: "sha256", expected: "f".repeat(64) },
  }) as Record<string, unknown>;
  assert(shaFail.ok === false && shaFail.verdict === "fail", "sha 不符应 fail");

  const pass = submitEvidence({
    nodeId: "A",
    artifactPath: "a.txt",
    producerInstance: "ROLE-CODE-01",
    auditorInstance: "ROLE-AUDIT-01",
    acceptance: { kind: "sha256", expected: SHA },
  }) as Record<string, unknown>;
  assert(pass.ok === true && pass.verdict === "pass", `落账应成功：${JSON.stringify(pass)}`);
  assert(getNode(store, "A")?.status === "submitted", "pass 后节点应 submitted");
  assert(pass.attemptNo === 4, `attempt_no 应递增到 4（unknown×2 + fail + pass），实际 ${pass.attemptNo}`);

  const dup = submitEvidence({
    nodeId: "A",
    artifactPath: "a.txt",
    evidenceId: String(pass.evidenceId),
    producerInstance: "ROLE-CODE-01",
  }) as Record<string, unknown>;
  assert(dup.ok === false && dup.error === "duplicate_evidence", "同 ID 覆盖必须拒绝");

  const notIndependent = submitEvidence({
    nodeId: "B",
    artifactPath: "b.txt",
    producerInstance: "ROLE-CODE-01",
    auditorInstance: "ROLE-CODE-02",
  }) as Record<string, unknown>;
  assert(
    notIndependent.ok === false && notIndependent.error === "audit-not-independent",
    "同职务审计必须拒绝",
  );
  resetCore();
  configureIo(null);
});

// ── 18. verifyDone：凭证 → done → 解锁下游；失败不写状态 ────────────────
check("verify_done_and_reject_semantics", () => {
  resetCore();
  configureIo({
    exists: () => true,
    isFile: () => true,
    sha256: () => SHA,
    readText: () => "hello",
    resolve: (p: string) => `/virtual/${p}`,
  });
  const store = new Store({ clock: fixedClock() });
  configureCore({ store });
  installReadyHook(store);
  addNode(store, {
    nodeId: "A",
    title: "a",
    spec: "s",
    evidenceRequired: ["artifact"],
    verifierIds: ["verifier-ci"],
  });
  addNode(store, { nodeId: "B", title: "b", spec: "s", deps: ["A"] });
  bootstrap(store);
  claimTask({ nodeId: "A", instanceId: "ROLE-CODE-01" });
  const submitted = submitEvidence({
    nodeId: "A",
    artifactPath: "a.txt",
    producerInstance: "ROLE-CODE-01",
    auditorInstance: "ROLE-AUDIT-01",
    verdict: "pass",
  }) as Record<string, unknown>;
  assert(submitted.ok === true, "证据提交应成功");

  const done = verifyDone({ nodeId: "A" }) as Record<string, unknown>;
  assert(done.ok === true && done.status === "done", `应 done：${JSON.stringify(done)}`);
  assert(Array.isArray(done.promoted) && done.promoted.includes("B"), "done 应解锁下游 B");
  assert(getNode(store, "B")?.status === "ready", "B 应变 ready");
  assert(replayMismatches(store).length === 0, "done 后 replay 应一致");

  addNode(store, {
    nodeId: "C",
    title: "c",
    spec: "s",
    status: "verifying",
    evidenceRequired: ["artifact"],
  });
  const before = store.journal.count();
  const failed = verifyDone({ nodeId: "C" }) as Record<string, unknown>;
  assert(
    failed.ok === false && failed.error === "credential-unavailable",
    `无证据必须 credential-unavailable：${JSON.stringify(failed)}`,
  );
  // P1 契约：验证失败 = 驳回（ready + dropLease + attempts+1），不再「什么都不写」
  const afterReject = getNode(store, "C");
  assert(afterReject?.status === "ready", `驳回后应 ready，实际 ${afterReject?.status}`);
  assert(afterReject?.attempts === 1, `驳回应 attempts+1，实际 ${afterReject?.attempts}`);
  assert(currentLease(store, "C") === undefined, "驳回后不得留 stale 租约");
  assert(store.journal.count() > before, "驳回必须留痕（node_rejected + status_changed）");
  const lastStatus = store.journal
    .all()
    .filter((e) => e.kind === "status_changed")
    .pop();
  assert(
    String(lastStatus?.payload.reason).startsWith("rejected:"),
    `驳回 reason 应为 rejected:*，实际 ${String(lastStatus?.payload.reason)}`,
  );
  assert(replayMismatches(store).length === 0, "驳回后 replay 应一致");
  resetCore();
  configureIo(null);
});

// ── 19. submitWish：确定性最小图 + 幂等 ────────────────────────────────
check("wish_submit", () => {
  resetCore();
  const store = new Store({ clock: fixedClock() });
  configureCore({ store });
  installReadyHook(store);

  const wish = submitWish({ text: "做一个 CRUD", maxParallel: 2, budgetTokens: 50000 }) as Record<string, unknown>;
  assert(wish.ok === true, `submitWish 应成功：${JSON.stringify(wish)}`);
  assert(
    (wish.nodes as string[]).join(",") ===
      "NODE-RESEARCH,NODE-PRD,NODE-CONTRACT,NODE-BUILD,NODE-AUDIT,NODE-DELIVER",
    "节点序列应与确定性计划一致",
  );
  assert(JSON.stringify(wish.ready) === JSON.stringify(["NODE-RESEARCH"]), "只有根节点应 ready");
  assert(getNode(store, "NODE-PRD")?.status === "planned", "下游应保持 planned");
  assert(replayMismatches(store).length === 0, "建图后 replay 应一致");
  assert(store.journal.validateStream().ok, "建图事件流应体检通过");

  const again = submitWish({ text: "再来一次" }) as Record<string, unknown>;
  assert(again.ok === false && again.error === "wish-already-submitted", "重复提交应拒绝，不静默建第二份图");

  const empty = submitWish({ text: "  " }) as Record<string, unknown>;
  assert(empty.ok === false && empty.error === "wish-text-required", "空愿望应拒绝");
  resetCore();
});

// ── 20. replan：单事务 + 版本 + 回滚 + 终态不可删 ───────────────────────
check("replan_single_transaction", () => {
  resetCore();
  const store = new Store({ clock: fixedClock() });
  configureCore({ store });
  installReadyHook(store);
  submitWish({ text: "做个 CRUD" });
  const versionBefore = currentGraphVersion(store);

  const rec = replan(store, {
    reason: "scope_change",
    add: [{ nodeId: "NODE-DOCS", title: "文档", spec: "s", deps: [] }],
    note: "补文档",
  });
  assert(rec.graph_version === versionBefore + 1, "版本应 +1");
  assert(rec.event_id === `EVT-R${String(rec.graph_version).padStart(4, "0")}`, "事件 ID 格式应为 EVT-R####");
  assert(rec.promoted.includes("NODE-DOCS"), "新无依赖节点应被补推 ready");
  assert(listReplanEvents(store).length === 1, "replan_events 应有 1 行");
  assert(replayMismatches(store).length === 0, "replan 后 replay 应一致");

  const versionNow = currentGraphVersion(store);
  const eventsNow = store.journal.count();
  const replansNow = listReplanEvents(store).length;
  expectError(
    () =>
      replan(store, {
        reason: "failure_retry",
        add: [
          { nodeId: "NODE-TMP", title: "tmp", spec: "s" },
          { nodeId: "NODE-BAD", title: "bad", spec: "s", deps: ["NODE-404"] },
        ],
      }),
    "graph_error",
  );
  assert(getNode(store, "NODE-TMP") === undefined, "回滚后不应留下半成品节点");
  assert(currentGraphVersion(store) === versionNow, "回滚后版本不变");
  assert(store.journal.count() === eventsNow, "回滚后事件数不变");
  assert(listReplanEvents(store).length === replansNow, "回滚后 replan_events 不变");

  mint(store, "NODE-RESEARCH");
  // 阶段闸门走 stages API：wish 图节点带 stage，done 前必须 passed
  passGate(store, "research", ["EVD-NODE-RESEARCH"]);
  graphSetReadyAndDone(store, "NODE-RESEARCH");
  assert(getNode(store, "NODE-RESEARCH")?.status === "done", "NODE-RESEARCH 应 done");
  expectError(
    () => replan(store, { reason: "scope_change", remove: ["NODE-RESEARCH"] }),
    "replan_error",
  );
  assert(getNode(store, "NODE-RESEARCH")?.status === "done", "终态节点必须留存");

  expectError(() => replan(store, { reason: "nonsense" as never }), "replan_error");
  resetCore();
});

// ── 21. decide：create-or-update（N5 契约） ────────────────────────────
check("decide_create_or_update", () => {
  resetCore();
  const store = new Store({ clock: fixedClock() });
  configureCore({ store });
  const options = [{ option_id: "a" }, { option_id: "b" }];

  const l0 = decide({ decisionId: "DEC-L0", level: "L0", question: "技术栈？", options, optionId: "a" }) as Record<string, unknown>;
  assert(l0.ok === true && l0.created === true, "L0 应创建成功");
  assert((l0.decision as { status: string }).status === "auto", "L0 应 auto");

  const l2Missing = decide({ decisionId: "DEC-L2", level: "L2", question: "库？", options }) as Record<string, unknown>;
  assert(
    l2Missing.ok === false && l2Missing.error === "decision-params-required",
    `L2 缺参数应明确报错：${JSON.stringify(l2Missing)}`,
  );
  assert((l2Missing.missing as string[]).includes("defaultOptionId"), "应指出缺 defaultOptionId");
  assert((l2Missing.missing as string[]).includes("timeoutSec"), "应指出缺 timeoutSec");

  const l2 = decide({
    decisionId: "DEC-L2",
    level: "L2",
    question: "库？",
    options,
    defaultOptionId: "a",
    timeoutSec: 60,
    now: 1000,
  }) as Record<string, unknown>;
  assert(l2.ok === true && (l2.decision as { status: string }).status === "proposed", "L2 应 proposed");

  const l3 = decide({ decisionId: "DEC-L3", level: "L3", question: "发布？", options }) as Record<string, unknown>;
  assert(l3.ok === true && (l3.decision as { status: string }).status === "blocked", "L3 应 blocked");
  const l3confirmed = decide({ decisionId: "DEC-L3", optionId: "b" }) as Record<string, unknown>;
  assert(l3confirmed.ok === true && l3confirmed.updated === true, "已存在应走更新");
  assert((l3confirmed.decision as { status: string }).status === "confirmed", "L3 确认后应 confirmed");

  const l0override = decide({ decisionId: "DEC-L0", optionId: "b" }) as Record<string, unknown>;
  assert((l0override.decision as { status: string }).status === "overridden", "L0 改选项应 overridden");

  const l2choose = decide({ decisionId: "DEC-L2", optionId: "b" }) as Record<string, unknown>;
  assert((l2choose.decision as { status: string }).status === "confirmed", "L2 提前定应 confirmed");

  const bare = decide({ decisionId: "DEC-NEW" }) as Record<string, unknown>;
  assert(bare.ok === false && bare.error === "decision-params-required", "缺参创建必须拒绝");
  assert(store.journal.validateStream().ok, "决策事件流应体检通过");
  resetCore();
});

// ── 22. 阶段闸门：未过闸门不得 done，通过后可 done ──────────────────────
check("stage_gate_blocks_done", () => {
  resetCore();
  configureIo({
    exists: () => true,
    isFile: () => true,
    sha256: () => SHA,
    readText: () => "hello",
    resolve: (p: string) => `/virtual/${p}`,
  });
  const store = new Store({ clock: fixedClock() });
  configureCore({ store });
  installReadyHook(store);
  addNode(store, {
    nodeId: "N1",
    title: "构建",
    spec: "s",
    stage: "build",
    evidenceRequired: ["artifact"],
    verifierIds: ["verifier-ci"],
  });
  bootstrap(store);
  claimTask({ nodeId: "N1", instanceId: "ROLE-CODE-01" });
  const submitted = submitEvidence({
    nodeId: "N1",
    artifactPath: "a.txt",
    producerInstance: "ROLE-CODE-01",
    auditorInstance: "ROLE-AUDIT-01",
    verdict: "pass",
  }) as Record<string, unknown>;
  assert(submitted.ok === true, "证据应落账");

  // 闸门未设 → 凭证不可用 → 驳回：ready + dropLease + attempts+1（P1 契约）
  assert(getGate(store, "build") === undefined, "初始应无闸门");
  assert(gateAllowsDone(store, "build") === false, "无闸门不得放行");
  const blocked = verifyDone({ nodeId: "N1" }) as Record<string, unknown>;
  assert(blocked.ok === false && blocked.error === "credential-unavailable", "闸门未过必须拒绝 done");
  assert(getNode(store, "N1")?.status === "ready", "被拒后应驳回为 ready");
  assert(getNode(store, "N1")?.attempts === 1, "驳回应 attempts+1");
  assert(currentLease(store, "N1") === undefined, "驳回后不得留 stale 租约");
  assert(doneCredential(store, "N1") === null, "闸门未过时不得铸出凭证");
  assert(blockedByGates(store).some((row) => row.node_id === "N1"), "诊断应列出被闸门挡住的节点");

  // 驳回后可立即重新领取（不会再报 alreadyHeld）
  const reclaim = claimTask({ nodeId: "N1", instanceId: "ROLE-CODE-01" }) as Record<string, unknown>;
  assert(reclaim.ok === true, `驳回后应可立即 re-claim：${JSON.stringify(reclaim)}`);
  assert(
    (reclaim.lease as { fencing_token: number }).fencing_token === 2,
    "re-claim 的 fencing 令牌应递增到 2",
  );

  // 失败闸门同样不放行（再次驳回，attempts 累计）
  failGate(store, "build", ["EVD-N1"]);
  assert(getGate(store, "build")?.status === "failed", "闸门应为 failed");
  assert(gateAllowsDone(store, "build") === false, "failed 不得放行");
  submitEvidence({
    nodeId: "N1",
    artifactPath: "a.txt",
    producerInstance: "ROLE-CODE-01",
    auditorInstance: "ROLE-AUDIT-01",
    verdict: "pass",
  } as Record<string, unknown>);
  const stillBlocked = verifyDone({ nodeId: "N1" }) as Record<string, unknown>;
  assert(stillBlocked.ok === false, "failed 闸门仍应拒绝");
  assert(getNode(store, "N1")?.attempts === 2, "第二次驳回应 attempts=2");
  assert(currentLease(store, "N1") === undefined, "第二次驳回同样清租约");

  // 通过后 → 再提交一次即可 done（完整回环）
  passGate(store, "build", ["EVD-N1"]);
  assert(getGate(store, "build")?.status === "passed", "闸门应为 passed");
  assert(gateAllowsDone(store, null) === true, "无 stage 应放行");
  assert(listGates(store).length === 1, "应只有 build 一道闸门");
  claimTask({ nodeId: "N1", instanceId: "ROLE-CODE-01" });
  submitEvidence({
    nodeId: "N1",
    artifactPath: "a.txt",
    producerInstance: "ROLE-CODE-01",
    auditorInstance: "ROLE-AUDIT-01",
    verdict: "pass",
  } as Record<string, unknown>);
  const done = verifyDone({ nodeId: "N1" }) as Record<string, unknown>;
  assert(done.ok === true && done.status === "done", `通过闸门后应 done：${JSON.stringify(done)}`);
  assert(getNode(store, "N1")?.status === "done", "节点应 done");
  assert(currentLease(store, "N1") === undefined, "done 后租约应已释放");
  assert(store.journal.validateStream().ok, "闸门事件流应体检通过");
  assert(replayMismatches(store).length === 0, "闸门用例后 replay 应一致");

  // 非法参数
  expectError(() => setGate(store, "unknown" as never, "passed"), "stage_error");
  expectError(() => setGate(store, "build", "done" as never), "stage_error");
  resetCore();
  configureIo(null);
});

// ── 23. 键名别名：camelCase / snake_case 等价；冲突明确报错 ─────────────
check("alias_camel_and_snake", () => {
  resetCore();
  configureIo({
    exists: () => true,
    isFile: () => true,
    sha256: () => SHA,
    readText: () => "hello",
    resolve: (p: string) => `/virtual/${p}`,
  });
  const store = new Store({ clock: fixedClock() });
  configureCore({ store });
  installReadyHook(store);
  addNode(store, {
    nodeId: "A",
    title: "a",
    spec: "s",
    evidenceRequired: ["artifact"],
    verifierIds: ["verifier-ci"],
  });
  bootstrap(store);
  claimTask({ node_id: "A", instance_id: "ROLE-CODE-01" });

  // 全 snake_case 入参（N2 归一化后的形状）必须能落账
  const snake = submitEvidence({
    node_id: "A",
    artifact_path: "a.txt",
    producer_instance: "ROLE-CODE-01",
    auditor_instance: "ROLE-AUDIT-01",
    verdict: "pass",
  } as Record<string, unknown>) as Record<string, unknown>;
  assert(snake.ok === true, `snake_case 入参应落账：${JSON.stringify(snake)}`);
  const record = store.state.evidence.get(String(snake.evidenceId));
  assert(record?.producer_instance === "ROLE-CODE-01", "snake_case producer 应落账");
  assert(record?.auditor_instance === "ROLE-AUDIT-01", "snake_case auditor 应落账");

  // camelCase 同样可用（两种写法指向同一字段）
  const camel = submitEvidence({
    nodeId: "A",
    artifactPath: "a.txt",
    producerInstance: "ROLE-CODE-01",
    auditorInstance: "ROLE-AUDIT-01",
    verdict: "fail",
  } as Record<string, unknown>) as Record<string, unknown>;
  assert(camel.ok === false && camel.verdict === "fail", "camelCase 入参应被识别（verdict=fail）");

  // 值冲突 → 明确 alias-conflict，不静默择一
  const conflict = submitEvidence({
    node_id: "A",
    artifact_path: "a.txt",
    producer_instance: "ROLE-CODE-01",
    producerInstance: "ROLE-CODE-02",
    verdict: "pass",
  } as Record<string, unknown>) as Record<string, unknown>;
  assert(
    conflict.ok === false && conflict.error === "alias-conflict",
    `别名冲突必须明确报错：${JSON.stringify(conflict)}`,
  );

  // 决策：snake_case 创建 + 更新
  const created = decide({
    decision_id: "DEC-S",
    level: "L2",
    question: "库？",
    options: [{ optionId: "a" }, { optionId: "b" }],
    default_option_id: "a",
    timeout_sec: 30,
    now: 1000,
  } as Record<string, unknown>) as Record<string, unknown>;
  assert(created.ok === true && created.created === true, `snake_case 决策应创建：${JSON.stringify(created)}`);
  assert((created.decision as { status: string }).status === "proposed", "L2 应 proposed");
  const updated = decide({ decision_id: "DEC-S", option_id: "b" } as Record<string, unknown>) as Record<string, unknown>;
  assert(updated.ok === true && updated.updated === true, "snake_case 更新应成功");
  assert((updated.decision as { status: string }).status === "confirmed", "更新后应 confirmed");
  resetCore();
  configureIo(null);
});

// ── 24. foldEvents：journal 折回 state（重开 counts 非 0、replay==snapshot）──
check("fold_events_restores_state", () => {
  resetCore();
  configureIo({
    exists: () => true,
    isFile: () => true,
    sha256: () => SHA,
    readText: () => "hello",
    resolve: (p: string) => `/virtual/${p}`,
  });
  const store = new Store({ clock: fixedClock() });
  configureCore({ store });
  installReadyHook(store);
  submitWish({ text: "做个 CRUD" });
  claimTask({ nodeId: "NODE-RESEARCH", instanceId: "ROLE-CODE-01" });
  submitEvidence({
    nodeId: "NODE-RESEARCH",
    artifactPath: "a.txt",
    producerInstance: "ROLE-CODE-01",
    auditorInstance: "ROLE-AUDIT-01",
    verdict: "pass",
  } as Record<string, unknown>);
  passGate(store, "research", ["EVD-NODE-RESEARCH-1"]);
  verifyDone({ nodeId: "NODE-RESEARCH" });
  decide({ decisionId: "DEC-1", level: "L1", question: "q", options: [{ option_id: "a" }, { option_id: "b" }], optionId: "a" } as never);
  replan(store, { reason: "scope_change", add: [{ nodeId: "NODE-DOCS", title: "文档", spec: "s" }] });

  const events = store.journal.raw();
  const folded = foldEvents(events);
  const counts = (state: typeof folded) => ({
    nodes: state.nodes.size,
    edges: state.edges.length,
    evidence: state.evidence.size,
    decisions: state.decisions.size,
    gates: state.gates.size,
    artifacts: state.artifacts.size,
    replan: state.replanEvents.length,
  });
  assert(
    JSON.stringify(counts(folded)) === JSON.stringify(counts(store.state)),
    `fold 计数应与内存状态一致：fold=${JSON.stringify(counts(folded))} live=${JSON.stringify(counts(store.state))}`,
  );
  const restoredStore = new Store({ clock: fixedClock(), state: folded });
  assert(
    JSON.stringify(snapshot(restoredStore)) === JSON.stringify(snapshot(store)),
    "fold 后的图快照应与原 store 完全一致",
  );

  // 重开场景：新 store 只吃事件 → counts 非 0、replay==snapshot
  const reopened = new Store({ clock: fixedClock() });
  const state = restoreFromEvents(reopened, events);
  assert(reopened.journal.count() === events.length, "事件应全部回灌");
  assert(state.nodes.size > 0, "重开后节点数不得为 0（N2 的 counts={0,0,0,0} 缺口）");
  assert(state.evidence.size > 0, "重开后证据数不得为 0");
  assert(state.gates.size > 0, "重开后闸门数不得为 0");
  assert(state.decisions.size > 0, "重开后决策数不得为 0");
  assert(
    replayMismatches(reopened).length === 0,
    `重开后 replay 应等于 snapshot：${JSON.stringify(replayMismatches(reopened).slice(0, 3))}`,
  );
  assert(
    JSON.stringify(snapshot(reopened)) === JSON.stringify(snapshot(store)),
    "重开后图快照应与原 store 一致",
  );

  // rehydrate 幂等
  const again = rehydrate(store);
  assert(JSON.stringify(counts(again)) === JSON.stringify(counts(store.state)), "rehydrate 应幂等");
  assert(replayMismatches(store).length === 0, "rehydrate 后 replay 应一致");
  resetCore();
  configureIo(null);
});

// ── 25. 统一身份 A：大小写/分隔符不敏感的角色实例解析 ──────────────────
check("identity_unified_roles", () => {
  const upper = parseInstanceId("ROLE-CODE-01");
  const lower = parseInstanceId("role-code-01");
  assert(upper && lower, "两种写法都应可解析");
  assert(upper.canonical === "ROLE-CODE-01", `canonical 应为 ROLE-CODE-01，实际 ${upper?.canonical}`);
  assert(lower.canonical === upper.canonical, "小写应归一到同一 canonical");
  assert(lower.role === "CODE", `role 应为 CODE，实际 ${lower.role}`);
  assert(lower.index === 1, `index 应为 1，实际 ${lower.index}`);

  const auditLower = parseInstanceId("role-audit-code-01");
  const auditUpper = parseInstanceId("ROLE-AUDIT-CODE-01");
  assert(auditLower?.role === "AUDIT_CODE", `role 应为 AUDIT_CODE，实际 ${auditLower?.role}`);
  assert(auditLower?.canonical === auditUpper?.canonical, "多段职务也应归一一致");
  assert(roleOfInstance("role-audit-code-01") === "AUDIT_CODE", "roleOfInstance 应归一");
  assert(roleOfInstance("ROLE-AUDIT-CODE-01") === "AUDIT_CODE", "旧大写同样归一");

  assert(parseInstanceId("verifier-ci") === null, "非实例 ID 应解析为 null");
  assert(roleOfInstance("verifier-ci") === "verifier-ci", "非实例 ID 原样返回");

  assert(sameInstance("role-code-01", "ROLE-CODE-01"), "两种写法应视为同一实例");
  assert(!sameInstance("role-code-01", "role-code-02"), "不同序号是不同实例");

  const sameInst = auditIndependence([
    { producer_instance: "role-code-01", auditor_instance: "ROLE-CODE-01" },
  ]);
  assert(sameInst.ok === false && sameInst.reason === "same-instance", "跨大小写同实例必须判不独立");
  const sameRole = auditIndependence([
    { producer_instance: "role-code-01", auditor_instance: "ROLE-CODE-02" },
  ]);
  assert(sameRole.ok === false && sameRole.reason === "same-role", "同职务不同实例必须判不独立");
  const sameAuditRole = auditIndependence([
    { producer_instance: "role-audit-code-01", auditor_instance: "ROLE-AUDIT-CODE-02" },
  ]);
  assert(sameAuditRole.ok === false && sameAuditRole.reason === "same-role", "AUDIT_CODE 同职务应不独立");
  const independent = auditIndependence([
    { producer_instance: "role-code-01", auditor_instance: "role-audit-01" },
  ]);
  assert(independent.ok === true, `不同职务应独立：${JSON.stringify(independent)}`);
  const missing = auditIndependence([{ producer_instance: "  ", auditor_instance: "role-audit-01" }]);
  assert(missing.ok === false && missing.reason === "missing-producer", "缺 producer 仍应 fail-closed");

  resetCore();
  configureIo({
    exists: () => true,
    isFile: () => true,
    sha256: () => SHA,
    readText: () => "hello",
    resolve: (p: string) => `/virtual/${p}`,
  });
  const store = new Store({ clock: fixedClock() });
  configureCore({ store });
  installReadyHook(store);
  addNode(store, {
    nodeId: "N1",
    title: "t",
    spec: "s",
    evidenceRequired: ["artifact"],
    verifierIds: ["verifier-ci"],
  });
  bootstrap(store);
  claimTask({ nodeId: "N1", instanceId: "role-code-01" });
  const submitted = submitEvidence({
    nodeId: "N1",
    artifactPath: "a.txt",
    producerInstance: "role-code-01",
    auditorInstance: "role-audit-01",
    verdict: "pass",
  }) as Record<string, unknown>;
  assert(submitted.ok === true, `小写身份应能落账：${JSON.stringify(submitted)}`);
  const record = store.state.evidence.get(String(submitted.evidenceId));
  assert(record?.producer_instance === "role-code-01", "记录保留原始小写（不擅自改写）");
  assert(record?.auditor_instance === "role-audit-01", "auditor 同样保留原样");

  const snapshotBefore = JSON.stringify(snapshot(store));
  roleOfInstance("role-audit-code-07");
  parseInstanceId("ROLE-CODE-09");
  auditIndependence([{ producer_instance: "role-code-01", auditor_instance: "role-audit-02" }]);
  assert(JSON.stringify(snapshot(store)) === snapshotBefore, "身份解析不得改变 snapshot");
  assert(doneCredential(store, "N1") !== null, "独立审计 + 小写身份应可铸造凭证");
  resetCore();
  configureIo(null);
});

const failed = results.filter((r) => !r.ok);
const output = {
  ok: failed.length === 0,
  passed: results.length - failed.length,
  failed: failed.length,
  cases: results,
};
console.log(JSON.stringify(output, null, 2));
process.exit(output.ok ? 0 : 1);
