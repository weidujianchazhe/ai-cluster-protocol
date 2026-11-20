/**
 * 「启用插件 = 自动放开宿主 Team 成员上限」的契约测试。
 *
 * 事实依据（从 `app.asar` 源码读出，不是猜）：
 *   - 上限是 Cordis **Config 项** `agentTeams.maxMembers`（`z.number().default(16)`），
 *     **不是硬编码常量**；
 *   - 检查点：`if (state.members.length >= this.maxMembers) throw TeamError('TEAM_MEMBER_LIMIT')`；
 *   - 该值被传给 `TeamRoster` 的**公开字段** `maxMembers`，所以运行时可改。
 *
 * 为什么这条要单独测：超上限时插件会**自动降级 activation**（第 38 轮已测），
 * 于是「上限没放开」不会报错、只会让所有 worker 变成 `ownerCapable:false` ——
 * 一个安静的能力降级。必须有一条测试钉住「启用协作时它真的被放开了」。
 *
 * 断言：
 *   1. 启用协作（coordination:true）→ 宿主 `roster.maxMembers` 被提到配置值；
 *   2. journal 留 `team_limit_raised`（含 from/to），可事后归因；
 *   3. 关闭协作 → **不动**宿主（关掉插件不该改别人）；
 *   4. 目标值 ≤ 当前值 → 不放宽也不报错（`team_limit_kept`），不把「已经够」当失败；
 *   5. `agentTeams` 不可达 / 赋值不生效 → 启用**仍然成功**（放开上限是优化，不是启用前提）。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (n) => pathToFileURL(path.join(root, 'lib', n)).href;
const { L0ControlService } = await import(lib('service.js'));

/** `writable:false` 用来模拟「宿主对象不可写」——赋值静默失效。 */
function makeCtx({ roster = { maxMembers: 16 }, rosterWritable = true, hasTeams = true } = {}) {
  const teams = hasTeams
    ? {
        membership: () => ({ role: 'lead', name: 'lead', id: 'team-1', root: { id: 's-lead' } }),
        roster,
      }
    : null;
  if (hasTeams && !rosterWritable) {
    Object.defineProperty(roster, 'maxMembers', { value: 16, writable: false, configurable: false });
  }
  return {
    get: (name) => {
      if (name === 'workingDirectory') return { defaultDirectory: root };
      if (name === 'agentTeams') return teams ?? undefined;
      return undefined;
    },
  };
}

async function withService(ctx, fn) {
  const stateDir = path.resolve(tempStateDir('tl-raise'));
  const svc = new L0ControlService(ctx, { workspaceRoot: root, stateDir, persistence: 'node', maxParallel: 8 }, {});
  try {
    return await fn(svc);
  } finally {
    try { svc.stopDispatch(); } catch { /* 未启动 */ }
    try { await svc.dispose(); } catch { /* 已关闭 */ }
    cleanupTempStateDirs();
  }
}

// ── 1 + 2：启用协作 → 上限被提高，并留痕 ────────────────────────────────
{
  const roster = { maxMembers: 16 };
  await withService(makeCtx({ roster }), async (svc) => {
    const access = svc.setSessionAccess('s-code', { coordination: true }, 'test');
    assert.equal(access.ok, true);
    assert.equal(roster.maxMembers, 256, `roster.maxMembers 应被提到 256，实际 ${roster.maxMembers}`);
    const journal = svc.readJournal();
    const raised = [...journal].reverse().find((r) => r.kind === 'team_limit_raised');
    assert.ok(raised, 'journal 必须有 team_limit_raised');
    assert.equal(raised.from, 16);
    assert.equal(raised.to, 256);
  });
  console.log('PASS 启用协作 → roster.maxMembers 16 → 256，journal 记 team_limit_raised（from/to）');
}

// ── 3：关闭协作 → 不动宿主 ────────────────────────────────────────────
{
  const roster = { maxMembers: 16 };
  await withService(makeCtx({ roster }), async (svc) => {
    svc.setSessionAccess('s-code', { coordination: false }, 'test');
    assert.equal(roster.maxMembers, 16, '关闭协作不得改宿主上限');
  });
  console.log('PASS 关闭协作 → 不动宿主（保持 16）');
}

// ── 4：目标 ≤ 当前 → 保持，不当失败 ────────────────────────────────────
{
  const roster = { maxMembers: 1000 };
  await withService(makeCtx({ roster }), async (svc) => {
    const access = svc.setSessionAccess('s-code', { coordination: true }, 'test');
    assert.equal(access.ok, true);
    assert.equal(roster.maxMembers, 1000, '已经更大的上限不得被调低');
    const journal = svc.readJournal();
    assert.ok([...journal].some((r) => r.kind === 'team_limit_kept'), 'journal 应记 team_limit_kept');
  });
  console.log('PASS 目标(256) ≤ 当前(1000) → 不调低、不报错、记团队 team_limit_kept');
}

// ── 5a：agentTeams 不可达 → 启用仍成功 ─────────────────────────────────
{
  await withService(makeCtx({ hasTeams: false }), async (svc) => {
    const access = svc.setSessionAccess('s-code', { coordination: true }, 'test');
    assert.equal(access.ok, true, '宿主没有 agentTeams 也必须能启用协作');
    assert.ok([...svc.readJournal()].some((r) => r.kind === 'team_limit_unavailable'));
  });
  console.log('PASS agentTeams 不可达 → 启用仍 ok，记 team_limit_unavailable（不阻断）');
}

// ── 5b：赋值不生效 → 启用仍成功，且不谎报 ─────────────────────────────
{
  const roster = {};
  await withService(makeCtx({ roster, rosterWritable: false }), async (svc) => {
    const access = svc.setSessionAccess('s-code', { coordination: true }, 'test');
    assert.equal(access.ok, true, '赋值失败也不得阻断启用');
    const journal = svc.readJournal();
    const failed = [...journal].reverse().find((r) => r.kind === 'team_limit_failed');
    assert.ok(failed, '赋值未生效必须记 team_limit_failed，不能静默当作成功');
  });
  console.log('PASS 赋值不生效 → 启用仍 ok，且记 team_limit_failed（不谎报成功）');
}

console.log('\n注意：真实宿主需**重载插件**后才会执行这段代码；');
console.log('本测试用构造的 agentTeams 桩验证逻辑，不能替代对真实宿主的验证。');
