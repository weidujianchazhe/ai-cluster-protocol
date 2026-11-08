/**
 * Lane S · tenant 路径（journal / 快照 / core-state 的落点）。
 *
 * 兼容策略（计划 §5：先加兼容层，不破坏现有数据）：
 *  - `default` 租户 → 与现状完全一致（`<stateDir>/journal.jsonl` 等）；
 *  - 非 `default` → `<stateDir>/tenants/<tenant>/journal.jsonl`；
 *  - 目录分隔符统一走 `node:path`，Windows/Linux 一致。
 *
 * 本模块只算路径，不做 IO；service 接线时用它替换 `path.join(stateDir, config.journalFile)`。
 */

import path from "node:path";

import { TenantMismatch } from "../security/errors.js";
import { DEFAULT_TENANT, normalizeTenant } from "./tenant.js";

                                  
                   
                   
                       
                        
                          
                                  
                       
 

                              
                 
                     
                   
                      
                       
                         
 

/** 计算某租户的状态落点（纯函数）。 */
export function tenantPaths(input                 )              {
  if (typeof input?.stateDir !== "string" || !input.stateDir.trim()) {
    throw new TypeError("tenantPaths 需要 stateDir");
  }
  const tenant = normalizeTenant(input.tenant ?? DEFAULT_TENANT);
  const isDefault = tenant === DEFAULT_TENANT;
  const base = path.resolve(input.stateDir);
  const root = isDefault ? base : path.join(base, input.tenantsRoot ?? "tenants", tenant);
  return {
    tenant,
    isDefault,
    stateDir: root,
    journalPath: path.join(root, input.journalFile ?? "journal.jsonl"),
    snapshotPath: path.join(root, input.snapshotFile ?? "snapshot.json"),
    persistenceDir: path.join(root, input.persistenceDir ?? "core-state"),
  };
}

/** 解析路径实际所属租户（供读取时校验；非 tenants/<id>/ 形态 → default）。 */
export function tenantOfPath(
  filePath        ,
  options                                            ,
)         {
  const base = path.resolve(options.stateDir);
  const target = path.resolve(filePath);
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return DEFAULT_TENANT;
  }
  const parts = relative.split(path.sep);
  const root = options.tenantsRoot ?? "tenants";
  if (parts.length >= 3 && parts[0] === root) {
    try {
      return normalizeTenant(parts[1]);
    } catch {
      return DEFAULT_TENANT;
    }
  }
  return DEFAULT_TENANT;
}

/**
 * 断言路径属于该租户（写前校验，fail-closed）。
 * 返回规范化 tenant；路径落在别的租户目录 → 抛 `tenant_mismatch`。
 */
export function assertPathTenant(
  filePath        ,
  tenant         ,
  options                                            ,
)         {
  const expected = normalizeTenant(tenant);
  const actual = tenantOfPath(filePath, options);
  if (actual !== expected) {
    throw new TenantMismatch(
      `路径租户不匹配：path=${filePath} 实际=${actual} 期望=${expected}`,
      { path: filePath, actualTenant: actual, expectedTenant: expected },
    );
  }
  return expected;
}


//# sourceURL=tenancy\paths.js