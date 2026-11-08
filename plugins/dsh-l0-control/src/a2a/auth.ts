/**
 * 鉴权：静态 bearer token（+ 可选静态头 + 可选租户串）。
 *
 * 规则（全部 fail-closed，默认拒绝）：
 *  1. `config.tokens` 为空 → 一律 401（部署忘了配 token 不等于放开）；
 *  2. 比较用 sha256 摘要 + `timingSafeEqual`，不比明文（长度恒定、无早退）；
 *  3. 令牌有效但 `requireTenant` 与 `x-a2a-tenant` 不一致 → 403（租户隔离归 Lane S，
 *     这里只做传输层的最小校验钩子，真实租户模块由 S 接线时替换）；
 *  4. 401 一律带 `WWW-Authenticate`，便于标准客户端重试。
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { A2AActor, A2AAuthConfig } from './types.ts';

export interface AuthOk {
  ok: true;
  actor: A2AActor;
}

export interface AuthFail {
  ok: false;
  status: 401 | 403;
  code: 'unauthorized' | 'tenant-mismatch';
  message: string;
  headers: Record<string, string>;
}

export type AuthResult = AuthOk | AuthFail;

const WWW_AUTHENTICATE = 'Bearer realm="a2a", error="invalid_token"';

/** 令牌指纹（写审计用，不落明文）。 */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** 恒定时间比较（先摘要，规避长度差异导致的早退）。 */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const da = digest(a);
  const db = digest(b);
  return timingSafeEqual(da, db);
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const direct = headers[name];
  if (typeof direct === 'string') return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/** 取 bearer token（大小写不敏感、容忍多余空格）。 */
export function extractBearer(headers: Record<string, string>): string | undefined {
  const raw = headerValue(headers, 'authorization');
  if (typeof raw !== 'string') return undefined;
  const match = /^\s*bearer\s+(.+?)\s*$/i.exec(raw);
  return match ? match[1] : undefined;
}

export function authorize(headers: Record<string, string>, config: A2AAuthConfig): AuthResult {
  const tokens = Array.isArray(config.tokens) ? config.tokens.filter((t) => typeof t === 'string' && t.length > 0) : [];
  if (tokens.length === 0) {
    return {
      ok: false,
      status: 401,
      code: 'unauthorized',
      message: 'A2A 未配置任何令牌（默认拒绝）',
      headers: { 'www-authenticate': WWW_AUTHENTICATE },
    };
  }

  const bearer = extractBearer(headers);
  let matched: string | undefined;
  if (typeof bearer === 'string') {
    for (const token of tokens) {
      if (safeEqual(bearer, token)) matched = token;
    }
  }

  if (!matched && config.staticHeader && typeof config.staticHeader.name === 'string') {
    const provided = headerValue(headers, config.staticHeader.name);
    if (typeof provided === 'string' && safeEqual(provided, config.staticHeader.value)) {
      matched = `static:${config.staticHeader.name}`;
    }
  }

  if (!matched) {
    return {
      ok: false,
      status: 401,
      code: 'unauthorized',
      message: '缺少或无效的 Authorization: Bearer <token>',
      headers: { 'www-authenticate': WWW_AUTHENTICATE },
    };
  }

  const tenant = typeof config.requireTenant === 'string' && config.requireTenant.length > 0
    ? config.requireTenant
    : null;
  if (tenant) {
    const provided = headerValue(headers, 'x-a2a-tenant');
    if (typeof provided !== 'string' || !safeEqual(provided, tenant)) {
      return {
        ok: false,
        status: 403,
        code: 'tenant-mismatch',
        message: `租户不匹配（期望 ${tenant}）`,
        headers: {},
      };
    }
  }

  return {
    ok: true,
    actor: {
      kind: 'a2a-client',
      id: `a2a:${tokenFingerprint(matched)}`,
      tokenFingerprint: tokenFingerprint(matched),
    },
  };
}
