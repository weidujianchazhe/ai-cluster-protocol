/**
 * Lane S · 安全错误（鉴权/多租户共用）。
 *
 * 约定（与 `src/core/errors.ts` 对齐）：
 *  - 所有「拒绝」必须在**任何状态写入 / journal 追加之前**抛出；
 *  - `code` 用 snake_case，便于与 Python oracle / e2e 断言对齐；
 *  - 默认拒绝：没有明确放行就是拒绝，不用 `false` 静默返回。
 */

export class SecurityError extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown>;

  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "SecurityError";
    this.code = code;
    this.detail = detail;
  }
}

/** 调用者身份缺失或不可解析（未认证）。 */
export class Unauthenticated extends SecurityError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super("unauthenticated", message, detail);
    this.name = "Unauthenticated";
  }
}

/** 身份可解析，但角色/能力不足以执行该动作（越权）。 */
export class Forbidden extends SecurityError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super("forbidden", message, detail);
    this.name = "Forbidden";
  }
}

/** 动作不在权限矩阵内（拼写错误/未登记的动作用默认拒绝处理）。 */
export class UnknownAction extends SecurityError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super("unknown_action", message, detail);
    this.name = "UnknownAction";
  }
}

/** 租户标识非法 / 缺失，或跨租户访问（fail-closed）。 */
export class TenantMismatch extends SecurityError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super("tenant_mismatch", message, detail);
    this.name = "TenantMismatch";
  }
}

/** 能力令牌不可信（签名/结构/范围不符）。 */
export class TokenInvalid extends SecurityError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super("token_invalid", message, detail);
    this.name = "TokenInvalid";
  }
}

/** 能力令牌已过期。 */
export class TokenExpired extends SecurityError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super("token_expired", message, detail);
    this.name = "TokenExpired";
  }
}

/** 是否为安全层拒绝（供 service/工具层统一映射 401/403/409）。 */
export function isSecurityError(error: unknown): error is SecurityError {
  return error instanceof SecurityError;
}

/** status code 映射：service 接线时直接取用，不各自拍脑袋。 */
export function httpStatusFor(code: string): number {
  switch (code) {
    case "unauthenticated":
      return 401;
    case "forbidden":
      return 403;
    case "tenant_mismatch":
      return 403;
    case "unknown_action":
      return 400;
    case "token_invalid":
    case "token_expired":
      return 401;
    default:
      return 403;
  }
}
