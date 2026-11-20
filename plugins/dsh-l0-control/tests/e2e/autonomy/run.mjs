/**
 * 可复现的自主循环端到端演练（Lane A）。
 *
 * 为什么需要这个文件：`check-autonomy.mjs` 一直在校验**那一次**历史演练——节点名与
 * 协调者 sessionId 都写死，journal 默认指向 `.l0-control/`（该目录第 26 轮已退役）。
 * 于是它在干净工作区里恒定 `exit 3`（输入不可读），**无法在 CI 里证明任何东西**：
 * 一个只在某台机器某一天跑得通的验收，等于没有验收。
 *
 * 这里做的事：用**真的 service**（不是 core 纯函数、不是桩接插件逻辑）跑一遍完整
 * 的 worker 自驱循环，产出两本真 journal，然后把同样两本 journal 交给**同一个**
 * `check-autonomy.mjs` 断同样 7 项不变量。断言实现只有一份，不复制第二套判定。
 *
 * 演练内容（刻意包含一次真实驳回）：
 *   1. 建图：6 节点依赖链，每节点带 stage（research/design/build/audit/deliver）；
 *   2. 每个节点由 `role-code-0X` 领取 → 写产物 → 过阶段闸门 → 交证据（带审计实例）；
 *   3. 其中一个节点**先**用「生产实例兼任审计」调 `verify_done` → 真实被拒（journal 留痕）；
 *      再按契约换 `role-audit-0X` 重试 → 通过；
 *   4. 校验 7 项不变量：6/6 done、claim 全来自 `role-*`、审计独立、租约证据、
 *      无协调者代发、驳回后重试成功、阶段闸门 passed。
 *
 * 用法：`node tests/e2e/autonomy/run.mjs`
 * 退出码：0 全绿 / 1 断言失败 / 3 演练本身没跑起来。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { tempStateDir, cleanupTempStateDirs } from '../../_temp-state.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..', '..', '..');
const workspaceRoot = path.resolve(pluginRoot, '..', '..');
const lib = (name) => pathToFileURL(path.join(pluginRoot, 'lib', name)).href;
const { L0ControlService } = await import(lib('service.js'));

// ── 节点与职务（依赖链 + 每节点 stage，和不变量里的五段闸门对齐）─────────────
const NODES = [
  { nodeId: 'NODE-RESEARCH', stage: 'research', deps: [] },
  { nodeId: 'NODE-PRD', stage: 'design', deps: ['NODE-RESEARCH'] },
  { nodeId: 'NODE-CONTRACT', stage: 'design', deps: ['NODE-PRD'] },
  { nodeId: 'NODE-BUILD', stage: 'build', deps: ['NODE-CONTRACT'] },
  { nodeId: 'NODE-AUDIT', stage: 'audit', deps: ['NODE-BUILD'] },
  { nodeId: 'NODE-DELIVER', stage: 'deliver', deps: ['NODE-AUDIT'] },
];
const CODE_WORKERS = ['role-code-01', 'role-code-02'];
// 审计职务必须是复合码（AUDIT_CODE / AUDIT_EVIDENCE / AUDIT_DESIGN）；
// 裸 `role-audit-01` 解析出的职务是 AUDIT，不在白名单里（service 会拒 auditor-role-required）。
const AUDITORS = ['role-audit-code-01', 'role-audit-evidence-01'];
/** 协调者会话 id 用判死值：演练里没有任何协调者直接发起 task_/verify。 */
const COORDINATOR_SENTINEL = 'driver-coordinator-never-acts';

// `tempStateDir` 只给出目录名（建在 cwd 下），而 service 会把它按
// `path.resolve(workspaceRoot, config.stateDir)` 解释——不换成绝对路径，状态就会落进
// **工作区根**而不是临时目录，清理钩子也删不到它（老测试留下的目录泄漏就是这么来的）。
// 同理产物路径必须是绝对的：service 把相对 artifactPath 解析到 workspaceRoot 下。
const stateDir = path.resolve(tempStateDir('autonomy'));
const artifactsDir = path.join(stateDir, 'artifacts');
fs.mkdirSync(artifactsDir, { recursive: true });

// sessionId ↔ instanceId 绑定表（宿主侧事实，由本演练自己提供）
const bindings = new Map();
for (const [index, instanceId] of [...CODE_WORKERS, ...AUDITORS].entries()) {
  bindings.set(instanceId, `sess-${instanceId}-${index}`);
}
const sessionOf = (instanceId) => bindings.get(instanceId);
const callerOf = (instanceId) => ({ id: sessionOf(instanceId) });

const makeCtx = () => ({
  get: (name) => {
    if (name === 'workingDirectory') return { defaultDirectory: workspaceRoot };
    if (name === 'subagents') return { list: () => ['spawn'], startActivation: async () => ({ childId: 'c', messageId: 'm' }) };
    // 宿主绑定：callerInstance() 靠它把 sessionId 反查成实例 id
    if (name === 'l0adapter') {
      return {
        report: () => ({
          instances: [...bindings.entries()].map(([instanceId, sessionId]) => ({ instanceId, sessionId })),
        }),
      };
    }
    return undefined;
  },
});

const svc = new L0ControlService(
  makeCtx(),
  { workspaceRoot, stateDir, persistence: 'node', maxParallel: 8 },
  {},
);

// graphStatus 把 core 结果嵌在 `graph` 里，而 withCore 又包一层 {ok,action,result,persistence}
const unwrap = (wrapped) => {
  const inner = wrapped && typeof wrapped === 'object' && 'graph' in wrapped ? wrapped.graph : wrapped;
  return inner && typeof inner === 'object' && 'result' in inner ? inner.result : inner;
};
const log = (line) => process.stdout.write(`${line}\n`);

try {
  // ── 1. 建图 ────────────────────────────────────────────────────────────
  const committed = unwrap(await svc.graphCommit({
    wish: '可复现自主循环演练',
    policies: { maxParallel: 8 },
    nodes: NODES.map((node) => ({
      nodeId: node.nodeId,
      title: node.nodeId,
      capability: 'CODE',
      stage: node.stage,
      deps: node.deps,
      evidenceRequired: ['artifact'],
      acceptance: { kind: 'exists' },
    })),
  }));
  assert.equal(committed?.ok, true, `建图失败：${JSON.stringify(committed?.errors ?? committed)}`);

  // ── 2. 逐节点跑 worker 自驱循环 ────────────────────────────────────────
  let rejectInjected = false;
  for (const [index, node] of NODES.entries()) {
    const codeWorker = CODE_WORKERS[index % CODE_WORKERS.length];
    const auditor = AUDITORS[index % AUDITORS.length];

    // 2a. claim（由 worker 自己的会话发起）
    const claimed = await svc.taskClaim({ nodeId: node.nodeId, instanceId: codeWorker }, callerOf(codeWorker));
    assert.equal(claimed?.ok, true, `claim 失败 ${node.nodeId}：${JSON.stringify(claimed).slice(0, 240)}`);
    const fencingToken = claimed?.result?.lease?.fencing_token;
    assert.ok(Number.isFinite(fencingToken), `claim 未返回 fencing_token：${JSON.stringify(claimed).slice(0, 240)}`);

    // 2b. 产物（真实落盘，acceptance: exists 会对它做机器判定）
    const artifact = path.join(artifactsDir, `${codeWorker}-${node.nodeId}.md`);
    fs.writeFileSync(artifact, `# ${node.nodeId}\n\n由 ${codeWorker} 产出（演练产物）。\n`, 'utf8');

    // 2c. 阶段闸门
    const gate = await svc.passGate({ stage: node.stage, evidence_refs: [path.basename(artifact)] });
    assert.notEqual(gate?.ok, false, `阶段闸门失败 ${node.stage}：${JSON.stringify(gate).slice(0, 240)}`);

    // 2d. 证据（producer=code、auditor=audit，为审计独立留痕）
    const evidence = await svc.evidenceSubmit(
      {
        nodeId: node.nodeId,
        artifactPath: artifact,
        fencingToken,
        producer_instance: codeWorker,
        auditor_instance: auditor,
        kind: 'artifact',
        acceptance: { kind: 'exists' },
      },
      callerOf(codeWorker),
    );
    assert.equal(evidence?.ok, true, `证据提交失败 ${node.nodeId}：${JSON.stringify(evidence).slice(0, 300)}`);

    // 2e. ★ 刻意注入一次真实驳回：BUILD 节点先让生产实例兼任审计
    if (node.nodeId === 'NODE-BUILD') {
      const selfAudit = await svc.verifyDone(
        { nodeId: node.nodeId, fencingToken, producer_instance: codeWorker, auditor_instance: codeWorker },
        callerOf(codeWorker),
      );
      assert.equal(selfAudit?.ok, false, `自审必须被拒：${JSON.stringify(selfAudit).slice(0, 240)}`);
      assert.equal(selfAudit?.error, 'audit-independence-violated');
      rejectInjected = true;
      const rejectedRows = svc.readJournal().filter((row) => row.kind === 'verify_done_rejected' && row.nodeId === node.nodeId);
      assert.equal(rejectedRows.length, 1, '被拒必须留 verify_done_rejected 痕');
    }

    // 2f. 审计实例按契约验证（fencingToken 是能力凭证，不绑身份）
    const verified = await svc.verifyDone(
      { nodeId: node.nodeId, fencingToken, producer_instance: codeWorker, auditor_instance: auditor },
      callerOf(auditor),
    );
    assert.equal(verified?.ok, true, `验证失败 ${node.nodeId}：${JSON.stringify(verified).slice(0, 320)}`);
  }
  assert.equal(rejectInjected, true, '演练必须包含一次真实驳回（否则第 6 项不变量没被验证）');

  const status = unwrap(await svc.graphStatus({ limit: 50 }));
  assert.equal(status?.counts?.done, NODES.length, `应 6/6 done，实际 ${JSON.stringify(status?.counts)}`);

  // ── 3. 定位两本 journal ────────────────────────────────────────────────
  const auditFile = svc.journalPath;
  const coreFile = path.join(stateDir, 'core-state', 'journal.jsonl');
  for (const [label, file] of [['扁平 journal', auditFile], ['core journal', coreFile]]) {
    assert.ok(fs.existsSync(file), `${label} 不存在：${file}`);
  }
  const coreRows = fs.readFileSync(coreFile, 'utf8').split('\n').filter((l) => l.trim()).length;
  const auditRows = svc.readJournal().length;
  log(`journal：扁平 ${auditRows} 行 / core ${coreRows} 行`);

  // ── 4. 用同一个校验器断同样 7 项不变量 ────────────────────────────────
  await svc.dispose(); // 先放开锁，校验器只读文件
  const checker = path.join(here, 'check-autonomy.mjs');
  const run = spawnSync(
    process.execPath,
    [checker, auditFile, coreFile, NODES.map((n) => n.nodeId).join(','), COORDINATOR_SENTINEL],
    { encoding: 'utf8' },
  );
  const stdout = String(run.stdout ?? '');
  let report = null;
  try {
    report = JSON.parse(stdout);
  } catch {
    report = null;
  }
  if (!report) {
    log(stdout.slice(-2000));
    log(String(run.stderr ?? '').slice(-2000));
    throw new Error(`校验器输出不可解析（exit=${run.status}）`);
  }
  for (const row of report.results ?? []) {
    log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}`);
    if (!row.ok) log(`      ${JSON.stringify(row.detail).slice(0, 500)}`);
  }
  assert.equal(report.ok, true, `不变量未全过：${report.failed}/${report.checks}`);
  assert.equal(run.status, 0, `校验器退出码 ${run.status}`);
  log(`\nPASS autonomy e2e: ${report.checks}/${report.checks} 项不变量全过（含 1 次真实驳回重试）`);
} finally {
  try {
    svc.stopDispatch();
  } catch {}
  try {
    await svc.dispose();
  } catch {}
  cleanupTempStateDirs();
}
