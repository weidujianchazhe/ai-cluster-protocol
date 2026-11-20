/**
 * 宿主服务自检：**缺了不报错，但必须能看见**。
 *
 * 为什么需要：本插件的 `inject` 只声明了 `['tools']`，而 `agentTeams` / `subagents` /
 * `sessionController` 全是运行时 `ctx.get()` 取的。宿主没提供时插件照常加载、工具照常可用，
 * 只是**能力悄悄降级**：
 *
 *   - 缺 `agentTeams` → `agent_spawn` 全部退回 activation（`ownerCapable:false`），
 *     `teamMemberLimit` 自动放开无效；但图/租约/证据/审计/协调器全部正常
 *   - 缺 `subagents`   → 完全派不出子会话
 *   - 缺 `sessionController` → 续跑与消息转发不可用
 *
 * 真机踩过：上一轮 32 并发里有一批 `via: startActivation` + `ownerCapable: false`，
 * 只能从这两个字段倒推出「Team 路径没走通」，**没有任何一条日志说缺了什么**。
 *
 * 断言：
 *   1. 三个服务齐全 → 留 `host_services_ok`，`caps.ok=true`
 *   2. 缺 `agentTeams` → 留 `host_service_missing`，且 `degraded` 里写清降级内容与补法
 *   3. 缺 `subagents` / `sessionController` 各自有对应降级说明
 *   4. **只报一次**：缺服务是稳定环境事实，不能每次工具调用都写一条
 *   5. `graphStatus` 的 `capabilities.hostServices` 反映真实（不依赖 journal）
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (n) => pathToFileURL(path.join(root, 'lib', n)).href;
const { L0ControlService } = await import(lib('service.js'));

/** 造一个只提供指定服务的 ctx。 */
const makeCtx = (provided) => ({
  get: (name) => {
    if (name === 'workingDirectory') return { defaultDirectory: root };
    if (provided.includes(name)) {
      if (name === 'agentTeams') return { membership: () => ({ role: 'lead' }), listMembers: () => [], roster: { maxMembers: 256 }, createTask: () => ({}) };
      if (name === 'subagents') return { startActivation: async () => ({}), sendMessage: async () => ({}), config: { maxActiveSubagents: { get: () => 256, set: () => {} } } };
      if (name === 'sessionController') return { inspect: () => ({}) };
      return {};
    }
    return undefined;
  },
});

async function withSvc(provided, fn) {
  const stateDir = path.resolve(tempStateDir('host'));
  const svc = new L0ControlService(makeCtx(provided), {
    workspaceRoot: root, stateDir, persistence: 'node', maxParallel: 8,
    coordinatorEnabled: false,
  }, {});
  try {
    return await fn(svc);
  } finally {
    try { svc.stopCoordinator(); } catch { /* 未启动 */ }
    try { svc.stopDispatch(); } catch { /* 未启动 */ }
    try { await svc.dispose(); } catch { /* 已关闭 */ }
    cleanupTempStateDirs();
  }
}

const ALL = ['agentTeams', 'subagents', 'sessionController'];

// ── 组 1：齐全 → ok ────────────────────────────────────────────────────
{
  await withSvc(ALL, async (svc) => {
    svc.reportHostServicesOnce('test');
    const ok = [...svc.readJournal()].find((r) => r.kind === 'host_services_ok');
    assert.ok(ok, '齐全时必须留 host_services_ok');
    assert.deepEqual(ok.services.sort(), [...ALL].sort());
    const view = svc.hostServicesView();
    assert.equal(view.ok, true);
    assert.deepEqual(view.missing, []);
  });
  console.log('PASS 三服务齐全 → host_services_ok，hostServicesView.ok=true');
}

// ── 组 2 + 3：缺 agentTeams → 说清降级与补法 ────────────────────────────
{
  await withSvc(['subagents', 'sessionController'], async (svc) => {
    svc.reportHostServicesOnce('test');
    const miss = [...svc.readJournal()].find((r) => r.kind === 'host_service_missing');
    assert.ok(miss, '缺服务必须留 host_service_missing');
    assert.deepEqual(miss.missing, ['agentTeams']);
    const degraded = String(JSON.stringify(miss.degraded));
    assert.ok(degraded.includes('activation'), '必须说清退回 activation');
    assert.ok(degraded.includes('ownerCapable') || degraded.includes('TeamTask owner'), '必须说清 owner 能力丢失');
    assert.ok(degraded.includes('experimental-agent-team'), '必须给出补法（启用哪个包）');
    assert.ok(degraded.includes('其余功能正常'), '必须说清哪些仍然正常——否则读者以为全废了');
    const view = svc.hostServicesView();
    assert.equal(view.ok, false);
    assert.deepEqual(view.missing, ['agentTeams']);
    assert.deepEqual(view.present.sort(), ['sessionController', 'subagents'].sort());
  });
  console.log('PASS 缺 agentTeams → 写清「退回 activation / 丢 owner / 怎么补 / 其余正常」');
}

// ── 组 3b：缺 subagents 与 sessionController 各自有说明 ─────────────────
{
  await withSvc(['agentTeams'], async (svc) => {
    const host = svc.hostServices();
    assert.deepEqual(host.missing.sort(), ['sessionController', 'subagents']);
    assert.ok(host.degraded.some((d) => d.includes('无法派发任何子会话')));
    assert.ok(host.degraded.some((d) => d.includes('续跑')));
  });
  console.log('PASS 缺 subagents / sessionController 各有对应降级说明');
}

// ── 组 4：只报一次 ────────────────────────────────────────────────────
{
  await withSvc(['subagents'], async (svc) => {
    svc.reportHostServicesOnce('first');
    svc.reportHostServicesOnce('second');
    svc.reportHostServicesOnce('third');
    const rows = [...svc.readJournal()].filter((r) => /^host_services_ok|^host_service_missing$/.test(String(r.kind)));
    assert.equal(rows.length, 1, `只应留一条，实际 ${rows.length} 条`);
  });
  console.log('PASS 只报一次（连调三次只落一条）——缺服务是稳定事实，不该刷屏');
}

// ── 组 5：graphStatus 的 capabilities.hostServices 反映真实 ─────────────
{
  await withSvc(['subagents', 'sessionController'], async (svc) => {
    const status = await svc.graphStatus({ limit: 1 });
    const host = status?.capabilities?.hostServices;
    assert.ok(host, 'graph_status.capabilities.hostServices 必须存在');
    assert.equal(host.ok, false);
    assert.deepEqual(host.missing, ['agentTeams']);
    assert.ok(Array.isArray(host.degraded) && host.degraded.length > 0);
  });
  console.log('PASS graph_status.capabilities.hostServices 直接反映缺失（不用翻 journal）');
}

// ── 组 6：齐全时 graphStatus 里 ok=true（避免误报）──────────────────────
{
  await withSvc(ALL, async (svc) => {
    const status = await svc.graphStatus({ limit: 1 });
    assert.equal(status?.capabilities?.hostServices?.ok, true);
  });
  console.log('PASS 服务齐全时 graph_status 不误报缺失');
}
