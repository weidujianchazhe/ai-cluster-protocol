/**
 * core 门面：N2 `service.ts` 通过 `import('./core/index.js')` 约定的 8 个动作。
 *
 * 约定（与 N2 对齐）：
 *  - 只导出实现得了的动作，且**不假装成功**：未落地返回 `{ok:false,error:'core-not-implemented'}`；
 *  - 门面自己持有 core store 单例；N4 的持久化层可用 `configureCore({store})` 注入同一 store；
 *  - 所有动作都同步返回（N2 用 `await` 兼容同步值）。
 */
import { Store } from "./store.js";
                                             
import { addNode, getNode, listNodes, edges, doneCredential, doneCredentialWithReason, rejectNode, setStatus, snapshot } from "./graph.js";
import { bootstrap, installReadyHook, readySet, recomputeReady } from "./ready.js";
import { claim, currentLease, renew } from "./leases.js";
import { addArtifact, addEvidence, getArtifact } from "./evidence.js";
import {
  blockingDecisions,
  chooseNow,
  createDecision,
  getDecision,
  listDecisions,
  tickL2,
} from "./decisions.js";
import { coreIo } from "./io.js";
import { ALIASES, AliasError, pickAlias, pickNumber, pickString } from "./alias.js";
import { foldEvents, rehydrate, restoreFromEvents } from "./fold.js";
import { commitGraph, graphSpecTemplate, planGraph } from "./graphspec.js";
import { runFactorGuards } from "./guards.js";
import { normalizeDispatchOptions, planDispatchTick } from "./dispatcher.js";
                                        

let sharedStore               = null;
const wired = new WeakSet       ();

function wire(store       )        {
  if (!wired.has(store)) {
    wired.add(store);
    installReadyHook(store);
  }
  return store;
}

/** 注入/替换门面使用的 store（N4 持久化层用；传 null 恢复默认内存 store）。 */
export function configureCore(options                           = {})       {
  sharedStore = options.store ?? null;
  if (sharedStore) wire(sharedStore);
}

/** 取门面 store（首次调用创建内存 store 并挂 ready 钩子）。 */
export function coreStore()        {
  if (!sharedStore) sharedStore = wire(new Store());
  return sharedStore;
}

/** 仅测试用：丢弃单例。 */
export function resetCore()       {
  sharedStore = null;
}

/**
 * 重开恢复：把持久化 journal 事件回灌 + 折叠成图状态（N2 `restoreCoreJournal` 缺的那一半）。
 *
 * 用法（N2）：读到 JSONL → `restoreCore({ events })` → `graphStatus()` 的 counts 立刻正确。
 */
export function restoreCore(options                         = {})                          {
  const store = coreStore();
  const provided = Array.isArray(options.events) ? options.events : null;
  const events = (provided ?? store.journal.raw())                                           ;
  const state = restoreFromEvents(store, events);
  ensureWired(store);
  const reconciled = reconcileState(store);
  return {
    ok: true,
    restored: store.journal.count(),
    counts: stateCounts(state),
    reconciled,
  };
}

/**
 * 内存 ↔ journal 一致性审计。
 *
 * 把 journal 重放成「应有的 state」，与当前内存逐表比对 **key 集合**。
 * 这是「只改内存不写事件」这类 bug 的唯一通用检测手段——今天那个 lease 复活
 * 就是它的第一个实例：重启后租约出现在内存里，而 journal 里没有任何能解释它的新事件。
 *
 * 只比 key 集合不比值：值差异可能来自合法的同态更新（例如 heartbeat 改时间戳
 * 但不改 owner），会产生大量噪声；key 集合的差异一定是真问题。
 */
export function auditStateConsistency()                                 {
  const store = coreStore();
  let expected                               ;
  try {
    expected = foldEvents(store.journal.raw());
  } catch (error) {
    return [{ table: "*", issue: "journal-unfoldable", error: (error         ).message }];
  }
  const drift                                 = [];
  const tables                                                              = [
    ["nodes", store.state.nodes                                   , expected.nodes                                   ],
    ["leases", store.state.leases                                   , expected.leases                                   ],
    ["evidence", store.state.evidence                                   , expected.evidence                                   ],
    ["artifacts", store.state.artifacts                                   , expected.artifacts                                   ],
    ["gates", store.state.gates                                   , expected.gates                                   ],
    ["decisions", store.state.decisions                                   , expected.decisions                                   ],
  ];
  for (const [table, live, want] of tables) {
    for (const key of live.keys()) {
      if (!want.has(key)) drift.push({ table, key, issue: "memory-only" });
    }
    for (const key of want.keys()) {
      if (!live.has(key)) drift.push({ table, key, issue: "journal-only" });
    }
  }
  return drift;
}

/**
 * 重启一致性自检（**主动对账**，而不是等第一次 claim 时被动修）。
 *
 * 典型残留在老版本里产生：`dropLease` 只删内存不写 journal，重启后 fold 重放旧的
 * `lease_claimed` 把租约复活，节点停在 `ready` 却「已被持有」——claim 报 alreadyHeld、
 * submit 不推进、verify 判 invalid-state，节点永久卡死。
 *
 * 对账规则：
 *  - `claimed` / `running` 持有租约 → 正常
 *  - `ready` + 租约 + assignee 为空 → 以租约为准补回 `claimed`
 *  - 其余任何状态持有租约 → 视为残留，删除并留痕
 *
 * 每一条修正都会写 journal，所以对账本身也是可审计的。
 */
export function reconcileState(store       )                                 {
  const fixes                                 = [];
  const nodeIds = [...store.state.nodes.keys()];
  for (const nodeId of nodeIds) {
    const node = store.state.nodes.get(nodeId);
    if (!node) continue;
    const lease = currentLease(store, nodeId);
    if (!lease) continue;
    if (node.status === "claimed" || node.status === "running") continue;
    if (node.status === "ready") {
      try {
        setStatus(store, nodeId, "claimed", {
          assignee: lease.owner,
          reason: "reconcile:lease_restored",
          notify: false,
        });
        fixes.push({ nodeId, action: "lease_restored", owner: lease.owner });
      } catch (error) {
        fixes.push({ nodeId, action: "lease_restore_failed", error: (error         ).message });
      }
      continue;
    }
    store.state.leases.delete(nodeId);
    store.journal.append("lease_released", nodeId, {
      reason: `reconcile:status=${node.status}`,
      at: store.nowIso(),
    });
    fixes.push({ nodeId, action: "lease_released", status: node.status });
  }
  return fixes;
}

/** 用 journal 重新折叠当前 store 的 state（不替换日志）。 */
export function rehydrateCore()                          {
  const store = coreStore();
  const state = rehydrate(store);
  return { ok: true, events: store.journal.count(), counts: stateCounts(state) };
}

function ensureWired(store       )       {
  wire(store);
}

function stateCounts(state                                         )                         {
  return {
    nodes: state.nodes.size,
    edges: state.edges.length,
    evidence: state.evidence.size,
    decisions: state.decisions.size,
    gates: state.gates.size,
    leases: state.leases.size,
    artifacts: state.artifacts.size,
    replan_events: state.replanEvents.length,
  };
}

// R4 起 8 个动作全部落地，`core-not-implemented` 兜底不再需要（保留 coreCapabilities().pending=[] 自证）。

                            
               
                       
                        
 

                                
                
 

/**
 * 领取入参：camelCase 与 snake_case 都收（N2 归一化后的入参是 snake_case）。
 * 实现经 `pickAlias` 读键（见 claimTaskImpl），所以这里把两套别名都声明出来。
 */
                                                                 
                  
                   
                
                      
                       
 

                                 
                 
                       
                  
 

                                                                
                  
                        
                    
                                       
                    
                                                                                            
                      
 

                                                                  
                  
                                       
 

                                                              
                      
                  
                 
                    
                
                    
                                                         
                           
                          
                  
                      
               
 

function briefNode(node            )                          {
  return {
    node_id: node.node_id,
    title: node.title,
    status: node.status,
    capability: node.capability,
    stage: node.stage,
    attempts: node.attempts,
    assignee: node.assignee,
    deps: node.deps,
    evidence_required: node.evidence_required,
  };
}

/**
 * 最小投影（P0-4/P1-5 铺垫）：task_next / graph_status 核心侧只返这 6 个字段。
 * capability 是自由标签（不是职务枚举），role 只是实例身份——这里不做任何绑定。
 * 旧的 briefNode（含 node_id/attempts/assignee/evidence_required）保留给
 * claim/verify/submitWish/export 等仍需完整信息的路径，不静默丢弃。
 */
function minimalNode(node            )                          {
  return {
    nodeId: node.node_id,
    title: node.title,
    stage: node.stage,
    capability: node.capability,
    deps: [...node.deps],
    status: node.status,
  };
}

/**
 * 愿望 → **只记录愿望**（工作图组成因子）。
 *
 * 这里不产出任何节点：图形态由 AI 用 `graph_plan` → `graph_commit` 按需求组装，
 * 不再有「research → PRD → contract → build → audit → deliver」这种固定流水线。
 * 重复提交愿望不再报错——它不建图，就不存在「静默产出第二份图」的风险；
 * 旧的 wish_id 通过 `previousWishId` 带回，便于回看意图演变。
 */
export const WISH_PLAN                 
                 
                
                     
                             
                 
   = [
  { nodeId: "NODE-RESEARCH", title: "愿望解析与调研", capability: "RESEARCH", stage: "research", deps: [] },
  { nodeId: "NODE-PRD", title: "产品规格 PRD", capability: "DESIGN", stage: "design", deps: ["NODE-RESEARCH"] },
  { nodeId: "NODE-CONTRACT", title: "接口与数据契约", capability: "DESIGN", stage: "design", deps: ["NODE-PRD"] },
  { nodeId: "NODE-BUILD", title: "实现与自测", capability: "CODE", stage: "build", deps: ["NODE-CONTRACT"] },
  { nodeId: "NODE-AUDIT", title: "独立审计", capability: "AUDIT", stage: "audit", deps: ["NODE-BUILD"] },
  { nodeId: "NODE-DELIVER", title: "交付打包", capability: "OPS", stage: "deliver", deps: ["NODE-AUDIT"] },
];

/**
 * 愿望 → 工作图（**只记录愿望，不再生成固定 6 节点**）。
 *
 * 组成因子原则：具体节点/依赖由 AI 用 `graph_plan` → `graph_commit` 决定。
 * `WISH_PLAN` 仅保留给 demo / 兼容测试，生产路径不再使用。
 */
function submitWishImpl(input           )                          {
  const text = String(input?.text ?? '').trim();
  if (!text) return { ok: false, error: "wish-text-required" };
  const store = coreStore();

  const maxParallel = input.maxParallel === undefined ? 2 : Number(input.maxParallel);
  const budgetTokens = input.budgetTokens === undefined ? 0 : Number(input.budgetTokens);
  const wishId = `WISH-${store.nowMs()}`;
  const previousWishId = store.state.meta.get("wish_id") ?? null;

  try {
    store.atomically(() => {
      store.state.meta.set("wish_id", wishId);
      store.state.meta.set("wish_text", text);
      store.state.meta.set("wish_max_parallel", String(maxParallel));
      store.state.meta.set("wish_budget_tokens", String(budgetTokens));
      store.journal.append("wish_submitted", null, { wish_id: wishId, previous_wish_id: previousWishId, text, maxParallel, budgetTokens });
    });
  } catch (error) {
    return {
      ok: false,
      error: (error                     ).code ?? "wish-record-failed",
      message: (error         ).message,
    };
  }

  return {
    ok: true,
    wishId,
    previousWishId,
    replaced: previousWishId !== null,
    text,
    maxParallel,
    budgetTokens,
    /** 生产路径不再自动建图：先 graph_plan 预览，再 graph_commit 落图 */
    graphPlanRequired: true,
    nodes: [],
    ready: readySet(store),
    template: graphSpecTemplate(text),
    instructions: [
      "1. 分析需求、约束、风险、可并行点；节点数量由工作决定，不由团队规模决定。",
      "2. 只用 Node 因子（nodeId/title/spec/capability/stage/deps/evidenceRequired/verifierIds/acceptance/budget）。",
      "3. 每个节点必须可验收（acceptance，或 evidenceRequired + verifierIds）；没有验收的节点不许落图。",
      "4. 先 graph_plan 预览（零写入），确认 errors/warnings/ready 后再 graph_commit。",
      "5. 强依赖必须显式写 deps；能并行的才并行。不套固定流水线。",
    ],
    graph: { nodes: listNodes(store).map(briefNode), edges: edges(store) },
  };
}

/** 图状态投影（只读）。
 *
 * P1-5 最小投影 + **core 层分页**：核心侧只返 counts + ready 列表 + 最小节点投影
 * （nodeId/title/stage/capability/deps/status），并按 `limit/offset` 在**铸造投影前**
 * 就只处理那一页——大图时不再「先全量 map 再切一刀」，内存峰值与 CPU 都跟着页大小走。
 *
 * 兼容保留（不静默丢）：version（uiSnapshot 读它）、graph 容器（a2a/observability
 * 读 graph.nodes）、journal、audit。graph.nodes 与 nodes 是同一页数据。
 */
                                     
                             
                 
                    
                  
 

export function graphStatus(options                     = {})                          {
  const store = coreStore();
  const report = store.journal.validateStream();
  // 组成因子巡检：只读，不写 journal。巡检项由 NodeRecord 的因子派生（见 core/guards.ts）。
  const guardReport = runFactorGuards({ store, nowMs: store.nowMs() });

  const total = store.state.nodes.size;
  const limitRaw = Number(options?.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 50;
  const offsetRaw = Number(options?.offset);
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;

  // 先排序、只对当前页做投影（map 只跑 pageSize 次，而不是全量）
  const ordered = listNodes(store);
  const pageNodes = ordered.slice(offset, offset + limit).map(minimalNode);

  // counts 需要全量状态统计，但只遍历 status 字段，不构造完整记录
  let done = 0;
  let blocked = 0;
  for (const node of store.state.nodes.values()) {
    if (node.status === "done") done += 1;
    else if (node.status === "blocked") blocked += 1;
  }
  const edgeList = edges(store);

  return {
    ok: true,
    version: Number(store.state.meta.get("graph_version") ?? "1"),
    ready: readySet(store),
    counts: {
      nodes: total,
      edges: edgeList.length,
      done,
      blocked,
    },
    /** 当前页的最小投影；graph.nodes 是同一页的兼容容器。 */
    nodes: pageNodes,
    graph: { nodes: pageNodes, edges: edgeList },
    page: {
      limit,
      offset,
      total,
      truncated: offset + limit < total,
      hint: "完整节点走 graph_export 或按 nodeId 点查",
    },
    journal: {
      events: store.journal.count(),
      lastSeq: store.journal.count(),
      ok: report.ok,
      issues: report.issues.slice(0, 5),
    },
    /** 巡检结果：谁停滞、谁的因子配置有问题。供集群内循环或人工消费。 */
    audit: {
      checked: guardReport.checked,
      bySeverity: guardReport.bySeverity,
      findings: guardReport.findings.slice(0, 20),
    },
  };
}

/** 派活计划（只读）。core 层包装：service 只传原始选项，不直接碰 store。 */
export function dispatchPlan(raw                         )                          {
  const store = coreStore();
  const options = normalizeDispatchOptions(raw         , Date.now());
  const tick = planDispatchTick(store, options);
  return {
    ok: true,
    mode: options.mode,
    dryRun: options.dryRun,
    intervalMs: options.intervalMs,
    maxPerTick: options.maxPerTick,
    dispatcherInstance: options.dispatcherInstance,
    ready: tick.ready,
    readyCount: tick.readyCount,
    plan: tick.plan,
    blocking: tick.blocking,
    willDispatch: tick.willDispatch,
    summary: tick.summary,
    hint: tick.hint ?? null,
  };
}

/** 取下一个可执行节点（ready 由 core 计算；可按职务过滤）。
 *
 * P0-4 最小投影：task 只返 nodeId/title/stage/capability/deps/status。
 * role 过滤只是按 capability 自由标签匹配（大小写不敏感），不把能力绑死职务。
 * 兼容说明：旧 task.node_id / task.attempts / task.assignee /
 * task.evidence_required 不再经 task_next 出（service/tools 仅透传结果，
 * 不读这些字段；core 自检已同步到 nodeId）。需要完整节点走 claimTask /
 * verifyDone / getNode（briefNode 路径）。
 */
export function nextTask(input                = {})                          {
  const store = coreStore();
  recomputeReady(store, { reason: "recompute" });
  const ready = listNodes(store).filter((n) => n.status === "ready");
  const role = input.role?.trim();
  const candidates = role
    ? ready.filter((n) => (n.capability ?? "").toUpperCase() === role.toUpperCase())
    : ready;
  const task = candidates[0] ?? null;
  return {
    ok: true,
    role: role ?? null,
    ready: ready.map((n) => n.node_id),
    task: task ? minimalNode(task) : null,
  };
}

/** 领取节点（走租约；返回 lease + 节点后像）。 */
function claimTaskImpl(input                )                          {
  const raw = (input ?? {})                           ;
  const nodeId = pickString(raw, ALIASES.nodeId) ?? "";
  if (!nodeId) return { ok: false, error: "node-id-required" };
  const store = coreStore();
  const owner =
    pickString(raw, ALIASES.instanceId) ?? input.instanceId ?? input.role ?? "agent";
  const existing = currentLease(store, nodeId);
  if (existing && existing.owner === owner) {
    // 历史残留修复：租约还在、节点却被驳回成 ready（老版本 dropLease 不落 journal，
    // 重启后 lease 复活）。以租约为准把状态补回 claimed，否则该节点永远卡在
    // 「ready + 已被持有」：claim 报 alreadyHeld、submit 不推进、verify 判 invalid-state。
    const held = getNode(store, nodeId);
    if (held && held.status === "ready") {
      setStatus(store, nodeId, "claimed", { assignee: owner, reason: "lease_restored" });
    }
    return {
      ok: true,
      alreadyHeld: true,
      lease: existing                                      ,
      node: briefNode(getNode(store, nodeId)              ),
    };
  }
  const lease        = claim(store, nodeId, owner, { ttlSec: 600 });
  const node = getNode(store, nodeId)              ;
  return {
    ok: true,
    lease: lease                                      ,
    node: briefNode(node),
  };
}

/**
 * 租约心跳续期（P0-3）：绑定的是 fencingToken 能力凭证，不是智能体身份。
 * 任一载体持有当前 token 即可续期（集群身份脱离）；owner 取自当前租约，
 * token 不匹配 / 已过期由 leases.renew 抛错，调用方按「续租失败即停手」处理。
 */
export function heartbeatTask(input                )                          {
  const nodeId = String(input?.nodeId ?? "").trim();
  if (!nodeId) return { ok: false, error: "node-id-required" };
  const fencingToken = Number(input?.fencingToken);
  if (!Number.isFinite(fencingToken)) return { ok: false, error: "fencing-token-required" };
  const store = coreStore();
  const lease = currentLease(store, nodeId);
  if (!lease) return { ok: false, error: "lease_expired", message: `租约不存在：${nodeId}` };
  try {
    const renewed = renew(store, nodeId, lease.owner, fencingToken, {
      ttlSec: Number.isFinite(Number(input?.ttlSec)) && Number(input?.ttlSec) > 0 ? Number(input?.ttlSec) : 600,
    });
    return { ok: true, lease: renewed                                      , nodeId };
  } catch (error) {
    const code = (error                     )?.code ?? (error         )?.name ?? "heartbeat-failed";
    return { ok: false, error: String(code).toLowerCase(), message: String((error         )?.message ?? error) };
  }
}

/**
 * 验收条目判定（fail-closed）。
 *
 * 裁决（Lead 2026-10-29）：既无 `acceptance` 又无显式 `verdict` → **`unknown`**（不得 pass）；
 * 只有「acceptance 命中」或「显式 verdict='pass'」才 pass。
 */
function evaluateAcceptance(
  acceptance                                     ,
  resolved        ,
  sha256        ,
  explicitVerdict                              ,
)                                                                            {
  if (!acceptance) {
    if (explicitVerdict === "pass" || explicitVerdict === "fail" || explicitVerdict === "unknown") {
      return {
        verdict: explicitVerdict,
        detail: { kind: "none", policy: "explicit-verdict", verdict: explicitVerdict },
      };
    }
    return {
      verdict: "unknown",
      detail: {
        kind: "none",
        reason: "no-acceptance-no-verdict",
        hint: "既没有 acceptance 也没有显式 verdict，按 unknown 处理（unknown 不得当作 pass）",
      },
    };
  }
  const kind = String(acceptance.kind ?? "exists");
  if (explicitVerdict && explicitVerdict !== "unknown") {
    // 显式 verdict 与 acceptance 都给了：以更严格者为准（fail 优先于 pass）
    const evaluated = evaluateAcceptance(acceptance, resolved, sha256);
    if (evaluated.verdict === "fail" || explicitVerdict === "fail") {
      return { verdict: "fail", detail: { ...evaluated.detail, explicitVerdict } };
    }
    return evaluated;
  }
  if (kind === "exists") return { verdict: "pass", detail: { kind } };
  if (kind === "sha256") {
    const expected = String(acceptance.expected ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      return { verdict: "unknown", detail: { kind, reason: "invalid-expected-sha256" } };
    }
    return {
      verdict: expected === sha256 ? "pass" : "fail",
      detail: { kind, expected, actual: sha256 },
    };
  }
  if (kind === "contains") {
    const expected = String(acceptance.expected ?? "");
    if (!expected) {
      // 空 expected 会让 includes("") 恒真 → 假 pass；这里必须 fail-closed 成 unknown
      return { verdict: "unknown", detail: { kind, reason: "empty-expected" } };
    }
    let text        ;
    try {
      text = coreIo().readText(resolved);
    } catch (error) {
      return { verdict: "unknown", detail: { kind, reason: (error         ).message } };
    }
    return { verdict: text.includes(expected) ? "pass" : "fail", detail: { kind } };
  }
  // 数值判定：从产物 JSON 里读一个数，与阈值比较。
  // 覆盖「保真度 F < 0.99 → 错」这类场景，数值来自产物本身而非调用方口述，
  // 因此别人可以重读同一文件算一遍。
  if (kind === "numeric") {
    const pathExpr = String(acceptance.path ?? "");
    const expected = Number(acceptance.expected);
    const comparator = String(acceptance.comparator ?? ">=");
    if (!pathExpr) return { verdict: "unknown", detail: { kind, reason: "missing-path" } };
    if (!Number.isFinite(expected)) return { verdict: "unknown", detail: { kind, reason: "invalid-expected" } };
    if (![">=", ">", "<=", "<", "=="].includes(comparator)) {
      return { verdict: "unknown", detail: { kind, reason: "unsupported-comparator", comparator } };
    }
    let doc         ;
    try {
      doc = JSON.parse(coreIo().readText(resolved));
    } catch (error) {
      return { verdict: "unknown", detail: { kind, reason: `artifact-not-json: ${(error         ).message}` } };
    }
    let cur          = doc;
    for (const seg of pathExpr.split(".")) {
      if (cur === null || typeof cur !== "object") return { verdict: "unknown", detail: { kind, reason: `path-broken: ${pathExpr}` } };
      cur = (cur                           )[seg];
    }
    const actual = Number(cur);
    if (!Number.isFinite(actual)) return { verdict: "unknown", detail: { kind, reason: `not-numeric: ${pathExpr}` } };
    const pass =
      comparator === ">=" ? actual >= expected
        : comparator === ">" ? actual > expected
          : comparator === "<=" ? actual <= expected
            : comparator === "<" ? actual < expected
              : actual === expected;
    return { verdict: pass ? "pass" : "fail", detail: { kind, path: pathExpr, comparator, expected, actual } };
  }
  // 结构判定：产物 JSON 必须含有指定键（可选带类型）。
  // 缺键是明确的不符合 → fail；读不到/解析不了 → unknown。
  if (kind === "schema") {
    const required = acceptance.required;
    if (!Array.isArray(required) || required.length === 0) {
      return { verdict: "unknown", detail: { kind, reason: "missing-required-list" } };
    }
    let doc         ;
    try {
      doc = JSON.parse(coreIo().readText(resolved));
    } catch (error) {
      return { verdict: "unknown", detail: { kind, reason: `artifact-not-json: ${(error         ).message}` } };
    }
    if (doc === null || typeof doc !== "object") {
      return { verdict: "fail", detail: { kind, reason: "artifact-not-object" } };
    }
    const types = (acceptance.types ?? {})                          ;
    const missing           = [];
    const mistyped           = [];
    for (const key of required.map(String)) {
      const v = (doc                           )[key];
      if (v === undefined) { missing.push(key); continue; }
      const want = types[key];
      if (!want) continue;
      const actualType = Array.isArray(v) ? "array" : typeof v;
      if (actualType !== want) mistyped.push(`${key}: want ${want}, got ${actualType}`);
    }
    if (missing.length || mistyped.length) {
      return { verdict: "fail", detail: { kind, missing, mistyped } };
    }
    return { verdict: "pass", detail: { kind, keys: required.length } };
  }
  return { verdict: "unknown", detail: { kind, reason: "unsupported-acceptance-kind" } };
}

function countEvidence(store       , nodeId        )         {
  return [...store.state.evidence.values()].filter((e) => e.node_id === nodeId).length;
}

/**
 * 提交证据：产物 sha 校验 → artifact/evidence **append-only** 落账 → 推进到 submitted。
 *
 * 顶层 `ok` 语义：只有「证据判定为 pass 且落账成功」才 `ok:true`；
 * 验收 fail/unknown 一律 `ok:false`（失败不得被包成成功）。
 */
function submitEvidenceImpl(input               )                          {
  const store = coreStore();
  const raw = (input ?? {})                           ;
  const nodeId = pickString(raw, ALIASES.nodeId) ?? "";
  if (!nodeId) return { ok: false, error: "node-id-required" };
  const artifactPath = pickString(raw, ALIASES.artifactPath) ?? "";
  if (!artifactPath) return { ok: false, error: "artifact-path-required" };
  const node = getNode(store, nodeId);
  if (!node) return { ok: false, error: "node-not-found", nodeId };
  if (node.status === "done") {
    return { ok: false, error: "evidence-after-done", nodeId, hint: "done 节点不再接受新证据" };
  }
  const producerInstance = String(pickString(raw, ALIASES.producerInstance) ?? "").trim();
  if (!producerInstance) {
    return {
      ok: false,
      error: "producer-instance-required",
      hint: "证据提交者实例必填（producerInstance 或 producer_instance；审计独立取数依赖它）",
    };
  }
  const auditorRaw = pickAlias(raw, ALIASES.auditorInstance);
  const auditorInstance =
    auditorRaw === undefined || auditorRaw === null ? null : String(auditorRaw);

  const io = coreIo();
  const resolved = input.resolved ? String(input.resolved) : io.resolve(artifactPath);
  if (!io.exists(resolved)) return { ok: false, error: "artifact-missing", resolved };
  if (!io.isFile(resolved)) return { ok: false, error: "artifact-not-file", resolved };

  let sha256        ;
  try {
    sha256 = input.sha256 ? String(input.sha256).toLowerCase() : io.sha256(resolved);
  } catch (error) {
    return { ok: false, error: "artifact-unreadable", resolved, message: (error         ).message };
  }

  // 显式 verdict 别名：verdict / evidence_verdict
  const explicitVerdictRaw = pickString(raw, ["verdict", "evidenceVerdict", "evidence_verdict"]);
  const explicitVerdict =
    explicitVerdictRaw === "pass" || explicitVerdictRaw === "fail" || explicitVerdictRaw === "unknown"
      ? (explicitVerdictRaw                               )
      : undefined;
  const acceptance = evaluateAcceptance(input.acceptance, resolved, sha256, explicitVerdict);
  const artifactId =
    pickString(raw, ALIASES.artifactId) ?? `ART-${nodeId}-${sha256.slice(0, 8)}`;
  const existingArtifact = getArtifact(store, artifactId);
  if (!existingArtifact) {
    try {
      addArtifact(store, {
        artifactId,
        path: resolved,
        sha256,
        producerNode: nodeId,
        verifierIds: input.verifier ? [String(input.verifier)] : [],
      });
    } catch (error) {
      return { ok: false, error: "artifact-rejected", message: (error         ).message };
    }
  } else if (existingArtifact.sha256 !== sha256) {
    return {
      ok: false,
      error: "artifact-sha-conflict",
      artifactId,
      expected: existingArtifact.sha256,
      actual: sha256,
    };
  }

  const attemptNo = pickNumber(raw, ALIASES.attemptNo) ?? countEvidence(store, nodeId) + 1;
  const evidenceId =
    pickString(raw, ALIASES.evidenceId) ?? `EVD-${nodeId}-${attemptNo}-${sha256.slice(0, 8)}`;
  // P1-8 来源门禁的诚实缺省：有 acceptance 且由本插件对真实产物机器判定（exists/sha256/contains）
  // → 这就是"已验证"的事实，缺省 verified；没有 acceptance、只有人手写的 verdict → inferred。
  // 显式给值永远优先，非法值由 addEvidence 抛 invalid-provenance。
  const provenanceDefault = input.acceptance ? "verified" : "inferred";
  let evidence;
  try {
    evidence = addEvidence(store, {
      evidenceId,
      nodeId,
      kind: String(input.kind ?? "artifact"),
      artifactId,
      verifierId: String(input.verifier ?? "verifier-ci"),
      verdict: acceptance.verdict,
      producerInstance,
      auditorInstance,
      attemptNo,
      at: input.at ? String(input.at) : undefined,
      provenance: (pickString(raw, ["provenance"]) ?? input.provenance ?? provenanceDefault)         ,
    });
  } catch (error) {
    return {
      ok: false,
      error: (error                     ).code ?? "evidence-rejected",
      message: (error         ).message,
    };
  }

  let advanced                = null;
  if (acceptance.verdict === "pass" && (node.status === "claimed" || node.status === "running")) {
    setStatus(store, nodeId, "submitted", { reason: "submitted", notify: false });
    advanced = "submitted";
  }

  const result                          = {
    ok: acceptance.verdict === "pass",
    evidenceId: evidence.evidence_id,
    verdict: acceptance.verdict,
    acceptance: acceptance.detail,
    artifactId,
    sha256,
    attemptNo,
    producerInstance,
    auditorInstance,
    nodeStatus: getNode(store, nodeId)?.status ?? null,
  };
  if (advanced) result.advancedFrom = node.status;
  if (acceptance.verdict !== "pass") {
    result.error = "evidence-not-passed";
    result.hint = "验收未通过/未知；节点不会推进（unknown 永不等价于 pass）";
  }
  return result;
}

/**
 * 证据 → done：凭证校验通过才迁移（`verifying → done`），并自动解锁下游。
 * 失败路径**不写任何状态**（先校验，后迁移）。
 */
export function verifyDone(input                 )                          {
  const store = coreStore();
  const nodeId = String(input?.nodeId ?? "");
  if (!nodeId) return { ok: false, error: "node-id-required" };
  const node = getNode(store, nodeId);
  if (!node) return { ok: false, error: "node-not-found", nodeId };
  if (node.status === "done") {
    return { ok: true, alreadyDone: true, node: briefNode(node), promoted: [] };
  }
  if (node.status !== "submitted" && node.status !== "verifying") {
    return {
      ok: false,
      error: "invalid-state",
      nodeStatus: node.status,
      hint: "只有 submitted / verifying 可验证；先提交证据",
    };
  }

  const outcome = doneCredentialWithReason(store, nodeId);
  const credential = outcome.credential;
  if (!credential) {
    // P1：验证失败必须走「reject 帮助函数」——ready + dropLease + attempts+1，
    // 否则节点回到 ready 却留着旧租约：claimTask 报 alreadyHeld、submitEvidence 不推进。
    let rejected                                 = null;
    try {
      const after = rejectNode(store, nodeId, "credential_unavailable", {
        // 键名不能用 reason：setStatus 的 extra 会并入 payload，`reason` 是驳回契约前缀
        // （rejected:*）的载体，被覆盖后 replay 与驳回判定都读错。
        detail: { nodeStatus: node.status, credentialReason: outcome.reason },
      });
      rejected = { nodeStatus: after.status, attempts: after.attempts, leaseDropped: true };
    } catch (error) {
      rejected = { error: (error         ).message };
    }
    return {
      ok: false,
      error: "credential-unavailable",
      reason: outcome.reason,
      nodeStatus: getNode(store, nodeId)?.status ?? node.status,
      beforeStatus: node.status,
      rejected,
      hint: `节点 ${nodeId} 不能进入 done：${outcome.reason ?? "原因未知"}。已驳回为 ready（释放租约 + attempts+1），修正后可立即重新领取`,
    };
  }

  const readyBefore = new Set(readySet(store));
  if (node.status === "submitted") {
    setStatus(store, nodeId, "verifying", { reason: "verify_started", notify: false });
  }
  const done = setStatus(store, nodeId, "done", {
    credential,
    reason: "evidence_ok",
    assignee: null,
    dropLease: true,
  });
  const promoted = readySet(store).filter((id) => !readyBefore.has(id));
  return {
    ok: true,
    status: done.status,
    evidence: credential.evidence,
    promoted,
    node: briefNode(done),
  };
}

/**
 * 决策：创建 / 现在就定 / 查询 三态合一（L3 确认走 `confirmL3` 语义）。
 *
 *  - `{decisionId, optionId}` → 现在就定（L2 提前 `confirmed`、L3 `confirm`、其他 `overridden`）
 *  - `{decisionId}`            → 只读查询
 *  - `{nodeId, level, question, options, ...}` → 新建
 * 顶层 `ok`：失败必须 `ok:false`（不把决策拒绝包成成功）。
 */
function decideImpl(input             )                          {
  const store = coreStore();
  const raw = (input ?? {})                           ;
  const decisionId = pickString(raw, ALIASES.decisionId);
  const optionId = pickString(raw, ALIASES.optionId);
  const defaultOptionId = pickString(raw, ALIASES.defaultOptionId);
  const timeoutSec = pickNumber(raw, ALIASES.timeoutSec);

  // 1) 已存在 → 更新（chooseNow：L3 confirm / L2 提前定 / 其他推翻）；无 optionId 则只读回显
  if (decisionId) {
    const existing = getDecision(store, decisionId);
    if (existing) {
      if (!optionId) return { ok: true, decision: existing, unchanged: true };
      try {
        const record = chooseNow(store, decisionId, optionId, {
          note: input.note ? String(input.note) : null,
        });
        return { ok: true, decision: record, updated: true };
      } catch (error) {
        return {
          ok: false,
          error: (error                     ).code ?? "decision-rejected",
          message: (error         ).message,
        };
      }
    }
  }

  // 2) 不存在 → 创建（缺必需参数时明确报错，不静默）
  const level = input?.level ? String(input.level) : undefined;
  const options = Array.isArray(input?.options)
    ? (input.options                                  ).map((o) => ({
        option_id: String(o.option_id ?? o.optionId ?? ""),
        label: o.label === undefined ? undefined : String(o.label),
      }))
    : [];
  const chosen = optionId;

  const missing           = [];
  if (!decisionId) missing.push("decisionId");
  if (!level) missing.push("level");
  if (!input?.question) missing.push("question");
  if (!options.length) missing.push("options");
  if (level === "L2") {
    if (!defaultOptionId) missing.push("defaultOptionId");
    if (timeoutSec === undefined || timeoutSec <= 0) missing.push("timeoutSec");
  }
  if ((level === "L0" || level === "L1") && !chosen) missing.push("optionId");
  if (missing.length) {
    return {
      ok: false,
      error: "decision-params-required",
      missing,
      hint: "创建决策需要 decisionId + level + question + options；L2 另需 defaultOptionId/default_option_id + timeoutSec/timeout_sec，L0/L1 需 optionId/option_id",
    };
  }

  try {
    const record = createDecision(store, {
      decisionId: decisionId          ,
      level: level         ,
      question: String(input.question),
      options,
      nodeId: (pickString(raw, ALIASES.nodeId) ?? input.nodeId ?? null)                 ,
      defaultOptionId: defaultOptionId ?? null,
      chosenOptionId: chosen ?? null,
      impact: (input.impact ? String(input.impact) : "low")         ,
      timeoutSec: timeoutSec ?? 0,
      note: input.note ? String(input.note) : null,
      now: input.now === undefined ? undefined : Number(input.now),
    });
    return { ok: true, decision: record, created: true };
  } catch (error) {
    return {
      ok: false,
      error: (error                     ).code ?? "decision-rejected",
      message: (error         ).message,
    };
  }
}

/** 推进到期 L2（超时按默认值落地）；返回 `timed_out` 的决策 id。 */
export function tickDecisions(options                   = {})                          {
  const store = coreStore();
  const timedOut = tickL2(store, options);
  return { ok: true, timedOut, decisions: listDecisions(store).map((d) => ({
    decision_id: d.decision_id,
    level: d.level,
    status: d.status,
    chosen_option_id: d.chosen_option_id,
  })) };
}

/** 工作图组成因子：`graph_plan` —— 纯校验 + 预览，**零写入**。 */
export function graphPlan(spec         )                          {
  const plan = planGraph(spec         );
  return { ...plan, dryRun: true };
}

/** 工作图组成因子：`graph_commit` —— 校验通过后落图；同一份图重复提交幂等。 */
export function graphCommit(spec         )                          {
  const store = coreStore();
  const result = commitGraph(store, spec         );
  return { ...result };
}

/** 节点上尚未落地的闸门决策（信息性；不参与 core 的 done 判定）。 */
export function nodeGates(nodeId        )                          {
  const store = coreStore();
  if (!nodeId) return { ok: false, error: "node-id-required" };
  return { ok: true, nodeId, blocking: blockingDecisions(store, nodeId) };
}

/** 导出投影数据（只返回数据，落盘由 N2 负责）。 */
export function exportProjection(outDir        )                          {
  const store = coreStore();
  const snap = snapshot(store);
  return {
    ok: true,
    outDir: outDir ?? null,
    projection: {
      generated_at: store.nowIso(),
      version: Number(store.state.meta.get("graph_version") ?? "1"),
      nodes: Object.values(snap.nodes).map(briefNode),
      edges: snap.edges,
      ready: readySet(store),
      gates: [...store.state.gates.values()].map((g) => ({ ...g })),
      decisions: listDecisions(store).map((d) => ({
        decision_id: d.decision_id,
        level: d.level,
        status: d.status,
        chosen_option_id: d.chosen_option_id,
        node_id: d.node_id,
      })),
      journal: { events: store.journal.count(), ok: store.journal.validateStream().ok },
    },
  };
}

/** 供 N2/N4 探测 core 能力。 */
export function coreCapabilities()                          {
  const implemented = [
    "graphStatus",
    "nextTask",
    "claimTask",
    "heartbeatTask",
    "exportProjection",
    "submitWish",
    "submitEvidence",
    "verifyDone",
    "decide",
    "tickDecisions",
    "nodeGates",
    "restoreCore",
    "rehydrateCore",
  ];
  const pending           = [];
  return {
    tier: "N3-core",
    implemented,
    pending,
    transitionsEnforced: true,
  };
}

// ---------------------------------------------------------------------------
// 公开入口：把「键名别名冲突」转成结构化错误（AlaisError 不冒泡到 N2）
// ---------------------------------------------------------------------------

function aliasFailure(error         )                                 {
  if (error instanceof AliasError) {
    return { ok: false, error: "alias-conflict", message: error.message, keys: error.keys };
  }
  return null;
}

export function submitWish(input           )                          {
  try {
    return submitWishImpl(input);
  } catch (error) {
    const failure = aliasFailure(error);
    if (failure) return failure;
    throw error;
  }
}

export function claimTask(input                )                          {
  try {
    return claimTaskImpl(input);
  } catch (error) {
    const failure = aliasFailure(error);
    if (failure) return failure;
    throw error;
  }
}

export function submitEvidence(input               )                          {
  try {
    return submitEvidenceImpl(input);
  } catch (error) {
    const failure = aliasFailure(error);
    if (failure) return failure;
    throw error;
  }
}

export function decide(input             )                          {
  try {
    return decideImpl(input);
  } catch (error) {
    const failure = aliasFailure(error);
    if (failure) return failure;
    throw error;
  }
}


//# sourceURL=core\facade.js