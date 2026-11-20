/**
 * Agent 预设：**不要默认指定一个别人可能没装的名字**。
 *
 * 原实现：`const agentPreset = input?.agentPreset ?? (parentEnabled ? 'memory-first' : undefined)`
 * ——只要父会话启用了记忆，就给子实例硬指定 `memory-first`。
 *
 * 本机没问题（`presets/memory-first` 已通过 Junction 装进 profile），但**别人未必装**。
 * 而宿主对这件事是硬的（`@deepseek-ai/dsh-subagent/lib/types/child-agent.js`）：
 *
 * ```js
 * if (composition.agentPreset !== undefined) {
 *   const presets = childCtx.get('agentPresets');
 *   if (presets === undefined) throw new SubagentError('...', 'PRESET_UNAVAILABLE');
 *   return presets.mount(childCtx, composition.agentPreset);   // 未知名字在这里失败
 * }
 * ```
 *
 * 也就是：**指定一个没注册的预设名 → spawn 直接失败**，不是降级，是派不出去。
 *
 * 而不传时宿主走 `selectedPreset ?? parent.composedPreset(parent)` —— 子实例**继承父的预设**，
 * 既不需要那个包存在，也不会丢掉父会话的记忆能力。
 *
 * 这是本轮发现的**第三个「外部依赖不假设别人有」的问题**（前两个：agentTeams 服务、
 * 系统临时目录清理）。共同形态：本机能跑，别人装上就炸，而且**爆在运行期而不是安装期**。
 *
 * 断言：
 *   1. 默认（空配置）→ spawnAgent 收到的 `agentPreset` 是 undefined（继承父）
 *   2. 显式配 `defaultAgentPreset` → 用它
 *   3. 调用方显式传 `agentPreset` → 覆盖配置
 *   4. 父会话启用记忆也不影响默认行为（不再自动塞 memory-first）
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (n) => pathToFileURL(path.join(root, 'lib', n)).href;
const { L0ControlService } = await import(lib('service.js'));
const { normalizeConfig } = await import(lib('config.js'));

/** 记录 spawnAgent 实际收到的参数。 */
const seen = [];

const makeCtx = () => ({
  get: (name) => {
    if (name === 'workingDirectory') return { defaultDirectory: root };
    if (name === 'agentTeams') {
      return { membership: () => ({ role: 'lead' }), listMembers: () => [], roster: { maxMembers: 256 }, createTask: () => ({}) };
    }
    if (name === 'subagents') {
      return {
        startActivation: async () => ({ childId: 'c1', messageId: 'm1' }),
        sendMessage: async () => ({}),
        config: { maxActiveSubagents: { get: () => 256, set: () => {} } },
        registerProvider: () => {},
      };
    }
    if (name === 'sessionController') return { inspect: () => ({}), create: async () => ({}) };
    return undefined;
  },
});

async function withSvc(configOverrides, fn) {
  const stateDir = path.resolve(tempStateDir('preset'));
  const svc = new L0ControlService(makeCtx(), {
    workspaceRoot: root, stateDir, persistence: 'node', maxParallel: 8, coordinatorEnabled: false,
    ...configOverrides,
  }, {});
  // 拦下 native.spawnAgent，记录 agentPreset，避免真去派
  const native = svc.native;
  const orig = native.spawnAgent.bind(native);
  native.spawnAgent = async (input, caller) => {
    seen.push({ agentPreset: input?.agentPreset });
    return { ok: true, instanceId: 'ROLE-CODE-01', sessionId: 'sess-x', via: 'startActivation' };
  };
  try {
    return await fn(svc);
  } finally {
    native.spawnAgent = orig;
    try { svc.stopCoordinator(); } catch { /* 未启动 */ }
    try { svc.stopDispatch(); } catch { /* 未启动 */ }
    try { await svc.dispose(); } catch { /* 已关闭 */ }
    cleanupTempStateDirs();
  }
}

const LEAD = { id: 'session-parent' };
const CALL = { role: 'CODE', task: '做点事', capability: 'CODE' };

// ── 组 1：默认空配置 → 不指定预设（继承父）──────────────────────────────
{
  seen.length = 0;
  await withSvc({}, async (svc) => {
    // 让父会话「启用」——原实现正是在这种情况下自动塞 memory-first
    svc.setSessionAccess('session-parent', { coordination: true }, 'test');
    await svc.spawnAgent(CALL, LEAD);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].agentPreset, undefined, '默认必须不指定预设（让子实例继承父）');
  });
  console.log('PASS 默认不指定 agentPreset（父会话已启用也照样继承，不再硬塞 memory-first）');
}

// ── 组 2：显式配 defaultAgentPreset → 用它 ─────────────────────────────
{
  seen.length = 0;
  await withSvc({ defaultAgentPreset: 'my-preset' }, async (svc) => {
    await svc.spawnAgent(CALL, LEAD);
    assert.equal(seen[0].agentPreset, 'my-preset');
  });
  console.log('PASS 配上 defaultAgentPreset → 用它');
}

// ── 组 3：调用方显式传参覆盖配置 ────────────────────────────────────────
{
  seen.length = 0;
  await withSvc({ defaultAgentPreset: 'my-preset' }, async (svc) => {
    await svc.spawnAgent({ ...CALL, agentPreset: 'explicit-one' }, LEAD);
    assert.equal(seen[0].agentPreset, 'explicit-one', '调用方显式值优先级最高');
  });
  console.log('PASS 调用方显式 agentPreset 覆盖默认配置');
}

// ── 组 4：配置成空白串等同于不指定（容错）──────────────────────────────
{
  seen.length = 0;
  await withSvc({ defaultAgentPreset: '   ' }, async (svc) => {
    await svc.spawnAgent(CALL, LEAD);
    assert.equal(seen[0].agentPreset, undefined, '空白串必须归一成 undefined，否则会去 mount 一个空白名');
  });
  console.log('PASS 空白配置归一为 undefined（避免 mount 空白 preset 名）');
}

// ── 组 5：配置项默认值本身是空 ──────────────────────────────────────────
{
  const cfg = normalizeConfig({});
  assert.equal(cfg.defaultAgentPreset, '', '配置默认值必须是空串（继承父），不能是 memory-first');
  console.log('PASS 配置默认值为空串（README 里写明的「空=继承父」与代码一致）');
}
