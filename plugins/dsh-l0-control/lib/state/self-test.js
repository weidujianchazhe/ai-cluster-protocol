/**
 * N4 · 状态层自测（可执行验收）
 *
 * 运行：`node plugins/dsh-l0-control/src/state/self-test.ts`
 * 依赖：Node ≥ 22.6（类型擦除）；无第三方依赖、无构建步骤。
 *
 * 覆盖 task-13 验收项：
 *   A. 双写被拒（STATE_LOCKED / STATE_FENCED_OUT）
 *   B. revision 单调 + 哈希链 + seq 连续
 *   C. 强杀后 journal 重放 == 快照（torn tail / 半写 / 截断）
 *   D. 快照 CAS：陈旧版本写被拒；快照超前 → fail-closed
 *   E. checkpoint / takeover / fencing
 *   F. TeamTask 投影可重建（投影哈希与 journal 折叠一致）
 *   G. 与 Python `control_plane` 事件重放语义对齐（同一夹具）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { MemoryFsPort, NodeFsPort } from './fs-port.js';
import { Journal, statePaths } from './journal.js';
import { canonicalJson, eventIdOf, nowIso, sha256Hex } from './canonical.js';
import { emptyState, fold } from './reducer.js';
import { buildSnapshot, checkAnchor, readSnapshot, updateSnapshot, verifySnapshot, writeSnapshot } from './snapshot.js';
import { openAndRecover } from './recovery.js';
import { Store } from './store.js';
import { projectTeamTasks, projectionStatus, rebuildProjection, diffProjection } from './projection.js';
import { persistCoreEvents, restoreCoreJournal, toCoreGraph, toEventRecords, pythonEventView } from './bridge.js';
import { checkEventIdFormat, diffOracle, parseOracleFixture, resolveFixturePath, runOracleScript } from './python-diff.js';
                                                   
import { StateError } from './types.js';

let passed = 0;
let failed = 0;
const failures                                          = [];

async function test(name        , fn                            )                {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  FAIL ${name}\n       ${message}`);
  }
}

function assert(condition         , message        )                    {
  if (!condition) throw new Error(message);
}

function assertEqual   (actual   , expected   , message        )       {
  const a = canonicalJson(actual           );
  const e = canonicalJson(expected           );
  if (a !== e) throw new Error(`${message}\n       expected=${e}\n       actual  =${a}`);
}

async function assertThrows(fn                        , code        , message        )                {
  try {
    await fn();
  } catch (error) {
    if (error instanceof StateError && error.code === code) return;
    const got = error instanceof StateError ? error.code : String(error);
    throw new Error(`${message}（期望 ${code}，实际 ${got}）`);
  }
  throw new Error(`${message}（期望抛 ${code}，实际未抛）`);
}

const T0 = Date.parse('2026-10-29T20:00:00+08:00');

async function journalSuite()                {
  console.log('\n[A/B] journal：单写者 / revision 单调 / 哈希链');

  await test('append 三条：seq 1..3，eventId 与 Python 同格式，链自洽', async () => {
    const fsPort = new MemoryFsPort();
    const { journal } = await Journal.open({ dir: '/mem/state', fs: fsPort, owner: 'w1', now: () => T0 });
    await journal.append({ kind: 'node_added', nodeId: 'NODE-001', payload: { nodeId: 'NODE-001' } });
    await journal.append({ kind: 'status_changed', nodeId: 'NODE-001', payload: { from: 'planned', to: 'ready' } });
    await journal.append({ kind: 'status_changed', nodeId: 'NODE-001', payload: { from: 'ready', to: 'claimed' } });
    assertEqual(journal.seq, 3, 'seq 应为 3');
    assertEqual(journal.revision, 3, 'revision === seq');
    assertEqual(journal.records().map((r) => r.eventId), ['EVT-000001', 'EVT-000002', 'EVT-000003'], 'eventId 格式');
    journal.verifyChain();
    assertEqual(journal.records()[2].prevHash, journal.records()[1].hash, 'prevHash 连接');
    await journal.release();
  });

  await test('双写被拒：第二个 owner 打开同一目录 → STATE_LOCKED', async () => {
    const fsPort = new MemoryFsPort();
    const first = await Journal.open({ dir: '/mem/state2', fs: fsPort, owner: 'w1', now: () => T0 });
    await first.journal.append({ kind: 'node_added', nodeId: 'N1' });
    await assertThrows(
      () => Journal.open({ dir: '/mem/state2', fs: fsPort, owner: 'w2', now: () => T0 }),
      'STATE_LOCKED',
      '第二写者必须被拒',
    );
    await first.journal.release();
  });

  await test('owner 释放后可被新 owner 打开（epoch=1 重新持有）', async () => {
    const fsPort = new MemoryFsPort();
    const first = await Journal.open({ dir: '/mem/state3', fs: fsPort, owner: 'w1', now: () => T0 });
    await first.journal.append({ kind: 'a' });
    await first.journal.release();
    const second = await Journal.open({ dir: '/mem/state3', fs: fsPort, owner: 'w2', now: () => T0 });
    assertEqual(second.journal.seq, 1, '重开后 seq 保留');
    await second.journal.append({ kind: 'b' });
    assertEqual(second.journal.seq, 2, '继续追加');
    await second.journal.release();
  });

  await test('哈希链被篡改 → STATE_HASH_BREAK（中间损坏不静默）', async () => {
    const fsPort = new MemoryFsPort();
    const { journal } = await Journal.open({ dir: '/mem/state4', fs: fsPort, owner: 'w1', now: () => T0 });
    await journal.append({ kind: 'a', payload: { v: 1 } });
    await journal.append({ kind: 'b', payload: { v: 2 } });
    await journal.release();
    const raw = (await fsPort.readText(statePaths('/mem/state4').journal))          ;
    const tampered = raw.replace('"v":1', '"v":9');
    await fsPort.writeCas(statePaths('/mem/state4').journal, tampered, {
      kind: 'replaceIfVersion',
      version: (await fsPort.versionOf(statePaths('/mem/state4').journal))          ,
    });
    await assertThrows(
      () => Journal.open({ dir: '/mem/state4', fs: fsPort, owner: 'w3', now: () => T0, repairTail: true }),
      'STATE_HASH_BREAK',
      '篡改必须 fail-closed',
    );
  });
}

async function tornTailSuite()                {
  console.log('\n[C] 崩溃尾部：半写行截断后 seq 回退到最后完整记录');

  await test('末行半写（无换行）→ open 自动截断，seq=2，repair 诊断非空', async () => {
    const fsPort = new MemoryFsPort();
    const { journal } = await Journal.open({ dir: '/mem/torn', fs: fsPort, owner: 'w1', now: () => T0 });
    await journal.append({ kind: 'a' });
    await journal.append({ kind: 'b' });
    fsPort.failNextAppend = 'partial';
    await journal.append({ kind: 'c', payload: { big: 'x'.repeat(40) } });
    await journal.release();

    const reopened = await Journal.open({ dir: '/mem/torn', fs: fsPort, owner: 'w2', now: () => T0 });
    assert(reopened.repair !== null, '应有 repair 诊断');
    assertEqual(reopened.repair?.droppedLines, 1, '丢弃 1 行');
    assertEqual(reopened.journal.seq, 2, 'seq 回退到 2');
    assertEqual(reopened.journal.records().map((r) => r.kind), ['a', 'b'], '保留完整记录');
    await reopened.journal.append({ kind: 'c2' });
    assertEqual(reopened.journal.seq, 3, '修复后可继续追加');
    await reopened.journal.release();
  });

  await test('seq=3 的 eventId 在修复后不复用（EVT-000003）', async () => {
    const fsPort = new MemoryFsPort();
    const { journal } = await Journal.open({ dir: '/mem/torn2', fs: fsPort, owner: 'w1', now: () => T0 });
    await journal.append({ kind: 'a' });
    await journal.append({ kind: 'b' });
    fsPort.failNextAppend = 'partial';
    await journal.append({ kind: 'c' });
    await journal.release();
    const reopened = await Journal.open({ dir: '/mem/torn2', fs: fsPort, owner: 'w2', now: () => T0 });
    const record = await reopened.journal.append({ kind: 'd' });
    assertEqual(record.eventId, 'EVT-000003', 'eventId 按 seq 重新生成');
    assertEqual(record.seq, 3, 'seq 连续');
    await reopened.journal.release();
  });
}

async function snapshotSuite()                {
  console.log('\n[D] 快照：CAS 发布 / 三元锚 / 陈旧版本拒绝');

  await test('bootstrap：无快照时按 journal 建快照，三元锚自洽', async () => {
    const fsPort = new MemoryFsPort();
    const paths = statePaths('/mem/snap1');
    // 只用 Journal（不触发 recovery）写两条，模拟"插件首次启动前已有 journal"
    const opened = await Journal.open({ dir: '/mem/snap1', fs: fsPort, owner: 'w1', now: () => T0 });
    await opened.journal.append({ kind: 'node_added', nodeId: 'N1', payload: { node: { nodeId: 'N1', title: 't', status: 'planned' } } });
    await opened.journal.append({ kind: 'status_changed', nodeId: 'N1', payload: { from: 'planned', to: 'ready', at: nowIso(T0) } });
    await opened.journal.release();

    const again = await openAndRecover({ dir: '/mem/snap1', fs: fsPort, owner: 'w2', now: () => T0 });
    assertEqual(again.report.source, 'journal+bootstrap', '首次应 bootstrap');
    assertEqual(again.report.snapshot.existed, false, '此前无快照');
    assertEqual(again.report.snapshot.updated, true, '应写快照');
    assertEqual(again.report.state.nodes.N1.status, 'ready', '折叠后状态');
    const loaded = await readSnapshot(fsPort, paths);
    assert(loaded !== null, '快照应存在');
    verifySnapshot(loaded .file);
    assertEqual(loaded .file.meta.seq, 2, '快照锚 seq');
    const raw = (await fsPort.readText(paths.journal))          ;
    assertEqual(loaded .file.meta.journalHash, sha256Hex(raw), 'journalHash = 原文 sha256');
    assertEqual(loaded .file.meta.journalBytes, Buffer.byteLength(raw, 'utf8'), 'journalBytes = 原文字节数');
    assertEqual(checkAnchor(loaded .file, again.journal.records(), raw).status, 'in-sync', '锚状态 in-sync');
    await again.journal.release();
  });

  await test('陈旧版本写快照 → STATE_STALE_VERSION（不覆盖别人刚写的）', async () => {
    const fsPort = new MemoryFsPort();
    const paths = statePaths('/mem/snap2');
    await fsPort.mkdirp(paths.root);
    const first = buildSnapshot(emptyState(), [], '', nowIso(T0));
    await writeSnapshot(fsPort, paths, first, { kind: 'createIfAbsent' });
    const staleVersion = (await fsPort.versionOf(paths.snapshot))          ;
    // 另一个写者先更新
    const second = buildSnapshot(emptyState(), [], '', nowIso(T0 + 1000));
    await writeSnapshot(fsPort, paths, second, { kind: 'replaceIfVersion', version: staleVersion });
    await assertThrows(
      () => writeSnapshot(fsPort, paths, first, { kind: 'replaceIfVersion', version: staleVersion }),
      'STATE_STALE_VERSION',
      '旧版本写必须被拒',
    );
    await assertThrows(
      () => writeSnapshot(fsPort, paths, first, { kind: 'createIfAbsent' }),
      'STATE_STALE_VERSION',
      'createIfAbsent 遇已存在必须被拒',
    );
  });

  await test('快照内容被篡改 → verifySnapshot 报 STATE_DIVERGED', async () => {
    const fsPort = new MemoryFsPort();
    const paths = statePaths('/mem/snap3');
    await fsPort.mkdirp(paths.root);
    const file = buildSnapshot(emptyState(), [], '', nowIso(T0));
    file.state.graphRevision = 99; // 改内容但不改 stateSha256
    await writeSnapshot(fsPort, paths, file, { kind: 'createIfAbsent' });
    const loaded = await readSnapshot(fsPort, paths);
    await assertThrows(async () => verifySnapshot(loaded .file), 'STATE_DIVERGED', '内容/哈希不符必须拒绝');
  });

  await test('updateSnapshot 读-改-写：版本推进且 CAS 生效', async () => {
    const fsPort = new MemoryFsPort();
    const paths = statePaths('/mem/snap4');
    await fsPort.mkdirp(paths.root);
    const a = buildSnapshot(emptyState(), [], '', nowIso(T0));
    const r1 = await updateSnapshot(fsPort, paths, a);
    const b = buildSnapshot({ ...emptyState(), graphRevision: 2 }, [], '', nowIso(T0 + 1));
    const r2 = await updateSnapshot(fsPort, paths, b);
    assertEqual([r1.operation, r2.operation], ['create', 'update'], 'create → update');
    assert(r1.version !== r2.version, '版本必须变化');
  });
}

async function recoverySuite()                {
  console.log('\n[E] 恢复：快照前后判定 / journal 权威 / fail-closed');

  await test('journal 前进、快照落后 → snapshot+replay，并把快照推到最新', async () => {
    const fsPort = new MemoryFsPort();
    const paths = statePaths('/mem/rec1');
    const { journal } = await openAndRecover({ dir: '/mem/rec1', fs: fsPort, owner: 'w1', now: () => T0 });
    await journal.append({ kind: 'node_added', nodeId: 'N1', payload: { node: { nodeId: 'N1', title: 't', status: 'planned' } } });
    await journal.append({ kind: 'node_added', nodeId: 'N2', payload: { node: { nodeId: 'N2', title: 't2', status: 'planned' } } });
    await journal.release();

    const mid = await openAndRecover({ dir: '/mem/rec1', fs: fsPort, owner: 'w2', now: () => T0 });
    await mid.journal.append({ kind: 'status_changed', nodeId: 'N1', payload: { from: 'planned', to: 'ready', at: nowIso(T0) } });
    await mid.journal.append({ kind: 'status_changed', nodeId: 'N2', payload: { from: 'planned', to: 'ready', at: nowIso(T0) } });
    await mid.journal.release();

    const last = await openAndRecover({ dir: '/mem/rec1', fs: fsPort, owner: 'w3', now: () => T0 });
    assertEqual(last.report.source, 'snapshot+replay', '应从快照重放增量');
    assertEqual(last.report.snapshot.existed, true, '快照应存在');
    assertEqual(last.report.snapshot.seq, 2, '旧快照 seq=2');
    assertEqual(last.report.seq, 4, 'journal seq=4');
    assertEqual(last.report.replayEqualsSnapshot, true, '全量折叠与增量重放一致');
    assertEqual(last.report.snapshot.updated, true, '快照应被推进');
    const loaded = await readSnapshot(fsPort, paths);
    assertEqual(loaded .file.meta.seq, 4, '快照已推进到 4');
    await last.journal.release();
  });

  await test('快照超前于 journal → STATE_SNAPSHOT_AHEAD（拒绝启动，不伪造历史）', async () => {
    const fsPort = new MemoryFsPort();
    const paths = statePaths('/mem/rec2');
    const { journal } = await openAndRecover({ dir: '/mem/rec2', fs: fsPort, owner: 'w1', now: () => T0 });
    for (const id of ['N1', 'N2', 'N3']) {
      await journal.append({ kind: 'node_added', nodeId: id, payload: { node: { nodeId: id, title: id, status: 'planned' } } });
    }
    await journal.release();
    // 先让快照推进到 seq=3（正常对账）
    const synced = await openAndRecover({ dir: '/mem/rec2', fs: fsPort, owner: 'w1', now: () => T0 });
    assertEqual(synced.report.snapshot.write?.meta.seq, 3, '快照应先到 seq=3');
    await synced.journal.release();
    // journal 被回滚：只留前 2 条
    const raw = (await fsPort.readText(paths.journal))          ;
    const keep = raw.split('\n').slice(0, 2).join('\n');
    await fsPort.writeCas(paths.journal, `${keep}\n`, {
      kind: 'replaceIfVersion',
      version: (await fsPort.versionOf(paths.journal))          ,
    });
    await assertThrows(
      () => openAndRecover({ dir: '/mem/rec2', fs: fsPort, owner: 'w2', now: () => T0 }),
      'STATE_SNAPSHOT_AHEAD',
      '快照 seq=3 > journal seq=2 必须拒绝',
    );
  });

  await test('快照与重放不一致 → journal 胜，留 snapshot_diverged 事件', async () => {
    const fsPort = new MemoryFsPort();
    const paths = statePaths('/mem/rec3');
    const { journal } = await openAndRecover({ dir: '/mem/rec3', fs: fsPort, owner: 'w1', now: () => T0 });
    await journal.append({ kind: 'node_added', nodeId: 'N1', payload: { node: { nodeId: 'N1', title: 't', status: 'planned' } } });
    await journal.append({ kind: 'status_changed', nodeId: 'N1', payload: { from: 'planned', to: 'ready', at: nowIso(T0) } });
    await journal.release();

    // 伪造一份"自洽但错误"的快照：state 与 seq=2 的重放结果不同，但 stateSha256 自洽
    const records = (await (async () => {
      const opened = await Journal.open({ dir: '/mem/rec3', fs: fsPort, owner: 'w9', now: () => T0 });
      const out = opened.journal.records();
      await opened.journal.release();
      return out;
    })());
    const wrong = fold(records);
    wrong.nodes.N1.status = 'done';
    const raw = (await fsPort.readText(paths.journal))          ;
    const forged = buildSnapshot(wrong, records, raw, nowIso(T0));
    if (fsPort.files.has(paths.snapshot)) await fsPort.remove(paths.snapshot);
    await writeSnapshot(fsPort, paths, forged, { kind: 'createIfAbsent' });

    const rec = await openAndRecover({ dir: '/mem/rec3', fs: fsPort, owner: 'w4', now: () => T0 });
    assertEqual(rec.report.diverged, true, '应判定分歧');
    assertEqual(rec.report.state.nodes.N1.status, 'ready', 'journal 胜：状态应为 ready');
    assert(rec.report.eventsAppended.length >= 1, '应追加 snapshot_diverged 事件');
    const loaded = await readSnapshot(fsPort, paths);
    assertEqual(loaded .file.state.nodes.N1.status, 'ready', '快照已被重写为 journal 事实');
    await rec.journal.release();
  });

  await test('重复 recover 幂等：无新增事件、无多余快照写', async () => {
    const fsPort = new MemoryFsPort();
    const { journal } = await openAndRecover({ dir: '/mem/rec4', fs: fsPort, owner: 'w1', now: () => T0 });
    await journal.append({ kind: 'node_added', nodeId: 'N1', payload: { node: { nodeId: 'N1', title: 't' } } });
    await journal.release();
    const first = await openAndRecover({ dir: '/mem/rec4', fs: fsPort, owner: 'w1', now: () => T0 });
    const before = first.journal.records().length;
    await first.journal.release();
    const second = await openAndRecover({ dir: '/mem/rec4', fs: fsPort, owner: 'w1', now: () => T0 });
    assertEqual(second.report.snapshot.updated, false, '已同步不应重写快照');
    assertEqual(second.journal.records().length, before, '不应新增事件');
    await second.journal.release();
  });
}

async function storeSuite()                {
  console.log('\n[F] Store 门面：append/折叠/takeover/checkpoint/关闭重开');

  await test('append 后内存状态 == 全量折叠（verify.ok）', async () => {
    const fsPort = new MemoryFsPort();
    const store = await Store.open({ dir: '/mem/store1', fs: fsPort, owner: 'w1', now: () => T0 });
    await store.append({
      kind: 'node_added',
      nodeId: 'N1',
      payload: { node: { nodeId: 'N1', title: '解析愿望', spec: 's', status: 'planned' } },
    });
    await store.append({ kind: 'status_changed', nodeId: 'N1', payload: { from: 'planned', to: 'ready', at: nowIso(T0) } });
    assertEqual(store.state.nodes.N1.status, 'ready', '折叠状态');
    assertEqual(store.revision, 2, 'revision');
    const verdict = store.verify();
    assert(verdict.ok, `verify 应通过：${verdict.memorySha} != ${verdict.replayedSha}`);
    await store.close();
  });

  await test('双写被拒：第二个 Store.open → STATE_LOCKED', async () => {
    const fsPort = new MemoryFsPort();
    const first = await Store.open({ dir: '/mem/store2', fs: fsPort, owner: 'w1', now: () => T0 });
    await first.append({ kind: 'node_added', nodeId: 'N1', payload: { node: { nodeId: 'N1', title: 't' } } });
    await assertThrows(
      () => Store.open({ dir: '/mem/store2', fs: fsPort, owner: 'w2', now: () => T0, waitMs: 0 }),
      'STATE_LOCKED',
      '第二写者必须被拒',
    );
    await first.close();
  });

  await test('takeover：过期锁被接管（epoch+1），旧 writer 写入 → STATE_FENCED_OUT', async () => {
    const fsPort = new MemoryFsPort();
    const first = await Store.open({ dir: '/mem/store3', fs: fsPort, owner: 'w1', ttlMs: 1000, now: () => T0 });
    await first.append({ kind: 'node_added', nodeId: 'N1', payload: { node: { nodeId: 'N1', title: 't' } } });
    assertEqual(first.currentFence?.token, 1, '初始 epoch=1');

    // 强杀语义：不 close，等锁过期后由新进程接管
    const later = await Store.open({ dir: '/mem/store3', fs: fsPort, owner: 'w2', ttlMs: 1000, now: () => T0 + 5000, takeover: true });
    assertEqual(later.currentFence?.token, 2, '接管后 epoch=2');
    assertEqual(later.state.nodes.N1.title, 't', '接管后重放状态');
    const kinds = later.journal.records().map((record) => record.kind);
    assert(kinds.includes('writer_taken_over'), '应留 writer_taken_over 事件');

    await assertThrows(
      () => first.append({ kind: 'status_changed', nodeId: 'N1', payload: { to: 'ready' } }),
      'STATE_FENCED_OUT',
      '旧 writer 写入必须被 fencing 拒绝',
    );
    await first.close(); // 不能删掉接管者的锁
    await later.append({ kind: 'status_changed', nodeId: 'N1', payload: { from: 'planned', to: 'ready', at: nowIso(T0) } });
    await later.close();
  });

  await test('活锁不可被 takeover 抢占', async () => {
    const fsPort = new MemoryFsPort();
    const first = await Store.open({ dir: '/mem/store4', fs: fsPort, owner: 'w1', ttlMs: 60_000, now: () => T0 });
    await assertThrows(
      () => Store.open({ dir: '/mem/store4', fs: fsPort, owner: 'w2', ttlMs: 60_000, now: () => T0 + 1, takeover: true, waitMs: 0 }),
      'STATE_LOCKED',
      '未过期锁不得抢占',
    );
    await first.close();
  });

  await test('checkpoint：不可变、幂等，携带 sessionId/lastSeq 锚', async () => {
    const fsPort = new MemoryFsPort();
    const store = await Store.open({ dir: '/mem/store5', fs: fsPort, owner: 'w1', now: () => T0 });
    await store.append({ kind: 'node_added', nodeId: 'N1', payload: { node: { nodeId: 'N1', title: 't' } } });
    const cp = await store.checkpoint({ sessionId: 'sess-1', lastSeq: 42 });
    assertEqual([cp.seq, cp.sessionId, cp.lastSeq], [1, 'sess-1', 42], '检查点锚');
    const again = await store.checkpoint({ sessionId: 'sess-1', lastSeq: 42 });
    assertEqual(again.checkpointId, cp.checkpointId, '同状态幂等');
    const files = await fsPort.listDir(statePaths('/mem/store5').checkpoints);
    assertEqual(files.length, 1, '只落一个检查点文件');
    await store.close();
  });

  await test('关闭后重开：revision/状态保留，快照落盘', async () => {
    const fsPort = new MemoryFsPort();
    const store = await Store.open({ dir: '/mem/store6', fs: fsPort, owner: 'w1', now: () => T0 });
    await store.append({ kind: 'node_added', nodeId: 'N1', payload: { node: { nodeId: 'N1', title: 't', status: 'planned' } } });
    await store.append({ kind: 'status_changed', nodeId: 'N1', payload: { from: 'planned', to: 'ready', at: nowIso(T0) } });
    await store.close();
    const reopened = await Store.open({ dir: '/mem/store6', fs: fsPort, owner: 'w2', now: () => T0 });
    assertEqual(reopened.revision, 2, 'revision 保留');
    assertEqual(reopened.state.nodes.N1.status, 'ready', '状态保留');
    assertEqual(reopened.lastRecovery.source, 'snapshot+replay', '从快照 + 增量恢复');
    assert(reopened.verify().ok, 'verify 通过');
    await reopened.close();
  });
}

async function projectionSuite()                {
  console.log('\n[G] TeamTask 投影：可重建 / 哈希稳定 / 差异可见');

  await test('投影纯函数：同状态两次投影哈希一致，顺序按阶段', async () => {
    const fsPort = new MemoryFsPort();
    const store = await Store.open({ dir: '/mem/proj1', fs: fsPort, owner: 'w1', now: () => T0 });
    await store.append({ kind: 'node_added', nodeId: 'N2', payload: { node: { nodeId: 'N2', title: '实现', stage: 'build', status: 'planned' } } });
    await store.append({ kind: 'node_added', nodeId: 'N1', payload: { node: { nodeId: 'N1', title: '调研', stage: 'research', status: 'ready' } } });
    const a = projectTeamTasks(store.state);
    const b = projectTeamTasks(store.state);
    assertEqual(a.projectionHash, b.projectionHash, '哈希稳定');
    assertEqual(a.tasks.map((task) => task.nodeId), ['N1', 'N2'], 'research 先于 build');
    assert(a.promptSummary.includes('revision=2'), 'prompt 摘要含 revision');
    await store.close();
  });

  await test('rebuildProjection：写盘 → in-sync；追加后 → seq-advanced 并可重算', async () => {
    const fsPort = new MemoryFsPort();
    const paths = statePaths('/mem/proj2');
    const store = await Store.open({ dir: '/mem/proj2', fs: fsPort, owner: 'w1', now: () => T0 });
    await store.append({ kind: 'node_added', nodeId: 'N1', payload: { node: { nodeId: 'N1', title: 't', status: 'ready' } } });
    const first = await rebuildProjection(fsPort, paths, store.state, { at: nowIso(T0) });
    assertEqual(first.rebuilt, true, '首次应重建');
    assertEqual(first.reason, 'missing', '原因 missing');
    const inSync = await projectionStatus(fsPort, paths, store.state);
    assertEqual([inSync.needsRebuild, inSync.reason], [false, 'in-sync'], '写后 in-sync');

    await store.append({ kind: 'status_changed', nodeId: 'N1', payload: { from: 'ready', to: 'claimed', assignee: 'ROLE-CODE-01', at: nowIso(T0) } });
    const stale = await projectionStatus(fsPort, paths, store.state);
    assertEqual([stale.needsRebuild, stale.reason], [true, 'seq-advanced'], '追加后过期');
    const plan                                         = { upsert: [], remove: [] };
    const second = await rebuildProjection(fsPort, paths, store.state, {
      at: nowIso(T0),
      writer: async (delta) => {
        plan.upsert = delta.upsert.map((task) => task.nodeId);
        plan.remove = delta.remove;
      },
    });
    assertEqual(second.rebuilt, true, '应重建');
    assertEqual(plan.upsert, ['N1'], '只 upsert 变化节点');
    assertEqual(plan.remove, [], '无删除');
    await store.close();
  });

  await test('diffProjection 能发现缺失/多余/改值', async () => {
    const fsPort = new MemoryFsPort();
    const store = await Store.open({ dir: '/mem/proj3', fs: fsPort, owner: 'w1', now: () => T0 });
    await store.append({ kind: 'node_added', nodeId: 'N1', payload: { node: { nodeId: 'N1', title: 't', status: 'ready' } } });
    const expected = projectTeamTasks(store.state);
    const actual = [{ ...expected.tasks[0], phase: 'x' }                                              ];
    const d1 = diffProjection(expected, actual);
    assertEqual([d1.missing.length, d1.extra.length, d1.changed.length], [0, 0, 1], '改值应被发现');
    const d2 = diffProjection(expected, []);
    assertEqual([d2.missing, d2.extra], [['N1'], []], '缺失应被发现');
    await store.close();
  });
}

async function bridgeSuite()                {
  console.log('\n[H] 与 N3 core / Python oracle 的互操作');

  await test('core 形状(snake_case)事件落盘 → 状态折叠 → 回灌 core 日志', async () => {
    const fsPort = new MemoryFsPort();
    const store = await Store.open({ dir: '/mem/bridge1', fs: fsPort, owner: 'w1', now: () => T0 });
    const events                    = [
      {
        seq: 1,
        event_id: 'EVT-000001',
        ts: nowIso(T0),
        kind: 'node_added',
        node_id: 'N1',
        payload: {
          node: {
            node_id: 'N1',
            title: '解析愿望',
            spec: 's',
            capability: null,
            stage: 'research',
            status: 'planned',
            deps: [],
            evidence_required: ['artifact'],
            decision_id: null,
            attempts: 0,
            assignee: null,
            verifier_ids: ['verifier-ci'],
            budget: { max_tokens: 1000 },
            created_at: nowIso(T0),
            updated_at: nowIso(T0),
          },
        },
      },
      { seq: 2, event_id: 'EVT-000002', ts: nowIso(T0), kind: 'edge_added', node_id: 'N1', payload: { from: 'N0', to: 'N1', kind: 'blocks' } },
      { seq: 3, event_id: 'EVT-000003', ts: nowIso(T0), kind: 'assignee_changed', node_id: 'N1', payload: { to: 'ROLE-CODE-01' } },
      { seq: 4, event_id: 'EVT-000004', ts: nowIso(T0), kind: 'attempts_changed', node_id: 'N1', payload: { to: 2 } },
      {
        seq: 5,
        event_id: 'EVT-000005',
        ts: nowIso(T0),
        kind: 'evidence_added',
        node_id: 'N1',
        payload: { evidence_id: 'EVD-1', kind: 'artifact', artifact_id: 'ART-1', verifier_id: 'verifier-ci', verdict: 'pass' },
      },
    ];
    const persisted = await persistCoreEvents(store, events);
    assertEqual(persisted.appended.map((record) => record.eventId), events.map((event) => event.event_id), 'eventId 与 core 对齐');
    assertEqual(persisted.baseSeq, 0, '首次以 0 为基准');
    assertEqual(store.state.nodes.N1.evidenceRequired, ['artifact'], 'snake_case 字段映射');
    assertEqual(store.state.nodes.N1.assignee, 'ROLE-CODE-01', 'assignee 事件折叠');
    assertEqual(store.state.nodes.N1.attempts, 2, 'attempts 事件折叠');
    assertEqual(store.state.evidence['EVD-1'].verdict, 'pass', '证据折叠');

    const fakeCore = {
      events: []                     ,
      count() {
        return this.events.length;
      },
      raw() {
        return [...this.events];
      },
      restore(next                   ) {
        this.events = [...next];
      },
    };
    const restored = await restoreCoreJournal(store, fakeCore);
    assertEqual(restored.restored, 5, '回灌条数');
    assertEqual(restored.coreSeq, 5, 'core seq 起点');
    assertEqual(fakeCore.raw()[4].event_id, 'EVT-000005', '回灌后事件号一致');
    const graph = toCoreGraph(store.state);
    assertEqual(graph.nodes.N1.node_id, 'N1', 'core NodeRecord 形状');
    assertEqual(graph.nodes.N1.evidence_required, ['artifact'], 'core 字段名');
    assertEqual(graph.edges.length, 1, '边映射');
    await store.close();
  });

  await test('core seq 与 journal 不连续 → STATE_SEQ_GAP（先回灌再写）', async () => {
    const fsPort = new MemoryFsPort();
    const store = await Store.open({ dir: '/mem/bridge2', fs: fsPort, owner: 'w1', now: () => T0 });
    await store.append({ kind: 'node_added', nodeId: 'N1', payload: { node: { nodeId: 'N1', title: 't' } } });
    await assertThrows(
      () =>
        persistCoreEvents(store, [
          { seq: 9, event_id: 'EVT-000009', ts: nowIso(T0), kind: 'status_changed', node_id: 'N1', payload: { to: 'ready' } },
        ]),
      'STATE_SEQ_GAP',
      'seq 分叉必须拒绝',
    );
    await store.close();
  });

  await test('pythonEventView 形状与 Python events 行一致', async () => {
    const fsPort = new MemoryFsPort();
    const store = await Store.open({ dir: '/mem/bridge3', fs: fsPort, owner: 'w1', now: () => T0 });
    const record = await store.append({ kind: 'status_changed', nodeId: 'N1', payload: { from: 'planned', to: 'ready', at: nowIso(T0) } });
    const view = pythonEventView(record);
    assertEqual(Object.keys(view).sort(), ['event_id', 'kind', 'node_id', 'payload', 'seq', 'ts'], 'Python 事件行字段');
    assertEqual(toEventRecords([record]).length, 1, '批量映射');
    await store.close();
  });
}

async function oracleSuite()                {
  console.log('\n[I] 与 Python oracle 同夹具差分');

  await test('同一脚本：TS 折叠状态 == Python snapshot（statuses/assignee/attempts/edges）', async () => {
    const fixturePath = resolveFixturePath(import.meta.url);
    const fixture = parseOracleFixture(fs.readFileSync(fixturePath, 'utf8'));
    const run = await runOracleScript(fixture.script);
    const diff = diffOracle(run.state, fixture);
    assert(diff.ok, `差分未归零：${diff.differences.join(',')}\n${JSON.stringify(diff.checks, null, 1)}`);
    assertEqual(run.replayEqualsState, true, 'TS 侧重放 == 内存状态');
    assertEqual(run.state.nodes.N1.assignee, 'agent-A', 'TS 重放保留 assignee（N4 加固点）');
    const idCheck = checkEventIdFormat(run.records);
    assert(idCheck.ok, `eventId 格式异常：${idCheck.actual}`);
    assertEqual(run.records[0].eventId, 'EVT-000001', '首条事件号');
  });

  await test('oracle 自洽性：Python snapshot == replay（上游已修 assignee 事件化）', async () => {
    const fixturePath = resolveFixturePath(import.meta.url);
    const fixture = parseOracleFixture(fs.readFileSync(fixturePath, 'utf8'));
    assertEqual(fixture.python.snapshotEqualsReplay, true, 'oracle 应自洽');
    assertEqual(fixture.python.replayAssignee, fixture.python.assignee, 'oracle replay 应保留 assignee');
  });
}

async function crashSuite()                {
  console.log('\n[J] 真实强杀（SIGKILL 子进程）→ 接管 + 重放 == 快照');

  await test('子进程被杀：锁残留 → takeover 接管 → revision 无丢失、无重复', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n4-crash-'));
    const childPath = fileURLToPath(new URL('./crash-child.ts', import.meta.url));
    const child = spawn(process.execPath, [childPath, dir, '5'], { stdio: 'ignore' });
    const committedPath = path.join(dir, 'committed.txt');

    for (let tick = 0; tick < 200 && !fs.existsSync(committedPath); tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(fs.existsSync(committedPath), '子进程应在超时前提交并写 committed.txt');
    const committed = Number(fs.readFileSync(committedPath, 'utf8'));
    child.kill('SIGKILL');
    await once(child, 'exit');

    const lockPath = path.join(dir, 'journal.lock');
    assert(fs.existsSync(lockPath), '强杀后锁文件应残留');
    const staleLock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))                                    ;
    assertEqual(staleLock.owner, 'crash-child', '残留锁属于子进程');

    // 锁 TTL=1s：等它过期，再走显式接管
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const recovered = await Store.open({ dir, fs: new NodeFsPort(), owner: 'recovery', ttlMs: 60_000, takeover: true });
    assertEqual(recovered.currentFence?.token, 2, '接管后 epoch=2');
    // 诊断事件（writer_taken_over）也占 seq → 业务记录数才是可比事实
    const business = recovered.journal.records().filter((record) => record.kind !== 'writer_taken_over');
    assertEqual(business.length, committed, '已提交的业务记录不丢失、不重复');
    assertEqual(recovered.revision, committed + 1, '诊断事件占 1 条 seq');
    assertEqual(Object.keys(recovered.state.nodes).sort(), ['N1', 'N2', 'N3', 'N4', 'N5'], '状态节点恰为 5 个');
    assert(recovered.verify().ok, '接管后重放 == 内存状态');
    assert(
      recovered.journal.records().some((record) => record.kind === 'writer_taken_over'),
      '应留 writer_taken_over 事件',
    );
    const revisionAfterTakeover = recovered.revision;
    await recovered.close();

    // 强杀现场再叠加"半行"：模拟写一半时掉电
    const journalFile = path.join(dir, 'journal.jsonl');
    fs.appendFileSync(journalFile, '{"seq":', 'utf8');
    const afterTorn = await Store.open({ dir, fs: new NodeFsPort(), owner: 'after-torn' });
    assert(afterTorn.lastRecovery.repair !== null, '应检测到 torn tail');
    assertEqual(afterTorn.lastRecovery.repair?.droppedLines, 1, '丢弃半行');
    assertEqual(afterTorn.revision, revisionAfterTakeover, 'revision 回到已提交边界');
    assert(afterTorn.verify().ok, '修复后重放仍一致');
    await afterTorn.close();

    fs.rmSync(dir, { recursive: true, force: true });
  });
}

async function alignSuite()                {
  console.log('\n[K] 序列空间对齐：core seq ≠ revision 时仍可追加（恢复 27 / N4 39 / 追加 12）');

  const fakeCore = (events                    = []) => ({
    events,
    count() {
      return this.events.length;
    },
    raw() {
      return [...this.events];
    },
    restore(next                   ) {
      this.events = [...next];
    },
  });

  await test('恢复 27 条、store 已 39 条，再追加 12 条：不拒绝、revision 单调', async () => {
    const fsPort = new MemoryFsPort();
    const store = await Store.open({ dir: '/mem/align1', fs: fsPort, owner: 'w1', now: () => T0 });

    // 27 条业务事件
    for (let index = 1; index <= 27; index += 1) {
      await store.append({
        kind: 'node_added',
        nodeId: `N${index}`,
        payload: { node: { nodeId: `N${index}`, title: `节点 ${index}`, status: 'planned' } },
      });
    }
    // 12 条诊断事件（历史接管/快照分歧留下的痕迹）
    for (let index = 1; index <= 12; index += 1) {
      await store.append({ kind: 'writer_taken_over', payload: { epoch: index, at: nowIso(T0) } });
    }
    assertEqual(store.revision, 39, 'N4 revision = 39');
    assertEqual(store.cursorOf('core'), null, '尚无游标');

    const core = fakeCore();
    const restored = await restoreCoreJournal(store, core);
    assertEqual(restored.coreSeq, 27, 'core 只拿到 27 条业务事件');
    assertEqual(restored.restored, 27, '回灌条数 = 业务条数');
    assertEqual(store.cursorOf('core')?.coreSeq, 27, '游标认领为 27');
    assert(store.revision > 39, '认领游标本身也是一条记录');

    // 再追加 12 条（seq 28..39 是 core 空间的编号，与 N4 revision 无关）
    const nextEvents                    = Array.from({ length: 12 }, (_, index) => {
      const seq = 28 + index;
      return {
        seq,
        event_id: `EVT-${String(seq).padStart(6, '0')}`,
        ts: nowIso(T0),
        kind: 'status_changed',
        node_id: `N${((index % 27) + 1)          }`,
        payload: { from: 'planned', to: 'ready', reason: 'align-test', at: nowIso(T0) },
      };
    });
    const revisionBefore = store.revision;
    const persisted = await persistCoreEvents(store, nextEvents);
    assertEqual(persisted.baseSeq, 27, '以 core 游标 27 为基准');
    assertEqual(persisted.appended.length, 12, '12 条全部落盘');
    assertEqual(persisted.cursorAfter, 39, '游标推进到 39');
    assert(store.revision > revisionBefore, 'revision 单调递增');
    for (let index = 1; index < persisted.appended.length; index += 1) {
      assert(
        persisted.appended[index].seq === persisted.appended[index - 1].seq + 1,
        'journal seq 连续',
      );
    }
    assert(
      persisted.appended[0].seq === revisionBefore + 1,
      `新记录从 max(revision, baseSeq)+1 起：${persisted.appended[0].seq} != ${revisionBefore + 1}`,
    );
    assertEqual(store.state.nodes.N1.status, 'ready', '事件已折叠进状态');
    await store.close();
  });

  await test('重开恢复后继续追加：游标持久化，不因历史 revision 拒绝', async () => {
    const fsPort = new MemoryFsPort();
    const first = await Store.open({ dir: '/mem/align2', fs: fsPort, owner: 'w1', now: () => T0 });
    for (let index = 1; index <= 3; index += 1) {
      await first.append({
        kind: 'node_added',
        nodeId: `N${index}`,
        payload: { node: { nodeId: `N${index}`, title: `节点 ${index}` } },
      });
    }
    await first.append({ kind: 'snapshot_diverged', payload: { snapshotSeq: 0 } });
    await first.close();

    const second = await Store.open({ dir: '/mem/align2', fs: fsPort, owner: 'w2', now: () => T0 });
    const core = fakeCore();
    const restored = await restoreCoreJournal(second, core);
    // core 业务 3 条；回灌前 revision 4 = 3 业务 + 1 诊断；认领游标再 +1 → 5
    assertEqual([restored.coreSeq, restored.revisionBefore], [3, 4], '回灌前 revision 4（3 业务 + 1 诊断）');
    assertEqual(restored.revision, 5, '认领游标写入 cursor_aligned → 5');
    const persisted = await persistCoreEvents(second, [
      { seq: 4, event_id: 'EVT-000004', ts: nowIso(T0), kind: 'status_changed', node_id: 'N1', payload: { from: 'planned', to: 'ready', at: nowIso(T0) } },
    ]);
    assertEqual(persisted.cursorAfter, 4, '游标推进');
    await second.close();

    // 第三次开：游标从盘上恢复，core 也恢复
    const third = await Store.open({ dir: '/mem/align2', fs: fsPort, owner: 'w3', now: () => T0 });
    const core3 = fakeCore();
    const restored3 = await restoreCoreJournal(third, core3);
    assertEqual(restored3.coreSeq, 4, '重开后 core seq 从游标恢复');
    const persisted3 = await persistCoreEvents(third, [
      { seq: 5, event_id: 'EVT-000005', ts: nowIso(T0), kind: 'status_changed', node_id: 'N2', payload: { from: 'planned', to: 'ready', at: nowIso(T0) } },
    ]);
    assertEqual(persisted3.appended.length, 1, '继续追加成功');
    assert(third.verify().ok, '重放 == 内存状态');
    await third.close();
  });

  await test('重复 / 回退 / 中间缺口 / core 领先 一律 STATE_SEQ_GAP', async () => {
    const fsPort = new MemoryFsPort();
    const store = await Store.open({ dir: '/mem/align3', fs: fsPort, owner: 'w1', now: () => T0 });
    await store.append({ kind: 'node_added', nodeId: 'N1', payload: { node: { nodeId: 'N1', title: 't' } } });
    await store.adoptCursor(1, 'core'); // 只能认领 ≤ revision 的位置
    const event = (seq        )                  => ({
      seq,
      event_id: `EVT-${String(seq).padStart(6, '0')}`,
      ts: nowIso(T0),
      kind: 'status_changed',
      node_id: 'N1',
      payload: { from: 'planned', to: 'ready', at: nowIso(T0) },
    });
    await assertThrows(
      () => persistCoreEvents(store, [{ ...event(1), seq: 1 }], { strict: true }),
      'STATE_SEQ_GAP',
      'strict：重复已消费区间必须拒绝',
    );
    await assertThrows(() => persistCoreEvents(store, [event(9)], { strict: true }), 'STATE_SEQ_GAP', 'strict：中间缺口必须拒绝');
    await assertThrows(
      () => store.appendFromSeq(99, [{ kind: 'status_changed', nodeId: 'N1', payload: { to: 'ready' } }]),
      'STATE_SEQ_GAP',
      'core 领先于 N4 必须拒绝',
    );
    // 正常路径仍然可用
    const ok = await persistCoreEvents(store, [event(2)]);
    assertEqual(ok.cursorAfter, 2, '游标 1 → 2');
    await store.close();
  });

  await test('乱序/稀疏批次：排序后落连续前缀 + 显式 gapAt（不整体拒绝）', async () => {
    const fsPort = new MemoryFsPort();
    const store = await Store.open({ dir: '/mem/align4', fs: fsPort, owner: 'w1', now: () => T0 });
    await store.append({ kind: 'node_added', nodeId: 'N1', payload: { node: { nodeId: 'N1', title: 't' } } });

    const ev = (seq        , kind = 'status_changed')                  => ({
      seq,
      event_id: `EVT-${String(seq).padStart(6, '0')}`,
      ts: nowIso(T0),
      kind,
      node_id: 'N1',
      payload: kind === 'status_changed' ? { from: 'planned', to: 'ready', at: nowIso(T0) } : { at: nowIso(T0) },
    });

    // 模拟真实宿主：core.raw() = [93, 1, 3, 2, 5]（恢复后稀疏 + 追加后乱序）
    const messy = [ev(93, 'ready_recomputed'), ev(1), ev(3), ev(2), ev(5)];
    const first = await persistCoreEvents(store, messy);
    assertEqual(first.reordered, true, '应识别入参乱序');
    assertEqual(first.appended.map((record) => record.seq), [2, 3, 4], '只落从 1+1 起的连续前缀（core 1,2,3 → journal 2,3,4）');
    assertEqual(first.cursorAfter, 3, '游标到 core seq 3');
    assertEqual([first.gapAt, first.remaining, first.incomplete], [4, 2, true], '显式回报缺口位置');
    assert(store.revision > 1, '确实写入了');

    // 补缺口后继续
    const second = await persistCoreEvents(store, [ev(4), ev(5), ev(93, 'ready_recomputed')]);
    assertEqual(second.appended.length, 2, '补 4/5 两条');
    assertEqual([second.gapAt, second.incomplete], [6, true], '缺口 6 如实回报（core 空间有洞，93 暂挂）');
    assertEqual(second.cursorAfter, 5, '游标 5');

    // 全部重复 → 幂等空写
    const third = await persistCoreEvents(store, [ev(1), ev(2), ev(3)]);
    assertEqual([third.appended.length, third.skipped], [0, 3], '重复整批被跳过');
    assertEqual(third.revisionAfter, second.revisionAfter, '不写盘');
    await store.close();
  });

  await test('回灌重编号：journal 稀疏 seq → core 稠密 1..N，后续批次必连续', async () => {
    const fsPort = new MemoryFsPort();
    const store = await Store.open({ dir: '/mem/align5', fs: fsPort, owner: 'w1', now: () => T0 });
    // 3 业务 + 2 诊断 → journal seq 为 1..5 但业务 seq 是 1,2,4（跳号）
    await store.append({ kind: 'node_added', nodeId: 'N1', payload: { node: { nodeId: 'N1', title: 't' } } });
    await store.append({ kind: 'node_added', nodeId: 'N2', payload: { node: { nodeId: 'N2', title: 't2' } } });
    await store.append({ kind: 'writer_taken_over', payload: { epoch: 2 } });
    await store.append({ kind: 'status_changed', nodeId: 'N1', payload: { from: 'planned', to: 'ready', at: nowIso(T0) } });
    await store.append({ kind: 'snapshot_diverged', payload: { snapshotSeq: 0 } });

    const core = {
      events: []                     ,
      count() {
        return this.events.length;
      },
      raw() {
        return [...this.events];
      },
      restore(next                   ) {
        this.events = [...next];
      },
    };
    const restored = await restoreCoreJournal(store, core);
    assertEqual([restored.restored, restored.coreSeq, restored.renumbered], [3, 3, true], '只灌业务且重编号');
    assertEqual(core.raw().map((event) => event.seq), [1, 2, 3], 'core seq 稠密连续');
    assertEqual(core.raw().map((event) => event.event_id), ['EVT-000001', 'EVT-000002', 'EVT-000003'], 'event_id 同步重编号');

    // core 之后 append 会用 count+1 = 4 → 与游标 3 连续，persist 一次通过
    const appended = { seq: 4, event_id: 'EVT-000004', ts: nowIso(T0), kind: 'status_changed', node_id: 'N2', payload: { from: 'planned', to: 'ready', at: nowIso(T0) } };
    core.events.push(appended);
    const persisted = await persistCoreEvents(store, core.raw());
    assertEqual([persisted.appended.length, persisted.incomplete], [1, false], '稠密空间下批次必连续');
    assertEqual(persisted.cursorAfter, 4, '游标 4');
    await store.close();
  });

  await test('6 节点链 · node 模式重载：counts=6 / done=6 / replay==snapshot / fingerprint 稳定', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n4-chain-'));
    const nodes = ['NODE-RESEARCH', 'NODE-PRD', 'NODE-CONTRACT', 'NODE-DB', 'NODE-BACKEND', 'NODE-AUDIT'];

    const first = await Store.open({ dir, fs: new NodeFsPort(), owner: 'chain-writer', ttlMs: 60_000 });
    for (const nodeId of nodes) {
      await first.append({
        kind: 'node_added',
        nodeId,
        payload: { node: { nodeId, title: `节点 ${nodeId}`, spec: 's', status: 'ready' } },
      });
    }
    for (const nodeId of nodes) {
      await first.append({
        kind: 'status_changed',
        nodeId,
        payload: { from: 'ready', to: 'done', reason: 'evidence_ok', at: nowIso(T0) },
      });
    }
    const fpBefore = sha256Hex(canonicalJson(first.state           ));
    await first.close();

    const second = await Store.open({ dir, fs: new NodeFsPort(), owner: 'chain-reader', ttlMs: 60_000 });
    const countNodes = Object.keys(second.state.nodes).length;
    const doneNodes = Object.values(second.state.nodes).filter((node) => node.status === 'done').length;
    assertEqual([countNodes, doneNodes], [6, 6], 'counts=6 / done=6');
    const fpAfter = sha256Hex(canonicalJson(second.state           ));
    assertEqual(fpAfter, fpBefore, '重载后 fingerprint 稳定');
    assert(second.verify().ok, 'replay == snapshot（全量折叠 == 内存状态）');
    const projection = projectTeamTasks(second.state);
    assertEqual(projection.tasks.length, 6, '投影 6 条');
    assertEqual(projection.tasks.filter((task) => task.status === 'done').length, 6, '投影全 done');
    await second.close();

    const third = await Store.open({ dir, fs: new NodeFsPort(), owner: 'chain-reader-2', ttlMs: 60_000 });
    assertEqual(sha256Hex(canonicalJson(third.state           )), fpBefore, '第二次重载 fingerprint 仍稳定');
    // 重载后继续按 core 空间追加
    const core = fakeCore();
    const restored = await restoreCoreJournal(third, core);
    assertEqual(restored.coreSeq, 12, 'core 拿到 12 条业务事件');
    const persisted = await persistCoreEvents(third, [
      { seq: 13, event_id: 'EVT-000013', ts: nowIso(T0), kind: 'status_changed', node_id: 'NODE-AUDIT', payload: { from: 'done', to: 'done', reason: 'touch', at: nowIso(T0) } },
    ]);
    assertEqual(persisted.cursorAfter, 13, '6 节点链后继续追加');
    await third.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

async function waitSuite()                {
  console.log('\n[L] 锁竞争：活锁等待（指数退避）/ 超时 / 只在 TTL 过期后 stale steal');

  await test('旧 writer 正在 close → 新 writer 等待后成功（不退化为 STATE_LOCKED）', async () => {
    const fsPort = new MemoryFsPort();
    const old = await Store.open({ dir: '/mem/wait1', fs: fsPort, owner: 'old-writer', now: () => Date.now() });
    await old.append({ kind: 'node_added', nodeId: 'N1', payload: { node: { nodeId: 'N1', title: 't' } } });

    // 拦住 release：模拟 close() 正在落快照、尚未删锁
    const realRemove = fsPort.remove.bind(fsPort);
    let openGate             ;
    const gate = new Promise      ((resolve) => {
      openGate = resolve;
    });
    fsPort.remove = async (file        ) => {
      await gate;
      return realRemove(file);
    };

    const closing = old.close();
    setTimeout(() => openGate(), 120);

    const waits                                                                       = [];
    const fresh = await Store.open({
      dir: '/mem/wait1',
      fs: fsPort,
      owner: 'new-writer',
      waitMs: 3000,
      retryBaseMs: 5,
      retryMaxMs: 25,
      onWait: (info) => waits.push({ attempt: info.attempt, elapsedMs: info.elapsedMs, holder: info.holder }),
    });
    await closing;
    assert(waits.length >= 1, '应发生至少一次等待（没人抢活锁）');
    assert(waits[0].holder === 'old-writer', '等待时能看到持锁者');
    assertEqual(fresh.revision, 1, '等到的状态含旧 writer 的记录');
    assertEqual(fresh.journal.lock?.owner, 'new-writer', '锁已易主给新 writer');
    await fresh.close();
  });

  await test('等待预算耗尽 → STATE_LOCKED，detail 带 waitedMs/attempts/holder', async () => {
    const fsPort = new MemoryFsPort();
    const holder = await Store.open({ dir: '/mem/wait2', fs: fsPort, owner: 'holder', now: () => Date.now() });
    let caught          = null;
    try {
      await Store.open({
        dir: '/mem/wait2',
        fs: fsPort,
        owner: 'waiter',
        waitMs: 150,
        retryBaseMs: 5,
        retryMaxMs: 20,
      });
    } catch (error) {
      caught = error;
    }
    assert(caught instanceof StateError, '应抛 StateError');
    assert(caught.code === 'STATE_LOCKED', `code=${caught.code}`);
    const detail = caught.detail                           ;
    assert(Number(detail.waitedMs) >= 100, `waitedMs=${String(detail.waitedMs)}`);
    assert(Number(detail.attempts) >= 2, `attempts=${String(detail.attempts)}`);
    assertEqual(detail.holder, 'holder', 'detail 指出持锁者');
    await holder.close();
  });

  await test('stale steal 严格按 TTL：未过期抢占被拒，过期后才接管', async () => {
    const fsPort = new MemoryFsPort();
    const holder = await Store.open({ dir: '/mem/wait3', fs: fsPort, owner: 'holder', ttlMs: 1000, now: () => T0 });

    await assertThrows(
      () =>
        Store.open({
          dir: '/mem/wait3',
          fs: fsPort,
          owner: 'thief',
          ttlMs: 1000,
          now: () => T0 + 500,
          takeover: true,
          waitMs: 0,
        }),
      'STATE_LOCKED',
      'TTL 内不得 stale steal',
    );

    const peek = await Store.waitForUnlock({ dir: '/mem/wait3', fs: fsPort, now: () => T0 + 500, timeoutMs: 10 });
    assertEqual([peek.released, peek.stale, peek.holder], [false, false, 'holder'], 'waitForUnlock 报告未过期');

    const thief = await Store.open({
      dir: '/mem/wait3',
      fs: fsPort,
      owner: 'thief',
      ttlMs: 1000,
      now: () => T0 + 1500,
      takeover: true,
      waitMs: 0,
    });
    assertEqual(thief.currentFence?.token, 2, '过期后接管 epoch=2');
    await assertThrows(
      () => holder.append({ kind: 'status_changed', nodeId: 'N1', payload: { to: 'ready' } }),
      'STATE_FENCED_OUT',
      '旧 writer 被 fence',
    );
    await thief.close();
  });
}

async function main()                {
  console.log('N4 state layer self-test');
  console.log(`node ${process.version} · canonical hash probe=${sha256Hex('probe').slice(0, 8)} · ${nowIso(T0)}`);
  await journalSuite();
  await tornTailSuite();
  await snapshotSuite();
  await recoverySuite();
  await storeSuite();
  await projectionSuite();
  await bridgeSuite();
  await alignSuite();
  await waitSuite();
  await oracleSuite();
  await crashSuite();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const failure of failures) console.error(`\n[failed] ${failure.name}\n`, failure.error);
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('state/self-test.ts');
if (invokedDirectly) {
  await main();
}

export { journalSuite, tornTailSuite, assert, assertEqual, assertThrows, test, MemoryFsPort, NodeFsPort, eventIdOf };


//# sourceURL=state\self-test.js