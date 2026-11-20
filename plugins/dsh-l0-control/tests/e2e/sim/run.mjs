/**
 * 集群容量仿真器：**插件层用真代码，宿主/LLM 层用模型**。
 *
 * 为什么需要它：目标里那句「经端到端证据验证的千 Agent」有两半。
 *   - 控制面那一半（claim / evidence / verify / dispatch / journal）我们已经能实测，
 *     但它只说明「插件不是瓶颈」；
 *   - 宿主 session 上限与 LLM 延迟那一半，**没有任何数据**，而它们极可能先撞墙。
 *
 * 没法凭空测出它们，但可以**把它们当参数**：给定 H（同时活 session 上限）与 LLM 延迟
 * 分布，这套结构会表现成什么样？这就是仿真能回答的问题。
 *
 * 保真度分层（不许混着说）：
 *   ┌ 插件控制面  → 真实 `L0ControlService`，走真 journal / 真租约 / 真凭证铸造
 *   └ worker 决策 → 抽取成「步数 + 每步 LLM 耗时分布」的参数
 *   └ 宿主能力   → H 台服务器排队模型（M/G/H，服务时间 = LLM + 实测 CPU）
 *
 * 时间模型：**虚拟时钟**。LLM 延迟不真等（否则 1000 节点要跑几十分钟），
 * 控制面 CPU 是**真实测量**的（同步调用，几百微秒级）。于是：
 *   总时长 = 插件 CPU（实测） + LLM 等待（抽样） + 宿主排队（模型）
 * 三者分别可归因 —— 这才是「瓶颈在哪一层」的答案。
 *
 * ⚠️ 本文件产出的是 **inferred** 结论（模型 + 假设参数），不是 verified。
 *    它不能证明「千 Agent 已达标」；它只能说明「在给定输入下会怎样，以及在什么参数处翻转」。
 *
 * 用法：
 *   node tests/e2e/sim/run.mjs                          # 200 节点，扫 H
 *   node tests/e2e/sim/run.mjs --nodes 500 --llm-ms 40000
 *   node tests/e2e/sim/run.mjs --json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { tempStateDir, cleanupTempStateDirs } from '../../_temp-state.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..', '..', '..');
const workspaceRoot = path.resolve(pluginRoot, '..', '..');
const lib = (name) => pathToFileURL(path.join(pluginRoot, 'lib', name)).href;
const { L0ControlService } = await import(lib('service.js'));

const argv = process.argv.slice(2);
const numArg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};
const NODES = numArg('nodes', 200);
const WORKERS = numArg('workers', 16);
const LLM_MEDIAN_MS = numArg('llm-ms', 0);
const LLM_SIGMA = numArg('llm-sigma', 0.8); // 对数正态 sigma（重尾：少数节点特别慢）
const STEPS = Math.max(2, numArg('steps', 3)); // 至少要 2：证据步与验证步必须分开
const RATE = numArg('rate', 100000);         // 领取速率上限（默认不成为约束）
const MAX_PARALLEL = numArg('max-parallel', WORKERS * 4);
const AS_JSON = argv.includes('--json');
const TRACE = argv.includes('--trace');
/** 宿主并发上限的扫描档（`0` = 无限）。 */
const HOST_SWEEP = (() => {
  const i = argv.indexOf('--host');
  if (i === -1) return [4, 8, 16, 32, 0]; // 实测宿主 active child limit = 8，见第 39 轮报告
  const raw = argv[i + 1] ?? '';
  return raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);
})();

const unwrap = (w) => {
  const inner = w && typeof w === 'object' && 'graph' in w ? w.graph : w;
  return inner && typeof inner === 'object' && 'result' in inner ? inner.result : inner;
};

/** 对数正态抽样：给定中位数与 sigma（模拟「多数快、少数特别慢」的 LLM 调用）。 */
function sampleLlm(median, sigma) {
  if (!(median > 0)) return 0;
  // 中位数 = exp(mu) ⇒ mu = ln(median)
  const mu = Math.log(median);
  // Box-Muller
  const u1 = Math.random() || 1e-12;
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.exp(mu + sigma * z);
}

const makeCtx = () => ({
  get: (name) => {
    if (name === 'workingDirectory') return { defaultDirectory: workspaceRoot };
    if (name === 'l0adapter') {
      return { report: () => ({ instances: [{ instanceId: 'role-code-01', sessionId: 's-code' }, { instanceId: 'role-audit-code-01', sessionId: 's-audit' }] }) };
    }
    return undefined;
  },
});
const CODE = 'role-code-01';
const AUDIT = 'role-audit-code-01';
const callerOf = (instanceId) => ({ id: instanceId === CODE ? 's-code' : 's-audit' });

/**
 * 跑一个场景：真 service + H 台服务器排队。
 *
 * 虚拟时间模型：
 *   slotEnds[h] = 第 h 个宿主 slot 何时空闲
 *   worker 的一步（LLM + CPU）只能在某个 slot 上执行 —— 起点 = max(自己的就绪时刻, 最早空闲 slot)
 * 这样「宿主上限 H」自然表现为排队，而不是硬编码一个系数。
 */
async function runScenario({ nodes, workers, hostLimit, llmMedian, steps, durations = null }) {
  const stateDir = path.resolve(tempStateDir('sim'));
  const svc = new L0ControlService(makeCtx(), {
    workspaceRoot, stateDir, persistence: 'node',
    maxParallel: Math.max(1, Math.min(workers, nodes) * 4),
    dispatchRatePerSecond: RATE,
  }, {});
  const artifactDir = path.join(stateDir, 'artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });

  let cpuMs = 0;          // 插件控制面真实 CPU（只算有效步，不算空转）
  let idleCpuMs = 0;      // 空转探测（领不到活时的 taskNext），单列，不进归因
  let llmMs = 0;          // 模型侧 LLM 抽样总和
  let queueMs = 0;        // 宿主排队等待
  /** 分项计时（诊断用）：哪个动作吃掉了 CPU。 */
  const trace = new Map();
  /**
   * 计时口径（**这里踩过一次坑，必须写下来**）：
   *
   * 并发路径里 `performance.now()` 测到的是**墙钟**，而 JS 单线程 + 微任务交错意味着
   * 「A 的一次任务调用」的墙钟里会塞进 B..P 的 CPU。实测同一个 `taskClaim`：
   *   w=1 → 1.78 ms；w=16 且只在 await 上交错 → 33 ms（20× 假膨胀）。
   * 那会凭空造出「控制面不随并发扩展」的错误结论。
   *
   * 所以：**服务时间只在串行标定阶段测**（`workers=1`，无交错，干净），
   * 并发阶段用标定出的常数当**模型参数**、不再现场测量。结构保真由「调用真 service」保证，
   * 时间的归因由标定保证——两者分开，才谈得上分层。
   */
  const timed = async (fn, label = 'other') => {
    if (durations) {
      const out = await fn();
      const dt = durations[label] ?? 0;
      cpuMs += dt;
      trace.set(label, (trace.get(label) ?? 0) + dt);
      return out;
    }
    const t0 = performance.now();
    try { return await fn(); } finally {
      const dt = performance.now() - t0;
      cpuMs += dt;
      trace.set(label, (trace.get(label) ?? 0) + dt);
    }
  };
  const timedIdle = async (fn) => {
    const t0 = performance.now();
    try { return await fn(); } finally { idleCpuMs += performance.now() - t0; }
  };

  try {
    await timed(() => svc.graphCommit({
      wish: 'sim',
      policies: { maxParallel: 1 << 20 },
      nodes: Array.from({ length: nodes }, (_, i) => ({
        nodeId: `M${String(i + 1).padStart(4, '0')}`,
        title: `n${i}`,
        capability: 'CODE',
        acceptance: { kind: 'exists' },
      })),
    }), 'graphCommit');
    try { await timed(() => svc.passGate({ stage: 'research', evidence_refs: [] }), 'passGate'); } catch { /* 闸门失败不阻断仿真 */ }

    const slotEnds = hostLimit > 0 ? new Array(hostLimit).fill(0) : [];
    const earliestSlot = () => {
      if (hostLimit <= 0) return { index: -1, freeAt: 0 };
      let idx = 0;
      for (let i = 1; i < slotEnds.length; i += 1) if (slotEnds[i] < slotEnds[idx]) idx = i;
      return { index: idx, freeAt: slotEnds[idx] };
    };
    /** 把一段「一步」排到虚拟时间轴上，返回这一步的结束时刻。 */
    const schedule = (readyAt, dur) => {
      const slot = earliestSlot();
      const start = Math.max(readyAt, slot.freeAt);
      if (slot.index >= 0) slotEnds[slot.index] = start + dur;
      return { start, end: start + dur };
    };

    const occupied = new Set();
    let finished = 0;
    let virtualEnd = 0;
    let claims = 0;
    /**
     * 让出**宏任务**，不是微任务。
     *
     * 这是本仿真器最要紧的一行：service 的每个动作内部都是一串 `await`（withCore → persist
     * → sanitize），全在微任务队列里。若 worker 之间只靠 `await` 交错，16 个 worker 的调用
     * 会**极限交错**，于是任意一次 `timed()` 的墙钟里塞满了别人的 CPU —— 实测把单 op 从
     * 1.6 ms 放大到 33 ms（20×），凭空造出一个「控制面不扩展」的假结论。
     * 规模演练靠每节点 `yieldTick()` 避开了这一点；这里必须一致。
     */
    const yieldTick = () => new Promise((resolve) => setImmediate(resolve));
    /** 失败计数：不看结果就断言是这类工具最容易犯的错，必须打出来。 */
    const fails = { claim: 0, evidence: 0, verify: 0, heartbeat: 0 };
    const lastError = {};
    /** 空转退避：虚拟时间上的大步长，避免「每 1 ms 真调一次 taskNext」把 CPU 打满。 */
    const IDLE_BACKOFF_MS = 500;

    const claimPending = async (instanceId) => {
      const next = unwrap(await timedIdle(() => svc.taskNext({})));
      const ready = Array.isArray(next?.ready) ? next.ready : [];
      const target = ready.find((id) => !occupied.has(id));
      if (!target) return null;
      occupied.add(target);
      claims += 1;
      const claimed = unwrap(await timed(() => svc.taskClaim({ nodeId: target, instanceId }, callerOf(instanceId)), 'taskClaim'));
      if (!claimed?.ok) {
        fails.claim += 1;
        lastError.claim = String(claimed?.error ?? claimed?.code ?? JSON.stringify(claimed ?? null)).slice(0, 80);
        occupied.delete(target);
        return null;
      }
      return { nodeId: target, token: claimed.lease.fencing_token };
    };

    const workerLoop = async (instanceId) => {
      let readyAt = 0;
      let idleRounds = 0;
      for (;;) {
        if (finished >= nodes) return;
        // 安全阀：仿真能无限空转就说明模型写错了，宁可炸也不要给一个假数字
        if (idleRounds > 200) throw new Error(`仿真停滞：${finished}/${nodes} done，领取 ${claims} 次仍未推进（步骤数=${steps}）`);
        if (claims > nodes * 12) throw new Error(`仿真异常：领取 ${claims} 次（节点 ${nodes}）；失败 ${JSON.stringify(fails)} 最近 ${JSON.stringify(lastError)}`);
        const job = await claimPending(instanceId);
        if (!job) {
          if (finished >= nodes) return;
          idleRounds += 1;
          readyAt += IDLE_BACKOFF_MS;
          virtualEnd = Math.max(virtualEnd, readyAt);
          continue;
        }
        idleRounds = 0;
        for (let step = 0; step < steps; step += 1) {
          const thinkMs = sampleLlm(llmMedian, LLM_SIGMA);
          llmMs += thinkMs;
          const cpuBefore = cpuMs;
          if (step === 0) {
            const artifact = path.join(artifactDir, `${instanceId}-${job.nodeId}.md`);
            fs.writeFileSync(artifact, `# ${job.nodeId}\n`, 'utf8');
            const ev = unwrap(await timed(() => svc.evidenceSubmit({
              nodeId: job.nodeId, artifactPath: artifact, fencingToken: job.token,
              producer_instance: instanceId, auditor_instance: AUDIT, kind: 'artifact',
              acceptance: { kind: 'exists' },
            }, callerOf(instanceId)), 'evidenceSubmit'));
            if (ev?.ok === false) { fails.evidence += 1; lastError.evidence = ev?.error ?? ev?.code; }
          } else if (step === steps - 1) {
            const v = unwrap(await timed(() => svc.verifyDone({
              nodeId: job.nodeId, fencingToken: job.token,
              producer_instance: instanceId, auditor_instance: AUDIT,
            }, callerOf(AUDIT)), 'verifyDone'));
            if (v?.ok === false) { fails.verify += 1; lastError.verify = v?.error ?? v?.code; }
            finished += 1;
          } else {
            const hb = unwrap(await timed(() => svc.taskHeartbeat({ nodeId: job.nodeId, fencingToken: job.token }, callerOf(instanceId)), 'taskHeartbeat'));
            if (hb?.ok === false) { fails.heartbeat += 1; lastError.heartbeat = hb?.error ?? hb?.code; }
          }
          const stepCpu = cpuMs - cpuBefore;
          const placed = schedule(readyAt, thinkMs + stepCpu);
          queueMs += Math.max(0, placed.start - readyAt);
          readyAt = placed.end;
          virtualEnd = Math.max(virtualEnd, readyAt);
        }
        await yieldTick();
      }
    };

    await Promise.all(Array.from({ length: workers }, (_, i) => workerLoop(CODE)));
    const status = unwrap(await svc.graphStatus({ limit: 1 }));
    const persistence = await svc.persistence();
    const coreEvents = persistence ? persistence.core.journal.count() : -1;
    const kinds = {};
    if (persistence) {
      for (const ev of persistence.core.journal.view()) kinds[ev.kind] = (kinds[ev.kind] ?? 0) + 1;
    }
    return {
      nodes, workers, hostLimit, llmMedian,
      done: Number(status?.counts?.done ?? 0),
      virtualMs: virtualEnd,
      cpuMs, idleCpuMs, llmMs, queueMs,
      fails, lastError, claims,
      coreEvents, kinds,
      trace: Object.fromEntries([...trace.entries()].sort((a, b) => b[1] - a[1])),
    };
  } finally {
    try { svc.stopDispatch(); } catch {}
    try { await svc.dispose(); } catch {}
    cleanupTempStateDirs();
  }
}

const pct = (part, total) => (total > 0 ? (part / total) * 100 : 0);

// ── 阶段 A：串行标定（干净的服务时间）──────────────────────────────────────
// 只在 1 个 worker 下测，没有任何交错，所以单 op 是真实 CPU。
const CAL_NODES = numArg('calibrate-nodes', 40);
let CALIB = null;
if (!argv.includes('--no-calibrate')) {
  const cal = await runScenario({ nodes: CAL_NODES, workers: 1, hostLimit: 0, llmMedian: 0, steps: STEPS });
  const per = (label) => (cal.trace[label] ?? 0) / CAL_NODES;
  // 键必须与 `timed()` 的 label 完全一致——否则 `durations[label]` 全是 undefined，
  // 仿真会给出「0 ms/节点、无限吞吐」这种漂亮但彻底错的数字。
  CALIB = {
    taskClaim: per('taskClaim'),
    evidenceSubmit: per('evidenceSubmit'),
    verifyDone: per('verifyDone'),
    taskHeartbeat: per('taskHeartbeat'),
  };
  if (!AS_JSON) {
    console.log(`阶段 A · 串行标定（${CAL_NODES} 节点 / 1 worker / 无 LLM）：`);
    console.log(`  taskClaim ${CALIB.taskClaim.toFixed(3)} ms · evidenceSubmit ${CALIB.evidenceSubmit.toFixed(3)} ms · `
      + `verifyDone ${CALIB.verifyDone.toFixed(3)} ms · taskHeartbeat ${CALIB.taskHeartbeat.toFixed(3)} ms`);
    console.log(`  ⇒ 每节点服务时间 ${(CALIB.taskClaim + CALIB.evidenceSubmit + CALIB.verifyDone + CALIB.taskHeartbeat).toFixed(3)} ms（喂给仿真的模型参数）\n`);
  }
}

const scenarios = [];
for (const hostLimit of HOST_SWEEP) {
  scenarios.push(await runScenario({
    nodes: NODES, workers: WORKERS, hostLimit,
    llmMedian: LLM_MEDIAN_MS, steps: STEPS, durations: CALIB,
  }));
}

if (AS_JSON) {
  console.log(JSON.stringify({ config: { NODES, WORKERS, LLM_MEDIAN_MS, LLM_SIGMA, STEPS }, calibration: CALIB, scenarios }, null, 2));
} else {
  console.log(`仿真配置：${NODES} 节点 / ${WORKERS} 逻辑 worker / 每节点 ${STEPS} 步 / LLM 中位 ${LLM_MEDIAN_MS} ms（σ=${LLM_SIGMA}）\n`);
  console.log('归因口径：把「一个 worker 的总时间」拆成 插件CPU + LLM + 宿主排队 三段，三者归一为 100%。');
  console.log('  插件CPU 是**真实测量**；LLM 与排队是**模型**。\n');
  console.log('宿主上限 H │ 模拟总时长 │   吞吐    │ 插件CPU │ LLM │ 排队 │ CPU/节点 │ 完成');
  console.log('───────────┼────────────┼───────────┼─────────┼─────┼──────┼──────────┼──────');
  for (const s of scenarios) {
    const t = s.virtualMs;
    const busy = s.cpuMs + s.llmMs + s.queueMs;
    console.log(
      `${String(s.hostLimit === 0 ? '∞' : s.hostLimit).padStart(10)} │` +
      `${(t / 1000).toFixed(2).padStart(10)} s │` +
      `${(s.nodes / (t / 1000)).toFixed(1).padStart(8)} n/s │` +
      `${pct(s.cpuMs, busy).toFixed(1).padStart(6)}% │` +
      `${pct(s.llmMs, busy).toFixed(0).padStart(3)}% │` +
      `${pct(s.queueMs, busy).toFixed(1).padStart(4)}% │` +
      `${(s.cpuMs / s.nodes).toFixed(2).padStart(7)}ms │` +
      `${String(s.done).padStart(4)}/${s.nodes}`,
    );
  }
  const base = scenarios.find((s) => s.hostLimit === 0) ?? scenarios[scenarios.length - 1];
  console.log(`\n最宽松档（H=${base.hostLimit === 0 ? '∞' : base.hostLimit}）：${(base.nodes / (base.virtualMs / 1000)).toFixed(1)} 节点/秒，`
    + `插件 CPU ${(base.cpuMs / base.nodes).toFixed(2)} ms/节点，空转探测 ${base.idleCpuMs.toFixed(0)} ms（不计入归因）`);
  console.log('这是 inferred 结论（模型 + 假设参数），不能当作「千 Agent 已达标」的证据。');
  if (TRACE) {
    console.log('\n失败计数：' + JSON.stringify(base.fails) + ' · 领取次数 ' + base.claims + ' · core 事件 ' + base.coreEvents);
    if (Object.keys(base.lastError ?? {}).length) console.log('最近错误：' + JSON.stringify(base.lastError));
    console.log('事件分布：' + JSON.stringify(base.kinds));
    console.log('\n分项计时（真实测量，单位 ms）：');
    for (const [label, ms] of Object.entries(base.trace ?? {})) {
      console.log('  ' + label.padEnd(16) + ms.toFixed(0).padStart(8) + ' ms');
    }
  }
}
