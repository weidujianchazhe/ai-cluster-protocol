/**
 * 组成因子巡检（factor guards）。
 *
 * 设计原则：**巡检项从节点的组成因子派生，不写死检查清单。**
 * 每个 guard 声明它盯的是哪个因子（`factor`）；将来给 NodeRecord 加一个新因子，
 * 只需要再写一条 guard 注册进来，循环与报告层无需改动。
 *
 * 这一层只做「判据」——不派活、不改状态、不调用工具。
 * 谁来消费这些 findings（集群内循环 / 外部巡检 / 人工）由上层决定。
 */
import type { NodeRecord } from "./types.ts";
import type { Store } from "./store.ts";
import { currentLease } from "./leases.ts";
import { gateAllowsDone } from "./stages.ts";

export type GuardSeverity = "info" | "warn" | "critical";

export interface GuardFinding {
  /** 组成因子名（与 NodeRecord 字段同名，便于对齐与扩展） */
  factor: string;
  /** 稳定的检查 ID，用于测试与去重 */
  check: string;
  nodeId: string;
  severity: GuardSeverity;
  message: string;
  /** 机器可读的上下文（阈值、实测值等） */
  detail: Record<string, unknown>;
}

export interface GuardContext {
  store: Store;
  /** 当前时刻（毫秒），注入以便测试 */
  nowMs: number;
  /** 租约心跳超过这个毫秒数视为停滞；缺省 15 分钟 */
  stalledAfterMs?: number;
  /** attempts 达到这个值视为反复失败；缺省 3 */
  maxAttempts?: number;
}

export interface FactorGuard {
  /** 盯哪个组成因子（NodeRecord 字段名） */
  factor: string;
  /** 稳定 ID */
  check: string;
  /** 只看这些状态（缺省：所有非终态） */
  appliesTo?: readonly NodeRecord["status"][];
  /** 返回 null 表示无问题 */
  evaluate: (node: NodeRecord, ctx: GuardContext) => Omit<GuardFinding, "factor" | "check" | "nodeId"> | null;
}

const TERMINAL: ReadonlyArray<NodeRecord["status"]> = ["done", "accepted"];

/** 非终态节点 = 还在流程里的节点，巡检默认只看它们。 */
function isActive(node: NodeRecord): boolean {
  return !TERMINAL.includes(node.status);
}

/**
 * 内置 guard 表。新增组成因子时，往这里加一条即可。
 */
export const FACTOR_GUARDS: readonly FactorGuard[] = [
  // ── status：停滞检测（官方 Watchdog 的核心判据，此前我们缺这一条）──
  {
    factor: "status",
    check: "stalled",
    appliesTo: ["claimed", "running"],
    evaluate: (node, ctx) => {
      const lease = currentLease(ctx.store, node.node_id);
      if (!lease) return null; // 无租约的停滞由 lease.orphan 负责
      const stalledAfter = ctx.stalledAfterMs ?? 15 * 60 * 1000;
      const idle = ctx.nowMs - lease.heartbeat_at;
      if (idle <= stalledAfter) return null;
      return {
        severity: idle > stalledAfter * 2 ? "critical" : "warn",
        message: `节点 ${node.node_id} 处于 ${node.status}（持有者 ${lease.owner}），但租约心跳已停滞 ${Math.round(idle / 60000)} 分钟`,
        detail: { idleMs: idle, thresholdMs: stalledAfter, owner: lease.owner, fencingToken: lease.fencing_token },
      };
    },
  },

  // ── deps：依赖未完成却已在执行 ──
  {
    factor: "deps",
    check: "unsatisfied-while-active",
    appliesTo: ["ready", "claimed", "running", "submitted", "verifying"],
    evaluate: (node, ctx) => {
      const undone = node.deps.filter((dep) => {
        const depNode = ctx.store.state.nodes.get(dep);
        return !depNode || depNode.status !== "done";
      });
      if (undone.length === 0) return null;
      return {
        severity: "critical",
        message: `节点 ${node.node_id} 处于 ${node.status}，但依赖未完成：${undone.join(", ")}`,
        detail: { undone },
      };
    },
  },

  // ── evidence_required：声明为空意味着节点无法被验收 ──
  {
    factor: "evidence_required",
    check: "empty",
    evaluate: (node, ctx) => {
      if (node.evidence_required.length > 0) return null;
      // 有 stage 的节点必然要过闸门，没有证据类型就无法铸造凭证
      if (!node.stage) return null;
      return {
        severity: "warn",
        message: `节点 ${node.node_id} 有阶段 ${node.stage} 但未声明必需证据类型，将无法铸造完成凭证`,
        detail: { stage: node.stage },
      };
    },
  },

  // ── verifier_ids：有证据要求却没有验证器白名单 ──
  {
    factor: "verifier_ids",
    check: "empty-with-evidence",
    evaluate: (node, ctx) => {
      if (node.verifier_ids.length > 0) return null;
      if (node.evidence_required.length === 0) return null;
      return {
        severity: "warn",
        message: `节点 ${node.node_id} 要求证据 ${node.evidence_required.join(",")} 但未声明 verifierIds，验证器白名单将无从校验`,
        detail: { evidenceRequired: node.evidence_required },
      };
    },
  },

  // ── attempts：反复失败，可能是任务本身不可完成 ──
  {
    factor: "attempts",
    check: "exceeded",
    evaluate: (node, ctx) => {
      const limit = ctx.maxAttempts ?? 3;
      if (node.attempts < limit) return null;
      return {
        severity: node.attempts >= limit * 2 ? "critical" : "warn",
        message: `节点 ${node.node_id} 已尝试 ${node.attempts} 次仍未完成，可能是任务定义或验收条件有问题`,
        detail: { attempts: node.attempts, threshold: limit },
      };
    },
  },

  // ── assignee ⇄ lease：两者必须同进同出 ──
  {
    factor: "assignee",
    check: "lease-mismatch",
    evaluate: (node, ctx) => {
      const lease = currentLease(ctx.store, node.node_id);
      const hasAssignee = Boolean(node.assignee);
      const hasLease = Boolean(lease);
      if (hasAssignee === hasLease) {
        // 都在：再校验是否同一个持有者
        if (hasAssignee && hasLease && lease && node.assignee !== lease.owner) {
          return {
            severity: "warn",
            message: `节点 ${node.node_id} 的 assignee(${node.assignee}) 与租约持有者(${lease.owner}) 不一致`,
            detail: { assignee: node.assignee, owner: lease.owner },
          };
        }
        return null;
      }
      if (hasAssignee && !hasLease) {
        return {
          severity: "warn",
          message: `节点 ${node.node_id} 有 assignee(${node.assignee}) 但没有租约，无法判断是否真的有人在执行`,
          detail: { assignee: node.assignee },
        };
      }
      return {
        severity: "info",
        message: `节点 ${node.node_id} 持有租约(${lease?.owner}) 但 assignee 为空，状态与租约可能不同步`,
        detail: { owner: lease?.owner },
      };
    },
  },

  // ── stage：闸门未过却已进入 submitted，说明有人在绕过闸门 ──
  {
    factor: "stage",
    check: "gate-not-passed",
    appliesTo: ["submitted", "verifying"],
    evaluate: (node, ctx) => {
      if (!node.stage) return null;
      if (gateAllowsDone(ctx.store, node.stage)) return null;
      return {
        severity: "warn",
        message: `节点 ${node.node_id} 处于 ${node.status}，但阶段闸门 ${node.stage} 未通过`,
        detail: { stage: node.stage },
      };
    },
  },

  // ── budget：声明了预算但未消费（预留扩展点，meter 接入后启用）──
  {
    factor: "budget",
    check: "declared-but-unmetered",
    evaluate: (node, ctx) => {
      const maxTokens = Number((node.budget as Record<string, unknown>)?.maxTokens ?? 0);
      if (!Number.isFinite(maxTokens) || maxTokens <= 0) return null;
      return {
        severity: "info",
        message: `节点 ${node.node_id} 声明了 maxTokens=${maxTokens}，但当前观测未接入 per-node 计量，无法校验是否超支`,
        detail: { maxTokens },
      };
    },
  },
];

export interface GuardReport {
  checked: number;
  findings: GuardFinding[];
  bySeverity: { critical: number; warn: number; info: number };
}

/**
 * 对工作图跑一遍因子巡检。
 *
 * 只读：不写 journal、不改状态、不调用任何工具。
 */
export function runFactorGuards(ctx: GuardContext): GuardReport {
  const findings: GuardFinding[] = [];
  let checked = 0;
  for (const node of ctx.store.state.nodes.values()) {
    if (!isActive(node)) continue;
    checked += 1;
    for (const guard of FACTOR_GUARDS) {
      if (guard.appliesTo && !guard.appliesTo.includes(node.status)) continue;
      let finding: Omit<GuardFinding, "factor" | "check" | "nodeId"> | null = null;
      try {
        finding = guard.evaluate(node, ctx);
      } catch {
        finding = {
          severity: "warn",
          message: `guard ${guard.factor}/${guard.check} 在节点 ${node.node_id} 上抛错，已跳过`,
          detail: {},
        };
      }
      if (finding) findings.push({ factor: guard.factor, check: guard.check, nodeId: node.node_id, ...finding });
    }
  }
  const bySeverity = { critical: 0, warn: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity] += 1;
  // critical 优先，同级按因子名稳定排序，便于比对
  findings.sort(
    (a, b) =>
      ({ critical: 0, warn: 1, info: 2 }[a.severity] - { critical: 0, warn: 1, info: 2 }[b.severity]) ||
      a.factor.localeCompare(b.factor) ||
      a.nodeId.localeCompare(b.nodeId),
  );
  return { checked, findings, bySeverity };
}
