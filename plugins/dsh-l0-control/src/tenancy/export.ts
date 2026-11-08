/**
 * Lane S · 导出过滤（`export` / 投影 / A2A Card 共用的 tenant 边界）。
 *
 * 规则：
 *  - 导出只包含请求租户的数据；其它租户记录被剔除（不报错、不泄露数量）。
 *  - `nodes` / `edges` / `evidence` / `artifacts` / `decisions` / `events` / `journal` 等集合按记录 tenant 过滤；
 *  - 顶层导出的 `tenant` 字段写入请求租户（供下游校验）；
 *  - `strict: true` 时，任何**缺 tenant** 的记录在非 default 作用域下被剔除（fail-closed）。
 *  - 不猜测：不认识的集合原样保留**仅当** `keepUnknownCollections` 为 true（默认 false → 剔除）。
 */

import { TenantMismatch } from "../security/errors.ts";
import { normalizeTenant } from "./tenant.ts";
import { filterInScope } from "./scope.ts";

export interface ExportFilterOptions {
  tenant?: unknown;
  strict?: boolean;
  /** 不认识的集合是否保留（默认 false：默认拒绝，宁缺勿泄）。 */
  keepUnknownCollections?: boolean;
  /** 需要处理的对象集合字段名（默认见下）。 */
  collectionKeys?: string[];
}

export const DEFAULT_COLLECTION_KEYS = [
  "nodes",
  "edges",
  "evidence",
  "artifacts",
  "decisions",
  "events",
  "journal",
  "tasks",
  "ledger",
  "stage_gates",
  "replan_events",
  "instances",
];

/** 过滤一份导出载荷（纯函数，不修改入参）。 */
export function filterExport<T extends Record<string, unknown>>(
  payload: T,
  options: ExportFilterOptions = {},
): Record<string, unknown> {
  const tenant = normalizeTenant(options.tenant);
  const strict = options.strict ?? false;
  const keys = options.collectionKeys ?? DEFAULT_COLLECTION_KEYS;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload ?? {})) {
    if (Array.isArray(value)) {
      if (keys.includes(key)) {
        out[key] = filterInScope(value as Record<string, unknown>[], tenant, { strict });
      } else if (options.keepUnknownCollections) {
        out[key] = value;
      }
      // 默认：未知数组集合被剔除（默认拒绝）
      continue;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      // 单对象：带 tenant 就按 tenant 过滤，否则视为共享元数据（如 config）原样保留
      if (Object.prototype.hasOwnProperty.call(record, "tenant")) {
        if (!filterInScope([record], tenant, { strict }).length) continue;
      }
      out[key] = value;
      continue;
    }
    out[key] = value;
  }

  out.tenant = tenant;
  return out;
}

/** 断言导出载荷属于该租户（已带 tenant 且不一致 → 拒绝；无 tenant → 打戳）。 */
export function assertExportTenant(
  payload: Record<string, unknown> | null | undefined,
  tenant: unknown,
): string {
  const scope = normalizeTenant(tenant);
  if (!payload || typeof payload !== "object") {
    throw new TypeError("assertExportTenant 需要导出载荷对象");
  }
  if (!Object.prototype.hasOwnProperty.call(payload, "tenant")) return scope;
  const declared = normalizeTenant(payload.tenant);
  if (declared !== scope) {
    throw new TenantMismatch(`导出载荷租户不符：payload=${declared} 期望=${scope}`, {
      payloadTenant: declared,
      expectedTenant: scope,
    });
  }
  return scope;
}
