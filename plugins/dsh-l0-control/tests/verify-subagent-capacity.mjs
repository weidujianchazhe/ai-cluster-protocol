/**
 * 「千 Agent」的真正天花板：宿主 `subagents.maxActiveSubagents`。
 *
 * 事实依据（从 `app.asar` 读源码，不是猜）：
 * ```js
 * static Config = z.object({
 *   maxDepth:           z.number().default(1).volatile(),
 *   maxActiveSubagents: z.number().min(1).max(MAX_SAFE_INTEGER).default(8).volatile(),
 * })
 * const releaseSlot = pool.reserve(this.maxActiveSubagents())   // 每次开封新子会话都现读
 * ```
 *
 * 两个结论：
 *   1. 它是 **Cordis 配置项**，默认 **8** —— 不是硬编码，可以调；
 *   2. 它是**活引用**（`() => config.maxActiveSubagents.get()`），改完**立即生效**，
 *      不需要重启宿主（Team 的 `maxMembers` 不同，那个是构造时传给 roster 的）。
 *
 * 为什么必须动它：`maxParallel` 配 64、`maxMembers` 配 256 都没用——第 9 个子会话起就报
 * `subagent limit reached (active child limit: 8)`。不放开这一层，「1000 个 Agent 协作」
 * 只是名义上的：派不出 1000 个，只能分批。
 *
 * 断言：
 *   1. 启用协作 → `maxActiveSubagents` 被提到 `subagentMaxActive`（默认 256）；
 *   2. 留 `subagent_capacity_raised`（含 from/to）；
 *   3. 已更大 → 不调低，记 `kept`，不算失败；
 *   4. 不可达 / 赋值不生效 → **启用仍成功**，但绝不谎报成功；
 *   5. 关闭协作 → 不动宿主。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (n) => pathToFileURL(path.join(root, 'lib', n)).href;
const { L0ControlService } = await import(lib('service.js'));

/** 造一个带**响应式 ref** 的假 subagents 服务（模拟 Cordis 的 config 项）。 */
function makeRef(initial, { writable = true } = {}) {
  let value = initial;
  return {
    get: () => value,
    set: (next) => {
      if (!writable) return; // 只读时静默失效 —— 回读必须能发现
      value = next;
    },
  };
}

function makeCtx({ ref, refMissing = false } = {}) {
  const subagents = refMissing ? undefined : { config: { maxActiveSubagents: ref }, list: () => ['spawn'] };
  return {
    get: (name) => {
      if (name === 'workingDirectory') return { defaultDirectory: root };
      if (name === 'subagents') return subagents;
      if (name === 'agentTeams') return { membership: () => ({ role: 'lead', name: 'lead', id: 't', root: { id: 's' } }), roster: { maxMembers: 256 } };
      return undefined;
    },
  };
}

async function withService(ctx, fn) {
  const stateDir = path.resolve(tempStateDir('sc'));
  const svc = new L0ControlService(ctx, { workspaceRoot: root, stateDir, persistence: 'node', maxParallel: 8 }, {});
  try {
    return await fn(svc);
  } finally {
    try { svc.stopDispatch(); } catch { /* 未启动 */ }
    try { await svc.dispose(); } catch { /* 已关闭 */ }
    cleanupTempStateDirs();
  }
}

// ── 组 1 + 2：启用 → 8 提到 256，并留痕 ─────────────────────────────────
{
  const ref = makeRef(8);
  await withService(makeCtx({ ref }), async (svc) => {
    svc.setSessionAccess('s-code', { coordination: true }, 'test');
    assert.equal(ref.get(), 256, `maxActiveSubagents 应提到 256，实际 ${ref.get()}`);
    const raised = [...svc.readJournal()].reverse().find((r) => r.kind === 'subagent_capacity_raised');
    assert.ok(raised, '必须留 subagent_capacity_raised');
    assert.equal(raised.from, 8);
    assert.equal(raised.to, 256);
  });
  console.log('PASS 启用协作 → maxActiveSubagents 8 → 256，journal 记 subagent_capacity_raised（from/to）');
}

// ── 组 3：已更大 → 不调低 ────────────────────────────────────────────────
{
  const ref = makeRef(1000);
  await withService(makeCtx({ ref }), async (svc) => {
    svc.setSessionAccess('s-code', { coordination: true }, 'test');
    assert.equal(ref.get(), 1000, '已更大的上限不得被调低');
    assert.ok([...svc.readJournal()].some((r) => r.kind === 'subagent_capacity_kept'));
  });
  console.log('PASS 目标(256) ≤ 当前(1000) → 不调低、记 kept');
}

// ── 组 4a：引用不可达 → 启用仍成功 ───────────────────────────────────────
{
  await withService(makeCtx({ refMissing: true }), async (svc) => {
    const access = svc.setSessionAccess('s-code', { coordination: true }, 'test');
    assert.equal(access.ok, true, '没有 subagents 服务也必须能启用协作');
    assert.ok([...svc.readJournal()].some((r) => r.kind === 'subagent_capacity_unavailable'));
  });
  console.log('PASS 引用不可达 → 启用仍 ok，记 subagent_capacity_unavailable（不阻断）');
}

// ── 组 4b：赋值静默失效 → 不谎报成功 ────────────────────────────────────
{
  const ref = makeRef(8, { writable: false });
  await withService(makeCtx({ ref }), async (svc) => {
    const access = svc.setSessionAccess('s-code', { coordination: true }, 'test');
    assert.equal(access.ok, true, '赋值失败不得阻断启用');
    assert.equal(ref.get(), 8, '前置：只读 ref 确实没变');
    assert.ok([...svc.readJournal()].some((r) => r.kind === 'subagent_capacity_failed'), '必须记 failed，不能谎报成功');
  });
  console.log('PASS 赋值静默失效 → 启用仍 ok，且记 subagent_capacity_failed（回读发现，不谎报）');
}

// ── 组 5：关闭协作 → 不动宿主 ────────────────────────────────────────────
{
  const ref = makeRef(8);
  await withService(makeCtx({ ref }), async (svc) => {
    svc.setSessionAccess('s-code', { coordination: false }, 'test');
    assert.equal(ref.get(), 8, '关闭协作不得改宿主并发上限');
  });
  console.log('PASS 关闭协作 → 不动宿主（保持 8）');
}
