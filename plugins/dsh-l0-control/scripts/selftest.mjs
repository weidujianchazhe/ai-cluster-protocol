/**
 * 插件自检（N2 交付的一部分）：用 stub ctx 验证「壳」的契约，不依赖宿主。
 *
 * 覆盖：
 *   1. 构建产物与 TS 源同步（`scripts/build.mjs --check`）
 *   2. apply() 注册 9 个工具 + `l0control` 服务
 *   3. Config 形状（归一化默认值 / 前缀生效）
 *   4. fail-closed：无 caller 的 team_status、无 core 的图操作、缺产物的 evidence_submit
 *   5. export 真写文件；能力声明含 supports_whitebox=false 与 native 分级
 *
 * 用法：`node scripts/selftest.mjs [--json]`，任一失败退出码 1。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const checks = [];
function check(name, fn) {
  try {
    const result = fn();
    checks.push({ name, ok: result?.ok !== false, detail: result?.detail ?? result ?? null });
  } catch (error) {
    checks.push({ name, ok: false, detail: { error: String(error?.message || error) } });
  }
}

// 1. 构建同步
check('build: lib 与 src 同步', () => {
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs'), '--check'], {
      cwd: root,
      encoding: 'utf8',
    });
    return { ok: JSON.parse(out).ok === true };
  } catch (error) {
    return { ok: false, detail: { message: String(error?.message || error) } };
  }
});

// 2. apply 注册面
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'l0control-'));
const registered = [];
const provided = {};
let disposer = null;
const ctx = {
  get: () => undefined,
  provide: (key, value) => {
    provided[key] = value;
  },
  effect: (fn) => {
    disposer = fn();
    return disposer;
  },
  tools: { register: (tool) => registered.push(tool.name) },
};

const mod = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href);
const handle = mod.apply(ctx, { workspaceRoot, stateDir: '.l0-control-selftest' });

check('apply: 注册 15 个工具（含 project_init）', () => ({
  ok: registered.length === 15 && registered.includes('project_init'),
  detail: { tools: registered, handle: handle?.tools ?? null },
}));

check('apply: 注册 l0control 服务', () => ({
  ok: Boolean(provided.l0control) && provided.l0control.describe().toolCount === 15,
  detail: { describe: provided.l0control?.describe?.().toolCount ?? null },
}));

const service = provided.l0control;

// 3. Config
check('config: 归一化默认值 + 前缀生效', () => {
  const custom = mod.apply(
    { ...ctx, tools: { register: () => {} }, provide: () => {}, effect: () => () => {} },
    { workspaceRoot, stateDir: '.l0-control-prefix', toolPrefix: 'l0_' },
  );
  return {
    ok: service.config.stateDir === '.l0-control-selftest' && custom.tools.every((name) => name.startsWith('l0_')),
    detail: { stateDir: service.config.stateDir, prefixed: custom.tools },
  };
});

// 4. fail-closed
check('fail-closed: team_status 无 caller', async () => {
  const result = service.teamStatus(undefined);
  return { ok: result.ok === false && result.error === 'caller-required', detail: result };
});

check('fail-closed: 图操作无 core', async () => {
  const status = await service.graphStatus();
  const claim = await service.taskClaim({ nodeId: 'N-1' });
  return {
    ok: status.graph?.error === 'core-unavailable' && claim.error === 'core-unavailable',
    detail: { graphError: status.graph?.error, claimError: claim.error },
  };
});

check('fail-closed: evidence 产物缺失即拒', async () => {
  const result = await service.evidenceSubmit({ nodeId: 'N-1', artifactPath: 'definitely-missing.bin' });
  return { ok: result.ok === false && result.error === 'artifact-missing', detail: result };
});

check('fail-closed: evidence 无 acceptance 且无 verdict → acceptance-required', async () => {
  const present = path.join(workspaceRoot, 'present.txt');
  fs.writeFileSync(present, 'ok\n', 'utf8');
  const noJudge = await service.evidenceSubmit(
    { nodeId: 'N-1', artifactPath: 'present.txt', producer_instance: 'ROLE-CODE-01' },
    { id: 'session-selftest' },
  );
  const withVerdict = await service.evidenceSubmit(
    { nodeId: 'N-1', artifactPath: 'present.txt', producer_instance: 'ROLE-CODE-01', verdict: 'pass' },
    { id: 'session-selftest' },
  );
  return {
    ok: noJudge?.error === 'acceptance-required' && withVerdict?.error !== 'acceptance-required',
    detail: { noJudge: noJudge?.error, withVerdict: withVerdict?.error ?? 'reached-core' },
  };
});

// 5. export + 能力声明
check('export: 真写 capabilities.json / STATE.md', async () => {
  const result = await service.exportProjection({ outDir: '.l0-control-selftest/export' });
  const exists = result.files.every((file) => fs.existsSync(file));
  const caps = JSON.parse(fs.readFileSync(path.join(workspaceRoot, '.l0-control-selftest', 'export', 'capabilities.json'), 'utf8'));
  return {
    ok: result.ok === true && exists && caps.quality.supports_whitebox === false,
    detail: { files: result.files.length, supportsWhitebox: caps.quality.supports_whitebox },
  };
});

check('capabilities: native 分级覆盖 15 工具', () => {
  const grades = mod.CAPABILITIES.tools;
  const keys = Object.keys(grades);
  const nativeTools = keys.filter((key) => grades[key].grade === 'native');
  return {
    ok:
      keys.length === 15 &&
      nativeTools.includes('team_status') &&
      grades.team_status.nativeService === 'agentTeams' &&
      grades.project_init.grade === 'self-built',
    detail: { keys, nativeTools },
  };
});

check('native: 缺 caller 一律 fail-closed', async () => {
  const spawn = await service.spawnAgent({ role: 'CODE', task: 'x' }, undefined);
  const send = await service.sendMessage({ instanceId: 'ROLE-CODE-01', text: 'x' }, undefined);
  const create = await service.createTeamTask({ subject: 's', description: 'd' }, undefined);
  const update = await service.updateTeamTask({ taskId: 't', expectedRevision: 1, action: 'claim' }, undefined);
  return {
    ok:
      spawn?.error === 'caller-required' &&
      send?.error === 'caller-required' &&
      create?.error === 'caller-required' &&
      update?.error === 'caller-required',
    detail: { spawn: spawn?.error, send: send?.error, create: create?.error, update: update?.error },
  };
});

check('native: Lead 走 spawnTeammate / 非 Lead 回退 startActivation / member 走 agentTeams.sendMessage', async () => {
  const { NativeTeam } = await import(pathToFileURL(path.join(root, 'lib', 'native', 'team.js')).href);
  const lead = { id: 'session-lead' };
  const teammate = { id: 'session-teammate' };
  const spawnedMembers = [];
  const teamMessages = [];
  const fakeAgentTeams = {
    membership: (caller) => ({ role: caller?.id === 'session-lead' ? 'lead' : 'teammate', name: caller?.id }),
    spawnTeammate: async (caller, request) => {
      spawnedMembers.push(request);
      return { member: { id: 'sess-member-01', name: request.name, role: 'teammate', status: 'active' } };
    },
    listMembers: () => [{ id: 'sess-member-01', name: 'role-code-09', role: 'teammate', status: 'active' }],
    sendMessage: async (caller, request) => {
      teamMessages.push(request);
      return { messageId: 'msg-team-1' };
    },
    createTask: async () => ({ id: 't1', revision: 1 }),
    updateTask: async () => ({ id: 't1', revision: 2 }),
  };
  const fakeSubagents = {
    startActivation: async () => ({ childId: 'child-act-1', messageId: 'msg-act-1', result: Promise.resolve({}), dispose: async () => {} }),
    sendMessage: async () => 'msg-sub-1',
  };
  const ctx = {
    get: (key) => (key === 'agentTeams' ? fakeAgentTeams : key === 'subagents' ? fakeSubagents : undefined),
  };
  const team = new NativeTeam(ctx, { provider: 'spawn', maxDepth: 2 });

  const leadSpawn = await team.spawnAgent({ role: 'CODE', index: 9, task: 'x' }, lead);
  const subSpawn = await team.spawnAgent({ role: 'BUILD', index: 1, task: 'y' }, teammate);
  const memberSend = await team.sendMessage({ instanceId: 'role-code-09', text: 'hi' }, lead);
  const subSend = await team.sendMessage({ instanceId: 'role-build-01', text: 'hi' }, teammate);

  return {
    ok:
      leadSpawn?.via === 'spawnTeammate' &&
      leadSpawn?.memberName === 'role-code-09' &&
      leadSpawn?.instanceId === 'role-code-09' &&
      leadSpawn?.memberName === leadSpawn?.instanceId &&
      leadSpawn?.sessionId === 'sess-member-01' &&
      leadSpawn?.ownerCapable === true &&
      spawnedMembers[0]?.context === 'fresh' &&
      subSpawn?.via === 'startActivation' &&
      subSpawn?.instanceId === 'role-build-01' &&
      subSpawn?.ownerCapable === false &&
      memberSend?.via === 'agentTeams.sendMessage' &&
      teamMessages[0]?.target === 'role-code-09' &&
      subSend?.via === 'subagents.sendMessage',
    detail: {
      leadSpawn: { via: leadSpawn?.via, memberName: leadSpawn?.memberName, instanceId: leadSpawn?.instanceId, ownerCapable: leadSpawn?.ownerCapable },
      subSpawn: { via: subSpawn?.via, instanceId: subSpawn?.instanceId, ownerCapable: subSpawn?.ownerCapable },
      memberSend: { via: memberSend?.via, target: teamMessages[0]?.target ?? null },
      subSend: { via: subSend?.via },
      teammateRequest: spawnedMembers[0] ? { name: spawnedMembers[0].name, context: spawnedMembers[0].context, provider: spawnedMembers[0].provider } : null,
    },
  };
});

check('pass_gate: 非法阶段拒绝 / 合法阶段走 core', async () => {
  const bad = await service.passGate({ stage: 'nope' });
  const good = await service.passGate({ stage: 'research', evidenceRefs: ['README.md'] });
  return {
    ok: bad?.error === 'stage-invalid' && bad?.allowed?.length === 5 && good,
    detail: { bad: bad?.error, goodOk: good?.ok, stage: good?.result?.stage ?? null },
  };
});

check('normalize: camelCase 别名等价 / 冲突拒绝', async () => {
  const camel = await service.evidenceSubmit({ nodeId: 'N-X', artifactPath: 'definitely-missing', producerInstance: 'ROLE-CODE-01' }, { id: 's' });
  const conflict = await service.evidenceSubmit(
    { nodeId: 'N-X', artifactPath: 'definitely-missing', producer_instance: 'ROLE-CODE-01', producerInstance: 'ROLE-CODE-02' },
    { id: 's' },
  );
  return {
    // camel 别名已被识别（因此错误是 artifact-missing 而不是 producer-unknown）
    ok: camel?.error === 'artifact-missing' && conflict?.error === 'key-conflict',
    detail: { camelError: camel?.error, conflictError: conflict?.error },
  };
});

// 6. 卸载幂等（effect disposer 不抛）
check('bootstrap: project_init 默认 dry-run 零写入 + journal 记 planned/result', async () => {
  const target = 'projects/selftest-bootstrap';
  // 第二个轴要先放开：coordination=true + management='on'
  service.setSessionAccess('sess-selftest-boot', { coordination: true, management: 'on' }, 'selftest');
  const result = await service.projectInit({ projectName: 'Selftest Bootstrap', root: target }, 'sess-selftest-boot');
  const abs = path.resolve(workspaceRoot, target);
  const journal = service.readJournal().map((row) => row.kind);
  return {
    ok:
      result?.ok === true &&
      result?.dryRun === true &&
      fs.existsSync(abs) === false &&
      journal.includes('project_init_planned') &&
      journal.includes('project_init_result'),
    detail: {
      dryRun: result?.dryRun,
      conflicts: result?.conflicts,
      git: result?.git?.state,
      created: result?.actions?.filter((row) => row.status === 'created').length ?? null,
      journalTail: journal.slice(-4),
    },
  };
});

check('dispose: effect disposer 可执行', () => {
  if (typeof disposer !== 'function') return { ok: false, detail: 'apply 未返回 effect disposer' };
  disposer();
  const journal = service.journalSummary();
  return { ok: journal.events >= 1, detail: journal };
});

check('ui: 两个 session 快照隔离（reload 后各取各的，不串数据）', async () => {
  const { L0ControlService } = await import(pathToFileURL(path.join(root, 'lib', 'service.js')).href);
  // 不同 session 给出不同规模的团队板，用来验证"不跨 session 复用"
  const teamsFor = (sessionId) => ({
    membership: () => ({ rootId: 'root-1', id: sessionId, role: 'teammate', name: `name-${sessionId}` }),
    listMembers: () => {
      const count = sessionId === 'sess-a' ? 2 : 3;
      return Array.from({ length: count }, (_, index) => ({ id: `m-${sessionId}-${index}`, name: `m${index}`, role: 'teammate', status: 'active' }));
    },
    listTasks: () => {
      const count = sessionId === 'sess-a' ? 1 : 4;
      return Array.from({ length: count }, (_, index) => ({ id: `t-${sessionId}-${index}`, subject: `task ${index}`, status: 'pending', revision: 1, ownerName: null }));
    },
  });
  const ctxFor = (sessionId) => ({
    get: (key) => (key === 'agentTeams' ? teamsFor(sessionId) : undefined),
    provide: () => {},
    effect: () => {},
    tools: { register: () => {} },
  });
  const stateDir = '.l0-control-ui-sessions';

  // 会话 A、B 各自投影一次（写各自的 team_snapshot）
  const svcA = new L0ControlService(ctxFor('sess-a'), { workspaceRoot, stateDir }, {});
  svcA.teamStatus({ id: 'sess-a' });
  const svcB = new L0ControlService(ctxFor('sess-b'), { workspaceRoot, stateDir }, {});
  svcB.teamStatus({ id: 'sess-b' });

  // 模拟 reload：同 stateDir、无 live caller
  const reloaded = new L0ControlService(ctxFor('sess-a'), { workspaceRoot, stateDir }, {});
  const snapA = await reloaded.uiSnapshot({ sessionId: 'sess-a' });
  const snapB = await reloaded.uiSnapshot({ sessionId: 'sess-b' });
  const a = snapA?.team ?? {};
  const b = snapB?.team ?? {};
  const aMembers = Array.isArray(a.members) ? a.members.length : 0;
  const bMembers = Array.isArray(b.members) ? b.members.length : 0;
  const aTasks = Array.isArray(a.tasks) ? a.tasks.length : 0;
  const bTasks = Array.isArray(b.tasks) ? b.tasks.length : 0;
  return {
    ok:
      a?.source === 'snapshot' &&
      b?.source === 'snapshot' &&
      a?.sessionId === 'sess-a' &&
      b?.sessionId === 'sess-b' &&
      aMembers === 2 &&
      bMembers === 3 &&
      aTasks === 1 &&
      bTasks === 4 &&
      snapA?.sessions?.length === 2,
    detail: {
      a: { source: a?.source, sessionId: a?.sessionId, members: aMembers, tasks: aTasks },
      b: { source: b?.source, sessionId: b?.sessionId, members: bMembers, tasks: bTasks },
      sessions: (snapA?.sessions ?? []).map((row) => row.sessionId),
    },
  };
});

check('ui: 未知 session / 未指定 session → source=none（不借用别人的快照）', async () => {
  const { L0ControlService } = await import(pathToFileURL(path.join(root, 'lib', 'service.js')).href);
  const fakeTeams = {
    membership: () => ({ rootId: 'root-1', id: 'sess-a', role: 'teammate', name: 'a' }),
    listMembers: () => [{ id: 'm1', name: 'm1', role: 'teammate', status: 'active' }],
    listTasks: () => [{ id: 't1', subject: 'x', status: 'pending', revision: 1, ownerName: null }],
  };
  const ctx = { get: (key) => (key === 'agentTeams' ? fakeTeams : undefined), provide: () => {}, effect: () => {}, tools: { register: () => {} } };
  const stateDir = '.l0-control-ui-unknown';
  const seed = new L0ControlService(ctx, { workspaceRoot, stateDir }, {});
  seed.teamStatus({ id: 'sess-a' });

  const fresh = new L0ControlService(ctx, { workspaceRoot, stateDir }, {});
  const unknown = await fresh.uiSnapshot({ sessionId: 'sess-zzz' });
  const noSession = await fresh.uiSnapshot();
  return {
    ok:
      unknown?.team?.source === 'none' &&
      unknown?.team?.error === 'no-snapshot-for-session' &&
      noSession?.team?.source === 'none' &&
      noSession?.team?.error === 'session-required' &&
      (unknown?.sessions ?? []).every((row) => row.sessionId !== 'sess-zzz'),
    detail: {
      unknown: { source: unknown?.team?.source, error: unknown?.team?.error },
      noSession: { source: noSession?.team?.source, error: noSession?.team?.error },
      sessions: (unknown?.sessions ?? []).map((row) => row.sessionId),
    },
  };
});

check('ui-server: ?sessionId= 透传到 getSnapshot（无参数时 undefined）', async () => {
  const { startUiServer } = await import(pathToFileURL(path.join(root, 'lib', 'ui-server.js')).href);
  const seen = [];
  const handle = await startUiServer({
    port: 0,
    getSnapshot: (sessionId) => {
      seen.push(sessionId ?? null);
      return { ok: true, team: { source: 'none', sessionId: sessionId ?? null } };
    },
  });
  try {
    const withId = await (await fetch(`${handle.url}/ui/snapshot?sessionId=sess-a`)).json();
    const without = await (await fetch(`${handle.url}/ui/snapshot`)).json();
    return {
      ok:
        seen[0] === 'sess-a' &&
        seen[1] === null &&
        withId?.team?.sessionId === 'sess-a' &&
        without?.team?.sessionId === null,
      detail: { seen, withId: withId?.team, without: without?.team },
    };
  } finally {
    await handle.close();
  }
});

check('access: 默认 disabled / 启用 / 停用 / reload 恢复 / 跨 session 不串', async () => {
  const { L0ControlService } = await import(pathToFileURL(path.join(root, 'lib', 'service.js')).href);
  const ctx = { get: () => undefined, provide: () => {}, effect: () => {}, tools: { register: () => {} } };
  const stateDir = '.l0-control-access';
  const svc = new L0ControlService(ctx, { workspaceRoot, stateDir }, {});

  const before = svc.isSessionEnabled('sess-1');
  const enabled = svc.setSessionEnabled('sess-1', true, 'test');
  const afterEnable = svc.isSessionEnabled('sess-1');
  const other = svc.isSessionEnabled('sess-2'); // 没记录 = 停用
  const snap = svc.uiSnapshot ? null : null;
  const access = svc.accessSnapshot();

  const reloaded = new L0ControlService(ctx, { workspaceRoot, stateDir }, {});
  const afterReload = reloaded.isSessionEnabled('sess-1');
  const otherAfterReload = reloaded.isSessionEnabled('sess-2');
  const disabled = reloaded.setSessionEnabled('sess-1', false, 'test');
  const afterDisable = reloaded.isSessionEnabled('sess-1');
  const reloadedAgain = new L0ControlService(ctx, { workspaceRoot, stateDir }, {});
  return {
    ok:
      before === false &&
      enabled?.ok === true &&
      afterEnable === true &&
      other === false &&
      access?.default === 'disabled' &&
      access?.sessions?.length >= 1 &&
      afterReload === true &&
      otherAfterReload === false &&
      disabled?.enabled === false &&
      afterDisable === false &&
      reloadedAgain.isSessionEnabled('sess-1') === false,
    detail: { before, afterEnable, other, afterReload, otherAfterReload, afterDisable, sessions: access?.sessions?.length ?? null },
  };
});

check('access: 双轴 —— 默认/只协作/管理 off-auto-on/旧记录迁移/reload/隔离', async () => {
  const { L0ControlService } = await import(pathToFileURL(path.join(root, 'lib', 'service.js')).href);
  const ctx = { get: () => undefined, provide: () => {}, effect: () => {}, tools: { register: () => {} } };
  const stateDir = '.l0-control-access-axes';

  // 旧记录迁移：直接塞一条只有 enabled 的 access_changed 到 journal
  fs.mkdirSync(path.resolve(workspaceRoot, stateDir), { recursive: true });
  fs.writeFileSync(
    path.resolve(workspaceRoot, stateDir, 'journal.jsonl'),
    `${JSON.stringify({ at: '2026-10-29T00:00:00.000Z', kind: 'access_changed', sessionId: 'sess-legacy', enabled: true, by: 'old' })}\n`,
    'utf8',
  );

  const svc = new L0ControlService(ctx, { workspaceRoot, stateDir }, {});
  const legacyCoordination = svc.isSessionEnabled('sess-legacy');
  const legacyManagement = svc.managementFor('sess-legacy');
  const defaultCoordination = svc.isSessionEnabled('sess-new');
  const defaultManagement = svc.managementFor('sess-new');

  // 只开协作：project_init 必须被 management-disabled 挡
  svc.setSessionAccess('sess-coord', { coordination: true }, 'test');
  const coordOnly = {
    coordination: svc.isSessionEnabled('sess-coord'),
    management: svc.managementFor('sess-coord'),
  };
  const blocked = await svc.projectInit({ projectName: 'blocked', dryRun: true }, 'sess-coord');

  // auto：放行（AI 决定），dry-run 不做任何写
  svc.setSessionAccess('sess-coord', { management: 'auto' }, 'test');
  const autoResult = await svc.projectInit({ projectName: 'auto-proj', dryRun: true }, 'sess-coord');

  // 关掉管理：立刻回到拒绝
  svc.setSessionAccess('sess-coord', { management: 'off' }, 'test');
  const backToOff = await svc.projectInit({ projectName: 'off-again', dryRun: true }, 'sess-coord');

  // reload：两轴都恢复；双轴独立（只改管理不动协作）
  const reloaded = new L0ControlService(ctx, { workspaceRoot, stateDir }, {});
  const reloadedCoord = reloaded.isSessionEnabled('sess-coord');
  const reloadedMgmt = reloaded.managementFor('sess-coord');
  reloaded.setSessionAccess('sess-coord', { management: 'on' }, 'test');
  const afterMgmtOnly = { coordination: reloaded.isSessionEnabled('sess-coord'), management: reloaded.managementFor('sess-coord') };

  return {
    ok:
      legacyCoordination === true &&
      legacyManagement === 'off' &&
      defaultCoordination === false &&
      defaultManagement === 'off' &&
      coordOnly.coordination === true &&
      coordOnly.management === 'off' &&
      blocked?.error === 'management-disabled' &&
      autoResult?.ok === true &&
      autoResult?.dryRun === true &&
      backToOff?.error === 'management-disabled' &&
      reloadedCoord === true &&
      reloadedMgmt === 'off' &&
      afterMgmtOnly.coordination === true &&
      afterMgmtOnly.management === 'on',
    detail: {
      legacy: { coordination: legacyCoordination, management: legacyManagement },
      defaults: { coordination: defaultCoordination, management: defaultManagement },
      coordOnly,
      blocked: blocked?.error ?? null,
      auto: { ok: autoResult?.ok, dryRun: autoResult?.dryRun },
      backToOff: backToOff?.error ?? null,
      reloaded: { coordination: reloadedCoord, management: reloadedMgmt },
      afterMgmtOnly,
    },
  };
});

check('access: uiSnapshot.access 反映当前 session（不借用别人的启用态）', async () => {
  const { L0ControlService } = await import(pathToFileURL(path.join(root, 'lib', 'service.js')).href);
  const ctx = { get: () => undefined, provide: () => {}, effect: () => {}, tools: { register: () => {} } };
  const stateDir = '.l0-control-access-ui';
  const svc = new L0ControlService(ctx, { workspaceRoot, stateDir }, {});
  svc.setSessionEnabled('sess-on', true, 'test');
  const on = await svc.uiSnapshot({ sessionId: 'sess-on' });
  const off = await svc.uiSnapshot({ sessionId: 'sess-off' });
  return {
    ok:
      on?.access?.enabled === true &&
      on?.access?.default === 'disabled' &&
      off?.access?.enabled === false &&
      off?.team?.source === 'none',
    detail: { on: on?.access, off: off?.access, offTeam: off?.team?.source },
  };
});

check('ui-server: GET/POST /ui/access 往返 + 非法体 400', async () => {
  const { startUiServer } = await import(pathToFileURL(path.join(root, 'lib', 'ui-server.js')).href);
  const store = new Map();
  const handle = await startUiServer({
    port: 0,
    getSnapshot: () => ({ ok: true }),
    getAccess: (sessionId) => ({ ok: true, sessionId: sessionId ?? null, enabled: store.get(sessionId) === true, default: 'disabled' }),
    setAccess: ({ sessionId, enabled, by }) => {
      store.set(sessionId, enabled === true);
      return { ok: true, sessionId, enabled: enabled === true, by: by ?? null };
    },
  });
  try {
    const before = await (await fetch(`${handle.url}/ui/access?sessionId=sess-a`)).json();
    const post = await (await fetch(`${handle.url}/ui/access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-a', enabled: true, by: 'test' }),
    })).json();
    const after = await (await fetch(`${handle.url}/ui/access?sessionId=sess-a`)).json();
    const bad = await fetch(`${handle.url}/ui/access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    return {
      ok:
        before?.enabled === false &&
        post?.ok === true &&
        post?.enabled === true &&
        after?.enabled === true &&
        bad.status === 400,
      detail: { before: before?.enabled, post: post?.enabled, after: after?.enabled, badStatus: bad.status },
    };
  } finally {
    await handle.close();
  }
});

check('pool: A/B 两工作区独立 journal / counts 不串 / 不抢锁 / registry reload 恢复', async () => {
  const { ServicePool } = await import(pathToFileURL(path.join(root, 'lib', 'workspaces', 'pool.js')).href);
  const { L0ControlService } = await import(pathToFileURL(path.join(root, 'lib', 'service.js')).href);
  const primary = path.join(workspaceRoot, 'pool-primary');
  const other = path.join(workspaceRoot, 'pool-other');
  fs.mkdirSync(primary, { recursive: true });
  fs.mkdirSync(other, { recursive: true });

  const makeCtx = (cwd) => ({
    get: (key) => (key === 'workingDirectory' ? { ensure: () => cwd, defaultDirectory: cwd } : undefined),
    provide: () => {},
    effect: () => {},
    tools: { register: () => {} },
  });

  const cfg = { workspaceRoot: primary, stateDir: '.l0-control-primary', persistence: 'node', persistenceDir: 'core-state' };
  const pool = new ServicePool({
    ctx: makeCtx(primary),
    config: cfg,
    createService: (c, c2, m) => new L0ControlService(c, c2, m),
    primaryRoot: primary,
    primaryStateDir: cfg.stateDir,
  });
  const primarySvc = new L0ControlService(makeCtx(primary), cfg, {});
  pool.adopt(primarySvc);

  const a = pool.get(primary);
  const b = pool.get(other);
  const dirsOk = a.stateDir === path.resolve(primary, cfg.stateDir) && b.stateDir === path.resolve(other, '.l0-control');
  const pathsDiffer = a.journalPath !== b.journalPath;

  const wishA = await a.wishSubmit({ text: 'A 的愿望' });
  const wishB = await b.wishSubmit({ text: 'B 的愿望' });
  const statusA = await a.graphStatus();
  const statusB = await b.graphStatus();
  const countsA = statusA?.graph?.result?.counts ?? statusA?.graph?.counts ?? null;
  const countsB = statusB?.graph?.result?.counts ?? statusB?.graph?.counts ?? null;

  const [claimA, claimB] = await Promise.all([
    a.taskClaim({ nodeId: 'NODE-RESEARCH', role: 'CODE', instanceId: 'role-code-01' }),
    b.taskClaim({ nodeId: 'NODE-RESEARCH', role: 'CODE', instanceId: 'role-code-02' }),
  ]);

  const poolForOther = new ServicePool({
    ctx: makeCtx(other),
    config: cfg,
    createService: (c, c2, m) => new L0ControlService(c, c2, m),
    primaryRoot: primary,
    primaryStateDir: cfg.stateDir,
  });
  const resolvedOther = pool.resolveWorkspaceRoot({ id: 'x' });
  const resolved = poolForOther.resolveWorkspaceRoot({ id: 'x' });

  const reopened = new ServicePool({
    ctx: makeCtx(primary),
    config: cfg,
    createService: (c, c2, m) => new L0ControlService(c, c2, m),
    primaryRoot: primary,
    primaryStateDir: cfg.stateDir,
  });
  const listed = await reopened.list();
  const roots = listed.map((row) => row.workspaceRoot);

  // journal 隔离：A 的愿望只出现在 A 的 journal，B 的只在 B 的
  const journalA = fs.readFileSync(a.journalPath, 'utf8');
  const journalB = fs.readFileSync(b.journalPath, 'utf8');
  const isolationOk = journalA.includes('A 的愿望') && !journalA.includes('B 的愿望') && journalB.includes('B 的愿望') && !journalB.includes('A 的愿望');

  return {
    ok:
      dirsOk &&
      pathsDiffer &&
      isolationOk &&
      fs.existsSync(a.journalPath) &&
      fs.existsSync(b.journalPath) &&
      (countsA?.nodes ?? 0) === 6 &&
      (countsB?.nodes ?? 0) === 6 &&
      claimA?.ok === true &&
      claimB?.ok === true &&
      resolved === path.resolve(other) &&
      resolvedOther === path.resolve(primary) &&
      roots.includes(path.resolve(primary)) &&
      roots.includes(path.resolve(other)),
    detail: {
      dirs: { a: a.stateDir, b: b.stateDir },
      journals: { a: a.journalPath, b: b.journalPath },
      counts: { a: countsA, b: countsB },
      wishes: { a: wishA?.ok, b: wishB?.ok },
      claims: { a: claimA?.ok, b: claimB?.ok },
      resolved: { primary: resolvedOther, other: resolved },
      registryRoots: roots,
    },
  };
});

check('descendants: teamStatus 后落快照；reload 无 caller 仍返回 36/0；未知 session none', async () => {
  const { L0ControlService } = await import(pathToFileURL(path.join(root, 'lib', 'service.js')).href);
  const children = Array.from({ length: 36 }, (_, index) => ({ id: `c-${index}`, kind: 'child', activity: 'inactive', parentId: 'sess-d' }));
  children[0] = { ...children[0], activity: 'running' };
  const fakeTeams = {
    membership: () => ({ rootId: 'root', id: 'sess-d', role: 'teammate', name: 'x' }),
    listMembers: () => [{ id: 'sess-d', name: 'x', role: 'teammate', status: 'running' }],
    listTasks: () => [{ id: 't1', subject: 'y', status: 'pending', revision: 1, ownerName: null }],
  };
  const fakeSubagents = { listDescendants: async () => children };
  const ctx = {
    get: (key) => (key === 'agentTeams' ? fakeTeams : key === 'subagents' ? fakeSubagents : undefined),
    provide: () => {},
    effect: () => {},
    tools: { register: () => {} },
  };
  const stateDir = '.l0-control-descendants';
  const svc = new L0ControlService(ctx, { workspaceRoot, stateDir }, {});
  svc.teamStatus({ id: 'sess-d' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const hasSnapshot = svc.readJournal().some((row) => row.kind === 'descendants_snapshot' && row.sessionId === 'sess-d');
  const liveSnap = await svc.uiSnapshot({ sessionId: 'sess-d' });

  const reloaded = new L0ControlService(ctx, { workspaceRoot, stateDir }, {});
  const reloadedSnap = await reloaded.uiSnapshot({ sessionId: 'sess-d' });
  const unknownSnap = await reloaded.uiSnapshot({ sessionId: 'sess-zzz' });

  return {
    ok:
      hasSnapshot === true &&
      liveSnap?.descendants?.source === 'live' &&
      liveSnap?.descendants?.count === 36 &&
      reloadedSnap?.descendants?.source === 'snapshot' &&
      reloadedSnap?.descendants?.count === 36 &&
      reloadedSnap?.descendants?.active === 1 &&
      typeof reloadedSnap?.descendants?.capturedAt === 'string' &&
      unknownSnap?.descendants?.source === 'none' &&
      unknownSnap?.descendants?.count === 0,
    detail: {
      hasSnapshot,
      live: { source: liveSnap?.descendants?.source, count: liveSnap?.descendants?.count },
      reloaded: {
        source: reloadedSnap?.descendants?.source,
        count: reloadedSnap?.descendants?.count,
        active: reloadedSnap?.descendants?.active,
      },
      unknown: { source: unknownSnap?.descendants?.source, count: unknownSnap?.descendants?.count },
    },
  };
});

check('update: fake fetch 四种情形（有新版/已最新/404/网络炸）', async () => {
  const { L0ControlService } = await import(pathToFileURL(path.join(root, 'lib', 'service.js')).href);
  const ctx = { get: () => undefined, provide: () => {}, effect: () => {}, tools: { register: () => {} } };
  const svc = new L0ControlService(ctx, { workspaceRoot, stateDir: '.l0-control-update' }, {});

  const jsonFetch = (version) => async () => ({ ok: true, status: 200, json: async () => ({ version }) });
  const newer = await svc.checkUpdate({ fetchImpl: jsonFetch('9.9.9') });
  const same = await svc.checkUpdate({ fetchImpl: jsonFetch(newer.currentVersion) });
  const notFound = await svc.checkUpdate({ fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  const broken = await svc.checkUpdate({
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  // 空 repo = 关闭检查
  const disabled = new L0ControlService(ctx, { workspaceRoot, stateDir: '.l0-control-update', updateRepo: '' }, {});
  const off = await disabled.checkUpdate({ fetchImpl: jsonFetch('9.9.9') });

  return {
    ok:
      newer?.ok === true &&
      newer?.available === true &&
      newer?.latestVersion === '9.9.9' &&
      typeof newer?.url === 'string' &&
      newer.url.includes('raw.githubusercontent.com') &&
      same?.ok === true &&
      same?.available === false &&
      notFound?.ok === false &&
      notFound?.error === 'remote-not-found' &&
      broken?.ok === false &&
      broken?.error === 'network-failed' &&
      off?.ok === false &&
      off?.error === 'update-repo-not-configured',
    detail: {
      newer: { ok: newer?.ok, available: newer?.available, current: newer?.currentVersion, latest: newer?.latestVersion },
      same: { ok: same?.ok, available: same?.available },
      notFound: notFound?.error,
      broken: broken?.error,
      off: off?.error,
    },
  };
});

check('update: /ui/update-check 走 getUpdateInfo（fail-soft，不 500）', async () => {
  const { startUiServer } = await import(pathToFileURL(path.join(root, 'lib', 'ui-server.js')).href);
  const handle = await startUiServer({
    port: 0,
    getSnapshot: () => ({ ok: true }),
    getUpdateInfo: () => ({ ok: true, available: true, currentVersion: '0.1.0', latestVersion: '0.2.0' }),
  });
  const failing = await startUiServer({
    port: 0,
    getSnapshot: () => ({ ok: true }),
    getUpdateInfo: () => {
      throw new Error('boom');
    },
  });
  try {
    const okRes = await fetch(`${handle.url}/ui/update-check`);
    const okJson = await okRes.json();
    const failRes = await fetch(`${failing.url}/ui/update-check`);
    const failJson = await failRes.json();
    return {
      ok:
        okRes.status === 200 &&
        okJson?.available === true &&
        okJson?.latestVersion === '0.2.0' &&
        failRes.status === 200 &&
        failJson?.ok === false &&
        failJson?.error === 'update-check-failed',
      detail: { ok: okJson, failStatus: failRes.status, fail: failJson },
    };
  } finally {
    await handle.close();
    await failing.close();
  }
});

// 7. 工具输出契约夹具
check('ui-server: POST /ui/project-init（preview 零写入 / 创建落位 / management=off → 409）', async () => {
  const { startUiServer } = await import(pathToFileURL(path.join(root, 'lib', 'ui-server.js')).href);
  const { L0ControlService } = await import(pathToFileURL(path.join(root, 'lib', 'service.js')).href);
  const ctx = { get: () => undefined, provide: () => {}, effect: () => {}, tools: { register: () => {} } };
  const stateDir = '.l0-control-ui-init';
  const svc = new L0ControlService(ctx, { workspaceRoot, stateDir }, {});
  svc.setSessionAccess('sess-init', { coordination: true, management: 'auto' }, 'test');

  const handle = await startUiServer({
    port: 0,
    getSnapshot: () => ({ ok: true }),
    projectInit: (input) => svc.projectInit({ ...input }, input?.sessionId),
  });
  const ws = path.join(workspaceRoot, 'ui-ws');
  fs.mkdirSync(ws, { recursive: true });
  const post = (body) =>
    fetch(`${handle.url}/ui/project-init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    const previewRes = await post({ sessionId: 'sess-init', workspaceRoot: ws, projectName: 'UiPreview', dryRun: true });
    const preview = await previewRes.json();
    const previewRoot = path.join(ws, 'projects', 'uipreview');

    const createRes = await post({ sessionId: 'sess-init', workspaceRoot: ws, projectName: 'UiCreate', dryRun: false });
    const created = await createRes.json();
    const createdRoot = path.join(ws, 'projects', 'uicreate');

    svc.setSessionAccess('sess-init', { management: 'off' }, 'test');
    const offRes = await post({ sessionId: 'sess-init', workspaceRoot: ws, projectName: 'UiOff', dryRun: false });
    const off = await offRes.json();

    return {
      ok:
        previewRes.status === 200 &&
        preview?.ok === true &&
        preview?.dryRun === true &&
        !fs.existsSync(previewRoot) &&
        createRes.status === 200 &&
        created?.ok === true &&
        created?.dryRun === false &&
        fs.existsSync(path.join(createdRoot, 'README.md')) &&
        fs.existsSync(`${createdRoot}-管理区`) &&
        offRes.status === 409 &&
        off?.error === 'management-disabled' &&
        !fs.existsSync(path.join(ws, 'projects', 'uioff')),
      detail: {
        preview: { status: previewRes.status, ok: preview?.ok, dryRun: preview?.dryRun, wrote: fs.existsSync(previewRoot) },
        create: { status: createRes.status, root: created?.project?.root, mgmt: created?.project?.managementDir },
        off: { status: offRes.status, error: off?.error },
      },
    };
  } finally {
    await handle.close();
  }
});

// 7. 工具输出契约夹具
check('contract: 9 工具输出形状 + 投影硬化', () => {
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'scripts', 'contract.mjs')], {
      cwd: root,
      encoding: 'utf8',
    });
    const report = JSON.parse(out);
    return { ok: report.ok === true, detail: { checks: report.checks, failed: report.failed } };
  } catch (error) {
    return { ok: false, detail: { message: String(error?.message || error) } };
  }
});

const failed = checks.filter((row) => !row.ok);
const report = { ok: failed.length === 0, total: checks.length, failed: failed.length, checks };
if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(report, null, 2));
} else {
  for (const row of checks) process.stdout.write(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}\n`);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
}
fs.rmSync(workspaceRoot, { recursive: true, force: true });
process.exit(report.ok ? 0 : 1);
