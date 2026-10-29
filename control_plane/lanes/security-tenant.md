# Lane S · security-tenant（鉴权 + 多租户）

> 预算 6 轮（已用 5，余 1）· 任务 task-27 · 计划 `designs/_research/生产化与全自主-30轮长任务.md` §3-S
> 写域：`plugins/dsh-l0-control/src/security/`、`src/tenancy/`、本 lane note。**未改** `service.ts` / entry / `core` / `state` / `lib`。
> 门禁：`node --test "src/security/tests/*.test.mjs" "src/tenancy/tests/*.test.mjs"` → **59 tests, 59 pass**。

---

## R1 · `src/security/` 身份 + 角色矩阵

| 文件 | 内容 |
|---|---|
| `errors.ts` | `SecurityError` + `Unauthenticated`(401) / `Forbidden`(403) / `UnknownAction`(400) / `TenantMismatch`(403) / `TokenInvalid`(401) / `TokenExpired`(401)；`isSecurityError`、`httpStatusFor` |
| `identity.ts` | `Principal`（id/kind/tenant/roles/slot）；`parseInstanceId`（`ROLE-<ROLE>-<NN>`）；`resolvePrincipal`（fail-closed：无 id / 未知 kind / 无角色 → `unauthenticated`）；`hasRole`、`actorRef`、`auditIndependenceConflict`（同实例 `audit_not_independent` / 同职务 `audit_same_role`） |
| `roles.ts` | 9 角色（ORCH/RESEARCH/DESIGN/CODE/AUDIT/DELIVER/OBS/PLUGIN/HUMAN）× 20 动作矩阵；`PERMISSIONS`、`isKnownAction`、`assertRoleAllowed`、`roleAllows`、`isGovernanceAction`；**未登记动作 = 拒绝**（无通配） |

治理动作：`verify_done` → AUDIT/HUMAN；`decide` → ORCH/HUMAN；`reassign` → ORCH/HUMAN（CODE/RESEARCH/DESIGN/DELIVER/OBS 全部拒绝）。

## R2 · 能力令牌 + 授权闸门

| 文件 | 内容 |
|---|---|
| `tokens.ts` | `v1.<payload>.<hmac-sha256>`；claims 自带 `sub/kind/tenant/roles/actions/iat/exp/jti`；`issueCapabilityToken`（secret ≥16、角色非空、动作必须已登记、HUMAN 需 `allowHuman`）、`verifyCapabilityToken`（结构 → `timingSafeEqual` 验签 → 过期 + skew → tenant → actions 白名单）、`decodeCapabilityToken`（仅调试，不验签） |
| `guard.ts` | `authorize(actor, action, ctx)`：身份 → 动作 → 角色 → 调用者 tenant=作用域 → `resourceTenant` → 治理标记 → 审计独立；`decide()` 不抛版；`authorizeWithAudit()` 返回 `{decision,row,error}`（拒绝路径也带 actor+tenant+code，可重抛原始 `SecurityError`）；`auditRow`、`permissionMatrix` |
| `index.ts` | 单入口 barrel，service 只需 `import ... from "./security/index.ts"` |

语义要点：**默认拒绝**（未知动作/无角色 → 拒）、**治理动作必须显式 `governance: true`**（防被普通写路径顺手带过）、**tenant 三级比对**（调用者 / 作用域 / 资源）。

## R3 · `src/tenancy/`

| 文件 | 内容 |
|---|---|
| `tenant.ts` | `DEFAULT_TENANT="default"`、`TENANT_RE`、`normalizeTenant`（空→default，非法→`tenant_mismatch`）、`assertTenantMatch`、`tenantOf`、`stampTenant` |
| `paths.ts` | `tenantPaths({stateDir,tenant,...})`：default → 原路径**逐字节兼容**；非 default → `<stateDir>/tenants/<tenant>/…`；`tenantOfPath`、`assertPathTenant`（写前后归属校验） |
| `scope.ts` | `filterInScope`（读：只返回本租户）、`assertRecordInScope`（写：跨租户 fail-closed）、`isInScope`（`strict` 时非 default 拒绝未标注记录）、`groupByTenant` |
| `export.ts` | `filterExport`（按 tenant 过滤导出集合；未知集合默认**剔除**，`keepUnknownCollections` 才保留）、`assertExportTenant` |

兼容策略遵守计划 §5：既有无 `tenant` 字段的数据视为 `default`，路径与现状一致，不破坏现有 journal/快照。

## R4 · 测试（59）

| 文件 | 例数 | 覆盖 |
|---|---:|---|
| `src/security/tests/identity.test.mjs` | 7 | 实例 ID 解析、缺身份/非法 kind/无角色、复合职务、tenant 归一与非法、actorRef、审计独立性三态 |
| `src/security/tests/roles.test.mjs` | 5 | 默认拒绝、治理动作矩阵（只给授权角色）、CODE/AUDIT 越权、矩阵自洽（无未知角色/无通配）、读写收窄 |
| `src/security/tests/tokens.test.mjs` | 9 | 签发→验签、匿名/缺角色/短密钥/非法 ttl、HUMAN 限制、未登记动作禁签、篡改 payload/签名/换密钥、过期+skew、租户不符、动作白名单、decode 边界 |
| `src/security/tests/guard.test.mjs` | 10 | 放行、默认拒绝三态、治理标记、tenant 三级、审计独立、`decide()` 不抛、审计行、`authorizeWithAudit` 返回、矩阵快照 |
| `src/security/tests/wiring.test.mjs` | 6 | 假 service 端到端：AUDIT 在 acme `verify_done` 放行；CODE 被拒**且不写业务状态**仍留审计；跨租户（actor/资源/导出）拒绝；401/400 映射；审计同实例拒绝 |
| `src/tenancy/tests/tenant.test.mjs` | 6 | 归一/默认/非法、`assertTenantMatch`、`tenantOf`、`stampTenant` 不污染入参 |
| `src/tenancy/tests/paths.test.mjs` | 6 | default 兼容、非 default 子目录、自定义文件名/tenantsRoot、缺 stateDir、路径反解、归属断言 |
| `src/tenancy/tests/scope.test.mjs` | 6 | 读过滤、`isInScope`、strict、写断言、错误带 id+action、分组 |
| `src/tenancy/tests/export.test.mjs` | 7 | 只含本租户、default 视角、未知集合剔除/保留、strict、单对象剔除、不改入参、`assertExportTenant` |
| `src/tenancy/tests/paths-smoke.test.mjs` | 3 | **真实临时 stateDir + 真文件**：default 路径逐字节兼容（老 journal 免迁移可读）、acme 落 `tenants/acme/` 且两租户文件互不覆盖、跨租户读拒绝（含 strict）、跨租户写/导出拒绝且被拒写入不落地 |

> 合共 **62 tests / 62 pass**（security 37 + tenancy 25）。命令：
> `node --test "src/security/tests/*.test.mjs" "src/tenancy/tests/*.test.mjs"`

## R5 · 接线契约 + 交付

- `src/security/WIRING.md`：主窗口/N2 接线清单（构造期 tenant 路径、每动作 `authorizeWithAudit` + 审计行、读过滤、写断言、导出过滤、错误映射、令牌模式、门禁命令），§10 给出 `config.ts` 的**精确 patch 建议**（`tenant` 默认 `default`、`tokenSecret` 默认 `''` 且非空 ≥16、`tenant` 不得来自请求体）；本 lane **未改** `config.ts`。
- 构建边界：`node scripts/build.mjs --check` 现在会报 drift（`lib/security`、`lib/tenancy` 尚未生成），**预期**；主窗口合并后跑 `node scripts/build.mjs` 归零。已用 `stripTypeScriptTypes` 逐文件验证 11 个新 `.ts` 全部可剥离（0 error，说明符正确改写为 `.js`）。


## 验收对照（task-27）

| 验收项 | 证据 |
|---|---|
| 未授权调用拒绝 | guard/roles/wiring 测试：`forbidden` / `unknown_action` / `unauthenticated` 全路径 |
| 跨租户读/写拒绝 | scope/paths/guard/wiring：`filterInScope` 永不返回他租户、`assertRecordInScope` 抛 `tenant_mismatch`、`resourceTenant` 三级比对 |
| 角色矩阵 | roles 5 例 + guard 10 例；治理动作仅 AUDIT/ORCH/HUMAN |
| tenant 兼容默认 default | tenant/paths 测试；default 路径与现状一致 |
| 审计带 actor/tenant | `auditRow` + `authorizeWithAudit`（含拒绝路径）+ wiring 断言 journal 行 `{kind:'auth',actor,tenant,decision,code}` |

## 已知缺口 / 交主窗口

1. **未接线**：`service.ts` 尚未调用本模块（按计划由主窗口/N2 在 M4 接线）；接线清单见 `WIRING.md`。
2. `lib/` 未生成 → `npm run verify` 仍报 drift，需主窗口跑 `node scripts/build.mjs`。
3. `config.tenant` / `config.tokenSecret` 需在 `config.ts` 增加两个可选字段（本 lane 未改 config.ts，属接线范围）。
4. 角色矩阵里 `PLUGIN` 目前仅 `graph.read`/`status.read`/`evidence.add`；若 service 内部还有其它动作，接线时补登记（未登记 = 拒绝，安全侧默认保守）。
