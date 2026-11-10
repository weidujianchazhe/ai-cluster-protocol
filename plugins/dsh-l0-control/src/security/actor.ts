/**
 * 调用者身份解析（纯函数，可单测）。
 *
 * 背景：`actorOf` 原来内联在 `index.ts` 里，既要做「按谁的身份行事」的优先级裁决，
 * 又要兜底成 plugin——混在工具执行闭包里既难单测，也很难一眼看出"哪个分支会 403"。
 *
 * 解析顺序（**顺序即语义**，改顺序前先看注释）：
 *   1. `instanceId`       —— 显式声明"我以这个实例行事"，优先级最高
 *   2. `auditor_instance` —— 审计实例必须排在生产者之前：
 *      `verify_done` 需要审计职务，若先取 `producer_instance`，actor 会被认成 CODE，
 *      即便带齐 auditor 也 403，且消息里看不出是哪一环不匹配
 *   3. `producer_instance`
 *   4. 活 Agent（`exec.agent.id`）—— 宿主注入的当前会话
 *   5. 兜底 plugin（无活 Agent：宿主/插件内部调用）
 */

export interface ActorLike {
  id: string;
  kind: 'agent' | 'plugin';
  tenant: string;
  roles: string[];
}

export interface ResolveActorInput {
  args?: Record<string, unknown> | null;
  exec?: { agent?: { id?: string } | null } | null;
  tenant: string;
  /** 从实例 ID 取职务码；返回 null 表示不是合法实例。 */
  roleOfInstance: (instanceId: unknown) => string | null;
}

/** 从 args 里按优先级挑第一个「能被识别成合法实例」的字段。 */
export function pickInstanceFromArgs(
  args: Record<string, unknown> | null | undefined,
  roleOfInstance: (value: unknown) => string | null,
): string | null {
  if (!args) return null;
  const candidates = [
    args.instanceId,
    args.auditor_instance,
    args.auditorInstance,
    args.producer_instance,
    args.producerInstance,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && roleOfInstance(value)) return value;
  }
  return null;
}

/** 解析调用者：永远返回一个 actor（不抛错），无法判定时是 plugin。 */
export function resolveActor(input: ResolveActorInput): ActorLike {
  const { args, exec, tenant, roleOfInstance } = input;
  const picked = pickInstanceFromArgs(args, roleOfInstance);
  if (picked) {
    const role = roleOfInstance(picked) as string;
    return { id: picked, kind: 'agent', tenant, roles: [role] };
  }
  const agentId = exec?.agent?.id;
  if (typeof agentId === 'string' && agentId) {
    return { id: agentId, kind: 'agent', tenant, roles: ['ORCH', 'HUMAN'] };
  }
  return { id: 'plugin', kind: 'plugin', tenant, roles: ['PLUGIN', 'HUMAN'] };
}
