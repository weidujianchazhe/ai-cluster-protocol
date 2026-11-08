/**
 * Lane S · tenant 作用域过滤（读 / 写 / journal / 导出共用）。
 *
 * 规则：
 *  - **读**：只返回本租户记录；其它租户的记录被过滤掉（不报错、不泄露存在性）。
 *  - **写**：目标记录 tenant 不符 → `TenantMismatch`（fail-closed，不静默改成自己的租户）。
 *  - 记录缺 `tenant` 字段 → 视为 `default`（兼容既有数据）。
 *  - `strict: true` 时，缺 `tenant` 字段的记录在非 default 作用域下**拒绝**（防止未标注数据越界）。
 */

import { TenantMismatch } from "../security/errors.js";
import { DEFAULT_TENANT, normalizeTenant, tenantOf } from "./tenant.js";

                               
                                                                   
                   
                                                        
                   
                       
                  
 

function recordId(record                         , idField         )         {
  if (idField && typeof record[idField] === "string") return String(record[idField]);
  for (const key of ["id", "node_id", "evidence_id", "artifact_id", "decision_id", "event_id", "seq"]) {
    if (record[key] !== undefined) return String(record[key]);
  }
  return "(unknown)";
}

function hasTenantField(record                         )          {
  return Object.prototype.hasOwnProperty.call(record, "tenant") && record.tenant !== undefined;
}

/** 记录是否属于该作用域（不抛；写路径请用 `assertRecordInScope`）。 */
export function isInScope(
  record                                            ,
  tenant         ,
  options               = {},
)          {
  const scope = normalizeTenant(tenant);
  if (!record || typeof record !== "object") return false;
  if (options.strict && scope !== DEFAULT_TENANT && !hasTenantField(record)) return false;
  return tenantOf(record) === scope;
}

/** 读过滤：保留本租户记录，保持原顺序。 */
export function filterInScope                                   (
  records                        ,
  tenant         ,
  options               = {},
)      {
  if (!Array.isArray(records)) return [];
  const scope = normalizeTenant(tenant);
  return records.filter((record) => isInScope(record, scope, options));
}

/** 写前断言：记录必须属于该作用域，否则 fail-closed。 */
export function assertRecordInScope(
  record                                            ,
  tenant         ,
  options               = {},
)         {
  const scope = normalizeTenant(tenant);
  if (!record || typeof record !== "object") {
    throw new TenantMismatch("写入目标记录缺失，无法判定租户", { scope, action: options.action });
  }
  if (options.strict && scope !== DEFAULT_TENANT && !hasTenantField(record)) {
    throw new TenantMismatch(
      `记录未标注 tenant，strict 作用域拒绝：${recordId(record, options.idField)}`,
      { scope, recordId: recordId(record, options.idField), action: options.action, reason: "unlabeled" },
    );
  }
  const recordTenant = tenantOf(record);
  if (recordTenant !== scope) {
    throw new TenantMismatch(
      `跨租户写入被拒绝：record.tenant=${recordTenant} scope=${scope}（${recordId(record, options.idField)}）`,
      {
        scope,
        recordTenant,
        recordId: recordId(record, options.idField),
        action: options.action,
      },
    );
  }
  return scope;
}

/** 批量读：按 tenant 分组（导出/统计用；不会跨租户合并成一份视图）。 */
export function groupByTenant                                   (
  records                        ,
)                      {
  const out                      = {};
  for (const record of Array.isArray(records) ? records : []) {
    const tenant = tenantOf(record);
    if (!out[tenant]) out[tenant] = [];
    out[tenant].push(record);
  }
  return out;
}


//# sourceURL=tenancy\scope.js