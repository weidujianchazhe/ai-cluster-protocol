// 能力目录 + 按需装配：小项目不该被重能力压垮，大项目不该缺能力。
import { deriveFacts, selectCapabilities, materializeCapabilities, CAPABILITIES_CATALOG } from "../lib/core/catalog.js";
import { planGraph } from "../lib/core/graphspec.js";

const cases = [];
const check = (name, cond, detail) => cases.push({ name, pass: Boolean(cond), detail });

const nodeSet = (n, extra = () => ({})) =>
  Array.from({ length: n }, (_, i) => ({ nodeId: `N${i}`, title: `n${i}`, ...extra(i) }));

// 1. 小图：一个能力都不装
{
  const facts = deriveFacts(nodeSet(2));
  const r = selectCapabilities(facts);
  check("2 节点不装任何能力", r.selected.length === 0 && r.cost.nodes === 0, r.selected.map((s) => s.id).join(",") || "none");
  check("跳过理由可读", r.skipped.every((s) => s.reason.length > 0), r.skipped.map((s) => s.id).join(","));
}

// 2. 节点数到 8 → audit
{
  const r = selectCapabilities(deriveFacts(nodeSet(8)));
  check("8 节点提议 audit", r.selected.some((s) => s.id === "audit"), r.selected.map((s) => s.id).join(","));
  check("8 节点不提议 watch", !r.selected.some((s) => s.id === "watch"), "watch 需 ≥15 或外部写");
}

// 3. 有 deliver 阶段 → audit（即使节点少）
{
  const r = selectCapabilities(deriveFacts(nodeSet(3, (i) => (i === 0 ? { stage: "deliver" } : {}))));
  check("deliver 阶段触发 audit", r.selected.some((s) => s.id === "audit"), r.selected.map((s) => s.id).join(","));
}

// 4. 有外部写入 → watch
{
  const r = selectCapabilities(deriveFacts(nodeSet(3, (i) => (i === 0 ? { writeScopes: ["repo/"] } : {}))));
  check("外部写入触发 watch", r.selected.some((s) => s.id === "watch"), r.selected.map((s) => s.id).join(","));
}

// 5. 声明预算 → meter
{
  const r = selectCapabilities(deriveFacts(nodeSet(3, (i) => (i === 0 ? { budget: { maxTokens: 1000 } } : {}))));
  check("声明预算触发 meter", r.selected.some((s) => s.id === "meter"), r.selected.map((s) => s.id).join(","));
}

// 6. 跨 3 阶段 → gate-chain
{
  const stages = ["research", "design", "build"];
  const r = selectCapabilities(deriveFacts(nodeSet(3, (i) => ({ stage: stages[i] }))));
  check("跨 3 阶段触发 gate-chain", r.selected.some((s) => s.id === "gate-chain"), r.selected.map((s) => s.id).join(","));
}

// 7. 大图：四个全装，成本可控
{
  const r = selectCapabilities(
    deriveFacts(nodeSet(20, (i) => ({
      stage: ["research", "design", "build", "deliver"][i % 4],
      ...(i === 0 ? { budget: { maxTokens: 5000 } } : {}),
      ...(i === 1 ? { writeScopes: ["repo/"] } : {}),
    }))),
  );
  check("大图全装四项", r.selected.length === 4, r.selected.map((s) => s.id).join(","));
  check("大图成本 4 个节点", r.cost.nodes === 4, `cost=${r.cost.nodes}`);
}

// 8. materialize：生成的节点结构合法
{
  const facts = deriveFacts(nodeSet(20, (i) => ({ stage: i === 0 ? "deliver" : "build", ...(i === 1 ? { writeScopes: ["x"] } : {}) })));
  const seeds = materializeCapabilities(["audit", "watch"], facts, ["N19"]);
  check("materialize 生成 2 个节点", seeds.length === 2, `got=${seeds.length}`);
  check(
    "生成的节点带依赖锚点与验收",
    seeds.every((s) => Array.isArray(s.deps) && s.acceptance && s.verifierIds.length > 0 && s.evidenceRequired.length > 0),
    JSON.stringify(seeds.map((s) => ({ id: s.nodeId, deps: s.deps }))),
  );
}

// 9. materialize 会拒绝不满足条件的能力（防止误装）
{
  const smallFacts = deriveFacts(nodeSet(2));
  const seeds = materializeCapabilities(["audit", "watch"], smallFacts, []);
  check("小图上 materialize 被忽略", seeds.length === 0, `got=${seeds.length}`);
}

// 10. graph_plan 的返回里带能力建议
{
  const r = planGraph({ wish: "t", nodes: [{ nodeId: "A", title: "a" }, { nodeId: "B", title: "b", deps: ["A"] }] });
  check("graph_plan 返回 capabilities", Boolean(r.capabilities) && Array.isArray(r.capabilities.selected), JSON.stringify(r.capabilities?.selected ?? null));
}

// 11. 目录本身：每个能力都声明了成本与条件
{
  const bad = CAPABILITIES_CATALOG.filter((c) => !c.id || !c.cost || typeof c.requires !== "function" || typeof c.build !== "function");
  check("每个能力都声明 cost/requires/build", bad.length === 0, `bad=${bad.length}`);
}

const failed = cases.filter((c) => !c.pass);
for (const c of cases) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : "  (" + c.detail + ")"}`);
console.log(failed.length === 0 ? "\nALL PASS" : `\nFAILED: ${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);
