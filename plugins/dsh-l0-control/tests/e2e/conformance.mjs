#!/usr/bin/env node
/**
 * N5 · conformance 摘要（U4）
 *
 * 把三份东西合成**一份机器可读摘要**，供主窗口/CI 一次判定：
 *   1. 适配器能力面（8 项动作 + 级别 + quality 声明）—— 来自 `lib/capabilities.js`
 *   2. A7 四态与退出码（pass/drift/failed/unknown = 0/1/2/3）—— 同上 conformance 块
 *   3. e2e 结果（两场景 mock）+ G5 真实恢复（lib/state）+ native 分支探测
 *
 * 用法：node tests/e2e/conformance.mjs [--json]
 * 退出码：取各子项最严：failed>0 → 2；未知/跳过 → 1；全绿 → 0；子项不可用 → 3
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const PLUGIN = path.join(REPO_ROOT, 'plugins', 'dsh-l0-control');
const EXIT = { pass: 0, drift: 1, failed: 2, unknown: 3 };

function runJson(script, args = []) {
  try {
    const out = execFileSync(process.execPath, [script, ...args, '--json'], { encoding: 'utf8', cwd: REPO_ROOT });
    return { parsed: JSON.parse(out), exit: 0 };
  } catch (err) {
    const stdout = String(err?.stdout ?? '');
    try {
      return { parsed: JSON.parse(stdout), exit: err?.status ?? EXIT.failed };
    } catch {
      return { parsed: null, exit: err?.status ?? EXIT.failed, error: String(err?.message ?? err).slice(0, 200) };
    }
  }
}

async function main() {
  const json = process.argv.includes('--json');

  // ① 适配器能力面 + A7 四态
  let adapter = { ok: false, reason: 'lib/capabilities.js 不可用' };
  try {
    const mod = await import(`file://${path.join(PLUGIN, 'lib', 'capabilities.js').replace(/\\/g, '/')}`);
    const digest = typeof mod.capabilitiesDigest === 'function' ? mod.capabilitiesDigest() : null;
    const caps = mod.CAPABILITIES ?? {};
    const actions = (digest?.tools ?? Object.keys(caps.tools ?? {})).slice?.() ?? [];
    adapter = {
      ok: true,
      toolCount: Array.isArray(actions) ? actions.length : (digest?.toolCount ?? 0),
      tools: actions,
      quality: digest?.quality ?? mod.QUALITY ?? null,
      conformance: digest?.conformance ?? null,
      grades: digest?.grades ?? null,
    };
  } catch (err) {
    adapter = { ok: false, reason: String(err?.message ?? err).slice(0, 200) };
  }

  // ② e2e（mock 两场景）+ G5（真实 lib/state）+ native 分支
  const crud = runJson(path.join(HERE, 'run.mjs'), ['--scenario', 'crud_wish', '--port', 'mock']);
  const replan = runJson(path.join(HERE, 'run.mjs'), ['--scenario', 'failure_replan', '--port', 'mock']);
  const g5 = runJson(path.join(HERE, 'state-g5.mjs'));
  const native = runJson(path.join(HERE, 'run.mjs'), ['--scenario', 'crud_wish', '--port', 'native']);
  const chain = runJson(path.join(HERE, 'native-chain.mjs'));
  const oracle = runJson(path.join(HERE, 'oracle-diff.mjs'));

  const parts = [
    ['adapter', adapter.ok ? 'pass' : 'unknown', adapter.ok ? 0 : EXIT.unknown],
    ['e2e:crud_wish', crud.parsed?.state ?? 'unknown', crud.exit],
    ['e2e:failure_replan', replan.parsed?.state ?? 'unknown', replan.exit],
    ['g5:real', g5.parsed?.state ?? 'unknown', g5.exit],
    ['native:branch', native.parsed?.state ?? 'unknown', native.exit],
    ['native:chain', chain.parsed?.state ?? 'unknown', chain.exit],
    ['oracle:diff', oracle.parsed?.state ?? 'unknown', oracle.exit],
  ];

  const failed = parts.filter(([, s]) => s === 'failed').length;
  const unknown = parts.filter(([, s]) => s === 'unknown').length;
  const drift = parts.filter(([, s]) => s === 'drift').length;
  const state = failed > 0 ? 'failed' : unknown > 0 ? 'unknown' : drift > 0 ? 'drift' : 'pass';
  const exitCode = EXIT[state];

  const summary = {
    suite: 'n5-conformance',
    state,
    exitCode,
    adapter,
    a7: {
      states: ['pass', 'drift', 'failed', 'unknown'],
      exitCodes: { pass: 0, drift: 1, failed: 2, unknown: 3 },
      failClosed: adapter.conformance?.failClosed ?? null,
    },
    e2e: {
      crud_wish: { state: crud.parsed?.state, passed: crud.parsed?.passed, failed: crud.parsed?.failed, skipped: crud.parsed?.skipped, total: crud.parsed?.total },
      failure_replan: { state: replan.parsed?.state, passed: replan.parsed?.passed, failed: replan.parsed?.failed, skipped: replan.parsed?.skipped, total: replan.parsed?.total },
    },
    g5: { state: g5.parsed?.state, passed: g5.parsed?.passed, failed: g5.parsed?.failed, total: g5.parsed?.total },
    native: { state: native.parsed?.state, passed: native.parsed?.passed, skipped: native.parsed?.skipped, checks: native.parsed?.checks?.map((c) => ({ id: c.id, state: c.skip ? 'guard-skip' : c.ok ? 'pass' : 'failed' })) },
    nativeChain: { state: chain.parsed?.state, passed: chain.parsed?.passed, failed: chain.parsed?.failed, skipped: chain.parsed?.skipped, stages: chain.parsed?.stages?.map((s) => ({ stage: s.stage, gate: s.gate })) },
    parts: parts.map(([name, s]) => ({ name, state: s })),
  };

  if (json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log('\n=== N5 conformance 摘要 ===');
    console.log(`adapter: tools=${adapter.toolCount} grades=${JSON.stringify(adapter.grades)}`);
    console.log(`a7: states=${summary.a7.states.join('/')} exit=${JSON.stringify(summary.a7.exitCodes)}`);
    for (const [name, s] of parts) console.log(`${s.toUpperCase().padEnd(8)} ${name}`);
    console.log(`\nstate=${state} exit=${exitCode}`);
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(EXIT.failed);
});
