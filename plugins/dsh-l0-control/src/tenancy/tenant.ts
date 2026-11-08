/**
 * Lane S · tenant 作用域（规范化 / 兼容默认 / fail-closed 比对）。
 *
 * 兼容策略（计划 §5）：既有单团队数据没有 tenant 字段 → 一律视为 `default`；
 * journal / 快照路径对 `default` 保持原样，其它 tenant 落到 `tenants/<tenant>/` 子目录。
 *
 * 规则：
 *  - tenant 只允许 `^[a-z0-9][a-z0-9._-]{0,62}$`（小写归一；非法 → `TenantMismatch`）；
 *  - 空/缺省 → `default`（不报错，但只对「读默认租户」成立，见 `assertTenantMatch`）；
 *  - 跨租户一律拒绝（读和写都拒绝；不返回「另一个租户的空集合」冒充成功）。
 */

import { TenantMismatch } from "../security/errors.ts";

export const DEFAULT_TENANT = "default";
export const TENANT_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/** 规范化 tenant：trim + 小写；空 → default；非法 → 抛 TenantMismatch。 */
export function normalizeTenant(input: unknown, options: { allowEmpty?: boolean } = {}): string {
  if (input === null || input === undefined) {
    if (options.allowEmpty) return DEFAULT_TENANT;
    return DEFAULT_TENANT;
  }
  const raw = String(input).trim().toLowerCase();
  if (!raw) return DEFAULT_TENANT;
  if (!TENANT_RE.test(raw)) {
    throw new TenantMismatch(`tenant 标识非法：${String(input)}`, { tenant: String(input) });
  }
  return raw;
}

export function isDefaultTenant(input: unknown): boolean {
  return normalizeTenant(input) === DEFAULT_TENANT;
}

/**
 * 断言记录 tenant 与请求 tenant 一致（fail-closed）。
 * 记录缺 tenant 字段 → 视为 default（兼容），但与请求 tenant 不一致时同样拒绝。
 */
export function assertTenantMatch(
  recordTenant: unknown,
  requestTenant: unknown,
  context: { action?: string; recordId?: string } = {},
): string {
  const request = normalizeTenant(requestTenant);
  const record = normalizeTenant(recordTenant);
  if (record !== request) {
    throw new TenantMismatch(
      `跨租户访问被拒绝：record.tenant=${record} 请求 tenant=${request}${
        context.action ? `（${context.action}）` : ""
      }`,
      { recordTenant: record, requestTenant: request, ...context },
    );
  }
  return request;
}

/** 记录所属 tenant（缺字段 → default）。 */
export function tenantOf(record: Record<string, unknown> | null | undefined): string {
  if (!record || typeof record !== "object") return DEFAULT_TENANT;
  return normalizeTenant((record as Record<string, unknown>).tenant);
}

/** 给记录打 tenant 戳（写入时用；已有不同 tenant 则拒绝）。 */
export function stampTenant<T extends Record<string, unknown>>(record: T, tenant: unknown): T {
  const normalized = normalizeTenant(tenant);
  if (record && Object.prototype.hasOwnProperty.call(record, "tenant")) {
    assertTenantMatch(record.tenant, normalized, { action: "stamp" });
  }
  return { ...record, tenant: normalized };
}
