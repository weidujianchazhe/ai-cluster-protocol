// 派活循环：三种模式（off/interval/resident），默认不激活；dryRun 默认开。
import { Store } from "../lib/core/store.js";
import { addNode } from "../lib/core/graph.js";
import { planDispatchTick, normalizeDispatchOptions, DEFAULT_DISPATCH_OPTIONS } from "../lib/core/dispatcher.js";

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
    verifierIds: ["v"],
    ...extra,
  });

const baseOpts = (over = {}) => ({
  mode: "interval",
  intervalMs: 60000,
  maxPerTick: 3,
  dryRun: true,
  dispatcherInstance: "ROLE-DISPATCH-01",
  nowMs: Date.now(),
  ...over,
});

// 1. off 模式什么都不做
{
  const store = mkStore();
  mkNode(store, "A");
  const r = planDispatchTick(store, baseOpts({ mode: "off" }));
  check("off 模式不派活", r.willDispatch.length === 0 && r.plan.length === 0, JSON.stringify(r.plan));
  check("off 模式给出来由", r.summary.includes("未激活"), r.summary);
}

// 2. interval + dryRun：只出计划
{
  const store = mkStore();
  mkNode(store, "A");
  store.state.nodes.get("A").status = "ready";
  const r = planDispatchTick(store, baseOpts({ dryRun: true }));
  check("dryRun 出 would-dispatch", r.plan.some((p) => p.action === "would-dispatch"), JSON.stringify(r.plan));
  check("dryRun 不标 dispatch", !r.plan.some((p) => p.action === "dispatch"), "no real dispatch");
}

// 3. 正式模式标记 dispatch
{
  const store = mkStore();
  mkNode(store, "A");
  store.state.nodes.get("A").status = "ready";
  const r = planDispatchTick(store, baseOpts({ dryRun: false }));
  check("非 dryRun 标记 dispatch", r.plan.some((p) => p.action === "dispatch"), JSON.stringify(r.plan));
}

// 4. maxPerTick 截断
{
  const store = mkStore();
  for (const id of ["A", "B", "C", "D", "E"]) {
    mkNode(store, id);
    store.state.nodes.get(id).status = "ready";
  }
  const r = planDispatchTick(store, baseOpts({ maxPerTick: 2, dryRun: false }));
  check("maxPerTick 生效", r.willDispatch.length === 2, `got=${r.willDispatch.length}`);
  check("超出上限的节点被说明", r.plan.some((p) => p.action === "skip" && p.reason.includes("maxPerTick")), JSON.stringify(r.plan.map((p) => p.action)));
}

// 5. 停滞节点被巡检拦截
{
  const store = mkStore();
  mkNode(store, "S");
  const n = store.state.nodes.get("S");
  n.status = "claimed";
  n.assignee = "w";
  store.state.leases.set("S", {
    node_id: "S",
    owner: "w",
    fencing_token: 1,
    expires_at: Date.now() + 600000,
    heartbeat_at: Date.now() - 40 * 60 * 1000, // 40 分钟没动 → critical
  });
  const r = planDispatchTick(store, baseOpts({ dryRun: false }));
  check("停滞节点进入 blocking", r.blocking.some((b) => b.check === "stalled"), r.blocking.map((b) => b.check).join(","));
}

// 6. 依赖未完成的 critical 也拦截
{
  const store = mkStore();
  mkNode(store, "A");
  mkNode(store, "B", { deps: ["A"] });
  store.state.nodes.get("A").status = "ready";
  store.state.nodes.get("B").status = "ready";
  const r = planDispatchTick(store, baseOpts({ dryRun: false }));
  const bPlan = r.plan.find((p) => p.nodeId === "B");
  check("依赖违规的节点被跳过", bPlan?.action === "skip" && bPlan.reason.includes("巡检拦截"), JSON.stringify(bPlan));
}

// 7. normalize：非法值回落默认
{
  const n1 = normalizeDispatchOptions({ mode: "bogus" }, Date.now());
  check("非法 mode 回落到 off", n1.mode === "off", n1.mode);
  const n2 = normalizeDispatchOptions({ mode: "interval", intervalMs: 1000 }, Date.now());
  check("过小 interval 回落到默认", n2.intervalMs === DEFAULT_DISPATCH_OPTIONS.intervalMs, String(n2.intervalMs));
  const n3 = normalizeDispatchOptions({ mode: "resident", maxPerTick: 999 }, Date.now());
  check("过大 maxPerTick 被夹到 32", n3.maxPerTick === 32, String(n3.maxPerTick));
}

// 8. normalize：dryRun 默认开
{
  const n = normalizeDispatchOptions({ mode: "interval" }, Date.now());
  check("未声明 dryRun 时默认 true", n.dryRun === true, String(n.dryRun));
  const n2 = normalizeDispatchOptions({ mode: "interval", dryRun: false }, Date.now());
  check("显式 false 才真的派活", n2.dryRun === false, String(n2.dryRun));
}

// 9. resident 模式与 interval 在 tick 层等价（差别在上层调度）
{
  const store = mkStore();
  mkNode(store, "A");
  store.state.nodes.get("A").status = "ready";
  const ri = planDispatchTick(store, baseOpts({ mode: "interval", dryRun: false }));
  const rr = planDispatchTick(store, baseOpts({ mode: "resident", dryRun: false }));
  check("interval 与 resident 的 tick 结果一致", JSON.stringify(ri.willDispatch) === JSON.stringify(rr.willDispatch), `${ri.willDispatch} vs ${rr.willDispatch}`);
}

const failed = cases.filter((c) => !c.pass);
for (const c of cases) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : "  (" + c.detail + ")"}`);
console.log(failed.length === 0 ? "\nALL PASS" : `\nFAILED: ${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);
