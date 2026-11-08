// 错误保真：doneCredentialWithReason 必须说清「为什么不能 done」。
//
// 背景：原先 doneCredential 只返回 null，verify_done 于是给一句笼统的
// “证据未覆盖/未通过、审计不独立、依赖未 done 或阶段闸门未过” —— 四种完全不同的
// 原因共用一句话，等于逼使用者重做一遍排查。实测时我们正是为此多花了两轮。
import { Store } from "../lib/core/store.js";
import { addNode, doneCredentialWithReason } from "../lib/core/graph.js";

const cases = [];
const check = (name, cond, detail) => cases.push({ name, pass: Boolean(cond), detail });

const mkStore = () => new Store();

// 1. 节点不存在 → 原因里点名节点
{
  const store = mkStore();
  const out = doneCredentialWithReason(store, "NOPE");
  check("节点不存在时给出具体原因", out.credential === null && /节点不存在/.test(out.reason ?? ""), `reason=${out.reason}`);
}

// 2. 节点存在但没有任何证据 → 原因指向「凭证为空」
{
  const store = mkStore();
  addNode(store, {
    nodeId: "N1",
    title: "t",
    spec: "s",
    capability: "CODE",
    stage: "build",
    deps: [],
    evidenceRequired: ["artifact"],
    verifierIds: ["verifier-ci"],
  });
  const out = doneCredentialWithReason(store, "N1");
  check("无证据时原因指向凭证为空", out.credential === null && /凭证为空|证据凭证为空/.test(out.reason ?? ""), `reason=${out.reason}`);
}

// 3. 证据存在但不覆盖必需类型 → 原因点名缺哪个类型
{
  const store = mkStore();
  addNode(store, {
    nodeId: "N2",
    title: "t",
    spec: "s",
    capability: "CODE",
    stage: null,
    deps: [],
    evidenceRequired: ["artifact", "review"],
    verifierIds: ["verifier-ci"],
  });
  const { addArtifact, addEvidence } = await import("../lib/core/evidence.js");
  addArtifact(store, { artifactId: "A1", path: "p", sha256: "0".repeat(64), producerNode: "N2" });
  addEvidence(store, {
    evidenceId: "E1",
    nodeId: "N2",
    kind: "artifact",
    artifactId: "A1",
    verifierId: "verifier-ci",
    verdict: "pass",
    producerInstance: "role-code-01",
    auditorInstance: "ROLE-AUDIT-CODE-01",
    provenance: "verified",
  });
  const out = doneCredentialWithReason(store, "N2");
  check(
    "类型未覆盖时原因点名缺失类型",
    out.credential === null && /未覆盖/.test(out.reason ?? "") && /review/.test(out.reason ?? ""),
    `reason=${out.reason}`,
  );
}

// 4. 证据是 inferred（被候选集过滤）→ 原因指向「凭证为空」而不是笼统的不可用
{
  const store = mkStore();
  addNode(store, {
    nodeId: "N3",
    title: "t",
    spec: "s",
    capability: "CODE",
    stage: null,
    deps: [],
    evidenceRequired: ["artifact"],
    verifierIds: ["verifier-ci"],
  });
  const { addArtifact, addEvidence } = await import("../lib/core/evidence.js");
  addArtifact(store, { artifactId: "A3", path: "p", sha256: "1".repeat(64), producerNode: "N3" });
  addEvidence(store, {
    evidenceId: "E3",
    nodeId: "N3",
    kind: "artifact",
    artifactId: "A3",
    verifierId: "verifier-ci",
    verdict: "pass",
    producerInstance: "role-code-01",
    auditorInstance: "ROLE-AUDIT-CODE-01",
    provenance: "inferred",
  });
  const out = doneCredentialWithReason(store, "N3");
  check(
    "只有 inferred 证据时不可 done，且原因非空",
    out.credential === null && (out.reason ?? "").length > 0,
    `reason=${out.reason}`,
  );
}

const failed = cases.filter((c) => !c.pass);
for (const c of cases) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : "  (" + c.detail + ")"}`);
console.log(failed.length === 0 ? "\nALL PASS" : `\nFAILED: ${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);
