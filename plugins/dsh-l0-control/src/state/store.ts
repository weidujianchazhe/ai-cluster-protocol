/**
 * N4 · Store 门面（单写者 + revision + checkpoint + takeover）
 *
 * 只做三件事：
 *   1. 打开即恢复（journal 权威 + 快照缓存），对外暴露只读 `state`；
 *   2. 一切写入走 `append()`：取 journal 单写者锁 → 追加 → 增量折叠到内存状态；
 *   3. 提供 `checkpoint()` / `takeover()` / `snapshot()`，供 N2 的 `l0control` 服务调用。
 *
 * 不做业务判断（done 凭证、ready 门控、租约语义归 N3 core）。
 * 双写：第二个进程 `Store.open()` 直接 `STATE_LOCKED`；过期锁只能经 `takeover()`。
 */

import { randomUUID } from 'node:crypto';
import { canonicalJson, nowIso, sha256Hex } from './canonical.ts';
import { Journal, statePaths, type StatePaths, type JournalStatus } from './journal.ts';
import { openAndRecover, type RecoveryReport } from './recovery.ts';
import { applyRecord, emptyState, fold } from './reducer.ts';
import { buildSnapshot, updateSnapshot, type SnapshotWriteResult } from './snapshot.ts';
import { StateError, type AppendInput, type Checkpoint, type CursorRecord, type FenceToken, type FsPort, type JournalRecord, type SnapshotMeta, type StateDoc, type StoreOptions } from './types.ts';

/** 遇活锁时的默认等待预算（毫秒）。 */
export const DEFAULT_WAIT_MS = 5000;

export interface StoreOpenOptions extends StoreOptions {
  /** 自定义折叠（N3）；默认 reducer。 */
  fold?: (records: JournalRecord[]) => StateDoc;
  /** 打开时是否写诊断事件（默认 true）。 */
  recordEvents?: boolean;
  /** 显式接管过期锁（等价 `Journal.open({stealIfStale:true})`）；活锁仍然拒绝。 */
  takeover?: boolean;
  /**
   * 遇活锁的等待预算（毫秒），默认 **5000**。
   * 0 = fail-fast（立即 `STATE_LOCKED`，测试/严格场景用）。
   * 等待期间只读锁文件，不抢活锁；只有 `heartbeatAt + ttlMs <= now`（真过期）才允许 stale steal。
   */
  waitMs?: number;
  /** 退避起点（默认 25ms）。 */
  retryBaseMs?: number;
  /** 退避上限（默认 500ms）。 */
  retryMaxMs?: number;
  /** 每次重试前的回调（观测用）。 */
  onWait?: (info: WaitInfo) => void;
}

export interface WaitInfo {
  attempt: number;
  elapsedMs: number;
  /** 当前持锁者（读不出锁文件时为 null）。 */
  holder: string | null;
  heartbeatAt: string | null;
  ttlMs: number | null;
  /** 是否已满足 stale 条件（heartbeat + TTL <= now）。 */
  stale: boolean;
}

export interface WaitForUnlockResult {
  released: boolean;
  waitedMs: number;
  attempts: number;
  /** 锁是否已过期（可被 takeover）。 */
  stale: boolean;
  holder: string | null;
}

export interface TakeoverResult {
  fence: FenceToken;
  /** 抢占锁的方式：`stolen`（接管过期锁）/ `acquired`（无锁直接持有）。 */
  mode: 'stolen' | 'acquired' | 'self';
  journalStatus: JournalStatus;
  recovery: RecoveryReport;
}

/** `Store.appendFromSeq()` 的返回值：同时给出两个序列空间的映射。 */
export interface AppendFromSeqResult {
  /** 调用方给的 core 空间基准（新记录从 baseSeq + 1 起）。 */
  baseSeq: number;
  /** 追加前的 journal revision。 */
  baseRevision: number;
  /** 追加前的游标（首次为 null）。 */
  cursorBefore: CursorRecord | null;
  /** 本批追加的记录（不含 `cursor_aligned`）。 */
  appended: JournalRecord[];
  /** 追加后的 journal revision。 */
  revisionAfter: number;
  /** 追加后的游标 coreSeq。 */
  cursorAfter: number;
  /** 是否写了 `cursor_aligned` 诊断事件。 */
  wroteCursor: boolean;
  /** 追加后的游标记录（含它自己的 seq）。 */
  cursor?: CursorRecord;
}

export class Store {
  readonly paths: StatePaths;
  private readonly journalRef: Journal;
  private readonly fsPort: FsPort;
  private readonly clock: () => number;
  private readonly foldFn: (records: JournalRecord[]) => StateDoc;
  private doc: StateDoc;
  private recoveryReport: RecoveryReport;
  private fence: FenceToken | null = null;
  private closed = false;

  private constructor(
    journal: Journal,
    report: RecoveryReport,
    options: StoreOpenOptions,
    paths: StatePaths,
  ) {
    this.journalRef = journal;
    this.paths = paths;
    this.fsPort = options.fs;
    this.clock = options.now ?? (() => Date.now());
    this.foldFn = options.fold ?? ((records) => fold(records, emptyState()));
    this.doc = report.state;
    this.recoveryReport = report;
    const lock = journal.lock;
    if (lock) {
      this.fence = {
        token: lock.epoch,
        owner: lock.owner,
        issuedAt: lock.startedAt,
        expiresAt: new Date(Date.parse(lock.heartbeatAt) + lock.ttlMs).toISOString(),
        previousToken: 0,
      };
    }
  }

  /**
   * 打开（默认遇活锁**等待**，指数退避，预算 `waitMs` 默认 5s）。
   *
   * 语义：
   *   - 活锁存在且未过期 → 不抢、不报错，按 25ms→500ms 退避重试，期间只读锁文件；
   *   - `waitMs: 0` → fail-fast（立即 `STATE_LOCKED`）；
   *   - 预算耗尽 → `STATE_LOCKED`，detail 带 `holder/heartbeatAt/ttlMs/waitedMs/attempts`；
   *   - 只有 `heartbeatAt + ttlMs <= now`（真过期）且 `takeover: true` 才 stale steal，
   *     **绝不**在 TTL 内抢活写者（旧 writer 可能正在 close/落快照）。
   */
  static async open(options: StoreOpenOptions): Promise<Store> {
    const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    const started = Date.now();
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await Store.openOnce(options);
      } catch (error) {
        if (!(error instanceof StateError) || error.code !== 'STATE_LOCKED' || waitMs <= 0) throw error;
        const elapsed = Date.now() - started;
        const info = await Store.readLock(options);
        if (elapsed >= waitMs) {
          throw new StateError('STATE_LOCKED', `等待锁超时（${waitMs}ms / ${attempt} 次尝试）`, {
            ...info,
            waitedMs: elapsed,
            attempts: attempt,
            hint: '确认上一个 writer 是否已 close()；崩溃后等 TTL 过期再用 takeover:true',
          });
        }
        options.onWait?.({ attempt, elapsedMs: elapsed, ...info });
        const base = options.retryBaseMs ?? 25;
        const cap = options.retryMaxMs ?? 500;
        const delay = Math.min(base * 2 ** (attempt - 1), cap, Math.max(1, waitMs - elapsed));
        await Store.sleep(delay);
      }
    }
  }

  private static async openOnce(options: StoreOpenOptions): Promise<Store> {
    const { journal, report } = await openAndRecover({
      ...options,
      fold: options.fold,
      recordEvents: options.recordEvents,
      stealIfStale: options.takeover === true,
    });
    return new Store(journal, report, options, journal.paths);
  }

  /** 只读锁文件（不抢）。用于等待/诊断。 */
  static async readLock(
    options: Pick<StoreOpenOptions, 'dir' | 'fs'> & { now?: () => number },
  ): Promise<{ holder: string | null; heartbeatAt: string | null; ttlMs: number | null; stale: boolean }> {
    const paths = statePaths(options.dir);
    const raw = await options.fs.readText(paths.lock);
    const now = (options.now ?? (() => Date.now()))();
    if (raw === null) return { holder: null, heartbeatAt: null, ttlMs: null, stale: true };
    try {
      const lock = JSON.parse(raw) as { owner?: string; heartbeatAt?: string; ttlMs?: number };
      const ttlMs = Number(lock.ttlMs ?? 0);
      const stale = Date.parse(String(lock.heartbeatAt)) + ttlMs <= now;
      return { holder: lock.owner ?? null, heartbeatAt: lock.heartbeatAt ?? null, ttlMs, stale };
    } catch {
      return { holder: null, heartbeatAt: null, ttlMs: null, stale: false };
    }
  }

  /**
   * 等锁释放（不打开 Store）。`service.open()` 若只想先确认可用，可先调它。
   * 返回 `released: true` 表示锁已消失；`stale: true` 表示仍存在但已过期（可 takeover）。
   */
  static async waitForUnlock(
    options: StoreOpenOptions & { timeoutMs?: number },
  ): Promise<WaitForUnlockResult> {
    const timeoutMs = options.timeoutMs ?? options.waitMs ?? DEFAULT_WAIT_MS;
    const started = Date.now();
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const info = await Store.readLock(options);
      if (info.holder === null || info.stale) {
        return {
          released: info.holder === null,
          waitedMs: Date.now() - started,
          attempts: attempt,
          stale: info.stale,
          holder: info.holder,
        };
      }
      const elapsed = Date.now() - started;
      if (elapsed >= timeoutMs) {
        return { released: false, waitedMs: elapsed, attempts: attempt, stale: false, holder: info.holder };
      }
      options.onWait?.({ attempt, elapsedMs: elapsed, ...info });
      const base = options.retryBaseMs ?? 25;
      const cap = options.retryMaxMs ?? 500;
      await Store.sleep(Math.min(base * 2 ** (attempt - 1), cap, Math.max(1, timeoutMs - elapsed)));
    }
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.round(ms))));
  }

  get state(): StateDoc {
    return this.doc;
  }

  get revision(): number {
    return this.doc.revision;
  }

  get journal(): Journal {
    return this.journalRef;
  }

  get lastRecovery(): RecoveryReport {
    return this.recoveryReport;
  }

  get currentFence(): FenceToken | null {
    return this.fence;
  }

  /** 追加一条业务事件并增量折叠；返回记录。 */
  async append(input: AppendInput): Promise<JournalRecord> {
    const [record] = await this.appendBatch([input]);
    return record;
  }

  /** 批量追加（一次 write + 一次 fsync）：用于"done 事务"这类需要成组落盘的动作。 */
  async appendBatch(inputs: AppendInput[]): Promise<JournalRecord[]> {
    this.assertOpen();
    await this.guardWriter();
    if (this.fence && inputs.some((input) => input.fencingToken != null && input.fencingToken < this.fence!.token)) {
      throw new StateError('STATE_FENCED_OUT', '批量写入含过期 fencing token', { token: this.fence.token });
    }
    const records = await this.journalRef.appendBatch(inputs);
    for (const record of records) applyRecord(this.doc, record);
    this.doc.revision = records.length ? records[records.length - 1].seq : this.doc.revision;
    return records;
  }

  /**
   * 以**外部序列空间**（core 的 seq）为基准追加。
   *
   * 解决的真实缺陷：core 的内存 seq 是本地业务计数（如恢复后 27），而 journal 的
   * revision 还含诊断事件（如 39）。旧实现要求 `event.seq === revision + 1 + i`，
   * 于是恢复后永远写不进去。本 API 的契约：
   *   - `baseSeq` = 调用方认为"已消费到的 core 序号"（新记录从 `baseSeq + 1` 起）；
   *   - 新记录在 journal 里的 seq 仍由 journal 决定：`max(store.revision, baseSeq) + 1` 起；
   *   - 历史保留不重写；重复（baseSeq < 游标）/回退/中间缺口 一律 `STATE_SEQ_GAP`；
   *   - 成功后追加一条 `cursor_aligned` 诊断事件，把 `coreSeq ↔ revision` 映射持久化；
   *   - 幂等：`baseSeq === 游标` 且无新记录 → 只返回当前映射，不写盘。
   */
  async appendFromSeq(
    baseSeq: number,
    inputs: AppendInput[],
    options: { cursorName?: string; ts?: string } = {},
  ): Promise<AppendFromSeqResult> {
    this.assertOpen();
    const name = options.cursorName ?? 'core';
    if (!Number.isInteger(baseSeq) || baseSeq < 0) {
      throw new StateError('STATE_SEQ_GAP', `baseSeq 必须是 >= 0 的整数：${baseSeq}`, { baseSeq });
    }
    const cursor = this.doc.cursors?.[name] ?? null;
    const baseRevision = this.doc.revision;

    if (baseSeq > baseRevision) {
      throw new StateError('STATE_SEQ_GAP', 'core 领先于 N4：N4 缺历史，必须先补齐再写', {
        baseSeq,
        revision: baseRevision,
        hint: 'core 侧事件未被持久化（例如未 persist 就重启）；从 core 快照重建或人工对账',
      });
    }
    if (cursor && baseSeq < cursor.coreSeq) {
      throw new StateError('STATE_SEQ_GAP', `重复/回退：baseSeq=${baseSeq} < 游标 ${cursor.coreSeq}`, {
        baseSeq,
        cursor: cursor.coreSeq,
        hint: '这批事件已经落过盘；重复提交被拒绝（幂等请用 baseSeq === cursor）',
      });
    }
    if (cursor && baseSeq > cursor.coreSeq) {
      throw new StateError('STATE_SEQ_GAP', `中间缺口：游标 ${cursor.coreSeq} 之后应传 ${cursor.coreSeq}，实际 ${baseSeq}`, {
        baseSeq,
        cursor: cursor.coreSeq,
        hint: 'core 与 journal 之间有事件没落盘；先补该区间',
      });
    }

    const coreSeqAfter = baseSeq + inputs.length;
    if (!inputs.length) {
      // 只有"首次认领游标"或"没有变化"两种情形
      if (cursor && cursor.coreSeq === baseSeq) {
        return {
          baseSeq,
          baseRevision,
          cursorBefore: cursor,
          appended: [],
          revisionAfter: baseRevision,
          cursorAfter: cursor.coreSeq,
          wroteCursor: false,
        };
      }
      const [cursorRecord] = await this.appendBatch([
        {
          kind: 'cursor_aligned',
          payload: { name, baseSeq, coreSeq: baseSeq, revision: baseRevision, at: options.ts ?? '' },
          ts: options.ts,
        },
      ]);
      void cursorRecord;
      return {
        baseSeq,
        baseRevision,
        cursorBefore: cursor,
        appended: [],
        revisionAfter: this.doc.revision,
        cursorAfter: baseSeq,
        wroteCursor: true,
      };
    }

    const records = await this.appendBatch([
      ...inputs,
      {
        kind: 'cursor_aligned',
        payload: {
          name,
          baseSeq,
          coreSeq: coreSeqAfter,
          revision: baseRevision,
          at: options.ts ?? '',
        },
        ts: options.ts,
      },
    ]);
    const cursorRecord = records[records.length - 1];
    return {
      baseSeq,
      baseRevision,
      cursorBefore: cursor,
      appended: records.slice(0, -1),
      revisionAfter: this.doc.revision,
      cursorAfter: coreSeqAfter,
      wroteCursor: true,
      cursor: this.doc.cursors?.[name] ?? {
        name,
        coreSeq: coreSeqAfter,
        revision: cursorRecord.seq,
        at: options.ts ?? '',
      },
    };
  }

  /** 读游标（默认 core）。 */
  cursorOf(name = 'core'): CursorRecord | null {
    return this.doc.cursors?.[name] ?? null;
  }

  /** 认领/推进游标（不追加业务事件），返回是否写盘。 */
  async adoptCursor(coreSeq: number, name = 'core'): Promise<{ changed: boolean; cursor: CursorRecord | null }> {
    const before = this.cursorOf(name);
    if (before && before.coreSeq === coreSeq) return { changed: false, cursor: before };
    const result = await this.appendFromSeq(coreSeq, [], { cursorName: name });
    return { changed: result.wroteCursor, cursor: this.cursorOf(name) };
  }

  /**
   * 写前守卫：读盘上的锁，确认 epoch 仍属于本 writer。
   * 这是"另一进程 takeover 后，旧 writer 的写入必须被拒"的关键检查
   * （本地缓存对象不会自动知道别人抢了锁）。
   */  private async guardWriter(): Promise<void> {
    const raw = await this.fsPort.readText(this.paths.lock);
    if (raw === null) {
      throw new StateError('STATE_LOCKED', '锁文件消失（可能被接管/清理），拒绝写入');
    }
    let holder: { owner?: string; epoch?: number } = {};
    try {
      holder = JSON.parse(raw) as { owner?: string; epoch?: number };
    } catch {
      throw new StateError('STATE_CORRUPT', '锁文件不可解析，拒绝写入', { file: this.paths.lock });
    }
    const myEpoch = this.fence?.token ?? this.journalRef.lock?.epoch ?? 0;
    if (Number(holder.epoch) !== Number(myEpoch)) {
      throw new StateError('STATE_FENCED_OUT', '写锁已被接管（epoch 变化），拒绝写入', {
        heldEpoch: Number(holder.epoch),
        myEpoch,
        holder: String(holder.owner ?? ''),
      });
    }
  }

  /** 心跳：刷新 journal 锁与 fence 有效期。 */
  async heartbeat(): Promise<void> {
    this.assertOpen();
    await this.journalRef.heartbeat();
    const lock = this.journalRef.lock;
    if (lock && this.fence) {
      this.fence = {
        ...this.fence,
        token: lock.epoch,
        expiresAt: new Date(Date.parse(lock.heartbeatAt) + lock.ttlMs).toISOString(),
      };
    }
  }

  /** 显式落快照（CAS）；返回写入结果与新锚。 */
  async snapshot(): Promise<{ write: SnapshotWriteResult | null; meta: SnapshotMeta }> {
    this.assertOpen();
    const records = this.journalRef.records();
    const raw = (await this.fsPort.readText(this.paths.journal)) ?? '';
    const file = buildSnapshot(this.doc, records, raw, nowIso(this.clock()));
    const current = await this.fsPort.versionOf(this.paths.snapshot);
    const sameAnchor =
      current !== null &&
      (await this.fsPort.readText(this.paths.snapshot))?.includes(`"journalHash": "${file.meta.journalHash}"`) === true;
    if (sameAnchor) return { write: null, meta: file.meta };
    const write = await updateSnapshot(this.fsPort, this.paths, file);
    return { write, meta: write.meta };
  }

  /**
   * 检查点：`(seq, graphRevision, stateSha256) + 执行态锚 (sessionId, lastSeq)`。
   * 检查点文件不可变（`createIfAbsent`），重复落同一 seq 幂等返回同名文件。
   */
  async checkpoint(meta: { sessionId?: string | null; lastSeq?: number | null; owner?: string } = {}): Promise<Checkpoint> {
    this.assertOpen();
    await this.fsPort.mkdirp(this.paths.checkpoints);
    const stateSha = sha256Hex(canonicalJson(this.doc as unknown));
    const checkpoint: Checkpoint = {
      checkpointId: `CKPT-${String(this.doc.revision).padStart(6, '0')}-${stateSha.slice(0, 8)}`,
      seq: this.doc.revision,
      revision: this.doc.revision,
      graphRevision: this.doc.graphRevision,
      owner: meta.owner ?? this.journalRef.lock?.owner ?? 'unknown',
      at: nowIso(this.clock()),
      stateSha256: stateSha,
      sessionId: meta.sessionId ?? null,
      lastSeq: meta.lastSeq ?? null,
    };
    const file = `${this.paths.checkpoints}/${checkpoint.checkpointId}.json`;
    const existing = await this.fsPort.readText(file);
    if (existing !== null) return checkpoint;
    const body = `${JSON.stringify({ checkpoint, state: this.doc }, null, 2)}\n`;
    await this.fsPort.writeCas(file, body, { kind: 'createIfAbsent' });
    return checkpoint;
  }

  /**
   * 接管：签发单调 fencing token。
   *   - 无锁 → 直接以 `token` 作为新 epoch 持有；
   *   - 锁未过期 → `STATE_LOCKED`（不抢活写者）；
   *   - 锁已过期 → CAS 抢占（`Journal.stealStaleLock`），旧 writer 的后续写入被 `STATE_FENCED_OUT`/`STATE_LOCKED` 拒绝。
   */
  async takeover(owner: string, ttlMs?: number): Promise<TakeoverResult> {
    this.assertOpen();
    const previousToken = this.fence?.token ?? 0;
    const token = Math.max(previousToken, this.journalRef.lock?.epoch ?? 0, this.clock()) + 1;
    const existingRaw = await this.fsPort.readText(this.paths.lock);
    let mode: TakeoverResult['mode'];

    if (existingRaw === null) {
      const now = this.clock();
      const record = {
        pid: process.pid,
        host: '',
        owner,
        epoch: token,
        startedAt: nowIso(now),
        heartbeatAt: nowIso(now),
        ttlMs: ttlMs ?? 30_000,
      };
      await this.fsPort.writeCas(this.paths.lock, `${canonicalJson(record as unknown as Record<string, unknown>)}\n`, {
        kind: 'createIfAbsent',
      });
      mode = 'acquired';
    } else if (this.journalRef.lock?.owner === owner) {
      mode = 'self';
    } else {
      await this.journalRef.stealStaleLock(token, owner);
      mode = 'stolen';
    }

    const now = this.clock();
    this.fence = {
      token,
      owner,
      issuedAt: nowIso(now),
      expiresAt: new Date(now + (ttlMs ?? 30_000)).toISOString(),
      previousToken,
    };

    // 接管后必须重放：另一个 writer 可能已追加过事件
    const reopened = await openAndRecover({
      dir: this.paths.root,
      fs: this.fsPort,
      owner,
      ttlMs,
      now: this.clock,
      fold: this.foldFn,
    });
    this.doc = reopened.report.state;
    this.recoveryReport = reopened.report;
    return {
      fence: this.fence,
      mode,
      journalStatus: reopened.journal.status(),
      recovery: reopened.report,
    };
  }

  /** 用 fencing token 守卫一次写（供 N2 的 `adapter_state` 类接口使用）。 */
  assertFence(token: number | null | undefined): void {
    if (!this.fence) return;
    if (token == null) throw new StateError('STATE_FENCED_OUT', '写入需要 fencing token');
    if (Number(token) !== this.fence.token) {
      throw new StateError('STATE_FENCED_OUT', `fencing token 不匹配：${token} != ${this.fence.token}`, {
        supplied: Number(token),
        held: this.fence.token,
      });
    }
    if (Date.parse(this.fence.expiresAt) <= this.clock()) {
      throw new StateError('STATE_FENCED_OUT', 'fencing 租约已过期', { expiresAt: this.fence.expiresAt });
    }
  }

  /** 全量重放对齐检查：`fold(records) == 内存状态`。 */
  verify(): { ok: boolean; replayedSha: string; memorySha: string } {
    const replayed = this.foldFn(this.journalRef.records());
    const replayedSha = sha256Hex(canonicalJson(replayed as unknown));
    const memorySha = sha256Hex(canonicalJson(this.doc as unknown));
    return { ok: replayedSha === memorySha, replayedSha, memorySha };
  }

  async close(options: { snapshot?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    if (options.snapshot !== false && this.journalRef.records().length) await this.snapshot();
    await this.journalRef.release();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new StateError('STATE_NOT_OPEN', 'Store 已关闭');
  }
}

export function newCheckpointId(): string {
  return `CKPT-${randomUUID().slice(0, 8)}`;
}

export { statePaths };
