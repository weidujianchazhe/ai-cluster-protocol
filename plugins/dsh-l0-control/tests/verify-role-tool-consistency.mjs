/**
 * 角色 / 权限 / 工具的一致性检查。
 *
 * 为什么需要它：这套系统有**三套并存的概念**，它们看起来像一套、实际互不约束：
 *
 * | 概念 | 位置 | 真实作用 |
 * |---|---|---|
 * | 权限角色 | `security/roles.ts` 的 `ROLES` | 权限矩阵的键（**只管非活 agent**） |
 * | 工人职务 | `native/worker.ts` 的 `ROLE_PROFILES` | 拼 prompt + 审计独立性判断（**不是权限**） |
 * | 能力标签 | 节点的 `capability` | 自由字符串；落在 `KNOWN_CAPABILITY_ROLES` 里才当职务用 |
 *
 * 三者的漂移是静默的 —— 没人报错，只是行为悄悄不对。这个测试把漂移变成失败。
 *
 * 四类检查：
 *
 *  1. **`profile.tools` 里的工具必须真实存在** —— 防「prompt 告诉 worker 能用 X，但 X 根本不存在」
 *  2. **`KNOWN_CAPABILITY_ROLES` 必须等于 `LEGAL_WORKER_ROLES`** —— 能力标签只有与真实 worker profile 同名时才按职务过滤
 *  3. **两套机制的差集必须被显式列出** —— 不是失败条件，是让人看见边界在哪
 *  4. **`LEGAL_WORKER_ROLES` 必须等于 `ROLE_PROFILES` 的 key** —— 防派生关系被手改破坏
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const lib = (n) => pathToFileURL(path.join(root, 'lib', n)).href;

const worker = await import(lib('native/worker.js'));
const roles = await import(lib('security/roles.js'));
const caps = await import(lib('capabilities.js'));
const facade = await import(lib('core/facade.js'));

const ROLE_PROFILES = worker.ROLE_PROFILES;
const LEGAL_WORKER_ROLES = worker.LEGAL_WORKER_ROLES;
const ROLES = roles.ROLES;
const TOOLS = new Set(Object.keys(caps.CAPABILITIES.tools));
const KNOWN = facade.KNOWN_CAPABILITY_ROLES;

console.log(`  权限角色 ${ROLES.length} 个 / 工人职务 ${LEGAL_WORKER_ROLES.length} 个 / 真实工具 ${TOOLS.size} 个`);

// ── 1. profile.tools 里的每个工具必须真实存在 ─────────────────────────
{
  const missing = [];
  for (const [role, profile] of Object.entries(ROLE_PROFILES)) {
    for (const tool of profile.tools ?? []) {
      if (!TOOLS.has(tool)) missing.push(`${role}.tools → ${tool}`);
    }
  }
  assert.deepEqual(missing, [],
    `工人职务声明了不存在的工具（prompt 会告诉 worker 用它们，但工具面上没有）：\n  ${missing.join('\n  ')}`);
}
console.log('PASS 1. 每个 ROLE_PROFILES[k].tools 都是真实工具（防 prompt 与工具面脱节）');

// ── 2. KNOWN_CAPABILITY_ROLES 必须等于 LEGAL_WORKER_ROLES ────────────
{
  const expected = new Set(LEGAL_WORKER_ROLES);
  const actual = new Set(KNOWN);
  const missing = [...expected].filter((r) => !actual.has(r));
  const extra = [...actual].filter((r) => !expected.has(r));
  assert.deepEqual(missing, [], `KNOWN_CAPABILITY_ROLES 缺这些执行职务（会让职务标签被错当自由标签）：${missing.join(', ')}`);
  assert.deepEqual(extra, [], `KNOWN_CAPABILITY_ROLES 多了这些非 worker 职务（会把同名自由标签误判成 role）：${extra.join(', ')}`);
}
console.log('PASS 2. KNOWN_CAPABILITY_ROLES == LEGAL_WORKER_ROLES（只有真实执行职务才触发 role 过滤）');

// ── 3. LEGAL_WORKER_ROLES 必须等于 ROLE_PROFILES 的 key ───────────────
{
  const fromProfiles = Object.keys(ROLE_PROFILES).sort();
  assert.deepEqual([...LEGAL_WORKER_ROLES].sort(), fromProfiles,
    'LEGAL_WORKER_ROLES 应等于 ROLE_PROFILES 的 key（它是派生的，别手改）');
}
console.log('PASS 3. LEGAL_WORKER_ROLES 与 ROLE_PROFILES 的 key 一致（派生关系没被手改）');

// ── 4. 两套机制的差集**显式列出**（不是失败条件，是让人看见边界）──────
{
  const onlyInPermissions = ROLES.filter((r) => !LEGAL_WORKER_ROLES.includes(r));
  const onlyInProfiles = LEGAL_WORKER_ROLES.filter((r) => !ROLES.includes(r));

  console.log('\n  ┌─ 两套机制的差集（这是设计，不是缺陷）');
  console.log(`  │ 只在权限层（不能当 worker 职务起实例）: ${onlyInPermissions.join(', ')}`);
  console.log(`  │ 只在工人职务（权限层没有对应键 → 走活 Agent 的主体权限通道）: ${onlyInProfiles.join(', ')}`);
  console.log('  └─');

  // 关键断言：只在工人职务里的那些，必须是已知的 3 个。
  // 多出任何一个都说明有人加了 worker 职务却没想清楚它的权限归属。
  assert.deepEqual(onlyInProfiles.sort(), ['EVIDENCE', 'OPS', 'TEST'],
    `只在工人职务里的角色发生了变化（当前已知是 EVIDENCE / OPS / TEST）。` +
    `新增的职务要么补进 ROLES，要么显式说明它只靠主体权限通道工作：${onlyInProfiles.join(', ')}`);

  // 另：权限层独有的是 ORCH/RESEARCH/AUDIT/DELIVER/OBS/PLUGIN/HUMAN —— 都是非 worker 角色
  for (const r of ['ORCH', 'HUMAN']) {
    assert.ok(onlyInPermissions.includes(r), `${r} 不该出现在工人职务里`);
  }
}
console.log('\nPASS 4. 两套机制的差集与已知一致：权限层独有 ORCH 等，工人职务独有 TEST/EVIDENCE/OPS');

// ── 5. 提醒：这份检查**不**验证「工人职务有没有权限」────────────────────
{
  // 因为活 Agent 在 actor.ts 里直接拿 ['ORCH','HUMAN']，role 不参与 authorize()。
  // 所以「TEST 不在 task.claim 白名单里」不等于「TEST 无法工作」——
  // 只有直接调 authorize({roles:['TEST']}, ...) 才会被拒，而真实调用链走不到那里。
  const taskClaim = roles.PERMISSIONS?.['task.claim'] ?? null;
  if (taskClaim) {
    const workerRolesWithoutClaim = LEGAL_WORKER_ROLES.filter((r) => !taskClaim.includes(r));
    console.log(`\n  ℹ️ 不在 task.claim 白名单里的工人职务: ${workerRolesWithoutClaim.join(', ') || '（无）'}`);
    console.log('     这**不是缺陷** —— 活 Agent 走 actor.ts 的主体权限通道拿 ORCH，不查本表。');
    console.log('     详细边界见 src/security/roles.ts 文件头的表格。');
  }
}
console.log('\n全部通过：三套概念的漂移已被测试锁住。');
