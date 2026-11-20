/**
 * `persist()` 必须只交出**还没落盘的那一段**，且不得深拷贝全史。
 *
 * 这条是第 29 轮那个 83 秒的根因：`CorePersistence.persist()` 原来每次都调
 * `journal.raw()`——它对**每一条**事件做 `cloneEvent`（payload 走 JSON 深拷贝），
 * 而 `persistCoreEvents` 又在全量数组上 `[...events].sort()` / `filter` / `Map`。
 * 于是每次 `withCore` 之后的落盘都是 O(全史)，吞吐随运行时长持续下降：
 * 1000 节点实测 12.0 节点/秒（83.3 s），同一次跑里 `verifyDone` 前 50 次 → 后 50 次 ×2.19。
 *
 * 修法：从尾部倒扫出 `seq > 已落盘游标` 的后缀交给持久化层；无待落事件时给空数组。
 *
 * 本测试**不测时间**（时间会 flaky，且性能数字归 `bench:service`），只断言结构性质：
 *
 *   1. 没有待落事件时，`persist()` 不得触碰 `journal.raw()`（即不得深拷贝全史）；
 *   2. 有 k 条待落事件时，交给持久化层的条数必须是 **k**，而不是全史条数；
 *   3. 落盘结果正确：盘上行数 == 已落盘事件数（增量语义不能漏写）；
 *   4. 尾部非单调（`restore()` 回滚 / 恢复期重编号后的形状）时**回退 `raw()`**——
 *      这条罕见路径用 O(n) 换正确性，必须有断言钉住，否则日后会被"顺手优化"掉。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (name) => pathToFileURL(path.join(root, 'lib', name)).href;
const { CorePersistence } = await import(lib('persistence.js'));
const { Store, commitGraph } = await import(lib('core/index.js'));

const dir = path.resolve(tempStateDir('persist-incr'));

/** 把 `raw()` 换成计数器：我们要断言的是「它被调了几次」，不是它多快。 */
function instrumentRaw(journal) {
  const counter = { calls: 0, eventsHanded: -1 };
  const original = journal.raw.bind(journal);
  journal.raw = () => {
    counter.calls += 1;
    const out = original();
    counter.eventsHanded = out.length;
    return out;
  };
  return counter;
}

try {
  const p = await CorePersistence.open({ dir, mode: 'node', waitMs: 0, owner: 'persist-incr' });
  const core = p.core;
  const journal = core.journal;
  const rawCounter = instrumentRaw(journal);

  // ── 0. 造 2000 条事件（一次批量），先落一次盘 ────────────────────────────
  const nodes = Array.from({ length: 2000 }, (_, i) => ({
    nodeId: `P${String(i + 1).padStart(4, '0')}`,
    title: `n${i}`,
    capability: 'CODE',
    acceptance: { kind: 'exists' },
  }));
  const committed = commitGraph(core, { wish: 'persist-incremental', nodes });
  assert.equal(committed.ok, true, `建图失败：${JSON.stringify(committed.errors ?? committed)}`);
  const totalEvents = journal.count();
  assert.ok(totalEvents >= 2000, `应已积累 ≥2000 条事件，实际 ${totalEvents}`);

  const first = await p.persist();
  assert.equal(first?.error, null, `首次落盘报错：${JSON.stringify(first?.error)}`);
  assert.ok(Number(first?.appended) > 0, '首次落盘应有内容');
  // 首次落盘走的是后缀路径（游标为 0 → 后缀就是全部），raw 不该被调
  assert.equal(rawCounter.calls, 0, `首次落盘不应深拷贝全史（raw 被调 ${rawCounter.calls} 次）`);

  // ── 1. 无待落事件：不得触碰 raw()，且不得写盘 ────────────────────────────
  const journalFile = p.state.paths.journal;
  const linesBefore = fs.readFileSync(journalFile, 'utf8').split('\n').filter((l) => l.trim()).length;
  const noop = await p.persist();
  assert.equal(noop?.appended, 0, '无待落事件时不应追加');
  assert.equal(rawCounter.calls, 0, '无待落事件时不得调 raw()（那是 O(全史) 深拷贝）');
  const linesAfterNoop = fs.readFileSync(journalFile, 'utf8').split('\n').filter((l) => l.trim()).length;
  assert.equal(linesAfterNoop, linesBefore, '无待落事件时不得写盘');

  // ── 2. 有 3 条待落：交出去的必须是 3 条，不是 2000+ ───────────────────────
  const before = journal.count();
  journal.append('noop_marker', null, { at: '2026-01-01T00:00:00.000Z', n: 1 });
  journal.append('noop_marker', null, { at: '2026-01-01T00:00:01.000Z', n: 2 });
  journal.append('noop_marker', null, { at: '2026-01-01T00:00:02.000Z', n: 3 });
  assert.equal(journal.count(), before + 3);
  const rawCallsBeforeIncrement = rawCounter.calls;
  const inc = await p.persist();
  assert.equal(inc?.appended, 3, `应只落新增的 3 条，实际 ${inc?.appended}`);
  assert.equal(inc?.error, null, `增量落盘报错：${JSON.stringify(inc?.error)}`);
  assert.equal(
    rawCounter.calls,
    rawCallsBeforeIncrement,
    '增量落盘不得调 raw()——它是「每次落盘都深拷贝全史」这个 bug 的唯一入口',
  );

  // ── 3. 落盘结果正确：三条新事件真的在盘上，且游标推进到末条 ──────────────
  // 注意不能断言「文件行数正好 +3」：N4 自己的诊断行也会写进同一个文件
  // （`businessRecords()` 把它们挡在 core 视图之外，但它们确实占行）。
  const persistedRows = fs.readFileSync(journalFile, 'utf8').split('\n').filter((l) => l.trim())
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
  const markers = persistedRows.filter((row) => row.kind === 'noop_marker');
  assert.equal(markers.length, 3, `三条标记事件都应落盘，实际 ${markers.length}`);
  assert.deepEqual(markers.map((row) => row.payload?.n), [1, 2, 3], '落盘顺序应与追加顺序一致');
  const linesAfterIncrement = persistedRows.length;
  assert.ok(linesAfterIncrement >= linesBefore + 3, `盘上至少应多 3 行，实际 ${linesBefore} → ${linesAfterIncrement}`);
  const cursor = p.state.cursorOf('core');
  assert.equal(Number(cursor?.coreSeq), journal.count(), '游标应推进到末条 seq');

  // ── 4. 尾部非单调（rollback 形状）：必须回退 raw()，且不能漏写 ────────────
  // 用第二个实例做：非单调要在「首次落盘」时观察（此时游标为 0，后缀=全部，
  // 倒扫会在尾部发现逆序）。在已落盘的实例上改游标属于内部状态操纵，测不到真路径。
  const dir2 = path.resolve(tempStateDir('persist-nonmono'));
  const p2 = await CorePersistence.open({ dir: dir2, mode: 'node', waitMs: 0, owner: 'persist-nonmono' });
  try {
    commitGraph(p2.core, {
      wish: 'nonmono',
      nodes: ['A1', 'A2', 'A3'].map((nodeId) => ({ nodeId, title: nodeId, capability: 'CODE', acceptance: { kind: 'exists' } })),
    });
    const raw2 = instrumentRaw(p2.core.journal);
    // 造非单调尾部：交换最后两条的顺序（restore 按给定顺序重建，不做重排）
    const all2 = p2.core.journal.view().map((event) => ({ ...event, payload: { ...event.payload } }));
    const len = all2.length;
    assert.ok(len >= 3, '前置：至少要有 3 条事件');
    const shuffled = [...all2.slice(0, len - 2), all2[len - 1], all2[len - 2]];
    p2.core.journal.restore(shuffled);
    await p2.persist();
    assert.ok(raw2.calls > 0, '尾部非单调时必须回退 raw()（用 O(n) 换正确性），否则倒扫会漏写');
    assert.equal(Number(p2.state.cursorOf('core')?.coreSeq), p2.core.journal.count(), '回退路径也要把游标推到末条');
  } finally {
    await p2.close({ snapshot: true });
  }

  // ── 5. 指纹缓存不得返回过期值（第 30 轮把它从 O(全史) 改成 O(1) 的分摊） ─────
  // `snapshot().fingerprint` 曾是 `journalFingerprint()` 每次现算：4005 条记录单次 24.19 ms，
  // 而 `service.graphStatus()` 又调了**两次** `snapshot()` → 单次 graphStatus 50 ms。
  // 加缓存后唯一要守的性质是：**缓存值必须永远等于现算值**。
  // 这里不测时间，只做「与独立现算对拍」。
  {
    const { journalFingerprint } = await import(lib('state/journal.js'));
    const fresh = () => journalFingerprint(p.state.journal.records());
    const first = p.snapshot().fingerprint;
    assert.equal(first, fresh(), '首次 fingerprint 应等于现算值');
    assert.equal(p.snapshot().fingerprint, first, '无追加时两次 snapshot 应一致');
    assert.equal(p.snapshot().fingerprint, fresh(), '缓存命中时也必须等于现算值');

    // 通过 core journal + persist 追加一条（N4 记录由桥接层写入，那才是 snapshot 折叠的对象）
    const core = p.core;
    core.journal.append('noop_marker', null, { at: '2026-01-01T00:00:09.000Z', n: 9 });
    await p.persist();
    const afterAppend = p.snapshot().fingerprint;
    assert.notEqual(afterAppend, first, '追加后 fingerprint 必须变化（缓存要失效）');
    assert.equal(afterAppend, fresh(), '追加后 fingerprint 必须等于现算值');
  }

  await p.close({ snapshot: true });
  console.log('PASS persist 增量：无待落零深拷贝 / k 条只交 k 条 / 盘上事件对得上 / 非单调尾部回退 raw()');
  console.log('PASS 指纹缓存：命中时等于现算 / 追加后失效且仍等于现算');} finally {
  cleanupTempStateDirs();
}
