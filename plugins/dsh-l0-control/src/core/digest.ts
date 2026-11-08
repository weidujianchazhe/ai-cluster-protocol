/**
 * 节点摘要（NodeDigest）——多视角抽象的地基。
 *
 * 核心约束：**摘要里不含原文**。
 * 一旦摘要保留对话或 spec 全文，所有视角都会去读它，成本就回到"汇聚全部上下文"。
 * 摘要是索引 + 计数 + 指针，不是内容副本。
 *
 * 另一个约束：摘要要能支撑**交叉**。
 * 同一个节点会同时出现在多个视角里（组织、能力、需求、证据、成本、实用），
 * 所以 digest 必须把各视角关心的字段平铺出来，而不是只保留一种组织方式。
 */
import type { NodeRecord } from "./types.ts";

export interface NodeDigest {
  nodeId: string;
  title: string;
  /** 能力标签：既是"谁来做"，也是"属于哪个视角" */
  capability: string | null;
  stage: string | null;
  status: string;
  /** 组织维度：谁在做、依赖谁 */
  org: { assignee: string | null; deps: string[] };
  /** 需求维度：对应哪些需求项（NodeRecord 暂无此字段，留空数组占位） */
  requirements: string[];
  /** 证据维度：三类证据的计数 */
  evidence: { required: string[]; verifiers: string[] };
  /** 成本维度：声明预算（真实消耗需接 meter） */
  cost: { maxTokens: number };
  /** 风险维度：尝试次数、停滞信号（由 guards 补充） */
  risk: { attempts: number; updatedAt: string };
}

/**
 * 从 NodeRecord 生成摘要。
 *
 * 刻意丢弃：`spec`（可能很长且含原文）、`created_at`（对判断无用）。
 */
export function toDigest(node: NodeRecord): NodeDigest {
  const budget = node.budget as Record<string, unknown> | undefined;
  const maxTokens = Number(budget?.maxTokens ?? 0);
  return {
    nodeId: node.node_id,
    title: node.title,
    capability: node.capability ?? null,
    stage: node.stage ?? null,
    status: node.status,
    org: { assignee: node.assignee ?? null, deps: [...node.deps] },
    requirements: [], // 待 NodeRecord 增加 requirementRefs
    evidence: {
      required: [...node.evidence_required],
      verifiers: [...node.verifier_ids],
    },
    cost: { maxTokens: Number.isFinite(maxTokens) ? maxTokens : 0 },
    risk: { attempts: node.attempts, updatedAt: node.updated_at },
  };
}

/** 批量生成。 */
export function digestAll(nodes: readonly NodeRecord[]): NodeDigest[] {
  return nodes.map(toDigest);
}

/** 摘要的字符量估算——用于成本核算，不含任何原文。 */
export function digestSize(d: NodeDigest): number {
  // 粗估：标题 + 标签 + 依赖名 + 计数
  return (
    d.nodeId.length +
    d.title.length +
    (d.capability?.length ?? 0) +
    (d.org.assignee?.length ?? 0) +
    d.org.deps.join("").length +
    d.evidence.required.join("").length +
    d.evidence.verifiers.join("").length +
    120 // 其余结构化字段的固定开销
  );
}
