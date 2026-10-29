/**
 * 键名别名（N3-R6 补口）：core 同时接受 camelCase 与 snake_case。
 *
 * 为什么需要：N2 的入参归一化会丢 camel、core 内部读 camel，两侧一名之差就导致
 * 「evidence 全拒」（N5 已复现）。这里统一用 `pickAlias`：**两个键同时存在且值不同 → 明确报错**，
 * 不静默择一。
 */
import { ControlError } from "./errors.ts";

export class AliasError extends ControlError {
  readonly keys: string[];
  constructor(keys: string[], message: string) {
    super("alias-conflict", message);
    this.name = "AliasError";
    this.keys = keys;
  }
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * 按优先级取第一个出现的键（传入顺序优先）。
 *
 * @throws AliasError 当多个键同时有值且彼此不等（含候选数组 key 名冲突）。
 */
export function pickAlias<T = unknown>(
  source: Record<string, unknown> | undefined | null,
  names: readonly string[],
): T | undefined {
  if (!source) return undefined;
  const present: Array<[string, unknown]> = [];
  for (const name of names) {
    if (name in source && !isEmpty(source[name])) present.push([name, source[name]]);
  }
  if (!present.length) return undefined;
  const first = present[0][1];
  for (const [name, value] of present.slice(1)) {
    if (!sameValue(first, value)) {
      throw new AliasError(
        names as string[],
        `键名别名冲突：${present.map(([k]) => k).join(" / ")} 同时存在且值不同`,
      );
    }
    void name;
  }
  return first as T;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  if (typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return String(a) === String(b);
}

/** 字符串别名（保留原始大小写，只做取键）。 */
export function pickString(
  source: Record<string, unknown> | undefined | null,
  names: readonly string[],
): string | undefined {
  const value = pickAlias(source, names);
  return value === undefined ? undefined : String(value);
}

/** 数字别名（非法数值 → undefined）。 */
export function pickNumber(
  source: Record<string, unknown> | undefined | null,
  names: readonly string[],
): number | undefined {
  const value = pickAlias(source, names);
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** 对象/数组别名。 */
export function pickObject<T>(
  source: Record<string, unknown> | undefined | null,
  names: readonly string[],
): T | undefined {
  return pickAlias<T>(source, names);
}

/** 常用别名组（单一事实源，避免各处手写拼错）。 */
export const ALIASES = {
  decisionId: ["decisionId", "decision_id"],
  nodeId: ["nodeId", "node_id"],
  optionId: ["optionId", "option_id", "chosenOptionId", "chosen_option_id"],
  defaultOptionId: ["defaultOptionId", "default_option_id"],
  timeoutSec: ["timeoutSec", "timeout_sec"],
  producerInstance: ["producerInstance", "producer_instance"],
  auditorInstance: ["auditorInstance", "auditor_instance"],
  evidenceId: ["evidenceId", "evidence_id"],
  artifactId: ["artifactId", "artifact_id"],
  artifactPath: ["artifactPath", "artifact_path"],
  verifierId: ["verifierId", "verifier_id"],
  producerNode: ["producerNode", "producer_node"],
  attemptNo: ["attemptNo", "attempt_no"],
  instanceId: ["instanceId", "instance_id"],
  maxParallel: ["maxParallel", "max_parallel"],
  budgetTokens: ["budgetTokens", "budget_tokens"],
} as const;
