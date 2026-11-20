/**
 * 存储落点体检：**在源头拦，不等满了再说**。
 *
 * 核心事实（本机实测）：
 *   - 协作记录（journal/证据）跟随工作区 → 天生可控
 *   - **每个 Agent 的会话集中落在 `$DSH_HOME/sessions/`，默认系统盘** → 约 1.29 MB/会话
 *   - 1000 Agent ≈ 1.26 GB，10000 ≈ 12.64 GB，**只增不减**
 *
 * 所以体检必须在启用时就说清「数据会写到哪个盘、还剩多少、你的规模够不够、怎么改」，
 * 而不是等盘满了让人去翻文档。
 *
 * 断言：
 *   1. 会话在系统盘 + 空间紧张 → 告警 + **给出可执行的迁移命令**
 *   2. 会话在非系统盘 → 不告警（避免对"小项目在 C 盘"天天喊狼来了）
 *   3. 系统盘但空间充裕 → 不告警（阈值是「<20 GB」或「千级预估 > 可用 30%」）
 *   4. 估算用**实测速率**（按已有会话平均大小），不是拍一个常数
 *   5. 协作记录落在系统盘时单独说明（它跟随工作区，与 session 不同源）
 *   6. 只报一次（空间是慢变量）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (n) => pathToFileURL(path.join(root, 'lib', n)).href;
const { L0ControlService } = await import(lib('service.js'));

/**
 * 取盘符。
 *
 * 注意：`path.parse(p).drive` 在 Node 里是 **undefined** —— 正确字段是 `root`。
 * 测试第一版就栽在这里：env 被赋成 undefined，systemDrive 保持进程原值 'C:'，
 * 于是「会话盘 == 系统盘」这个前置永远不成立，断言报 actual='F:' expected='C:'，
 * 看起来像被测代码错了。用正则取最稳。
 */
const driveOfPath = (p) => {
  const m = /^([A-Za-z]:)/.exec(path.resolve(p));
  return m ? m[1].toUpperCase() : '';
};

const makeCtx = () => ({
  get: (name) => {
    if (name === 'workingDirectory') return { defaultDirectory: root };
    if (name === 'agentTeams') return { membership: () => ({ role: 'lead' }), listMembers: () => [], roster: { maxMembers: 256 }, createTask: () => ({}) };
    if (name === 'subagents') return { startActivation: async () => ({}), sendMessage: async () => ({}), config: { maxActiveSubagents: { get: () => 256, set: () => {} } } };
    if (name === 'sessionController') return { inspect: () => ({}) };
    return undefined;
  },
});

/** 造一个假 DSH_HOME，里面放 n 个指定大小的会话文件。 */
function fakeDshHome(n, mb) {
  const dir = path.resolve(tempStateDir('dshhome'));
  const sessions = path.join(dir, 'sessions', '--workspace--');
  fs.mkdirSync(sessions, { recursive: true });
  for (let i = 0; i < n; i += 1) {
    fs.writeFileSync(path.join(sessions, `session-${i}.jsonl.zstd`), Buffer.alloc(Math.round(mb * 1024 * 1024), 0x41));
  }
  return dir;
}

async function withSvc({ dshHome, systemDrive, stateDirAbs }, fn) {
  const oldHome = process.env.DSH_HOME;
  const oldSys = process.env.SystemDrive;
  if (dshHome !== undefined) process.env.DSH_HOME = dshHome;
  if (systemDrive !== undefined) process.env.SystemDrive = systemDrive;
  const stateDir = stateDirAbs ?? path.resolve(tempStateDir('st'));
  const svc = new L0ControlService(makeCtx(), {
    workspaceRoot: root, stateDir, persistence: 'node', maxParallel: 8, coordinatorEnabled: false,
  }, {});
  try {
    return await fn(svc);
  } finally {
    try { svc.stopCoordinator(); } catch { /* 未启动 */ }
    try { svc.stopDispatch(); } catch { /* 未启动 */ }
    try { await svc.dispose(); } catch { /* 已关闭 */ }
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldSys === undefined) delete process.env.SystemDrive; else process.env.SystemDrive = oldSys;
    cleanupTempStateDirs();
  }
}

// ── 组 1：真实环境 → 空间紧张时必须告警 + 迁移命令 ──────────────────────
{
  // 用**真实** DSH_HOME / SystemDrive，不做模拟：
  // 这一组要验的正是「本机现在到底会不会告警」，模拟出来的不算。
  await withSvc({ dshHome: undefined, systemDrive: undefined }, async (svc) => {
    const h = svc.storageHealth();
    const sessionDrive = h.locations.sessionDir.drive;
    const sysDrive = String(h.systemDrive);
    const sessionFree = h.drives.find((d) => d.root === sessionDrive)?.freeGb ?? -1;
    console.log(`  实测：会话盘 ${sessionDrive}（可用 ${sessionFree} GB）/ 系统盘 ${sysDrive} / ${h.locations.sessionDir.sessions} 会话 ${h.locations.sessionDir.sessionsMb} MB / 每会话 ${h.estimate.perAgentMb} MB`);
    const tight = sessionFree >= 0 && sessionFree < 20;
    const willOverflow = sessionFree >= 0 && h.estimate.for1000AgentsGb > sessionFree * 0.3;
    if (sessionDrive === sysDrive && (tight || willOverflow)) {
      assert.ok(h.warnings.length > 0, '空间紧张时必须告警');
      const joined = h.warnings.join(' ');
      assert.ok(/会话集中写在系统盘/.test(joined), '必须说清「在系统盘」');
      assert.ok(/只增不减/.test(joined), '必须说清它会持续增长');
      assert.ok(/1000 个 Agent/.test(joined), '必须给出千级预估');
      assert.ok(h.advice.some((a) => /DSH_HOME/.test(a)), '必须给出 DSH_HOME 迁移命令');
      assert.ok(h.advice.some((a) => /重开|重新启动|重启/.test(a)), '必须说明改完要重开 DSH');
      console.log('PASS 真实环境：会话在系统盘且紧张 → 告警 + 可执行迁移命令');
    } else {
      console.log('SKIP 组1（本机系统盘空间充裕，阈值不触发）');
    }
  });
}

// ── 组 2：会话在非系统盘 → 不因「在系统盘」告警 ─────────────────────────
{
  const home = fakeDshHome(2, 1);
  const otherDrive = driveOfPath(home);
  const fakeSystem = otherDrive.toUpperCase() === 'C:' ? 'Z:' : 'C:';
  await withSvc({ dshHome: home, systemDrive: fakeSystem }, async (svc) => {
    const h = svc.storageHealth();
    assert.notEqual(h.locations.sessionDir.drive, String(h.systemDrive), '前置：会话盘 ≠ 系统盘');
    assert.ok(!h.warnings.some((w) => /会话集中写在系统盘/.test(w)), '会话不在系统盘时不得报这条');
    console.log('PASS 会话在非系统盘 → 不因「在系统盘」告警');
  });
}

// ── 组 3：估算用实测速率（不是编的常数）────────────────────────────────
{
  const home = fakeDshHome(5, 2); // 5 个 × 2 MB
  await withSvc({ dshHome: home, systemDrive: 'C:' }, async (svc) => {
    const h = svc.storageHealth();
    assert.equal(h.locations.sessionDir.sessions, 5, '会话数要数对');
    assert.ok(Math.abs(h.estimate.perAgentMb - 2) < 0.2, `每会话应≈2 MB，实际 ${h.estimate.perAgentMb}`);
    assert.ok(Math.abs(h.estimate.for1000AgentsGb - (2 * 1000) / 1024) < 0.1, '千级估算要跟着实测走');
    console.log(`PASS 估算跟实测走：${h.locations.sessionDir.sessions} 会话 × ${h.estimate.perAgentMb} MB → 1000 个 ≈ ${h.estimate.for1000AgentsGb} GB`);
  });
}

// ── 组 4：协作记录落点单独说明（与 session 不同源）──────────────────────
{
  const home = fakeDshHome(1, 1);
  const cState = 'C:\\\\l0-probe-state';
  await withSvc({ dshHome: home, systemDrive: 'C:', stateDirAbs: cState }, async (svc) => {
    const h = svc.storageHealth();
    const stateOnSys = h.locations.stateDir.drive === String(h.systemDrive);
    if (stateOnSys) {
      assert.ok(h.warnings.some((w) => /协作记录/.test(w) && /跟随工作区/.test(w)), '协作记录在系统盘要单独说明它跟随工作区');
      assert.ok(h.warnings.some((w) => /512 MB/.test(w)), '要给出 journal 分段上限，让人知道封顶在哪');
      console.log('PASS 协作记录落在系统盘 → 单独说明「跟随工作区」+ 512 MB 分段上限');
    } else {
      console.log('SKIP 组4（构造的 stateDir 未解析到系统盘）');
    }
  });
}

// ── 组 5：只报一次 ────────────────────────────────────────────────────
{
  const home = fakeDshHome(1, 1);
  await withSvc({ dshHome: home, systemDrive: 'C:' }, async (svc) => {
    svc.reportStorageOnce('a');
    svc.reportStorageOnce('b');
    svc.reportStorageOnce('c');
    const rows = [...svc.readJournal()].filter((r) => /^storage_ok|^storage_tight$/.test(String(r.kind)));
    assert.equal(rows.length, 1, `只应留一条，实际 ${rows.length}`);
    console.log('PASS 存储体检只报一次（连调三次只落一条）');
  });
}


// ── 组 7：env_check —— 缺 agentTeams 必须进 blockers 且 ready=false ──────
{
  const home = fakeDshHome(1, 1);
  await withSvc({ dshHome: home, systemDrive: 'C:' }, async (svc) => {
    // 把 agentTeams 拿掉：hostServicesView 会把它列进 missing
    const original = svc.ctx.get;
    svc.ctx.get = (name) => (name === 'agentTeams' ? undefined : original.call(svc.ctx, name));
    try {
      const r = svc.envCheck();
      assert.equal(r.ready, false, '缺 agentTeams 时 ready 必须为 false（派出的实例当不了 owner）');
      assert.ok(r.blockers.some((b) => /agentTeams/.test(b)), 'blockers 必须点名 agentTeams');
      assert.ok(r.blockers.some((b) => /TeamTask owner/.test(b)), '必须说清缺了会怎样');
    } finally {
      svc.ctx.get = original;
    }
  });
  console.log('PASS env_check：缺 agentTeams → ready=false 且 blockers 说清后果');
}

// ── 组 8：env_check 齐全环境 → ready=true + 给出 suggestedMaxAgents ──────
{
  const home = fakeDshHome(2, 1);
  await withSvc({ dshHome: home, systemDrive: 'C:' }, async (svc) => {
    const r = svc.envCheck();
    assert.equal(r.ready, true, '服务齐全时应 ready');
    assert.deepEqual(r.blockers, []);
    /**
     * **不能断言「一定能算出数字」。**
     *
     * `suggestedMaxAgents` 依赖 `fs.statfsSync` 读会话盘可用空间。这个调用在容器、
     * 受限权限、非 Windows 路径等环境下可能返回异常值（实测：他人机器上返回 -1），
     * 此时正确行为是**返回 null 并说明为什么算不了**，而不是编一个数字。
     *
     * 原来这里断言 `typeof === 'number' && > 0`，于是环境一换就红——
     * 那不是产品缺陷，是**测试把「能探测到磁盘」当成了前提**。
     *
     * 正确判据：**有据可依，或明确承认无据可依**。
     */
    const s = r.scale.suggestedMaxAgents;
    assert.ok(
      s === null || (typeof s === 'number' && Number.isFinite(s) && s >= 0),
      `suggestedMaxAgents 必须是有限非负数或 null（无法推算），实际 ${s}`,
    );
    if (s === null) {
      assert.ok(
        /无法推算|探测|statfs|不可用/.test(String(r.note) + JSON.stringify(r.warnings)),
        'null 时必须说明推算不了的原因，不能静默',
      );
      console.log('  SKIP 本机磁盘探测不可用 → suggestedMaxAgents=null（已说明原因，符合预期）');
    } else {
      console.log(`  PASS suggestedMaxAgents=${s}（千级 ${r.scale.for1000AgentsGb} GB）`);
    }
    const g = r.scale.for1000AgentsGb;
    assert.ok(g === null || (typeof g === 'number' && g > 0), `for1000AgentsGb 应为正数或 null，实际 ${g}`);
    assert.ok(String(r.note).includes('一半'), 'note 必须写明估算口径');
  });
  console.log('PASS env_check：ready=true，suggestedMaxAgents 有据则给数、无据则说清');
}

// ── 组 6：graph_status 暴露 storage ────────────────────────────────────
{
  const home = fakeDshHome(1, 1);
  await withSvc({ dshHome: home, systemDrive: 'C:' }, async (svc) => {
    const status = await svc.graphStatus({ limit: 1 });
    const st = status.storage;
    assert.ok(st, 'graph_status.storage 必须存在');
    assert.ok(Array.isArray(st.drives) && st.drives.length > 0, '要列出各盘空间');
    assert.ok(st.estimate && typeof st.estimate.perAgentMb === 'number', '要带估算');
    console.log('PASS graph_status.storage 暴露落点 + 各盘空间 + 估算');
  });
}
