// 组成因子巡检：判据必须能真的触发，且正常节点不误报。
//
// 背景：官方 Super-agent 的 Watchdog 核心是「判断 Worker 有没有实质进展」，
// 我们的 observability 有 6 条告警规则但没有「停滞」这一条。这里补上，
// 并且让巡检项从 NodeRecord 的因子派生（见 src/core/guards.ts）。
import { Store } from "../lib/core/store.js";
import { addNode } from "../lib/core/graph.js";
import { runFactorGuards, FACTOR_GUARDS } from "../lib/core/guards.js";

const cases = [];
const check = (name, cond, detail) => cases.push({ name, pass: Boolean(cond), detail });

const mkStore = () => new Store();

const mkNode = (store, nodeId, extra = {}) =>
  addNode(store, {
    nodeId,
    title: nodeId,
    spec: "s",
    capability: "CODE",
    stage: null,
    deps: [],
    evidenceRequired: ["artifact"],
    verifierIds: ["verifier-ci"],
    ...extra,
  });

// 1. 停滞：claimed + 心跳过期 → status/stalled
{
  const store = mkStore();
  mkNode(store, "N1");
  const n = store.state.nodes.get("N1");
  n.status = "claimed";
  n.assignee = "role-code-01";
  store.state.leases.set("N1", {
    node_id: "N1",
    owner: "role-code-01",
    fencing_token: 1,
    expires_at: Date.now() + 600000,
    heartbeat_at: Date.now() - 20 * 60 * 1000, // 20 分钟没动
  });
  const r = runFactorGuards({ store, nowMs: Date.now() });
  const hit = r.findings.find((f) => f.check === "stalled");
  check("停滞节点被识别", Boolean(hit) && hit.severity === "warn", hit ? hit.message : "no finding");
}

// 2. 停滞加倍 → critical
{
  const store = mkStore();
  mkNode(store, "N2");
  const n = store.state.nodes.get("N2");
  n.status = "running";
  n.assignee = "role-code-01";
  store.state.leases.set("N2", {
    node_id: "N2",
    owner: "role-code-01",
    fencing_token: 1,
    expires_at: Date.now() + 600000,
    heartbeat_at: Date.now() - 40 * 60 * 1000,
  });
  const r = runFactorGuards({ store, nowMs: Date.now() });
  const hit = r.findings.find((f) => f.check === "stalled");
  check("长时间停滞升级为 critical", Boolean(hit) && hit.severity === "critical", hit ? hit.severity : "none");
}

// 3. 依赖未完成却已 ready → deps/unsatisfied-while-active
{
  const store = mkStore();
  mkNode(store, "A", { deps: [] });
  mkNode(store, "B", { deps: ["A"] });
  store.state.nodes.get("A").status = "ready"; // 未 done
  store.state.nodes.get("B").status = "ready"; // 却已 ready
  const r = runFactorGuards({ store, nowMs: Date.now() });
  const hit = r.findings.find((f) => f.check === "unsatisfied-while-active");
  check("依赖未完成被识别", Boolean(hit) && hit.nodeId === "B", hit ? hit.message : "no finding");
}

// 4. attempts 超限（阈值 3；≥6 升 critical）
{
  const store = mkStore();
  mkNode(store, "N4");
  store.state.nodes.get("N4").attempts = 7;
  store.state.nodes.get("N4").status = "ready";
  const r = runFactorGuards({ store, nowMs: Date.now() });
  const hit = r.findings.find((f) => f.check === "exceeded");
  check("反复失败被识别", Boolean(hit) && hit.severity === "critical", hit ? hit.severity : "none");
}

// 4b. 达到警告线但未到严重线 → warn
{
  const store = mkStore();
  mkNode(store, "N4b");
  store.state.nodes.get("N4b").attempts = 4;
  store.state.nodes.get("N4b").status = "ready";
  const r = runFactorGuards({ store, nowMs: Date.now() });
  const hit = r.findings.find((f) => f.check === "exceeded");
  check("4 次失败只报警告", Boolean(hit) && hit.severity === "warn", hit ? hit.severity : "none");
}

// 5. 正常节点不误报
{
  const store = mkStore();
  mkNode(store, "OK");
  const r = runFactorGuards({ store, nowMs: Date.now() });
  const real = r.findings.filter((f) => f.severity !== "info");
  check("配置完整的 ready 节点无误报", real.length === 0, real.map((f) => f.check).join(",") || "clean");
}

// 6. 已 done 的节点不参与巡检
{
  const store = mkStore();
  mkNode(store, "D");
  store.state.nodes.get("D").status = "done";
  const r = runFactorGuards({ store, nowMs: Date.now() });
  check("终态节点被跳过", r.checked === 0, `checked=${r.checked}`);
}

// 7. 因子表本身：每条 guard 都声明了因子
{
  const bad = FACTOR_GUARDS.filter((g) => !g.factor || !g.check || typeof g.evaluate !== "function");
  check("每条 guard 声明了 factor/check/evaluate", bad.length === 0, `bad=${bad.length}`);
}

const failed = cases.filter((c) => !c.pass);
for (const c of cases) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : "  (" + c.detail + ")"}`);
console.log(failed.length === 0 ? "\nALL PASS" : `\nFAILED: ${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);
