/**
 * journal 分段：**绕开单文件的物理上限**，不是性能优化。
 *
 * 立项依据（`_probe-file-limit.mjs` 实测，Node v24.9.0）：
 *   - `readFileSync(path,'utf8')` 要建字符串，V8 `MAX_STRING_LENGTH` = 512 MB；
 *   - 64 MB / 256 MB 读得动，**512 MB 直接 `ERR_STRING_TOO_LONG`**；
 *   - 真实 journal 528 B/行 ⇒ 约 102 万行（≈50 万节点）就到顶，再多**根本读不进来**。
 *
 * 所以分段买的是「还能不能跑」，不是「跑多快」。**同时要纠正一句旧话**：
 * 哈希链是 `hash = sha256(prevHash + …)`，天然**串行**，「让恢复可并行」这条**不成立**，
 * 本轮不做、也不写在理由里。
 *
 * 本测试断言的是**语义**（不测时间）：
 *   1. 超过阈值会滚动，段名按段号升序，活动段永远是 `journal.jsonl`；
 *   2. 跨段 seq / prevHash **仍是一条连续的链**（分段不改变链语义）；
 *   3. 重开时能把所有段拼回完整历史，`seq` / `records` 与滚动前一致；
 *   4. **锚点跨段仍自洽**：`rawText()` 返回逻辑全文（不是只有活动段）；
 *   5. torn tail 只在**活动段**被修复；
 *   6. **已封存段里出现坏行 → fail-closed**（它是 rename 过来的完整文件，坏了就是被改过）；
 *   7. 老版本只读活动段 → `STATE_SEQ_GAP`（**响亮失败**，不是安静地少读一半）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (name) => pathToFileURL(path.join(root, 'lib', name)).href;
const { Journal, statePaths, sealedSegments, segmentName } = await import(lib('state/journal.js'));
const { NodeFsPort } = await import(lib('state/fs-port.js'));

const SEGMENT_BYTES = 4096; // 很小的阈值，逼出多段
const TOTAL = 200;          // 200 条记录

const dir = path.resolve(tempStateDir('segments'));
const paths = statePaths(dir);
const fsPort = new NodeFsPort();

try {
  // ── 1. 写入足够多的记录，逼出滚动 ────────────────────────────────────────
  const opened = await Journal.open({ dir, fs: fsPort, owner: 'seg-test', segmentMaxBytes: SEGMENT_BYTES, waitMs: 0 });
  const journal = opened.journal;
  for (let i = 0; i < TOTAL; i += 1) {
    await journal.append({ kind: 'noop_marker', payload: { n: i, pad: 'x'.repeat(48) } });
  }
  const statusAfterWrite = journal.status();
  assert.equal(statusAfterWrite.seq, TOTAL);
  assert.ok(statusAfterWrite.sealedSegments >= 2, `应已滚动出多段，实际封存段 ${statusAfterWrite.sealedSegments}`);

  const entries = await fsPort.listDir(paths.root);
  const sealed = sealedSegments(entries);
  assert.ok(sealed.length >= 2, '目录里应有 ≥2 个已封存段');
  assert.deepEqual(sealed.map((s) => s.name), sealed.map((_, i) => segmentName(i + 1)), '段名应按段号升序且从 0001 起');
  assert.ok(entries.some((e) => e.name === 'journal.jsonl'), '活动段必须仍叫 journal.jsonl（老读者靠它 fail-closed）');

  // 每段都不超过阈值太多（一批写完可能略超，但不应出现一个巨型段）
  for (const row of sealed) {
    const size = fs.statSync(path.join(paths.root, row.name)).size;
    assert.ok(size <= SEGMENT_BYTES * 3, `段 ${row.name} 大小 ${size} 超出预期（阈值 ${SEGMENT_BYTES}）`);
  }

  // ── 2. 跨段仍是一条连续链 ──────────────────────────────────────────────
  const records = journal.records();
  assert.equal(records.length, TOTAL, '记录数应等于写入次数');
  assert.equal(records[0].seq, 1);
  assert.equal(records[0].prevHash, '', '全链首条 prevHash 必须为空串');
  for (let i = 1; i < records.length; i += 1) {
    assert.equal(records[i].seq, records[i - 1].seq + 1, `seq 必须连续（第 ${i} 条）`);
    assert.equal(records[i].prevHash, records[i - 1].hash, `prevHash 必须接上（第 ${i} 条）`);
  }

  // ── 3. 锚点：rawText 是**逻辑全文**，不是只有活动段 ──────────────────────
  const rawText = await journal.rawText();
  assert.equal(Buffer.byteLength(rawText, 'utf8'), statusAfterWrite.bytes, 'rawText 字节数必须等于 status().bytes（跨段合计）');
  const activeOnly = fs.readFileSync(paths.journal, 'utf8');
  assert.ok(activeOnly.length < rawText.length, '活动段应只占全文的一部分（否则没测到跨段）');

  await journal.release();

  // ── 4. 重开：把所有段拼回来 ────────────────────────────────────────────
  const reopened = await Journal.open({ dir, fs: fsPort, owner: 'seg-test', segmentMaxBytes: SEGMENT_BYTES, waitMs: 0 });
  assert.equal(reopened.journal.status().seq, TOTAL, '重开后 seq 必须与滚动前一致');
  assert.equal(reopened.journal.records().length, TOTAL, '重开后记录数必须一致');
  assert.equal(reopened.journal.status().sealedSegments, sealed.length, '重开后封存段数应一致');
  assert.equal((await reopened.journal.rawText()).length, rawText.length, '重开后 rawText 长度应一致');
  await reopened.journal.release();

  // ── 5. torn tail 只在活动段被修复 ───────────────────────────────────────
  const beforeTorn = fs.readFileSync(paths.journal, 'utf8');
  fs.appendFileSync(paths.journal, '{"seq":99999,"eventId":"EVT-0', 'utf8');
  const torn = await Journal.open({ dir, fs: fsPort, owner: 'seg-test', segmentMaxBytes: SEGMENT_BYTES, waitMs: 0 });
  assert.ok(torn.repair, '活动段 torn tail 应被修复并留痕');
  assert.equal(fs.readFileSync(paths.journal, 'utf8'), beforeTorn, '截断后活动段应恢复为修复前的完整内容');
  assert.equal(torn.journal.records().length, TOTAL, '修复后记录数不变');
  await torn.journal.release();

  // ── 6. 已封存段里出现坏行 → fail-closed ────────────────────────────────
  const firstSegment = path.join(paths.root, sealed[0].name);
  const firstText = fs.readFileSync(firstSegment, 'utf8');
  fs.writeFileSync(firstSegment, 'GARBAGE-NOT-JSON\n' + firstText, 'utf8');
  let corruptCode = null;
  try {
    const bad = await Journal.open({ dir, fs: fsPort, owner: 'seg-test', segmentMaxBytes: SEGMENT_BYTES, waitMs: 0 });
    await bad.journal.release();
  } catch (error) {
    corruptCode = error?.code ?? error?.name ?? 'unknown';
  }
  assert.equal(corruptCode, 'STATE_CORRUPT', `已封存段损坏必须 fail-closed，实际 ${corruptCode}`);
  fs.writeFileSync(firstSegment, firstText, 'utf8'); // 还原

  // ── 7. 老版本只读活动段 → STATE_SEQ_GAP（响亮失败）──────────────────────
  const legacyDir = path.resolve(tempStateDir('segments-legacy'));
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.copyFileSync(paths.journal, path.join(legacyDir, 'journal.jsonl'));
  let legacyCode = null;
  try {
    const legacy = await Journal.open({ dir: legacyDir, fs: new NodeFsPort(), owner: 'legacy', waitMs: 0 });
    await legacy.journal.release();
  } catch (error) {
    legacyCode = error?.code ?? error?.name ?? 'unknown';
  }
  assert.equal(legacyCode, 'STATE_SEQ_GAP', `只读活动段必须响亮失败（STATE_SEQ_GAP），实际 ${legacyCode}`);

  // ── 8. 默认阈值下不滚动（行为与旧版本一致）────────────────────────────
  const plainDir = path.resolve(tempStateDir('segments-plain'));
  const plain = await Journal.open({ dir: plainDir, fs: new NodeFsPort(), owner: 'plain', waitMs: 0 });
  for (let i = 0; i < 50; i += 1) await plain.journal.append({ kind: 'noop_marker', payload: { n: i } });
  assert.equal(plain.journal.status().sealedSegments, 0, '默认 64 MB 阈值下不应滚动');
  await plain.journal.release();

  // ── 9. 走 core↔state 桥（CorePersistence）也要能滚动并正确重开 ───────────
  // 这一组是**端到端**：核心事件经 `persistCoreEvents` → `state.appendBatch` →
  // `journal.appendBatch` 才落盘，滚动逻辑在最后一跳。前 8 组只测了 Journal 本身。
  const { CorePersistence } = await import(lib('persistence.js'));
  const { Store, commitGraph } = await import(lib('core/index.js'));
  const e2eDir = path.resolve(tempStateDir('segments-e2e'));
  const p1 = await CorePersistence.open({ dir: e2eDir, mode: 'node', owner: 'seg-e2e', waitMs: 0, segmentMaxBytes: 4096 });
  const nodeCount = 400;
  const committed = commitGraph(p1.core, {
    wish: 'segment e2e',
    policies: { maxParallel: 8 },
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
      nodeId: `S${String(i).padStart(4, '0')}`,
      title: `n${i}`,
      capability: 'CODE',
      acceptance: { kind: 'exists' },
    })),
  });
  assert.equal(committed.ok, true, `建图失败：${JSON.stringify(committed.errors ?? committed)}`);
  const persisted1 = await p1.persist();
  assert.equal(persisted1?.error, null, `落盘报错：${JSON.stringify(persisted1?.error)}`);
  const seqBefore = p1.core.journal.count();
  await p1.close({ snapshot: true });

  const e2ePaths = statePaths(e2eDir);
  const e2eEntries = await new NodeFsPort().listDir(e2ePaths.root);
  const e2eSealed = sealedSegments(e2eEntries);
  assert.ok(e2eSealed.length >= 1, `端到端应滚出 ≥1 个封存段，实际 ${e2eSealed.length}`);

  const p2 = await CorePersistence.open({ dir: e2eDir, mode: 'node', owner: 'seg-e2e', waitMs: 0, segmentMaxBytes: 4096 });
  assert.equal(p2.core.journal.count(), seqBefore, `重开后事件数应一致：${p2.core.journal.count()} vs ${seqBefore}`);
  assert.equal(p2.core.state.nodes.size, nodeCount, '重开后节点数应一致');
  await p2.close({ snapshot: true });

  console.log('PASS journal 分段：滚动命名 / 跨段连续链 / 重开拼回 / rawText 跨段 / torn tail 只修活动段 / 封存段损坏 fail-closed / 老读者响亮失败 / 默认不滚动 / CorePersistence 端到端');
} finally {
  cleanupTempStateDirs();
}
