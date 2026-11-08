// 验收类型扩展：numeric（数值阈值）与 schema（结构校验）。
// 参考 Quantum Research Copilot 的三级验证（F < 0.99 → 错），但保持最小：
// 数值必须来自**产物本身**，不是调用方口述，这样别人能重读同一文件复算一遍。
import fs from "node:fs";
import path from "node:path";
import { Store } from "../lib/core/store.js";
import { addNode } from "../lib/core/graph.js";
import { configureCore, submitEvidence } from "../lib/core/facade.js";

const cases = [];
const check = (name, cond, detail) => cases.push({ name, pass: Boolean(cond), detail });

const tmp = path.join(process.env.TEMP ?? ".", "l0-acc");
fs.mkdirSync(tmp, { recursive: true });
const writeJson = (name, obj) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(obj), "utf8");
  return p;
};

const setup = () => {
  const store = new Store();
  configureCore({ store });
  addNode(store, {
    nodeId: "N1",
    title: "N1",
    spec: "s",
    capability: "CODE",
    stage: null,
    deps: [],
    evidenceRequired: ["artifact"],
    verifierIds: ["v"],
  });
  store.state.nodes.get("N1").status = "running";
  return store;
};

const submit = (artifactPath, acceptance) =>
  submitEvidence({
    nodeId: "N1",
    artifactPath,
    producer_instance: "ROLE-CODE-01",
    verifier: "verifier-ci",
    acceptance,
  });

// 1. numeric：达标 → pass
{
  setup();
  const p = writeJson("fid-pass.json", { metrics: { fidelity: 0.995 } });
  const r = submit(p, { kind: "numeric", path: "metrics.fidelity", comparator: ">=", expected: 0.99 });
  check("numeric 达标判 pass", r?.verdict === "pass", JSON.stringify(r?.verdict ?? r?.error));
}

// 2. numeric：不达标 → fail（对应 F < 0.99）
{
  setup();
  const p = writeJson("fid-fail.json", { metrics: { fidelity: 0.25 } });
  const r = submit(p, { kind: "numeric", path: "metrics.fidelity", comparator: ">=", expected: 0.99 });
  check("numeric 不达标判 fail", r?.verdict === "fail", JSON.stringify(r?.verdict ?? r?.error));
  check("fail 详情带实测值", JSON.stringify(r ?? {}).includes("0.25"), JSON.stringify(r ?? {}).slice(0, 160));
}

// 3. numeric：路径不存在 → unknown（不是 fail，也不是 pass）
{
  setup();
  const p = writeJson("fid-missing.json", { other: 1 });
  const r = submit(p, { kind: "numeric", path: "metrics.fidelity", comparator: ">=", expected: 0.99 });
  check("路径缺失判 unknown", r?.verdict === "unknown", JSON.stringify(r?.verdict ?? r?.error));
}

// 4. numeric：产物不是 JSON → unknown
{
  setup();
  const p = path.join(tmp, "not-json.txt");
  fs.writeFileSync(p, "hello", "utf8");
  const r = submit(p, { kind: "numeric", path: "x", comparator: ">=", expected: 1 });
  check("非 JSON 产物判 unknown", r?.verdict === "unknown", JSON.stringify(r?.verdict ?? r?.error));
}

// 5. numeric：非法 comparator → unknown
{
  setup();
  const p = writeJson("cmp.json", { x: 1 });
  const r = submit(p, { kind: "numeric", path: "x", comparator: "~=", expected: 1 });
  check("非法 comparator 判 unknown", r?.verdict === "unknown", JSON.stringify(r?.verdict ?? r?.error));
}

// 6. schema：键齐全 → pass
{
  setup();
  const p = writeJson("sch-ok.json", { p_sv: 0.5, p_meas: 49, n: 100 });
  const r = submit(p, { kind: "schema", required: ["p_sv", "p_meas", "n"] });
  check("schema 齐全判 pass", r?.verdict === "pass", JSON.stringify(r?.verdict ?? r?.error));
}

// 7. schema：缺键 → fail
{
  setup();
  const p = writeJson("sch-miss.json", { p_sv: 0.5 });
  const r = submit(p, { kind: "schema", required: ["p_sv", "p_meas", "n"] });
  check("schema 缺键判 fail", r?.verdict === "fail", JSON.stringify(r?.verdict ?? r?.error));
}

// 8. schema：类型不符 → fail
{
  setup();
  const p = writeJson("sch-type.json", { p_sv: "0.5", p_meas: 49, n: 100 });
  const r = submit(p, { kind: "schema", required: ["p_sv", "p_meas"], types: { p_sv: "number", p_meas: "number" } });
  check("schema 类型不符判 fail", r?.verdict === "fail", JSON.stringify(r?.verdict ?? r?.error));
}

// 9. schema：空 required → unknown（防恒真）
{
  setup();
  const p = writeJson("sch-empty.json", { a: 1 });
  const r = submit(p, { kind: "schema", required: [] });
  check("空 required 判 unknown", r?.verdict === "unknown", JSON.stringify(r?.verdict ?? r?.error));
}

// 10. 旧的三种 kind 不受影响
{
  setup();
  const p = path.join(tmp, "plain.txt");
  fs.writeFileSync(p, "hello world", "utf8");
  const r1 = submit(p, { kind: "exists" });
  check("exists 仍 pass", r1?.verdict === "pass", JSON.stringify(r1?.verdict ?? r1?.error));
}
{
  setup();
  const p = path.join(tmp, "plain2.txt");
  fs.writeFileSync(p, "hello world", "utf8");
  const r = submit(p, { kind: "contains", expected: "world" });
  check("contains 仍 pass", r?.verdict === "pass", JSON.stringify(r?.verdict ?? r?.error));
}

const failed = cases.filter((c) => !c.pass);
for (const c of cases) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : "  (" + c.detail + ")"}`);
console.log(failed.length === 0 ? "\nALL PASS" : `\nFAILED: ${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);
