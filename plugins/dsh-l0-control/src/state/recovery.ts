/**
 * N4 · 崩溃恢复
 *
 * 策略（journal 权威 / 快照是缓存，plan §2）：
 *   1. 打开 journal（含 torn tail 截断）→ 校验哈希链。
 *   2. 折叠 journal = 权威状态。
 *   3. 读快照：
 *      - 缺失 → 按 journal 建立快照（bootstrap）。
 *      - `snapshot.seq > journal.seq` → `STATE_SNAPSHOT_AHEAD`（journal 丢了：拒绝启动，
 *        不拿快照反推 journal，否则等于伪造历史）。
 *      - 锚不符 / 折叠到 snapshot.seq 与快照内容不一致 → `diverged`：**journal 胜**，
 *        重写快照并在 journal 追加 `snapshot_diverged` 事件（留痕，不静默）。
 *      - 一致 → 从快照基线只重放 `seq > snapshot.seq` 的增量（快路径），并复核与全量折叠相等。
 *   4. 若 journal 已前进，把快照推进到最新 seq。
 *
 * 不变量：`replay(records) == state`（对同一 seq）；`revision` 单调；
 *        恢复过程本身只产生 `snapshot_*` / `writer_*` 类事件，不伪造业务事件。
 */

import { canonicalJson } from './canonical.ts';
import { Journal, type JournalStatus, type StatePaths } from './journal.ts';
import { applyRecord, emptyState, fold, foldUntil } from './reducer.ts';
import {
  buildSnapshot,
  checkAnchor,
  readSnapshot,
  stateSha256,
  updateSnapshot,
  verifySnapshot,
  type SnapshotWriteResult,
} from './snapshot.ts';
import { StateError, type FsPort, type JournalRecord, type SnapshotFile, type StateDoc, type StoreOptions } from './types.ts';

export type RecoverySource = 'journal+bootstrap' | 'journal' | 'snapshot+replay';

export interface RecoveryReport {
  ok: true;
  seq: number;
  revision: number;
  graphRevision: number;
  source: RecoverySource;
  records: number;
  repair: JournalStatus['repair'];
  snapshot: {
    existed: boolean;
    seq: number | null;
    version: string | null;
    updated: boolean;
    write: SnapshotWriteResult | null;
  };
  diverged: boolean;
  anchor: string;
  replayEqualsSnapshot: boolean;
  state: StateDoc;
  eventsAppended: string[];
}

export interface RecoverOptions {
  fs: FsPort;
  paths: StatePaths;
  /** 已打开的 journal（持有写锁）。 */
  journal: Journal;
  /** 折叠函数（N3 可覆盖）。 */
  fold?: (records: JournalRecord[]) => StateDoc;
  /** 时间源（测试注入）。 */
  now?: () => number;
  /** 是否把新增诊断事件写进 journal（默认 true）。 */
  recordEvents?: boolean;
}

export async function recoverWithJournal(options: RecoverOptions): Promise<RecoveryReport> {
  const { fs, paths, journal } = options;
  const foldFn = options.fold ?? ((records: JournalRecord[]) => fold(records, emptyState()));
  const clock = options.now ?? (() => Date.now());
  const recordEvents = options.recordEvents ?? true;

  journal.verifyChain();
  const records = journal.records();
  const rawJournal = (await fs.readText(paths.journal)) ?? '';
  const authoritative = foldFn(records);
  const eventsAppended: string[] = [];
  let diverged = false;
  let snapshotWrite: SnapshotWriteResult | null = null;

  const loaded = await readSnapshot(fs, paths);
  let source: RecoverySource = 'journal';
  let snapshotExisted = false;
  let snapshotSeq: number | null = null;
  let snapshotVersion: string | null = null;

  if (loaded === null) {
    source = 'journal+bootstrap';
  } else {
    snapshotExisted = true;
    snapshotSeq = loaded.file.meta.seq;
    snapshotVersion = loaded.version;
    verifySnapshot(loaded.file);

    if (loaded.file.meta.seq > authoritative.revision) {
      throw new StateError('STATE_SNAPSHOT_AHEAD', '快照超前于 journal：拒绝以快照反推历史', {
        snapshotSeq: loaded.file.meta.seq,
        journalSeq: authoritative.revision,
        hint: '若确属旧快照，删除 snapshot.json 后从 journal 重建；若 journal 被回滚，人工介入',
      });
    }

    const anchor = checkAnchor(loaded.file, records, rawJournal);
    const atAnchor = foldUntil(records, loaded.file.meta.seq, emptyState());
    const anchorMatches = canonicalJson(atAnchor.state as unknown) === canonicalJson(loaded.file.state as unknown);

    if (!anchorMatches || anchor.status === 'diverged') {
      diverged = true;
      source = 'journal';
      if (recordEvents) {
        const event = await journal.append({
          kind: 'snapshot_diverged',
          payload: {
            snapshotSeq: loaded.file.meta.seq,
            journalSeq: authoritative.revision,
            anchorStatus: anchor.status,
            matches: anchorMatches,
            snapshotSha: loaded.file.meta.stateSha256,
            replaySha: stateSha256(atAnchor.state),
            at: new Date(clock()).toISOString(),
          },
        });
        eventsAppended.push(event.eventId);
      }
    } else {
      // 快路径：快照为基线，只重放增量
      const fast = JSON.parse(JSON.stringify(loaded.file.state)) as StateDoc;
      for (const record of records.filter((item) => item.seq > loaded.file.meta.seq)) applyRecord(fast, record);
      fast.revision = authoritative.revision;
      if (canonicalJson(fast as unknown) !== canonicalJson(authoritative as unknown)) {
        diverged = true;
        source = 'journal';
        if (recordEvents) {
          const event = await journal.append({
            kind: 'snapshot_diverged',
            payload: {
              snapshotSeq: loaded.file.meta.seq,
              journalSeq: authoritative.revision,
              reason: 'incremental-replay-mismatch',
              at: new Date(clock()).toISOString(),
            },
          });
          eventsAppended.push(event.eventId);
        }
      } else {
        source = 'snapshot+replay';
      }
    }
  }

  // 用最终的 journal 原文（可能刚追加了 snapshot_diverged）重建快照
  const finalRecords = journal.records();
  const finalRaw = (await fs.readText(paths.journal)) ?? '';
  const finalState = foldFn(finalRecords);
  const snapshotFile: SnapshotFile = buildSnapshot(finalState, finalRecords, finalRaw, new Date(clock()).toISOString());

  let updated = false;
  if (loaded === null) {
    snapshotWrite = await updateSnapshot(fs, paths, snapshotFile);
    updated = true;
  } else if (
    !diverged &&
    loaded.file.meta.seq === finalState.revision &&
    loaded.file.meta.journalHash === snapshotFile.meta.journalHash
  ) {
    updated = false; // 已同步，不产生无意义写入（也避免 revision/hash 抖动）
  } else {
    snapshotWrite = await updateSnapshot(fs, paths, snapshotFile);
    updated = true;
  }

  const replayEqualsSnapshot =
    canonicalJson(foldFn(finalRecords) as unknown) === canonicalJson(finalState as unknown);

  return {
    ok: true,
    seq: finalState.revision,
    revision: finalState.revision,
    graphRevision: finalState.graphRevision,
    source: diverged ? 'journal' : source,
    records: finalRecords.length,
    repair: journal.status().repair,
    snapshot: {
      existed: snapshotExisted,
      seq: snapshotSeq,
      version: snapshotVersion,
      updated,
      write: snapshotWrite,
    },
    diverged,
    anchor: loaded === null ? 'missing' : checkAnchor(loaded.file, records, rawJournal).status,
    replayEqualsSnapshot,
    state: finalState,
    eventsAppended,
  };
}

/** 打开 → 恢复 的一步式入口（取锁、修复尾部、对账快照）。 */
export async function openAndRecover(
  options: StoreOptions & {
    fold?: (records: JournalRecord[]) => StateDoc;
    recordEvents?: boolean;
    stealIfStale?: boolean;
  },
): Promise<{ journal: Journal; report: RecoveryReport }> {
  const opened = await Journal.open({ ...options, stealIfStale: options.stealIfStale });
  const report = await recoverWithJournal({
    fs: options.fs,
    paths: opened.journal.paths,
    journal: opened.journal,
    fold: options.fold,
    now: options.now,
    recordEvents: options.recordEvents,
  });
  return { journal: opened.journal, report };
}
