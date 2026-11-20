/**
 * 审计身份解析：`producer_instance` **不得**被当成调用者身份。
 *
 * 真机事故（第 39 轮）：审计实例 `role-audit-code-47` 调 `verify_done`，被授权层判成自审 → 403：
 *
 * ```
 * ok=false  error=forbidden (403, action=verify_done, actor.id=role-code-62)
 * ```
 *
 * `role-code-62` 正是该节点的**生产者**。链路是这样断的：
 *
 *   1. 契约**建议**审计方省略 `auditor_instance`（服务会用自己的实例名取审计方）；
 *   2. `resolveActor` 的候选顺序是
 *      `instanceId → auditor_instance → **producer_instance** → 活 Agent`；
 *   3. 省略 `auditor_instance` ⇒ 候选落到 `producer_instance` ⇒ actor 被认成生产者；
 *   4. 生产者职务是 `CODE`，而 `verify_done` 白名单是
 *      `[AUDIT, AUDIT_CODE, AUDIT_EVIDENCE, AUDIT_DESIGN, HUMAN]` ⇒ **403**。
 *
 * 也就是：**按契约做事的合法审计，必然失败。**
 *
 * 注意不能把 `producer_instance` 从候选里**无条件**删掉：
 * `evidence.add` 的白名单是 `[RESEARCH, DESIGN, CODE, DELIVER, PLUGIN]`——**不含 ORCH/HUMAN**，
 * 而生产 worker 正是靠 `producer_instance` 拿到 CODE 职务的。无条件删会让证据提交全断。
 * 所以只在**审计动作**上排除。
 *
 * 断言：
 *   1. 审计动作 + 省略 auditor_instance + 带 producer_instance → actor **不是** producer；
 *   2. 审计动作 + 显式 auditor_instance → actor 是该审计实例；
 *   3. 非审计动作（evidence 场景）→ 仍然用 producer_instance（回归）；
 *   4. `excludeProducer` 下若无任何身份可用 → 落到活 Agent；
 *   5. `CODE` 职务确实不在 verify_done 白名单里（这是 403 的另一半，钉住它免得有人误放宽）。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const lib = (n) => pathToFileURL(path.join(root, 'lib', n)).href;
const { resolveActor, pickInstanceFromArgs } = await import(lib('security/actor.js'));
const roles = await import(lib('security/roles.js'));

/** 职务表：只认这几类实例名，其余返回 null（模拟真实 roleOfInstance）。 */
const roleOfInstance = (value) => {
  const id = String(value ?? '');
  const m = /^role-([a-z]+)/i.exec(id);
  if (!m) return null;
  const key = m[1].toUpperCase();
  if (key === 'AUDIT') return 'AUDIT_CODE';
  return ['CODE', 'DESIGN', 'RESEARCH', 'DELIVER', 'OPS'].includes(key) ? key : null;
};

const tenant = 'default';

// ── 组 1：审计动作省略 auditor_instance → 不得认成 producer ──────────────
{
  const actor = resolveActor({
    args: { nodeId: 'M8-03', fencingToken: 2, producer_instance: 'role-code-62' },
    exec: { agent: { id: 'sess-audit-uuid' } },
    tenant,
    roleOfInstance,
    excludeProducer: true,
  });
  assert.notEqual(actor.id, 'role-code-62', '**核心断言**：审计身份不得是生产者');
  assert.equal(actor.id, 'sess-audit-uuid', '应落到活 Agent（审计会话）');
  assert.ok(!actor.roles.includes('CODE'), '不得继承生产者职务');
}
console.log('PASS 审计动作省略 auditor_instance → actor 不是 producer，落到活 Agent');

// ── 组 2：显式 auditor_instance → 用它 ──────────────────────────────────
{
  const actor = resolveActor({
    args: { nodeId: 'M8-03', producer_instance: 'role-code-62', auditor_instance: 'role-audit-code-47' },
    exec: { agent: { id: 'sess-audit-uuid' } },
    tenant,
    roleOfInstance,
    excludeProducer: true,
  });
  assert.equal(actor.id, 'role-audit-code-47');
  assert.deepEqual(actor.roles, ['AUDIT_CODE']);
}
console.log('PASS 显式 auditor_instance → actor 是该审计实例，职务 AUDIT_CODE');

// ── 组 3：非审计动作（证据场景）仍用 producer_instance —— 回归 ───────────
{
  const actor = resolveActor({
    args: { nodeId: 'M8-03', producer_instance: 'role-code-62' },
    exec: { agent: { id: 'sess-code-uuid' } },
    tenant,
    roleOfInstance,
    // 不传 excludeProducer：这是 evidence_submit 的形态
  });
  assert.equal(actor.id, 'role-code-62', '证据提交必须仍以生产者身份行事');
  assert.deepEqual(actor.roles, ['CODE']);
  // 而 CODE 在 evidence.add 白名单里、不在 verify_done 里 —— 两条都得成立
  assert.ok(roles.rolesForAction('evidence.add').includes('CODE'), 'CODE 必须能 evidence.add');
}
console.log('PASS 非审计动作仍用 producer_instance（CODE 能 evidence.add）—— 回归未破');

// ── 组 4：excludeProducer 下无身份可用 → 活 Agent；连活 Agent 都没有 → plugin ──
{
  const a = resolveActor({ args: { producer_instance: 'role-code-62' }, exec: { agent: { id: 's1' } }, tenant, roleOfInstance, excludeProducer: true });
  assert.equal(a.id, 's1');
  const b = resolveActor({ args: { producer_instance: 'role-code-62' }, exec: null, tenant, roleOfInstance, excludeProducer: true });
  assert.equal(b.kind, 'plugin', '没有活 Agent 时 fail-closed 成 plugin（verify_done 会拒）');
}
console.log('PASS excludeProducer 下依次退回活 Agent → plugin');

// ── 组 5：钉住 CODE 不在 verify_done 白名单（403 的另一半）──────────────
{
  const allowed = roles.rolesForAction('verify_done');
  assert.ok(!allowed.includes('CODE'), 'CODE 不得进 verify_done 白名单');
  for (const r of ['AUDIT_CODE', 'AUDIT_EVIDENCE', 'AUDIT_DESIGN']) {
    assert.ok(allowed.includes(r), `verify_done 必须允许 ${r}`);
  }
  // pickInstanceFromArgs 的原始候选里仍含 producer（供非审计动作用）——
  // 用它说清"为什么必须靠 excludeProducer 而不是删候选"。
  const raw = pickInstanceFromArgs({ producer_instance: 'role-code-62' }, roleOfInstance);
  assert.equal(raw, 'role-code-62', '原始候选行为不变（非审计动作仍需要它）');
}
console.log('PASS CODE 不在 verify_done 白名单；原始候选仍含 producer（所以只能按动作排除）');
