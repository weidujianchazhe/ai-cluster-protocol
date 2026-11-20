/**
 * 状态层大规模持久化：三处「写完但状态没跟上」「算过又再算」的修复。
 *
 * 第 26 轮测 10 万节点时撞出三个真问题，都不是慢，是错或白算：
 *
 * 1. **`push(...records)` 炸栈**（错）。`appendBatch()` 落盘后才把记录挂进缓存，
 *    而挂的写法是 `recordsCache.push(...out)`——走函数实参栈。实测 12 万条成功、
 *    12.5 万条抛 `RangeError: Maximum call stack size exceeded`。10 万节点一次落
 *    20 万条，于是：盘上 20 万行、内存 0 条、`revision` 停在旧值。同一份 journal
 *    对两个读者给出两套状态。
 *
 * 2. **`status().bytes` 每次现算**（白算）。原来的 reduce + `JSON.stringify` 逐条
 *    序列化，20 万条 280 ms，而每次冷启动都要调一次，只为填一个诊断字段。
 *
 * 3. **恢复流程重复计算**（白算）。同一份 state 被 `canonicalJson` 8 次、同一批记录
 *    被 `fold` 4 次；9.2 s 里约 3.5 s 是纯重复。另外 `replayEqualsSnapshot` 是恒真式
 *    （比较的两边由构造成立），报出的 `true` 不含信息。
 *
 * 这个测试盯的是语义正确性，不是性能数字（数字见 `tests/_probe-*.mjs`）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (name) => pathToFileURL(path.join(root, 'lib', name)).href;
const { Store } = await import(lib('state/store.js'));
const { Journal, statePaths } = await import(lib('state/journal.js'));
const { NodeFsPort } = await import(lib('state/fs-port.js'));
const { MemoryFsPort } = await import(lib('state/fs-port.js'));
const { openAndRecover } = await import(lib('state/recovery.js'));
const { buildSnapshot, readSnapshot, verifySnapshot, checkAnchor } = await import(lib('state/snapshot.js'));
const { fold, emptyState, applyRecord } = await import(lib('state/reducer.js'));
const { canonicalJson, sha256Hex } = await import(lib('state/canonical.js'));

const T0 = Date.parse('2026-11-20T00:00:00.000Z');

// ── 1. ★ 批量追加超过实参栈上限：落盘 + 缓存 + revision 必须三者一致 ─────────
//    之前 12.5 万条以上必炸，且抛出点在写盘之后 → 盘与内存永久错位。
{
  const fsPort = new MemoryFsPort();
  const dir = '/mem/scale-batch';
  const journal = (await Journal.open({ dir, fs: fsPort, owner: 'w1', now: () => T0, ttlMs: 600_000 })).journal;
  const BATCH = 200_000; // 远超实测 12.5 万的实参栈上限
  const inputs = Array.from({ length: BATCH }, (_, i) => ({
    kind: 'node_added',
    nodeId: `N${i}`,
    payload: { node: { nodeId: `N${i}`, title: `n${i}`, status: 'planned' } },
  }));
  const records = await journal.appendBatch(inputs);
  assert.equal(records.length, BATCH, `应返回 ${BATCH} 条，实际 ${records.length}`);
  assert.equal(journal.records().length, BATCH, `缓存应有 ${BATCH} 条，实际 ${journal.records().length}`);
  assert.equal(journal.seq, BATCH, `seq 应为 ${BATCH}，实际 ${journal.seq}`);
  // 字节数与盘上一致（不是 0，也不是只算了一部分）
  const onDisk = (fsPort.files.get(journal.paths.journal)?.content ?? '');
  assert.equal(journal.status().bytes, Buffer.byteLength(onDisk, 'utf8'), 'status().bytes 应等于盘上字节数');
  assert.ok(journal.status().bytes > 0, 'status().bytes 不能是 0');
  // 链完好
  journal.verifyChain();
  await journal.release();
  console.log(`PASS  批量 ${BATCH} 条一次落盘：缓存/seq/bytes/链 全部一致`);
}

// ── 2. 缓存里没有的旧行为会静默丢数据：状态文档必须跟着折 ───────────────────
{
  const fsPort = new MemoryFsPort();
  const store = await Store.open({ dir: '/mem/scale-fold', fs: fsPort, owner: 'w1', now: () => T0, ttlMs: 600_000 });
  const N = 130_000; // 刚好越过实参栈上限的那一档
  const records = await store.appendBatch(
    Array.from({ length: N }, (_, i) => ({
      kind: 'node_added',
      nodeId: `N${i}`,
      payload: { node: { nodeId: `N${i}`, title: `n${i}`, status: 'planned' } },
    })),
  );
  assert.equal(records.length, N);
  assert.equal(Object.keys(store.state.nodes).length, N, `折叠出的节点数应是 ${N}，实际 ${Object.keys(store.state.nodes).length}`);
  assert.equal(store.revision, N, `revision 应是 ${N}，实际 ${store.revision}`);
  const verdict = store.verify();
  assert.equal(verdict.ok, true, '内存状态必须等于全量重放');
  await store.close({ snapshot: false });
  console.log(`PASS  ${N} 条批量 appendBatch：折叠/${N} 节点、revision、verify 一致`);
}

// ── 3. `status().bytes` 是增量维护的：多次追加后仍精确 ─────────────────────
{
  const fsPort = new MemoryFsPort();
  const journal = (await Journal.open({ dir: '/mem/scale-bytes', fs: fsPort, owner: 'w1', now: () => T0, ttlMs: 600_000 })).journal;
  for (let round = 0; round < 5; round += 1) {
    await journal.appendBatch(
      Array.from({ length: 100 }, (_, i) => ({ kind: 'node_added', nodeId: `N${round}-${i}`, payload: { round, i } })),
    );
    const onDisk = (fsPort.files.get(journal.paths.journal)?.content ?? '');
    assert.equal(
      journal.status().bytes,
      Buffer.byteLength(onDisk, 'utf8'),
      `第 ${round + 1} 轮后 bytes 应与盘上同步`,
    );
  }
  // 重开一次：从 loadAndRepair 的 consumedBytes 接上，不能归零
  await journal.release();
  const reopened = (await Journal.open({ dir: '/mem/scale-bytes', fs: fsPort, owner: 'w2', now: () => T0, ttlMs: 600_000 })).journal;
  const onDisk = (fsPort.files.get(reopened.paths.journal)?.content ?? '');
  assert.equal(reopened.status().bytes, Buffer.byteLength(onDisk, 'utf8'), '重开后 bytes 应等于盘上字节数');
  await reopened.release();
  console.log('PASS  status().bytes 增量维护：5 轮追加 + 重开，始终等于盘上字节数');
}

// ── 4. torn tail 截断后，bytes 只算保留部分（不能把截掉的那截算进去）────────
{
  const fsPort = new MemoryFsPort();
  const dir = '/mem/scale-torn';
  const first = (await Journal.open({ dir, fs: fsPort, owner: 'w1', now: () => T0, ttlMs: 600_000 })).journal;
  await first.append({ kind: 'node_added', nodeId: 'N1', payload: { a: 1 } });
  await first.append({ kind: 'node_added', nodeId: 'N2', payload: { a: 2 } });
  await first.release();
  // 手写一条半截 JSON（模拟崩溃在 write 中途）
  const journalFile = pathsOf(dir).journal;
  const beforeEntry = fsPort.files.get(journalFile);
  const before = beforeEntry.content;
  fsPort.files.set(journalFile, { content: `${before}{"seq":3,"eventId":"EVT-000`, mtimeMs: beforeEntry.mtimeMs });
  const opened = await Journal.open({ dir, fs: fsPort, owner: 'w2', now: () => T0, ttlMs: 600_000 });
  assert.equal(opened.journal.records().length, 2, 'torn tail 应被截掉');
  assert.equal(opened.journal.status().bytes, Buffer.byteLength(before, 'utf8'), 'bytes 只算保留的字节');
  assert.equal(opened.repair?.droppedLines, 1, '应报告丢弃 1 行');
  // 截断后仍可继续追加，且 bytes 继续同步
  await opened.journal.append({ kind: 'node_added', nodeId: 'N3', payload: { a: 3 } });
  const after = fsPort.files.get(journalFile).content;
  assert.equal(opened.journal.status().bytes, Buffer.byteLength(after, 'utf8'), '截断后继续追加，bytes 仍精确');
  opened.journal.verifyChain();
  await opened.journal.release();
  console.log('PASS  torn tail：截断 / bytes 只算保留部分 / 之后继续追加仍精确');
}

function pathsOf(dir) {
  return statePaths(dir);
}

// ── 5. ★ 恢复流程的重复计算去掉后，判定能力不能退化 ────────────────────────
//    原实现对同一份数据做两轮独立核对（foldUntil 到快照 seq、clone+重放增量）。
//    现在只保留后者，覆盖前者的全部错误情形。这里逐情形验证。
{
  // 5a. 正常同步：source=snapshot+replay，快照不重写
  {
    const fsPort = new MemoryFsPort();
    const dir = '/mem/scale-rec-sync';
    const first = await openAndRecover({ dir, fs: fsPort, owner: 'w1', now: () => T0 });
    assert.equal(first.report.source, 'journal+bootstrap', '首次应 bootstrap（空 journal 也要建快照）');
    for (const id of ['N1', 'N2', 'N3']) {
      await first.journal.append({ kind: 'node_added', nodeId: id, payload: { node: { nodeId: id, title: id, status: 'planned' } } });
    }
    await first.journal.release();
    const synced = await openAndRecover({ dir, fs: fsPort, owner: 'w2', now: () => T0 });
    assert.equal(synced.report.source, 'snapshot+replay', '快照在 seq=0，应增量重放 3 条');
    assert.equal(synced.report.diverged, false);
    assert.equal(synced.report.snapshot.updated, true, '快照应被推进到 seq=3');
    await synced.journal.release();
    const again = await openAndRecover({ dir, fs: fsPort, owner: 'w3', now: () => T0 });
    assert.equal(again.report.source, 'snapshot+replay', '同步后应走快路径');
    assert.equal(again.report.diverged, false);
    assert.equal(again.report.snapshot.updated, false, '已同步不该重写快照');
    assert.equal(again.report.replayCheck, 'by-construction', '应显式标注 replay 检查的证据来源');
    assert.equal(again.report.replayEqualsSnapshot, true);
    await again.journal.release();
    console.log('PASS  恢复快路径：bootstrap → 增量推进 → 已同步不重写 / replayCheck 标注来源');
  }

  // 5b. 快照内容被篡改（哈希自洽但内容错）→ 必须判分歧
  {
    const fsPort = new MemoryFsPort();
    const dir = '/mem/scale-rec-forge';
    const { journal } = await openAndRecover({ dir, fs: fsPort, owner: 'w1', now: () => T0 });
    await journal.append({ kind: 'node_added', nodeId: 'N1', payload: { node: { nodeId: 'N1', title: 't', status: 'planned' } } });
    await journal.append({ kind: 'status_changed', nodeId: 'N1', payload: { from: 'planned', to: 'ready', at: new Date(T0).toISOString() } });
    await journal.release();
    const paths = statePaths(dir);
    const reader = await Journal.open({ dir, fs: fsPort, owner: 'w9', now: () => T0 });
    const records = reader.journal.records();
    const rawNow = await reader.journal.rawText();
    await reader.journal.release();
    const wrong = fold(records);
    wrong.nodes.N1.status = 'done'; // 与 journal 事实不符，但下面重算 stateSha256 让它自洽
    const forged = buildSnapshot(wrong, records, rawNow, new Date(T0).toISOString());
    await fsPort.remove(paths.snapshot);
    await fsPort.writeCas(paths.snapshot, `${JSON.stringify(forged, null, 2)}\n`, { kind: 'createIfAbsent' });
    // 自洽性确认：篡改后的快照能过 verifySnapshot
    const loaded = await readSnapshot(fsPort, paths);
    verifySnapshot(loaded.file);

    const rec = await openAndRecover({ dir, fs: fsPort, owner: 'w4', now: () => T0 });
    assert.equal(rec.report.diverged, true, '篡改的快照必须判分歧');
    assert.equal(rec.report.state.nodes.N1.status, 'ready', 'journal 胜');
    assert.ok(rec.report.eventsAppended.length >= 1, '应留 snapshot_diverged 事件');
    const reloaded = await readSnapshot(fsPort, paths);
    assert.equal(reloaded.file.state.nodes.N1.status, 'ready', '快照被重写为 journal 事实');
    await rec.journal.release();
    console.log('PASS  篡改快照（哈希自洽、内容错）：判分歧、journal 胜、留痕、重写快照');
  }

  // 5c. 锚点前缀字节被改写 → checkAnchor 先拦住（哈希链可能仍自洽）
  {
    const fsPort = new MemoryFsPort();
    const dir = '/mem/scale-rec-anchor';
    const { journal } = await openAndRecover({ dir, fs: fsPort, owner: 'w1', now: () => T0 });
    for (const id of ['N1', 'N2']) {
      await journal.append({ kind: 'node_added', nodeId: id, payload: { node: { nodeId: id, title: id } } });
    }
    await journal.release();
    const synced = await openAndRecover({ dir, fs: fsPort, owner: 'w2', now: () => T0 });
    await synced.journal.release();
    // 就地改写 journal 的一行（seq/prevHash 都保持原样，故哈希链仍"连续"，但字节变了）
    const paths = statePaths(dir);
    const entry = fsPort.files.get(paths.journal);
    const text = entry.content;
    assert.ok(text.includes('"title":"N1"'), '前置条件：journal 里应有可改写的内容');
    fsPort.files.set(paths.journal, { content: text.replace('"title":"N1"', '"title":"X1"'), mtimeMs: entry.mtimeMs });
    await assert.rejects(
      () => openAndRecover({ dir, fs: fsPort, owner: 'w3', now: () => T0 }),
      (error) => ['STATE_HASH_BREAK', 'STATE_DIVERGED', 'STATE_CORRUPT'].includes(error.code),
      '就地改写必须 fail-closed',
    );
    await fsPort.remove(paths.lock);
    console.log('PASS  锚点前缀被就地改写：fail-closed（不会静默接受）');
  }

  // 5d. 快照落后（journal 前进）→ 增量重放仍要对上全量折叠
  {
    const fsPort = new MemoryFsPort();
    const dir = '/mem/scale-rec-ahead';
    const { journal } = await openAndRecover({ dir, fs: fsPort, owner: 'w1', now: () => T0 });
    await journal.append({ kind: 'node_added', nodeId: 'N1', payload: { node: { nodeId: 'N1', title: 't' } } });
    await journal.release();
    const snapAt1 = await openAndRecover({ dir, fs: fsPort, owner: 'w2', now: () => T0 });
    await snapAt1.journal.append({ kind: 'node_added', nodeId: 'N2', payload: { node: { nodeId: 'N2', title: 't2' } } });
    await snapAt1.journal.append({ kind: 'node_added', nodeId: 'N3', payload: { node: { nodeId: 'N3', title: 't3' } } });
    await snapAt1.journal.release();
    const rec = await openAndRecover({ dir, fs: fsPort, owner: 'w3', now: () => T0 });
    assert.equal(rec.report.source, 'snapshot+replay', '快照落后应走增量重放');
    assert.equal(rec.report.diverged, false);
    assert.equal(Object.keys(rec.report.state.nodes).length, 3, '三个节点都在');
    assert.equal(rec.report.snapshot.updated, true, '快照应被推进');
    assert.equal(rec.report.snapshot.seq, 1, '旧快照 seq=1');
    assert.equal(rec.report.seq, 3, 'journal seq=3');
    await rec.journal.release();
    console.log('PASS  快照落后：增量重放 == 全量折叠，快照推进到最新');
  }
}

// ── 6. `rawText()` 缓存：追加后必须重新读盘，不能返回旧内容 ────────────────
{
  const fsPort = new MemoryFsPort();
  const journal = (await Journal.open({ dir: '/mem/scale-raw', fs: fsPort, owner: 'w1', now: () => T0, ttlMs: 600_000 })).journal;
  const t1 = await journal.rawText();
  assert.equal(t1, '', '空 journal 原文为空');
  assert.equal(journal.hasRawText(), true, '加载后应有缓存');
  await journal.append({ kind: 'node_added', nodeId: 'N1', payload: { a: 1 } });
  assert.equal(journal.hasRawText(), false, '追加应作废缓存（拼接是 O(n²)，只能作废）');
  const t2 = await journal.rawText();
  assert.notEqual(t2, '', '追加后原文必须包含新行');
  assert.equal(t2, (fsPort.files.get(journal.paths.journal)?.content ?? ''), '重读结果应等于盘上内容');
  // 关键：原文前缀 sha256 必须与快照锚点对得上（缓存的用途就是这个）
  const records = journal.records();
  const snap = buildSnapshot(fold(records), records, t2, new Date(T0).toISOString());
  const anchor = checkAnchor(snap, records, t2);
  assert.equal(anchor.status, 'in-sync', '用缓存原文构建的快照锚点必须自洽');
  assert.equal(anchor.prefixHash, snap.meta.journalHash, '前缀摘要应等于全文摘要（此处全覆盖）');
  console.log('PASS  rawText 缓存：加载后有 / 追加作废 / 重读等于盘上 / 锚点自洽');
}

// ── 7. `buildSnapshot` 的 known 覆盖：传错值必须能被下游发现（不是无条件信任）──
{
  const fsPort = new MemoryFsPort();
  const paths = statePaths('/mem/scale-known');
  const state = { ...emptyState(), revision: 3, graphRevision: 1 };
  state.nodes = { N1: { nodeId: 'N1', title: 't', spec: '', capability: null, stage: null, status: 'planned', deps: [], evidenceRequired: [], decisionId: null, attempts: 0, assignee: null, verifierIds: [], budget: {}, createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString() } };
  const raw = '{"seq":1}\n';
  const realSha = sha256Hex(canonicalJson(state));

  // 正确的 known：结果与现算一致
  const good = buildSnapshot(state, [], raw, new Date(T0).toISOString(), { stateSha256: realSha });
  assert.equal(good.meta.stateSha256, realSha);
  assert.equal(good.meta.stateSha256, sha256Hex(canonicalJson(state)), 'known 与现算应相同');

  // 错误的 known：落盘后 verifySnapshot 必须拒绝（known 只是省算，不是免校验）
  const bad = buildSnapshot(state, [], raw, new Date(T0).toISOString(), { stateSha256: 'deadbeef' });
  await fsPort.writeCas(paths.snapshot, `${JSON.stringify(bad, null, 2)}\n`, { kind: 'createIfAbsent' });
  const loaded = await readSnapshot(fsPort, paths);
  assert.throws(() => verifySnapshot(loaded.file), (error) => error.code === 'STATE_DIVERGED', '错误摘要必须被 verifySnapshot 拒绝');
  console.log('PASS  buildSnapshot.known：正确值等价于现算，错误值被 verifySnapshot 拒绝');
}

// ── 8. 真实磁盘：Store 冷启动 + 快照 + 重开，字节/状态/游标三者对账 ────────
//    前面几组都用 MemoryFsPort（快、可控）。这一组走真实 NodeFsPort：
//    torn tail 截断、fsync、CAS 重命名这些只有真文件才暴露的路径必须至少过一遍。
{
  const dir = tempStateDir('scale-real');
  const store = await Store.open({ dir, fs: new NodeFsPort(), owner: 'w1', waitMs: 0, ttlMs: 600_000 });
  const N = 5000;
  await store.appendBatch(
    Array.from({ length: N }, (_, i) => ({
      kind: 'node_added',
      nodeId: `N${i}`,
      payload: { node: { nodeId: `N${i}`, title: `n${i}`, status: 'planned' } },
    })),
  );
  const bytesBefore = store.journal.status().bytes;
  const shaBefore = sha256Hex(canonicalJson(store.state));
  const diskBytes = fs.statSync(path.join(dir, 'journal.jsonl')).size;
  assert.equal(bytesBefore, diskBytes, `status().bytes 应等于真实文件大小：${bytesBefore} vs ${diskBytes}`);
  await store.close({ snapshot: true });

  const reopened = await Store.open({ dir, fs: new NodeFsPort(), owner: 'w2', waitMs: 0, ttlMs: 600_000 });
  assert.equal(Object.keys(reopened.state.nodes).length, N, '节点数应恢复');
  assert.equal(reopened.revision, N, 'revision 应恢复');
  assert.equal(sha256Hex(canonicalJson(reopened.state)), shaBefore, '状态摘要应一致');
  const bytesAfter = reopened.journal.status().bytes;
  assert.equal(bytesAfter, bytesBefore, `重开后 bytes 应一致：${bytesBefore} → ${bytesAfter}`);
  const verdict = reopened.verify();
  assert.equal(verdict.ok, true, '重开后 verify 必须通过');
  await reopened.close({ snapshot: false });
  console.log(`PASS  真实磁盘 ${N} 节点：bytes==文件大小 / 重开状态摘要 / revision / verify 全对`);
}

cleanupTempStateDirs();
console.log('\n全部通过');
