# `src/security` + `src/tenancy` 接线契约（Lane S 交付，主窗口/N2 执行）

> 本 lane **不改** `service.ts` / `entry` / `core` / `state`。下面是接线时唯一需要改的几处，
> 全部是「加一行调用」，失败一律 fail-closed。

## 0. 导入

```ts
import {
  authorizeWithAudit, authorize, decide, httpStatusFor, isSecurityError,
  permissionMatrix, verifyCapabilityToken, isGovernanceAction,
} from "./security/index.ts";
import {
  tenantPaths, normalizeTenant, filterInScope, assertRecordInScope,
  filterExport, assertExportTenant,
} from "./tenancy/index.ts";
```

## 1. 构造期：tenant 决定状态落点（默认租户零改动）

```ts
// service.ts constructor 里替换原来的 path.join(stateDir, config.journalFile)
const paths = tenantPaths({
  stateDir: this.stateDir,
  tenant: normalizeTenant(this.config.tenant ?? "default"),   // 缺省 = default
  journalFile: this.config.journalFile,
  snapshotFile: this.config.snapshotFile,
  persistenceDir: this.config.persistenceDir,
});
this.tenant = paths.tenant;
this.stateDir = paths.stateDir;
this.journalPath = paths.journalPath;
this.snapshotPath = paths.snapshotPath;
```

- `default` 租户：路径与现状**逐字节一致**（`<stateDir>/journal.jsonl`），既有数据不用迁移。
- 非 default：`<stateDir>/tenants/<tenant>/journal.jsonl`。

## 2. 每个工具动作前：授权 + 审计（唯一入口）

```ts
const { decision, row } = authorizeWithAudit(actorInput, action, {
  tenant: this.tenant,
  resourceTenant: /* 目标节点/记录 tenant，能拿到就给 */ undefined,
  governance: isGovernanceAction(action),      // verify_done / decide / reassign 必须 true
  requireAuditIndependence: action === "verify_done",
  producerInstance: evidenceRecord?.producer_instance,
  auditorInstance: actorInput?.id,
});
this.appendJournal("auth", row);               // 允许/拒绝都留痕（actor + tenant + code）
if (!decision) {
  const error = new Error(row.message) as any;
  error.code = row.code;
  throw error;                                 // 映射见 §6
}
```

动作名（与 `roles.ts` 的 `PERMISSIONS` 一一对应，**未登记即拒**）：
`wish.create` · `graph.read` · `graph.write` · `task.next` · `task.claim` · `task.heartbeat` ·
`task.submit` · `evidence.add` · `gate.pass` · `verify_done` · `decide` · `reassign` ·
`team.spawn` · `team.message` · `terminate` · `resume` · `replan` · `status.read` · `journal.read` · `export`

治理动作矩阵（**只给授权角色**）：

| 动作 | 允许角色 |
|---|---|
| `verify_done` | `AUDIT` · `HUMAN` |
| `decide` | `ORCH` · `HUMAN` |
| `reassign` | `ORCH` · `HUMAN` |

## 3. 读路径：按租户过滤

```ts
const rows = filterInScope(this.readJournal(), this.tenant);       // journal 行
const nodes = filterInScope(Object.values(snapshot.nodes), this.tenant);
// strict 模式（生产建议开）：非 default 租户下，未标注 tenant 的旧记录被剔除
filterInScope(rows, this.tenant, { strict: true });
```

## 4. 写路径：写前断言（fail-closed）

```ts
assertRecordInScope(nodeRecord, this.tenant, { action: "graph.write" });
// 跨租户 → 抛 tenant_mismatch；strict + 未标注 → 同样拒绝
```

## 5. 导出：过滤 + 打戳

```ts
const payload = filterExport(rawExport, { tenant: this.tenant });
assertExportTenant(payload, this.tenant);      // 防御：调用方别把别的租户载荷传进来
```

## 6. 错误映射（service 出口）

```ts
if (isSecurityError(error)) {
  return { ok: false, code: error.code, status: httpStatusFor(error.code), message: error.message };
}
```

- `unauthenticated` → 401 · `forbidden` / `tenant_mismatch` → 403 · `unknown_action` → 400 ·
  `token_invalid` / `token_expired` → 401。
- **先授权后写**：任何 journal/状态写入都必须发生在 `authorize` 之后（拒绝路径只写 `auth` 审计行）。

## 7. 令牌模式（可选，A2A / 外部调用）

```ts
const principal = verifyCapabilityToken(headerToken, {
  secret: this.config.tokenSecret,     // 必须 ≥16 字符
  tenant: this.tenant,                 // 令牌 tenant 不符 → tenant_mismatch
  action,                              // 令牌 actions 白名单与角色矩阵同步校验
});
```

- 令牌自带 `roles` / `tenant` / `exp`；`HUMAN` 角色默认不能被令牌携带（`allowHuman` 才放开）。
- 未配 `tokenSecret` 时不启用令牌模式，走 §2 的 `actor` 字段。

## 8. 自检与观测

```ts
permissionMatrix();  // 角色矩阵快照，可挂到 graph_status.security
```

## 9. 门禁（本 lane 已绿）

```bash
node --test "src/security/tests/*.test.mjs" "src/tenancy/tests/*.test.mjs"   # 62 tests
node scripts/build.mjs                                                        # 生成 lib/security、lib/tenancy
```

> `build.mjs --check` 在本 lane 合并前会报 drift（lib/ 尚未生成新模块），这是预期的：
> 主窗口合并后跑一次 `node scripts/build.mjs` 即恢复 0 drift。

## 10. `config.ts` 精确 patch 建议（本 lane **未改** config.ts）

`src/config.ts` 现有 13 个字段（`CONFIG_SPEC` L21–L35、`L0ControlConfig` L37–L51）。
接线需要两个可选字段，其它不动：

```diff
 export const CONFIG_SPEC: Record<string, FieldSpec> = {
   ...
   persistenceDir: { type: 'string', default: 'core-state', description: 'journal/快照目录（相对 stateDir）' },
+  tenant: { type: 'string', default: 'default', description: '租户作用域（默认 default；非 default 落 tenants/<tenant>/）' },
+  tokenSecret: { type: 'string', default: '', description: '能力令牌 HMAC 密钥（空=不启用令牌模式；非空必须 ≥16 字符）' },
   nativeProvider: { type: 'string', default: 'spawn', description: 'subagents provider（spawn / fork / …）' },
```

```diff
 export type L0ControlConfig = {
   ...
   persistenceDir: string;
+  tenant: string;
+  tokenSecret: string;
   nativeProvider: string;
```

要点（三条，都很重要）：

1. **`tenant` 默认必须是 `'default'`**：`normalizeConfig()` 会把缺省值填成 `default`，
   于是 `tenantPaths()` 走 default 分支 → 路径与现状逐字节一致（既有 `journal.jsonl` 不用迁移）。
2. **`tokenSecret` 默认 `''` = 显式关闭令牌模式**：空串不得当成「弱密钥」去签发。
   service 构造期按下面校验（本 lane 的 `issue/verifyCapabilityToken` 对 `<16` 会抛 `token_invalid`，
   这里提前失败更好排查）：
   ```ts
   const tenant = normalizeTenant(cfg.tenant);                     // 非法 → tenant_mismatch
   if (cfg.tokenSecret && cfg.tokenSecret.length < 16) {
     throw new Error('config.tokenSecret 必须为空或 ≥16 字符');
   }
   const tokenMode = Boolean(cfg.tokenSecret);                     // false → 走 actor 字段
   ```
3. **`tenant` 不允许来自请求体**（只从配置/环境读，例如 `process.env.DSH_L0_TENANT`），
   否则调用方可以「自报租户」绕过 `authorize()` 的 tenant 三级比对。

> `standardSchema().toJSON()` 与 schemastery shape 都从 `CONFIG_SPEC` 派生，加字段后自动生效，
> 不需要改 `jsonSchemaOf` / `buildSchemastery` / `normalizeConfig`。

