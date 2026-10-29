/**
 * fixture 差分（N3-R4）：把 `fixtures/graph/*.json` 在 TS 侧跑一遍，与 Python oracle 用**同一份
 * `fixtures/manifest.json` 期望**逐条比对，输出 `diff`（0 = 与 Python 判定一致）。
 *
 * 说明：Python 侧的门禁是 `python tools/check_fixtures.py`（23 通过 / 0 问题），它按 manifest 期望判；
 * 这里按同一 manifest 期望判 TS 侧结论，因此 `diff === 0` 等价于「同夹具差分 = 0」。
 *
 * 用法：`node src/core/fixture-diff.ts`（或经 build 后的 lib/core/fixture-diff.js）
 * 退出码：0 = diff 0；1 = 有差异/读取失败。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Verdict = "valid" | "invalid";

interface Issue {
  code: string;
  message: string;
}

interface FixtureCase {
  file: string;
  expect: Verdict;
  expect_error_contains?: string;
}

interface CaseResult {
  file: string;
  expect: Verdict;
  tsVerdict: Verdict;
  match: boolean;
  keywordOk?: boolean;
  issues: Issue[];
  note?: string;
}

const NODE_STATUSES = new Set([
  "planned",
  "ready",
  "claimed",
  "running",
  "submitted",
  "verifying",
  "accepted",
  "rejected",
  "blocked",
  "done",
]);
const SCOPES = new Set(["shareable", "private", "unlabeled"]);
const IMPACTS = new Set(["low", "medium", "high"]);

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, "fixtures", "manifest.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`找不到仓库根（fixtures/manifest.json）：从 ${start} 向上 8 层未命中`);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** schema-lite + 语义校验（对齐 tools/check_fixtures.py 的规则集合）。 */
function validateGraphFixture(g: Record<string, unknown>): Issue[] {
  const issues: Issue[] = [];
  const push = (code: string, message: string): void => {
    issues.push({ code, message });
  };

  for (const key of ["graph_id", "goal", "acceptance", "budget", "version", "nodes", "edges", "artifacts", "events", "ledger"]) {
    if (!(key in g)) push(`missing_field:${key}`, `缺少必填字段 "${key}"`);
  }
  if (typeof g.graph_id === "string" && !/^GRAPH-[0-9]{8}-[0-9A-F]{6}$/.test(g.graph_id)) {
    push("bad_graph_id", `graph_id 必须匹配 ^GRAPH-[0-9]{8}-[0-9A-F]{6}$，实际 ${g.graph_id}`);
  }
  if (typeof g.goal !== "string" || !g.goal.trim()) push("missing_goal", "goal 必须是非空字符串");
  if (Array.isArray(g.acceptance) && (g.acceptance as unknown[]).length === 0) {
    push("missing_acceptance", "acceptance 至少一项");
  }
  const budget = (g.budget ?? {}) as Record<string, unknown>;
  for (const key of ["max_tokens", "max_calls", "max_wall_min", "max_parallel"]) {
    if (!(key in budget)) push(`missing_field:budget.${key}`, `budget 缺少 ${key}`);
  }
  if (typeof budget.max_tokens === "number" && budget.max_tokens < 1) {
    push("negative_budget", `budget.max_tokens 必须 >= 1，实际 ${budget.max_tokens}`);
  }
  if (typeof g.version === "number" && g.version < 1) push("bad_version", "version 必须 >= 1");

  const nodes = asArray(g.nodes) as Array<Record<string, unknown>>;
  if (!nodes.length) push("no_nodes", "nodes 至少一个");
  const ids = nodes.map((n) => String(n.node_id ?? ""));
  if (new Set(ids).size !== ids.length) push("duplicate_node_id", "节点 id 重复");
  const idSet = new Set(ids);

  for (const node of nodes) {
    const nid = String(node.node_id ?? "");
    const status = String(node.status ?? "");
    if (!NODE_STATUSES.has(status)) push("bad_node_status", `节点 ${nid} 状态非法：${status}`);
    for (const key of ["node_id", "title", "spec", "status", "deps"]) {
      if (!(key in node)) push(`missing_field:node.${key}`, `节点 ${nid} 缺少 ${key}`);
    }
    if (node.scope !== undefined && !SCOPES.has(String(node.scope))) {
      push("unknown_scope", `节点 ${nid} scope 非法：${node.scope}`);
    }
    if (node.impact !== undefined && !IMPACTS.has(String(node.impact))) {
      push("bad_impact", `节点 ${nid} impact 非法：${node.impact}`);
    }
    const deps = asArray(node.deps).map(String);
    for (const dep of deps) {
      if (!idSet.has(dep)) push("dep_missing", `依赖不存在：${nid} -> ${dep}`);
    }
  }

  // 依赖环（DFS）
  const depMap = new Map<string, string[]>();
  for (const node of nodes) depMap.set(String(node.node_id), asArray(node.deps).map(String));
  for (const edge of asArray(g.edges) as Array<Record<string, unknown>>) {
    if (edge.kind === "blocks") {
      const to = String(edge.to);
      const list = depMap.get(to) ?? [];
      list.push(String(edge.from));
      depMap.set(to, list);
    }
  }
  const colour = new Map<string, number>();
  const seenCycle = new Set<string>();
  const walk = (nid: string, stack: string[]): boolean => {
    colour.set(nid, 1);
    for (const dep of depMap.get(nid) ?? []) {
      if (!idSet.has(dep)) continue;
      if (colour.get(dep) === 1) {
        const cycle = [...stack.slice(stack.indexOf(dep)), dep].join(" -> ");
        if (!seenCycle.has(cycle)) {
          seenCycle.add(cycle);
          push("dep_cycle", `依赖成环：${cycle}`);
        }
        return true;
      }
      if ((colour.get(dep) ?? 0) === 0 && walk(dep, [...stack, dep])) return true;
    }
    colour.set(nid, 2);
    return false;
  };
  for (const nid of idSet) {
    if ((colour.get(nid) ?? 0) === 0 && walk(nid, [nid])) break;
  }

  // accepted / done 必须有 verifier_ids
  for (const node of nodes) {
    if (["accepted", "done"].includes(String(node.status)) && asArray(node.verifier_ids).length === 0) {
      push("missing_verifier", `节点 ${node.node_id} 状态 ${node.status} 但缺 verifier_ids`);
    }
  }

  // 状态单元（state_units）：id 模式 / kind / status / scope
  for (const unitRaw of asArray(g.state_units) as Array<Record<string, unknown>>) {
    const uid = String(unitRaw.unit_id ?? "");
    if (!/^UNIT-[A-Z0-9-]+$/.test(uid)) push("bad_unit_id", `unit_id 格式非法：${uid}`);
    for (const key of ["unit_id", "kind", "statement", "status"]) {
      if (!(key in unitRaw)) push(`missing_field:unit.${key}`, `状态单元 ${uid} 缺少 ${key}`);
    }
    if (unitRaw.scope !== undefined && !SCOPES.has(String(unitRaw.scope))) {
      push("unknown_scope", `状态单元 ${uid} scope 非法：${unitRaw.scope}（允许 shareable/private/unlabeled）`);
    }
  }

  // 产物引用
  const artifactIds = new Set(asArray(g.artifacts).map((a) => String((a as Record<string, unknown>).artifact_id)));  for (const artifact of asArray(g.artifacts) as Array<Record<string, unknown>>) {
    if (!idSet.has(String(artifact.producer_node))) {
      push("artifact_producer_missing", `产物 producer 不存在：${artifact.artifact_id}`);
    }
  }

  // 决策：L2 默认值 + 超时 + 超时后 chosen==default；L3 confirmed/blocked；L0/L1 auto/confirmed/overridden
  for (const decision of asArray(g.decisions) as Array<Record<string, unknown>>) {
    const did = String(decision.decision_id);
    const level = String(decision.level);
    const status = String(decision.status);
    if (decision.node_id && !idSet.has(String(decision.node_id))) {
      push("decision_node_missing", `决策 ${did} 的 node_id 不存在`);
    }
    if (level === "L2") {
      if (!decision.default_option_id) push("l2_missing_default", `决策 ${did}（L2）缺 default_option_id`);
      if (!decision.timeout_sec) push("l2_missing_timeout", `决策 ${did}（L2）缺 timeout_sec`);
      if (status === "timed_out" && decision.chosen_option_id !== decision.default_option_id) {
        push("l2_timeout_mismatch", `决策 ${did}（L2）超时后 chosen 必须等于默认值`);
      }
    } else if (level === "L3") {
      if (!["confirmed", "blocked"].includes(status)) {
        push("l3_bad_status", `决策 ${did}（L3）状态必须 confirmed 或 blocked`);
      }
      if (status === "confirmed" && !decision.chosen_option_id) {
        push("l3_missing_chosen", `决策 ${did}（L3）confirmed 但缺 chosen_option_id`);
      }
    } else {
      if (!["auto", "confirmed", "overridden"].includes(status)) {
        push("decision_bad_status", `决策 ${did}（${level}）状态非法：${status}`);
      }
      if (!decision.chosen_option_id) push("decision_missing_chosen", `决策 ${did}（${level}）缺 chosen_option_id`);
    }
  }

  // done 的证据链
  for (const node of nodes) {
    const evidence = asArray(node.evidence) as Array<Record<string, unknown>>;
    for (const row of evidence) {
      if (!artifactIds.has(String(row.artifact_id))) {
        push("evidence_artifact_missing", `证据 ${row.evidence_id} 引用的 artifact 不存在`);
      }
    }
    if (node.status !== "done") continue;
    if (!evidence.length) {
      push("done_without_evidence", `节点 ${node.node_id} 状态 done 但缺证据`);
      continue;
    }
    const failed = evidence.filter((e) => e.verdict !== "pass").map((e) => String(e.evidence_id));
    if (failed.length) {
      push("done_evidence_failed", `节点 ${node.node_id} 状态 done 但证据未通过：${failed.join(",")}`);
    }
    const required = new Set(asArray(node.evidence_required).map(String));
    const got = new Set(evidence.filter((e) => e.verdict === "pass").map((e) => String(e.kind)));
    const missing = [...required].filter((k) => !got.has(k)).sort();
    if (missing.length) {
      push("done_missing_kind", `节点 ${node.node_id} 状态 done 但缺必需证据类型：${missing.join(",")}`);
    }
  }

  // ready 依赖门控
  const statusOf = new Map(nodes.map((n) => [String(n.node_id), String(n.status)]));
  for (const node of nodes) {
    if (node.status !== "ready") continue;
    for (const dep of asArray(node.deps).map(String)) {
      if (statusOf.get(dep) !== "done") {
        push("ready_dep_not_done", `节点 ${node.node_id} 状态 ready 但依赖 ${dep} 未 done`);
      }
    }
  }

  // 阶段闸门
  const gates = new Map(
    asArray(g.stage_gates).map((x) => {
      const gate = x as Record<string, unknown>;
      return [String(gate.stage), String(gate.status)];
    }),
  );
  for (const node of nodes) {
    const stage = node.stage === undefined || node.stage === null ? "" : String(node.stage);
    if (stage && node.status === "done" && gates.get(stage) !== "passed") {
      push("gate_not_passed", `节点 ${node.node_id} 状态 done 但阶段闸门 ${stage} 未 passed`);
    }
  }

  // replan 版本不得超前
  for (const row of asArray(g.replan_events) as Array<Record<string, unknown>>) {
    if (Number(row.graph_version ?? 0) > Number(g.version ?? 0)) {
      push("replan_version_ahead", `重算事件 ${row.event_id} 的 graph_version 超前`);
    }
  }

  return issues;
}

function run(): number {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = findRepoRoot(here);
  const manifestPath = path.join(root, "fixtures", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { graph?: FixtureCase[] };
  const cases = manifest.graph ?? [];

  const results: CaseResult[] = [];
  for (const testCase of cases) {
    const filePath = path.join(root, testCase.file);
    let issues: Issue[] = [];
    let note: string | undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
      issues = validateGraphFixture(parsed);
    } catch (error) {
      note = `读取失败：${(error as Error).message}`;
      issues = [{ code: "unreadable", message: note }];
    }
    const tsVerdict: Verdict = issues.length ? "invalid" : "valid";
    const match = tsVerdict === testCase.expect;
    const keyword = testCase.expect_error_contains;
    const keywordOk = keyword
      ? issues.some((i) => i.message.includes(keyword) || i.code.includes(keyword.toLowerCase()))
      : undefined;
    results.push({
      file: testCase.file,
      expect: testCase.expect,
      tsVerdict,
      match,
      keywordOk,
      issues,
      note,
    });
  }

  const diffs = results.filter((r) => !r.match || r.keywordOk === false);
  const payload = {
    ok: diffs.length === 0,
    repo: root,
    cases: results.length,
    matched: results.length - diffs.length,
    diff: diffs.length,
    details: diffs.map((d) => ({
      file: d.file,
      expect: d.expect,
      tsVerdict: d.tsVerdict,
      keywordOk: d.keywordOk,
      issues: d.issues.map((i) => i.code),
    })),
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return payload.ok ? 0 : 1;
}

process.exit(run());
