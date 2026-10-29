/**
 * 工具输出契约夹具：把 9 个工具的**返回形状**钉成可执行断言。
 *
 * 为什么需要：工具输出直接过宿主校验（必须 lossless JSON）；形状一改，
 * 上游 Agent 的解析就断。这里用 stub ctx 把 9 条路径都跑一遍，逐字段校验类型，
 * 并把样本写到 `fixtures/tool-outputs.json` 供评审与回归 diff。
 *
 * 用法：
 *   node scripts/contract.mjs           # 校验（失败退出码 1）
 *   node scripts/contract.mjs --write   # 校验并回写 samples
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const write = process.argv.includes('--write');

// ── 形状规格：key → 类型（object/array 取类型；嵌套用对象字面量） ──
const SPEC = {
  wish_submit: { required: { ok: 'boolean' }, optional: { action: 'string', error: 'string', hint: 'string', detail: 'object' } },
  graph_status: {
    required: {
      ok: 'boolean',
      journal: { path: 'string', events: 'number', lastKind: 'string|null' },
      stateDir: 'string',
      snapshotExists: 'boolean',
      capabilities: { plugin: 'string', toolCount: 'number', grades: 'object', supports_whitebox: 'boolean' },
      graph: 'object',
    },
  },
  task_next: { required: { ok: 'boolean' }, optional: { action: 'string', result: 'object', error: 'string' } },
  project_init: {
    required: {
      ok: 'boolean',
      dryRun: 'boolean',
      project: { name: 'string', slug: 'string', root: 'string', managementDir: 'string', marker: 'string' },
      actions: 'array',
      conflicts: 'array',
      git: { state: 'string' },
      next: 'string',
    },
  },
  task_claim: { required: { ok: 'boolean' }, optional: { action: 'string', result: 'object', error: 'string' } },
  evidence_submit: { required: { ok: 'boolean' }, optional: { action: 'string', error: 'string', resolved: 'string', hint: 'string' } },
  verify_done: { required: { ok: 'boolean' }, optional: { action: 'string', error: 'string', result: 'object' } },
  decide: { required: { ok: 'boolean' }, optional: { action: 'string', error: 'string', result: 'object' } },
  pass_gate: { required: { ok: 'boolean' }, optional: { action: 'string', error: 'string', result: 'object', stage: 'string' } },
  team_status: {
    required: {
      ok: 'boolean',
      native: 'boolean',
      caller: 'string',
      membership: { rootId: 'string', id: 'string', role: 'string', name: 'string' },
      memberCount: 'number',
      taskCount: 'number',
    },
  },
  export: { required: { ok: 'boolean', outDir: 'string', files: 'array' }, optional: { core: 'object' } },
};

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matches(value, spec, pathLabel, issues) {
  if (typeof spec === 'string') {
    const expected = spec.split('|');
    const actual = typeOf(value);
    if (!expected.includes(actual) && !(expected.includes('object') && actual === 'object')) {
      issues.push(`${pathLabel}: 期望 ${spec}，实际 ${actual}`);
    }
    return;
  }
  if (typeOf(value) !== 'object') {
    issues.push(`${pathLabel}: 期望 object，实际 ${typeOf(value)}`);
    return;
  }
  for (const [key, sub] of Object.entries(spec)) {
    if (!(key in value)) {
      issues.push(`${pathLabel}.${key}: 缺失`);
      continue;
    }
    matches(value[key], sub, `${pathLabel}.${key}`, issues);
  }
}

function validate(toolName, value) {
  const issues = [];
  const spec = SPEC[toolName];
  if (!spec) return [`${toolName}: 没有声明 SPEC`];
  if (typeOf(value) !== 'object') return [`${toolName}: 顶层不是 object（${typeOf(value)}）`];
  for (const [key, kind] of Object.entries(spec.required ?? {})) {
    if (!(key in value)) issues.push(`${toolName}.${key}: 缺失（required）`);
    else matches(value[key], kind, `${toolName}.${key}`, issues);
  }
  for (const [key, kind] of Object.entries(spec.optional ?? {})) {
    if (key in value) matches(value[key], kind, `${toolName}.${key}`, issues);
  }
  // lossless：必须能被 JSON 往返而不丢东西
  try {
    const round = JSON.parse(JSON.stringify(value));
    if (JSON.stringify(round) !== JSON.stringify(value)) issues.push(`${toolName}: JSON 往返不一致（非 lossless）`);
  } catch (error) {
    issues.push(`${toolName}: 不可 JSON 化（${String(error?.message || error)}）`);
  }
  return issues;
}

// ── stub ctx：喂进"脏"的 agentTeams 值，验证投影确实兜住了 ──
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'l0control-contract-'));
fs.writeFileSync(path.join(workspaceRoot, 'present.txt'), 'ok\n', 'utf8');

const caller = { id: 'session-contract-caller' };
const dirtyMembers = [
  { id: 'session-1', name: 'lead', role: 'lead', status: 'running', model: 'm', provider: undefined, diagnostics: ['x'], context: 'fork' },
  { id: 'session-2', name: 'peer', role: 'teammate', status: 'inactive', model: 'm', provider: 'spawn', diagnostics: [], context: 'fresh' },
];
const dirtyTasks = [
  { id: 'task-1', revision: 3, subject: 's', status: 'completed', ownerName: 'peer', ready: false, blockedBy: ['task-0'], writeScopeWarnings: [] },
];
const fakeAgentTeams = {
  membership: () => ({ root: { id: 'session-root', nested: { deep: true } }, id: 'team-1', role: 'teammate', name: 'contract-peer' }),
  listMembers: () => dirtyMembers,
  listTasks: () => dirtyTasks,
};

const provided = {};
const registered = [];
const ctx = {
  get: (key) => (key === 'agentTeams' ? fakeAgentTeams : undefined),
  provide: (key, value) => {
    provided[key] = value;
  },
  effect: (fn) => fn(),
  tools: { register: (tool) => registered.push(tool.name) },
};

const mod = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href);
mod.apply(ctx, { workspaceRoot, stateDir: '.l0-contract' });

const service = provided.l0control;
const exec = { agent: caller };
// 双轴 access：契约夹具先开协作 + 管理（否则 project_init 会被 management-disabled 挡）
const CONTRACT_SESSION = caller?.id ?? 'contract-session';
service.setSessionAccess(CONTRACT_SESSION, { coordination: true, management: 'on' }, 'contract');

const calls = {
  wish_submit: () => service.wishSubmit({ text: '契约夹具用愿望' }),
  graph_status: () => service.graphStatus(),
  task_next: () => service.taskNext({ role: 'CODE' }),
  task_claim: () => service.taskClaim({ nodeId: 'N-1', role: 'CODE', instanceId: 'ROLE-CODE-01' }),
  evidence_submit: () =>
    service.evidenceSubmit(
      {
        nodeId: 'N-1',
        artifactPath: 'present.txt',
        verifier: 'contract',
        acceptance: { kind: 'contains', expected: 'ok' },
        producer_instance: 'ROLE-CODE-01',
      },
      exec.agent,
    ),
  verify_done: () =>
    service.verifyDone(
      { nodeId: 'N-1', acceptance: { kind: 'exists' }, producer_instance: 'ROLE-CODE-01', auditor_instance: 'ROLE-AUDIT_CODE-01' },
      exec.agent,
    ),
  decide: () => service.decide({ decisionId: 'DEC-1', level: 'L0', optionId: 'default' }),
  pass_gate: () => service.passGate({ stage: 'research', evidence_refs: ['README.md'] }),
  team_status: () => service.teamStatus(caller ?? exec.agent),
  export: () => service.exportProjection({ outDir: '.l0-contract/export' }),
  project_init: () => service.projectInit({ projectName: 'contract-fixture', dryRun: true }, CONTRACT_SESSION),
};

// 门禁负例：每条都必须被拒，且错误码稳定
const gateCases = [
  {
    name: 'evidence_submit#producer-unknown',
    run: () => service.evidenceSubmit({ nodeId: 'N-2', artifactPath: 'present.txt' }, exec.agent),
    expect: 'producer-unknown',
  },
  {
    name: 'verify_done#auditor-required',
    run: () => service.verifyDone({ nodeId: 'N-2', producer_instance: 'ROLE-CODE-01' }, exec.agent),
    expect: 'auditor-required',
  },
  {
    name: 'verify_done#audit-independence-violated',
    run: () =>
      service.verifyDone(
        { nodeId: 'N-2', producer_instance: 'ROLE-AUDIT_CODE-01', auditor_instance: 'ROLE-AUDIT_CODE-01' },
        exec.agent,
      ),
    expect: 'audit-independence-violated',
  },
  {
    name: 'verify_done#auditor-role-required',
    run: () =>
      service.verifyDone(
        { nodeId: 'N-2', producer_instance: 'ROLE-CODE-01', auditor_instance: 'ROLE-CODE-02' },
        exec.agent,
      ),
    expect: 'auditor-role-required',
  },
  {
    name: 'pass_gate#stage-invalid',
    run: () => service.passGate({ stage: 'nope' }),
    expect: 'stage-invalid',
  },
  {
    name: 'evidence_submit#acceptance-required',
    run: () =>
      service.evidenceSubmit({ nodeId: 'N-5', artifactPath: 'present.txt', producer_instance: 'ROLE-CODE-01' }, exec.agent),
    expect: 'acceptance-required',
  },
  {
    name: 'evidence_submit#key-conflict',
    run: () =>
      service.evidenceSubmit(
        { nodeId: 'N-3', artifactPath: 'present.txt', producer_instance: 'ROLE-CODE-01', producerInstance: 'ROLE-CODE-02' },
        exec.agent,
      ),
    expect: 'key-conflict',
  },
  {
    name: 'evidence_submit#camel-alias-accepted',
    run: async () => {
      const value = await service.evidenceSubmit(
        { nodeId: 'N-4', artifactPath: 'present.txt', producerInstance: 'ROLE-CODE-01' },
        exec.agent,
      );
      // 别名归一化后应走到 core（而不是 producer-unknown）
      return value?.error === 'producer-unknown' ? { ok: false, error: 'alias-not-normalized', value } : value;
    },
    expect: null, // 只要求不是 producer-unknown；具体错误由 core 决定
  },
];

// expect === null 的用例只断言「ok 为 false 且 error 不为 aliasing 失败」
const looseCases = new Set(['evidence_submit#camel-alias-accepted']);

const results = [];
const samples = {};
for (const [toolName, run] of Object.entries(calls)) {
  const value = await run();
  const issues = validate(toolName, value);
  results.push({ tool: toolName, ok: issues.length === 0, issues });
  samples[toolName] = value;
}

// team_status 额外断言：脏字段不得出现、Agent 句柄不得出现
const teamIssues = [];
const team = samples.team_status;
for (const member of team.members ?? []) {
  for (const banned of ['context', 'diagnostics', 'nested']) {
    if (banned in member) teamIssues.push(`team_status.members[].${banned}: 脏字段未被投影掉`);
  }
}
if (typeof team.membership?.rootId !== 'string') teamIssues.push('team_status.membership.rootId 不是字符串（Agent 句柄泄漏？）');
if (!Array.isArray(team.tasks) || team.tasks.some((task) => Array.isArray(task.blockedBy))) {
  teamIssues.push('team_status.tasks[].blockedBy 必须是计数（blockedByCount），不能是数组');
}
results.push({ tool: 'team_status#projection', ok: teamIssues.length === 0, issues: teamIssues });

// 门禁负例
for (const gate of gateCases) {
  const value = await gate.run();
  const issues = [];
  if (looseCases.has(gate.name)) {
    // 别名归一化用例：只要不是 aliasing 失败就算通过（具体错误由 core 决定）
    if (value?.error === 'alias-not-normalized') issues.push('camelCase 别名未被归一化');
    if (value?.error === 'key-conflict') issues.push('单侧 camelCase 不该判 key-conflict');
  } else {
    if (value?.ok !== false) issues.push(`期望 ok:false，实际 ${JSON.stringify(value).slice(0, 120)}`);
    if (value?.error !== gate.expect) issues.push(`期望 error=${gate.expect}，实际 ${value?.error}`);
  }
  results.push({ tool: gate.name, ok: issues.length === 0, issues });
  samples[gate.name] = value;
}

if (write) {
  const dir = path.join(root, 'fixtures');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tool-outputs.json'), JSON.stringify({ generatedAt: new Date().toISOString(), samples }, null, 2), 'utf8');
}

const failed = results.filter((row) => !row.ok);
const report = { ok: failed.length === 0, checks: results.length, failed: failed.length, registered, results };
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
fs.rmSync(workspaceRoot, { recursive: true, force: true });
process.exit(report.ok ? 0 : 1);
