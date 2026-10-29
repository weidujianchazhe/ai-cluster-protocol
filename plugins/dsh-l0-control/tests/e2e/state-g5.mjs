#!/usr/bin/env node
/**
 * N5 · G5 恢复断言（真实实现：`lib/state/*`，N4 交付）
 *
 * 与 run.mjs 里的 mock 版 G5 对应，但直接调用 N4 的真实模块：
 *   - `Journal.open` / `append` / `verifyChain`
 *   - `recoverWithJournal` / `buildSnapshot` / `writeSnapshot` / `checkAnchor`
 *   - `StateError.code` 恢复错误码
 *
 * 用法：node tests/e2e/state-g5.mjs [--json]
 * 退出码：0 pass / 1 drift / 2 failed / 3 unknown（模块不可用）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const LIB = path.join(REPO_ROOT, 'plugins', 'dsh-l0-control', 'lib', 'state');

const EXIT = { pass: 0, drift: 1, failed: 2, unknown: 3 };
const checks = [];
const add = (id, title, okFlag, detail = '') => checks.push({ id, title, ok: !!okFlag, detail });

async function load() {
  const [journalMod, recoveryMod, snapshotMod, fsPortMod, reducerMod] = await Promise.all([
    import(`file://${path.join(LIB, 'journal.js').replace(/\\/g, '/')}`),
    import(`file://${path.join(LIB, 'recovery.js').replace(/\\/g, '/')}`),
    import(`file://${path.join(LIB, 'snapshot.js').replace(/\\/g, '/')}`),
    import(`file://${path.join(LIB, 'fs-port.js').replace(/\\/g, '/')}`),
    import(`file://${path.join(LIB, 'reducer.js').replace(/\\/g, '/')}`),
  ]);
  return { journalMod, recoveryMod, snapshotMod, fsPortMod, reducerMod };
}

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `n5-g5-${label}-`));
}

async function main() {
  const json = process.argv.includes('--json');
  let mods;
  try {
    mods = await load();
  } catch (err) {
    const payload = { state: 'unknown', exitCode: EXIT.unknown, reason: `lib/state 不可用：${err?.message ?? err}` };
    if (json) console.log(JSON.stringify(payload, null, 2));
    else console.log(`[unknown] ${payload.reason}`);
    process.exit(EXIT.unknown);
  }
  const { journalMod, recoveryMod, snapshotMod, fsPortMod, reducerMod } = mods;

  const dir = tmpDir('main');
  const fsPort = new fsPortMod.NodeFsPort();

  // ── 1) 打开 journal 并追加真实记录 ──────────────────────────────
  const opened = await journalMod.Journal.open({ fs: fsPort, dir });
  const journal = opened.journal;
  const paths = journalMod.statePaths(dir);

  const nodeId = 'NODE-T1';
  await journal.append({ kind: 'node_added', nodeId, payload: { node: { nodeId, title: 't', spec: 's', status: 'planned', stage: 'build', capability: 'CODE', deps: [], evidenceRequired: [], attempts: 0 } } });
  await journal.append({ kind: 'status_changed', nodeId, payload: { from: 'planned', to: 'ready', reason: 'dependency_done', at: new Date().toISOString() } });

  const records = journal.records();
  add('G5R-1', 'JournalRecord 形状（seq 严格 +1 / eventId / prevHash 链）',
    records.every((r, i) => r.seq === i + 1 && typeof r.eventId === 'string' && r.prevHash === (i === 0 ? '' : records[i - 1].hash)),
    `${records.length} records`);
  let chainOk = true;
  try { journal.verifyChain(); } catch { chainOk = false; }
  add('G5R-2', 'verifyChain 通过（真实实现）', chainOk);

  // ── 2) 真实 recoverWithJournal：无快照 → bootstrap ─────────────
  const opened2 = await journalMod.Journal.open({ fs: fsPort, dir, stealIfStale: true });
  const rec1 = await recoveryMod.recoverWithJournal({ fs: fsPort, paths, journal: opened2.journal });
  add('G5R-3', 'recoverWithJournal 无快照时从 journal bootstrap',
    rec1 && rec1.state && rec1.state.revision === opened2.journal.records().length,
    `source=${rec1?.source} revision=${rec1?.state?.revision}`);

  // ── 3) 写真实快照后再次恢复：走快路径 ───────────────────────────
  const rawJournal1 = fs.readFileSync(paths.journal, 'utf8');
  const snapFile = snapshotMod.buildSnapshot(rec1.state, opened2.journal.records(), rawJournal1, new Date().toISOString());
  await snapshotMod.updateSnapshot(fsPort, paths, snapFile);
  const opened3 = await journalMod.Journal.open({ fs: fsPort, dir, stealIfStale: true });
  const rec2 = await recoveryMod.recoverWithJournal({ fs: fsPort, paths, journal: opened3.journal });
  add('G5R-4', '有快照时恢复走快路径且 revision 一致',
    rec2 && rec2.state && rec2.state.revision === opened3.journal.records().length,
    `source=${rec2?.source} revision=${rec2?.state?.revision}`);

  // ── 4) 锚前缀规则：journal 前进后旧快照仍可校验 ─────────────────
  const snapshotFile = JSON.parse(fs.readFileSync(paths.snapshot, 'utf8'));
  const recordsAtRecover = opened3.journal.records().map((r) => ({ ...r }));
  const before = opened3.journal.records();
  await opened3.journal.append({ kind: 'stage_gate_changed', payload: { stage: 'build', status: 'passed' } });
  const after = opened3.journal.records();
  const rawAfter = fs.readFileSync(paths.journal, 'utf8');
  const anchor = snapshotMod.checkAnchor(snapshotFile, after, rawAfter);
  add('G5R-5', '锚按前缀比较（journal 前进后旧快照仍有效）',
    anchor.status !== 'diverged', `status=${anchor.status} snapshotSeq=${snapshotFile.meta.seq} journalSeq=${after.length} (before=${before.length})`);

  // ── 5) 快照超前 → STATE_SNAPSHOT_AHEAD ─────────────────────────
  // 构造"内部自洽但 seq 超前"的快照（seq == revision == state.revision == N），
  // 让它通过 verifySnapshot，从而真正走到 SNAPSHOT_AHEAD 分支。
  const aheadFile = JSON.parse(JSON.stringify(snapshotFile));
  const aheadSeq = after.length + 10;
  aheadFile.meta.seq = aheadSeq;
  aheadFile.meta.revision = aheadSeq;
  aheadFile.state.revision = aheadSeq;
  // 改完 state 必须重算 stateSha256，否则会先在 verifySnapshot 处被判 STATE_DIVERGED，
  // 走不到 SNAPSHOT_AHEAD 分支（这本身也是一条应当成立的自洽约束）。
  aheadFile.meta.stateSha256 = snapshotMod.stateSha256(aheadFile.state);
  fs.writeFileSync(paths.snapshot, JSON.stringify(aheadFile, null, 2), 'utf8');
  let aheadCode = null;
  try {
    const opened4 = await journalMod.Journal.open({ fs: fsPort, dir, stealIfStale: true });
    await recoveryMod.recoverWithJournal({ fs: fsPort, paths, journal: opened4.journal });
  } catch (err) {
    aheadCode = err?.code ?? null;
  }
  add('G5R-6', '快照超前 → STATE_SNAPSHOT_AHEAD（fail-closed）', aheadCode === 'STATE_SNAPSHOT_AHEAD', `code=${aheadCode}`);

  // ── 6) journal 被篡改 → STATE_HASH_BREAK ───────────────────────
  const dir2 = tmpDir('tamper');
  const openedT = await journalMod.Journal.open({ fs: fsPort, dir: dir2 });
  await openedT.journal.append({ kind: 'node_added', nodeId: 'NODE-T2', payload: { node: { nodeId: 'NODE-T2', title: 't', spec: 's', status: 'planned', stage: 'build', capability: 'CODE', deps: [], evidenceRequired: [], attempts: 0 } } });
  await openedT.journal.append({ kind: 'status_changed', nodeId: 'NODE-T2', payload: { from: 'planned', to: 'ready', reason: 'x', at: new Date().toISOString() } });
  const paths2 = journalMod.statePaths(dir2);
  const lines = fs.readFileSync(paths2.journal, 'utf8').split('\n').filter(Boolean);
  const tampered = JSON.parse(lines[0]);
  tampered.payload.node.title = 'TAMPERED';
  lines[0] = JSON.stringify(tampered);
  fs.writeFileSync(paths2.journal, lines.join('\n') + '\n', 'utf8');
  let tamperCode = null;
  try {
    const opened5 = await journalMod.Journal.open({ fs: fsPort, dir: dir2, stealIfStale: true });
    opened5.journal.verifyChain();
  } catch (err) {
    tamperCode = err?.code ?? null;
  }
  add('G5R-7', 'journal 被篡改 → STATE_HASH_BREAK（fail-closed）', tamperCode === 'STATE_HASH_BREAK', `code=${tamperCode}`);

  // ── 7) 折叠一致：fold(records) 与 recover 结果同 revision ───────
  const folded = reducerMod.fold(recordsAtRecover, reducerMod.emptyState());
  add('G5R-8', 'fold(records) 与 recover 状态一致（revision）',
    folded.revision === rec2.state.revision,
    `fold=${folded.revision} recover=${rec2.state.revision} records=${recordsAtRecover.length}`);

  const failed = checks.filter((c) => c.ok === false).length;
  const passed = checks.filter((c) => c.ok === true).length;
  const state = failed > 0 ? 'failed' : 'pass';
  const payload = { suite: 'g5-real', state, exitCode: EXIT[state], passed, failed, total: checks.length, checks };

  if (json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log('\n=== G5 @real (lib/state) ===');
    for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(10)} ${c.title}${c.detail ? ' — ' + c.detail : ''}`);
    console.log(`\nstate=${state} passed=${passed} failed=${failed} exit=${EXIT[state]}`);
  }
  for (const d of [dir, dir2]) fs.rmSync(d, { recursive: true, force: true });
  process.exit(EXIT[state]);
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(EXIT.failed);
});
