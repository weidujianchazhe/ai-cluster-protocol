/**
 * Lane S · 能力令牌（capability token）。
 *
 * 形态：`v1.<base64url(payload)>.<base64url(HMAC-SHA256)>`
 *  - payload 自带 `tenant` / `roles` / `exp`，verifier 不再依赖调用方自报；
 *  - 签名密钥由调用方注入（service 接线时从 config/env 取），本模块不读全局状态；
 *  - `HUMAN` 角色默认**不允许**被令牌携带（人工/ L3 必须走真实身份，`allowHuman` 才放开）；
 *  - 所有失败 fail-closed：结构/签名 → `TokenInvalid`；过期 → `TokenExpired`；
 *    租户不符 → `TenantMismatch`；动作越界 → `Forbidden`。
 */

import crypto from "node:crypto";

import { DEFAULT_TENANT, normalizeTenant } from "../tenancy/tenant.js";
import { Forbidden, TokenExpired, TokenInvalid, TenantMismatch } from "./errors.js";
import { parseInstanceId, resolvePrincipal } from "./identity.js";
                                                          
import { isKnownAction } from "./roles.js";

export const TOKEN_VERSION = "v1";
const MIN_SECRET_LENGTH = 16;

                                   
              
                  
                 
                  
                                    
                            
              
              
              
 

                               
                  
                   
                  
                   
                     
                               
                  
                 
                  
                       
               
 

                                
                 
                  
                  
                                           
                  
                                      
                   
 

function base64url(buffer                 )         {
  const buf = typeof buffer === "string" ? Buffer.from(buffer, "utf8") : buffer;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(text        )         {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = padded.length % 4;
  const withPad = remainder === 0 ? padded : padded + "=".repeat(4 - remainder);
  return Buffer.from(withPad, "base64");
}

function sign(payloadPart        , secret        )         {
  return base64url(crypto.createHmac("sha256", secret).update(payloadPart).digest());
}

function requireSecret(secret         )         {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    throw new TokenInvalid(`token secret 不可用（至少 ${MIN_SECRET_LENGTH} 字符）`);
  }
  return secret;
}

/** 签发令牌。角色集为空、subject 空、tenant 非法 → 直接拒绝（不签废令牌）。 */
export function issueCapabilityToken(options              )         {
  const secret = requireSecret(options.secret);
  const subject = typeof options.subject === "string" ? options.subject.trim() : "";
  if (!subject) throw new TokenInvalid("令牌 subject 不能为空");
  const kind            = options.kind ?? "agent";
  const tenant = normalizeTenant(options.tenant ?? DEFAULT_TENANT);
  const roles = (options.roles ?? (parseInstanceId(subject)?.role ? [parseInstanceId(subject) .role] : []))
    .map((role) => String(role).trim().toUpperCase())
    .filter(Boolean);
  if (roles.length === 0) throw new TokenInvalid("令牌必须至少带一个角色");
  if (roles.includes("HUMAN") && !options.allowHuman) {
    throw new TokenInvalid("HUMAN 角色不得由能力令牌携带（需 allowHuman 显式放开）");
  }
  const actions = options.actions === undefined ? null : options.actions;
  if (Array.isArray(actions)) {
    for (const action of actions) {
      if (!isKnownAction(action)) throw new TokenInvalid(`动作未登记，禁止签发：${action}`);
    }
  }
  const nowSec = Number.isFinite(options.nowSec) ? Number(options.nowSec) : Math.floor(Date.now() / 1000);
  const ttl = Number.isFinite(options.ttlSec) ? Number(options.ttlSec) : 3600;
  if (ttl <= 0) throw new TokenInvalid("ttlSec 必须为正数");

  const claims                   = {
    sub: subject,
    kind,
    tenant,
    roles,
    actions,
    iat: nowSec,
    exp: nowSec + ttl,
    jti: options.jti ?? crypto.randomUUID(),
  };
  const payloadPart = base64url(JSON.stringify(claims));
  return `${TOKEN_VERSION}.${payloadPart}.${sign(payloadPart, secret)}`;
}

/** 只解码不验签（调试/审计用；**不得**用于授权判定）。 */
export function decodeCapabilityToken(token        )                   {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
    throw new TokenInvalid("令牌结构非法");
  }
  try {
    return JSON.parse(fromBase64url(parts[1]).toString("utf8"))                    ;
  } catch {
    throw new TokenInvalid("令牌 payload 不是合法 JSON");
  }
}

/**
 * 校验令牌并返回 Principal（含 claims）。
 * 校验顺序：结构 → 签名（timingSafeEqual）→ 过期 → 租户 → 动作白名单 → 角色矩阵。
 */
export function verifyCapabilityToken(
  token        ,
  options               ,
)                                           {
  const secret = requireSecret(options.secret);
  const raw = String(token ?? "").trim();
  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
    throw new TokenInvalid("令牌结构非法（expected v1.<payload>.<sig>）");
  }
  const [, payloadPart, sigPart] = parts;
  const expected = sign(payloadPart, secret);
  const actualBuf = Buffer.from(sigPart);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) {
    throw new TokenInvalid("令牌签名不匹配");
  }

  const claims = decodeCapabilityToken(raw);
  const nowSec = Number.isFinite(options.nowSec) ? Number(options.nowSec) : Math.floor(Date.now() / 1000);
  const skew = Number.isFinite(options.skewSec) ? Number(options.skewSec) : 0;
  if (typeof claims.exp !== "number" || claims.exp + skew <= nowSec) {
    throw new TokenExpired(`令牌已过期（exp=${claims.exp}, now=${nowSec}）`, { exp: claims.exp });
  }

  if (options.tenant !== undefined) {
    const requested = normalizeTenant(options.tenant);
    if (normalizeTenant(claims.tenant) !== requested) {
      throw new TenantMismatch(`令牌租户不匹配：token=${claims.tenant} 请求=${requested}`, {
        tokenTenant: claims.tenant,
        requestTenant: requested,
      });
    }
  }

  if (options.action !== undefined) {
    if (Array.isArray(claims.actions) && !claims.actions.includes(options.action)) {
      throw new Forbidden(`令牌动作白名单不含 ${options.action}`, {
        action: options.action,
        actions: claims.actions,
      });
    }
  }

  const principal = resolvePrincipal(
    { kind: claims.kind, id: claims.sub, tenant: claims.tenant, roles: claims.roles },
    { defaultTenant: claims.tenant },
  );
  return { ...principal, claims };
}


//# sourceURL=security\tokens.js