// 多视角抽象 + 冲突路由：验证「不读原文也能得出判断」与「人不是默认裁决者」。
import { Store } from "../lib/core/store.js";
import { addNode } from "../lib/core/graph.js";
import { digestAll } from "../lib/core/digest.js";
import { runFacets } from "../lib/core/facets.js";
import { detectConflicts, routeConflicts, summarizeRouting, HUMAN_ONLY_NEEDS } from "../lib/core/conflict.js";

const cases = [];
const check = (name, cond, detail) => cases.push({ name, pass: Boolean(cond), detail });

const mkStore = () => new Store();
const mkNode = (store, nodeId, extra = {}) =>
  addNode(store, {
    nodeId,
    title: nodeId,
    spec: "SPEC-FULL-TEXT-SHOULD-NOT-LEAK",
    capability: "CODE",
    stage: null,
    deps: [],
    evidenceRequired: ["artifact"],
    verifierIds: ["v"],
    ...extra,
  });

const nodesOf = (store) => [...store.state.nodes.values()];

// 1. 摘要不含原文
{
  const store = mkStore();
  mkNode(store, "A");
  const ds = digestAll(nodesOf(store));
  const s = JSON.stringify(ds);
  check("摘要不含 spec 原文", !s.includes("SPEC-FULL-TEXT-SHOULD-NOT-LEAK"), s.slice(0, 120));
}

// 2. 五个静态视角都能产出
{
  const store = mkStore();
  for (const id of ["A", "B", "C"]) mkNode(store, id);
  const r = runFacets(digestAll(nodesOf(store)), "让流程可核验");
  check("静态视角 5 个", r.static.length === 5, r.static.map((d) => d.facetId).join(","));
  check("动态视角 2 个", r.dynamic.length === 2, r.dynamic.map((d) => d.facetId).join(","));
  check("摘要字符量可计量", r.digestChars > 0, String(r.digestChars));
}

// 3. 交叉：同一个节点出现在多个视角里
{
  const store = mkStore();
  mkNode(store, "X", { capability: "CODE" });
  const r = runFacets(digestAll(nodesOf(store)), "g");
  const inOrg = r.static.find((d) => d.facetId === "org").nodes.includes("X");
  const inCap = r.static.find((d) => d.facetId === "capability").nodes.includes("X");
  const inEv = r.static.find((d) => d.facetId === "evidence").nodes.includes("X");
  check("同一节点出现在多个视角（交叉）", inOrg && inCap && inEv, `org=${inOrg} cap=${inCap} ev=${inEv}`);
}

// 4. 无标签节点触发冲突，且路由给 agent（不是人）
{
  const store = mkStore();
  for (const id of ["A", "B", "C"]) mkNode(store, id, { capability: undefined });
  const ds = digestAll(nodesOf(store));
  const r = runFacets(ds, "g");
  const cs = detectConflicts([...r.static, ...r.dynamic], ds);
  const routed = routeConflicts(cs, { availableCapabilities: new Map([["requirements-analysis", ["ROLE-REQ-01"]]]), catalogCapabilities: [] });
  const c = routed.find((x) => x.needs.includes("requirements-analysis"));
  check("无标签触发冲突", Boolean(c), cs.map((x) => x.subject).join(";") || "none");
  check("该冲突路由给 agent 而非人", c && c.route === "agent", c ? c.route : "n/a");
  check("路由带理由", c && c.reason.length > 10, c ? c.reason : "n/a");
}

// 5. 缺能力时升级给人，并标记为能力缺口
{
  const store = mkStore();
  for (const id of ["A", "B", "C"]) mkNode(store, id, { capability: undefined });
  const ds = digestAll(nodesOf(store));
  const r = runFacets(ds, "g");
  const cs = detectConflicts([...r.static, ...r.dynamic], ds);
  const routed = routeConflicts(cs, { availableCapabilities: new Map(), catalogCapabilities: [] });
  const c = routed.find((x) => x.needs.includes("requirements-analysis"));
  check("无承接方时升级给人", c && c.route === "human", c ? c.route : "n/a");
  const sum = summarizeRouting(routed);
  check("记为能力缺口", sum.capabilityGaps.includes("requirements-analysis"), sum.capabilityGaps.join(",") || "none");
}

// 6. 实用冲突永远走人（人专属能力）
{
  const store = mkStore();
  mkNode(store, "D", { capability: "DELIVER" });
  const ds = digestAll(nodesOf(store));
  const r = runFacets(ds, "g");
  const cs = detectConflicts([...r.static, ...r.dynamic], ds);
  const routed = routeConflicts(cs, { availableCapabilities: new Map([["human-experience", ["someone"]]]), catalogCapabilities: ["human-experience"] });
  const u = routed.find((x) => x.type === "usability");
  check("实用冲突存在", Boolean(u), cs.map((x) => x.type).join(",") || "none");
  check("实用冲突强制走人", u && u.route === "human", u ? u.route : "n/a");
  check("理由写明需真实使用", u && u.reason.includes("出品人"), u ? u.reason.slice(0, 60) : "n/a");
}

// 7. human-experience 永不被 agent 承接
{
  check("人类专属能力集合含两项", HUMAN_ONLY_NEEDS.has("human-experience") && HUMAN_ONLY_NEEDS.has("human-value"), [...HUMAN_ONLY_NEEDS].join(","));
}

// 8. 悬空依赖被检出（addNode 会拒绝悬空依赖，所以只能靠"依赖节点被删除"制造）
{
  const store = mkStore();
  mkNode(store, "E");
  mkNode(store, "F", { deps: ["E"] });
  // 模拟：E 被删除 / journal 重放出问题，F 的依赖悬空
  store.state.nodes.delete("E");
  const ds = digestAll(nodesOf(store));
  const r = runFacets(ds, "g");
  const cs = detectConflicts([...r.static, ...r.dynamic], ds);
  check("依赖被删除后检出悬空", cs.some((c) => c.subject.includes("悬空依赖")), cs.map((c) => c.subject).join(";"));
}

// 9. 成本随视角数增长，不随节点数增长（本视角只读摘要）
{
  const small = mkStore(); for (const id of ["A", "B"]) mkNode(small, id);
  const big = mkStore(); for (let i = 0; i < 60; i++) mkNode(big, `N${i}`);
  const rs = runFacets(digestAll(nodesOf(small)), "g");
  const rb = runFacets(digestAll(nodesOf(big)), "g");
  // 大图摘要会长，但不会因为读原文而爆炸：每节点贡献约 100-200 字符
  const perNode = (rb.digestChars - rs.digestChars) / 58;
  check("每节点摘要开销可控（<400 字符）", perNode < 400, `perNode≈${Math.round(perNode)}`);
}

const failed = cases.filter((c) => !c.pass);
for (const c of cases) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : "  (" + c.detail + ")"}`);
console.log(failed.length === 0 ? "\nALL PASS" : `\nFAILED: ${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);
