/**
 * 脱敏与数值护栏（Lane O）。
 *
 * 两条硬规则：
 *  1. **只输出可审计字段**：节点 `spec` / `title` / 愿望文本 / prompt **不进**观测投影；
 *     `meta` 里若带密钥类键，一律替换为 `[redacted]`。
 *  2. **只输出有限数**：`NaN` / `Infinity` / `undefined` 会破坏 JSON 消费方的聚合，
 *     统一在入口用 `finite()` 收敛。
 */

/** 判定「这个键是不是敏感」：只匹配密钥类，**不能**误伤 `tokensIn` / `tokens` 这类指标名。 */
const SENSITIVE_KEY =
  /(secret|password|passwd|authorization|auth[-_]?header|api[-_]?key|apikey|cookie|bearer|session[-_]?id|credential|private[-_]?key)/i;

/** 单字符串上限：长文本（可能是 prompt 片段）直接截断，避免把上下文漏进导出。 */
export const MAX_STRING = 200;

export const REDACTED = "[redacted]";

/** 收敛为有限数；非数字 → fallback（默认 0），负数按 0 处理（指标不为负）。 */
export function finite(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n < 0 ? 0 : n;
}

/** 整数护栏（用于 counts / retries）。 */
export function integer(value: unknown, fallback = 0): number {
  return Math.trunc(finite(value, fallback));
}

/** 比率护栏：0..1。 */
export function ratio(value: unknown): number {
  const n = finite(value, 0);
  return n > 1 ? 1 : n;
}

/** 时间戳：优先用注入时钟，非法值回落到 `now`。 */
export function isoAt(value: unknown, now: string): string {
  if (typeof value !== "string" || value.length === 0) return now;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return now;
  return new Date(parsed).toISOString();
}

/** 深层脱敏：对象按键过滤、数组逐项、字符串截断、数字收敛。 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return REDACTED;
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return finite(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redactValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 50);
    for (const [key, item] of entries) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(item, depth + 1);
    }
    return out;
  }
  return REDACTED;
}

/** `meta` 专用：脱敏后仍是普通对象（永不返回 null，便于消费方直接展开）。 */
export function safeMeta(meta: unknown): Record<string, unknown> {
  const redacted = redactValue(meta);
  if (!redacted || typeof redacted !== "object" || Array.isArray(redacted)) return {};
  return redacted as Record<string, unknown>;
}

/** 判断一段导出的 JSON 文本里是否还残留敏感值（测试与 `selfcheck` 共用）。 */
export const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/i,
  /"(password|secret|api[_-]?key|authorization)"\s*:\s*"(?!\[redacted\])/i,
];
