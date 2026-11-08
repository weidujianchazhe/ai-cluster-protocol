// 集群状态：醒来时读的那一份。验证「短、带来源、可判断过期」。
import { Store } from "../lib/core/store.js";
import { addNode } from "../lib/core/graph.js";
import { buildClusterState, isStateStale, markStateBuilt, lastStateSeq, renderStateForContext } from "../lib/core/state.js";

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

// 1. 状态里不含任何原文
{
  const store = mkStore();
  mkNode(store, "A");
  const s = buildClusterState(store);
  const text = JSON.stringify(s) + renderStateForContext(s);
  check("状态不含 spec 原文", !text.includes("SPEC-FULL-TEXT-SHOULD-NOT-LEAK"), text.slice(0, 100));
}

// 2. 每条断言都带 source 与 evidence
{
  const store = mkStore();
  mkNode(store, "A");
  const s = buildClusterState(store);
  const bad = s.claims.filter((c) => !c.source || !c.source.kind || !c.source.ref || !c.evidence);
  check("断言全部带 source/evidence", bad.length === 0, `bad=${bad.length}`);
  const badNext = s.next.filter((n) => !n.source || !n.reason);
  check("下一步全部带 source/reason", badNext.length === 0, `bad=${badNext.length}`);
}

// 3. 紧凑：字符量在可控范围
{
  const store = mkStore();
  for (let i = 0; i < 30; i++) mkNode(store, `N${i}`);
  const s = buildClusterState(store);
  check("状态字符量 < 3000", s.chars < 3000, `chars=${s.chars}`);
  const text = renderStateForContext(s);
  check("上下文渲染 < 2000 字符", text.length < 2000, `len=${text.length}`);
}

// 4. 过期判定：journal 前进后状态变 stale
{
  const store = mkStore();
  mkNode(store, "A");
  const s1 = buildClusterState(store);
  markStateBuilt(store, s1.basedOnSeq);
  check("刚生成时不 stale", !isStateStale(store), `seq=${lastStateSeq(store)} journal=${store.journal.count()}`);
  // 再写一条事件（addNode 会写 journal）
  mkNode(store, "B");
  check("journal 前进后 stale", isStateStale(store), `seq=${lastStateSeq(store)} journal=${store.journal.count()}`);
}

// 5. 标记便宜、生成按需：markStateBuilt 只写 meta
{
  const store = mkStore();
  mkNode(store, "A");
  const before = store.journal.count();
  markStateBuilt(store, before);
  check("标记不写 journal", store.journal.count() === before, `${before} -> ${store.journal.count()}`);
}

// 6. 目标缺失时标 assumed 而非 verified
{
  const store = mkStore();
  mkNode(store, "A");
  const s = buildClusterState(store);
  const goalClaim = s.claims[0];
  check("目标缺失标 assumed", goalClaim.evidence === "assumed", goalClaim.evidence);
}

// 7. 有 ready 节点时给出下一步
{
  const store = mkStore();
  mkNode(store, "A");
  store.state.nodes.get("A").status = "ready";
  const s = buildClusterState(store);
  check("有 ready 时给下一步", s.next.some((n) => n.action.includes("A")), JSON.stringify(s.next.map((n) => n.action)));
}

// 8. 空图不崩
{
  const store = mkStore();
  const s = buildClusterState(store);
  check("空图可生成", s.phase === "空图", s.phase);
  check("空图给出无待办", s.next.length === 1 && s.next[0].action === "无待办", JSON.stringify(s.next));
}

// 9. 冲突进入状态且带路由
{
  const store = mkStore();
  for (const id of ["A", "B", "C"]) mkNode(store, id, { capability: undefined });
  const s = buildClusterState(store);
  check("冲突出现在状态里", s.conflicts.length > 0, String(s.conflicts.length));
  const conflictClaim = s.claims.find((c) => c.source.kind === "conflict");
  check("冲突断言带 conflict 来源", Boolean(conflictClaim), conflictClaim ? conflictClaim.source.ref : "none");
}

// 10. 渲染文本包含关键段落
{
  const store = mkStore();
  mkNode(store, "A");
  const text = renderStateForContext(buildClusterState(store));
  check("渲染含目标", text.includes("目标："), "no 目标");
  check("渲染含下一步", text.includes("下一步："), "no 下一步");
  check("渲染含成本", text.includes("成本："), "no 成本");
}

const failed = cases.filter((c) => !c.pass);
for (const c of cases) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : "  (" + c.detail + ")"}`);
console.log(failed.length === 0 ? "\nALL PASS" : `\nFAILED: ${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);
