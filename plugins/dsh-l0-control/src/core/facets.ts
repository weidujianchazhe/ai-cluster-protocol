/**
 * 多视角抽象（facets）。
 *
 * 结构不是树：**同一批节点被多个正交视角各读一遍**，产生互不相同的摘要。
 * 一个节点会同时出现在多个视角里（交叉是特征，不是缺陷）。
 *
 * 两类视角，代价完全不同：
 *   static  —— pick 是可判定的谓词，一次遍历，纯内存
 *   dynamic —— 无法用谓词表达，需要读**其他视角的摘要**再判断（不允许读原文）
 *
 * 动态视角的输入永远是摘要，不是原文。这条保证了成本随视角数增长，
 * 不随节点数增长。
 */
import type { NodeDigest } from "./digest.ts";

export type FacetKind = "static" | "dynamic";

export interface FacetDigest {
  facetId: string;
  /** 参与本视角的节点数 */
  matched: number;
  /** 结构化计数：各视角自己定义 */
  counts: Record<string, number>;
  /** 值得注意的点（已压缩，不含原文） */
  notes: string[];
  /** 本视角覆盖到的 nodeId，供冲突定位 */
  nodes: string[];
}

export interface Facet {
  id: string;
  title: string;
  kind: FacetKind;
  /** 本视角关心什么 / 忽略什么，供人阅读与冲突说明引用 */
  question: string;
  /** static：筛选参与节点 */
  pick?: (d: NodeDigest) => boolean;
  /** static：对参与节点做压缩（只读入参，实现方不得改动原数组） */
  digest?: (all: readonly NodeDigest[], picked: NodeDigest[]) => FacetDigest;
  /** dynamic：读其他视角的摘要后判断（不读原文） */
  judge?: (input: { goal: string; digests: FacetDigest[] }) => FacetDigest;
}

// ── static 视角 ────────────────────────────────────────────────

const orgFacet: Facet = {
  id: "org",
  title: "组织",
  kind: "static",
  question: "谁在做、谁依赖谁、有没有人同时挂多个节点",
  pick: () => true,
  digest: (all, picked) => {
    const byAssignee = new Map<string, number>();
    let unassigned = 0;
    for (const d of picked) {
      const key = d.org.assignee ?? "(未分配)";
      byAssignee.set(key, (byAssignee.get(key) ?? 0) + 1);
      if (!d.org.assignee) unassigned += 1;
    }
    const counts: Record<string, number> = {};
    for (const [k, v] of byAssignee) counts[k] = v;
    const overloaded = [...byAssignee.entries()].filter(([, n]) => n >= 3).map(([k, n]) => `${k} 承担 ${n} 个节点`);
    return {
      facetId: "org",
      matched: picked.length,
      counts,
      notes: [
        ...(unassigned ? [`${unassigned} 个节点未分配`] : []),
        ...overloaded,
      ],
      nodes: picked.map((d) => d.nodeId),
    };
  },
};

const capabilityFacet: Facet = {
  id: "capability",
  title: "能力",
  kind: "static",
  question: "各类工作分别有多少、是否失衡",
  pick: () => true,
  digest: (all, picked) => {
    const counts: Record<string, number> = {};
    for (const d of picked) {
      const key = d.capability ?? "(无标签)";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    const notes: string[] = [];
    if (counts["(无标签)"]) notes.push(`${counts["(无标签)"]} 个节点没有能力标签，无法按能力路由`);
    const auditish = Object.entries(counts)
      .filter(([k]) => k.startsWith("AUDIT"))
      .reduce((s, [, n]) => s + n, 0);
    if (picked.length >= 8 && auditish === 0) notes.push("节点数 ≥8 但没有审计类节点，产出无人独立复核");
    return { facetId: "capability", matched: picked.length, counts, notes, nodes: picked.map((d) => d.nodeId) };
  },
};

const evidenceFacet: Facet = {
  id: "evidence",
  title: "证据可靠度",
  kind: "static",
  question: "多少节点声明了证据要求、多少有验证器、多少缺其一",
  pick: (d) => d.evidence.required.length > 0 || d.evidence.verifiers.length > 0,
  digest: (all, picked) => {
    let both = 0;
    let noVerifier = 0;
    let noRequired = 0;
    for (const d of picked) {
      const hasReq = d.evidence.required.length > 0;
      const hasVer = d.evidence.verifiers.length > 0;
      if (hasReq && hasVer) both += 1;
      else if (hasReq && !hasVer) noVerifier += 1;
      else if (!hasReq && hasVer) noRequired += 1;
    }
    const unconditional = all.length - picked.length;
    return {
      facetId: "evidence",
      matched: picked.length,
      counts: { both, noVerifier, noRequired, unconditional },
      notes: [
        ...(noVerifier ? [`${noVerifier} 个节点要求证据但没有验证器白名单`] : []),
        ...(unconditional ? [`${unconditional} 个节点完全没有证据要求`] : []),
      ],
      nodes: picked.map((d) => d.nodeId),
    };
  },
};

const costFacet: Facet = {
  id: "cost",
  title: "成本",
  kind: "static",
  question: "预算声明分布、是否有节点声明了却没接入计量",
  pick: (d) => d.cost.maxTokens > 0,
  digest: (all, picked) => {
    const total = picked.reduce((s, d) => s + d.cost.maxTokens, 0);
    return {
      facetId: "cost",
      matched: picked.length,
      counts: { declared: picked.length, undeclared: all.length - picked.length, totalMaxTokens: total },
      notes: [
        ...(picked.length ? [`${picked.length} 个节点声明预算，合计 ${total} tokens（声明值，非实测）`] : []),
        ...(all.length - picked.length ? [`${all.length - picked.length} 个节点未声明预算`] : []),
      ],
      nodes: picked.map((d) => d.nodeId),
    };
  },
};

const riskFacet: Facet = {
  id: "risk",
  title: "风险",
  kind: "static",
  question: "反复失败的节点、卡在非终态太久的节点",
  pick: (d) => d.risk.attempts > 0 || (d.status !== "done" && d.status !== "accepted"),
  digest: (all, picked) => {
    const retried = picked.filter((d) => d.risk.attempts >= 2);
    const stuck = picked.filter((d) => ["claimed", "running", "submitted", "verifying"].includes(d.status));
    return {
      facetId: "risk",
      matched: picked.length,
      counts: { retried: retried.length, stuck: stuck.length },
      notes: [
        ...retried.map((d) => `${d.nodeId} 已尝试 ${d.risk.attempts} 次`),
        ...(stuck.length >= 3 ? [`${stuck.length} 个节点停在非终态`] : []),
      ],
      nodes: picked.map((d) => d.nodeId),
    };
  },
};

// ── dynamic 视角（读摘要，不读原文）──────────────────────────

const goalDriftFacet: Facet = {
  id: "goal-drift",
  title: "目标偏离",
  kind: "dynamic",
  question: "现在在做的事，还是原目标要的吗",
  judge: ({ goal, digests }) => {
    const notes: string[] = [];
    // 只做结构性判断：不猜语义，只报"能看出不对"的形态
    const cap = digests.find((d) => d.facetId === "capability");
    const ev = digests.find((d) => d.facetId === "evidence");
    const risk = digests.find((d) => d.facetId === "risk");
    if (!goal.trim()) notes.push("未声明原目标，无法判断是否偏离");
    if (cap && cap.counts["(无标签)"] > cap.matched * 0.5) {
      notes.push("过半节点无能力标签：无法确认它们服务于目标");
    }
    if (ev && ev.counts.unconditional > 0) {
      notes.push(`${ev.counts.unconditional} 个节点无任何证据要求：完成与否不可核验`);
    }
    if (risk && risk.counts.retried >= 2) {
      notes.push(`${risk.counts.retried} 个节点反复失败：可能是目标定义本身有问题`);
    }
    return {
      facetId: "goal-drift",
      matched: digests.reduce((s, d) => s + d.matched, 0),
      counts: { signals: notes.length },
      notes: notes.length ? notes : ["结构性检查未发现偏离信号（语义层面需人或其他 agent 判断）"],
      nodes: [],
    };
  },
};

const usabilityFacet: Facet = {
  id: "usability",
  title: "实用",
  kind: "dynamic",
  question: "技术上没问题，但用起来顺不顺",
  judge: ({ goal, digests }) => {
    const notes: string[] = [
      "本视角无法由静态摘要自动判定：需要真实使用或扮演用户",
    ];
    const hasDeliver = digests.some((d) => d.facetId === "capability" && (d.counts["DELIVER"] ?? 0) > 0);
    if (!hasDeliver) notes.push("图中没有交付/验收类节点：实用判断无挂载点");
    return {
      facetId: "usability",
      matched: 0,
      counts: { signals: notes.length },
      notes,
      nodes: [],
    };
  },
};

export const BUILTIN_FACETS: readonly Facet[] = [
  orgFacet,
  capabilityFacet,
  evidenceFacet,
  costFacet,
  riskFacet,
  goalDriftFacet,
  usabilityFacet,
];

export interface FacetRunResult {
  goal: string;
  static: FacetDigest[];
  dynamic: FacetDigest[];
  /** 摘要总量（字符），用于成本核算 */
  digestChars: number;
}

/**
 * 跑一遍所有视角。
 *
 * static 先跑（一次遍历），dynamic 后跑（只读 static 的摘要）。
 */
export function runFacets(nodes: readonly NodeDigest[], goal: string, facets: readonly Facet[] = BUILTIN_FACETS): FacetRunResult {
  const staticFacets = facets.filter((f) => f.kind === "static" && f.pick && f.digest);
  const dynamicFacets = facets.filter((f) => f.kind === "dynamic" && f.judge);

  const staticOut: FacetDigest[] = [];
  for (const f of staticFacets) {
    const picked = nodes.filter((d) => f.pick!(d));
    staticOut.push(f.digest!(nodes, picked));
  }

  const dynamicOut: FacetDigest[] = [];
  for (const f of dynamicFacets) {
    dynamicOut.push(f.judge!({ goal, digests: staticOut }));
  }

  const digestChars = [...staticOut, ...dynamicOut].reduce(
    (s, d) => s + JSON.stringify(d).length,
    0,
  );
  return { goal, static: staticOut, dynamic: dynamicOut, digestChars };
}
