/**
 * N4 · 单写者 JSONL journal（权威状态日志）
 *
 * 语义（对齐 Python `control_plane/events.py` + 本 lane 的加固项）：
 *   - 只追加；每行一条记录；`seq` 严格 +1；`eventId` = `EVT-%06d`。
 *   - 哈希链：`hash = sha256(canonical({seq,eventId,ts,kind,nodeId,payload,prevHash}))`。
 *     断链 / seq 跳号 / 行不可解析 → fail-closed（不静默修复中间损坏）。
 *   - 单写者：`journal.lock`（createIfAbsent + 心跳 + TTL）；第二写者 `STATE_LOCKED`。
 *     过期锁只能经 `Journal.stealStaleLock()`（CAS 抢占，epoch+1）或 `Store.takeover()`。
 *   - torn tail：崩溃时最后一行可能是半条 JSON —— `open()` 默认截断到最后一条完整记录
 *     （WAL 式尾部修复），并把修复事实写入 `repair` 诊断；中间损坏不截断，直接报错。
 */

import path from 'node:path';
import { hostname } from 'node:os';
import {
  canonicalJson,
  eventIdOf,
  nowIso,
  parseRecordLine,
  recordHashOk,
  sealRecord,
  sha256Hex,
} from './canonical.ts';
import {
  StateError,
  type AppendInput,
  type DirEntry,
  type JournalRecord,
  type LockRecord,
  type StoreOptions,
} from './types.ts';

export interface StatePaths {
  root: string;
  journal: string;
  lock: string;
  snapshot: string;
  checkpoints: string;
  projection: string;
}

export function statePaths(dir: string): StatePaths {
  const root = path.resolve(dir);
  return {
    root,
    journal: path.join(root, 'journal.jsonl'),
    lock: path.join(root, 'journal.lock'),
    snapshot: path.join(root, 'snapshot.json'),
    checkpoints: path.join(root, 'checkpoints'),
    projection: path.join(root, 'projection.json'),
  };
}

export interface JournalStatus {
  seq: number;
  revision: number;
  bytes: number;
  owner: string;
  epoch: number;
  lock: LockRecord | null;
  repair: { truncatedBytes: number; droppedLines: number; at: string } | null;
  records: number;
}

export interface JournalOpenResult {
  journal: Journal;
  repair: { truncatedBytes: number; droppedLines: number; at: string } | null;
  stolen: LockRecord | null;
}

function defaultOwner(): string {
  return `${hostname()}:${process.pid}`;
}

export class Journal {
  readonly paths: StatePaths;
  private readonly fsPort: StoreOptions['fs'];
  private readonly owner: string;
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private readonly readonly: boolean;
  private recordsCache: JournalRecord[] = [];
  private lockRecord: LockRecord | null = null;
  private repairInfo: JournalStatus['repair'] = null;

  private constructor(options: StoreOptions, paths: StatePaths) {
    this.paths = paths;
    this.fsPort = options.fs;
    this.owner = options.owner ?? defaultOwner();
    this.ttlMs = options.ttlMs ?? 30_000;
    this.clock = options.now ?? (() => Date.now());
    this.readonly = options.readonly ?? false;
  }

  static async open(options: StoreOptions & { stealIfStale?: boolean }): Promise<JournalOpenResult> {
    const paths = statePaths(options.dir);
    const journal = new Journal(options, paths);
    await options.fs.mkdirp(paths.root);
    const takeover = await journal.acquireLock(options.stealIfStale === true);
    const repair = options.repairTail === false ? null : await journal.loadAndRepair();
    journal.repairInfo = repair;
    if (takeover) {
      // 记录已经在队列尾：先加载再留痕，保证 prevHash 正确
      await journal.append({
        kind: 'writer_taken_over',
        payload: {
          fromOwner: takeover.previous.owner,
          fromEpoch: takeover.previous.epoch,
          fromHeartbeatAt: takeover.previous.heartbeatAt,
          toOwner: takeover.lock.owner,
          epoch: takeover.lock.epoch,
          reason: 'open-takeover',
          at: takeover.lock.startedAt,
        },
      });
    }
    return { journal, repair, stolen: takeover ? takeover.lock : null };
  }

  get ownerId(): string {
    return this.owner;
  }

  get lock(): LockRecord | null {
    return this.lockRecord;
  }

  records(): JournalRecord[] {
    return this.recordsCache;
  }

  last(): JournalRecord | null {
    return this.recordsCache.length ? this.recordsCache[this.recordsCache.length - 1] : null;
  }

  get seq(): number {
    return this.last()?.seq ?? 0;
  }

  get revision(): number {
    return this.seq;
  }

  status(): JournalStatus {
    return {
      seq: this.seq,
      revision: this.revision,
      bytes: this.recordsCache.reduce((sum, record) => sum + JSON.stringify(record).length + 1, 0),
      owner: this.owner,
      epoch: this.lockRecord?.epoch ?? 0,
      lock: this.lockRecord,
      repair: this.repairInfo,
      records: this.recordsCache.length,
    };
  }

  /** 追加一条记录（单写者、fsync）。返回被 seal 的记录。 */
  async append(input: AppendInput): Promise<JournalRecord> {
    const [record] = await this.appendBatch([input]);
    return record;
  }

  /** 批量追加：一次 write + 一次 fsync，行序即 seq 序。 */
  async appendBatch(inputs: AppendInput[]): Promise<JournalRecord[]> {
    if (this.readonly) throw new StateError('STATE_READONLY', 'journal 以只读模式打开，拒绝追加');
    if (!inputs.length) return [];
    this.assertWriter();
    const out: JournalRecord[] = [];
    let prevHash = this.last()?.hash ?? '';
    let seq = this.seq;
    const lines: string[] = [];
    for (const input of inputs) {
      if (!input.kind) throw new StateError('STATE_CORRUPT', '事件 kind 不能为空');
      if (input.fencingToken != null && this.lockRecord && input.fencingToken < this.lockRecord.epoch) {
        throw new StateError('STATE_FENCED_OUT', `写入被 fencing 拒绝：token=${input.fencingToken} < epoch=${this.lockRecord.epoch}`, {
          token: input.fencingToken,
          epoch: this.lockRecord.epoch,
        });
      }
      seq += 1;
      const record = sealRecord({
        seq,
        eventId: eventIdOf(seq),
        ts: input.ts ?? nowIso(this.clock()),
        kind: input.kind,
        nodeId: input.nodeId ?? null,
        payload: input.payload ?? {},
        prevHash,
      });
      prevHash = record.hash;
      lines.push(`${canonicalJson(record)}\n`);
      out.push(record);
    }
    await this.fsPort.append(this.paths.journal, lines.join(''));
    this.recordsCache.push(...out);
    return out;
  }

  /** 校验整条链：seq 连续 / prevHash 连接 / 单条哈希自洽。 */
  verifyChain(): void {
    let prev: JournalRecord | null = null;
    for (const record of this.recordsCache) {
      if (!recordHashOk(record)) {
        throw new StateError('STATE_HASH_BREAK', `记录哈希不自洽：seq=${record.seq}`, {
          seq: record.seq,
          eventId: record.eventId,
        });
      }
      if (prev === null) {
        if (record.seq !== 1 || record.prevHash !== '') {
          throw new StateError('STATE_SEQ_GAP', `首条记录必须是 seq=1 且 prevHash=""：seq=${record.seq}`, {
            seq: record.seq,
          });
        }
      } else {
        if (record.seq !== prev.seq + 1) {
          throw new StateError('STATE_SEQ_GAP', `seq 不连续：${prev.seq} → ${record.seq}`, {
            prev: prev.seq,
            current: record.seq,
          });
        }
        if (record.prevHash !== prev.hash) {
          throw new StateError('STATE_HASH_BREAK', `哈希链断开：seq=${record.seq}`, {
            seq: record.seq,
            expected: prev.hash,
            actual: record.prevHash,
          });
        }
      }
      prev = record;
    }
  }

  /** 心跳：刷新锁的 `heartbeatAt`（CAS，防与抢占者互相覆盖）。 */
  async heartbeat(): Promise<void> {
    if (!this.lockRecord) throw new StateError('STATE_NOT_OPEN', '未持有锁，无法心跳');
    const version = await this.fsPort.versionOf(this.paths.lock);
    const next: LockRecord = { ...this.lockRecord, heartbeatAt: nowIso(this.clock()) };
    await this.fsPort.writeCas(
      this.paths.lock,
      `${canonicalJson(next as unknown as Record<string, unknown>)}\n`,
      version === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version },
    );
    this.lockRecord = next;
  }

  /** 释放锁（正常关闭）。只在"盘上锁仍属于本 writer 同一 epoch"时删除，避免误删接管者的锁。 */
  async release(): Promise<void> {
    if (!this.lockRecord) return;
    if (this.lockRecord.owner !== this.currentOwner()) return;
    const raw = await this.fsPort.readText(this.paths.lock);
    if (raw !== null) {
      try {
        const holder = JSON.parse(raw) as LockRecord;
        if (Number(holder.epoch) !== Number(this.lockRecord.epoch) || holder.owner !== this.lockRecord.owner) {
          this.lockRecord = null;
          return; // 已被接管：不删别人的锁
        }
      } catch {
        this.lockRecord = null;
        return;
      }
    }
    await this.fsPort.remove(this.paths.lock);
    this.lockRecord = null;
  }

  /**
   * 抢占过期锁（显式接管路径）。要求：
   *   - 现有锁确实过期（`heartbeatAt + ttl <= now`），否则 `STATE_LOCKED`；
   *   - 调用方提供 `fencingToken`，且 `token > 现有 epoch`，否则 `STATE_FENCED_OUT`；
   *   - CAS 替换锁（版本不匹配说明别人先抢到）→ `STATE_LOCKED`。
   * 成功后返回新锁（epoch = token）。
   */
  async stealStaleLock(fencingToken: number, owner = this.owner): Promise<LockRecord> {
    const raw = await this.fsPort.readText(this.paths.lock);
    if (raw === null) throw new StateError('STATE_LOCKED', '锁不存在，无需抢占');
    const current = JSON.parse(raw) as LockRecord;
    const now = this.clock();
    if (Date.parse(current.heartbeatAt) + current.ttlMs > now) {
      throw new StateError('STATE_LOCKED', `锁未过期，拒绝抢占：${current.owner}`, {
        owner: current.owner,
        heartbeatAt: current.heartbeatAt,
        ttlMs: current.ttlMs,
      });
    }
    if (!(fencingToken > current.epoch)) {
      throw new StateError('STATE_FENCED_OUT', `fencing token 必须单调大于当前 epoch：${fencingToken} <= ${current.epoch}`, {
        token: fencingToken,
        epoch: current.epoch,
      });
    }
    const next: LockRecord = {
      pid: process.pid,
      host: hostname(),
      owner,
      epoch: fencingToken,
      startedAt: nowIso(now),
      heartbeatAt: nowIso(now),
      ttlMs: this.ttlMs,
    };
    const version = await this.fsPort.versionOf(this.paths.lock);
    try {
      await this.fsPort.writeCas(this.paths.lock, `${canonicalJson(next as unknown as Record<string, unknown>)}\n`, {
        kind: 'replaceIfVersion',
        version: version as string,
      });
    } catch (error) {
      if (error instanceof StateError && error.code === 'STATE_STALE_VERSION') {
        throw new StateError('STATE_LOCKED', '抢占竞争失败：锁已被他人更新', { file: this.paths.lock });
      }
      throw error;
    }
    this.lockRecord = next;
    this.ownerOverride(owner);
    await this.append({
      kind: 'writer_taken_over',
      payload: {
        fromOwner: current.owner,
        toOwner: owner,
        fromEpoch: current.epoch,
        epoch: fencingToken,
        at: nowIso(now),
      },
    });
    return next;
  }

  private ownerValue = '';

  private ownerOverride(owner: string): void {
    this.ownerValue = owner;
  }

  private currentOwner(): string {
    return this.ownerValue || this.owner;
  }

  /** 单写者断言：当前锁必须属于本 writer。 */
  private assertWriter(): void {
    if (!this.lockRecord) throw new StateError('STATE_NOT_OPEN', '未持有锁，拒绝写入');
    if (this.lockRecord.owner !== this.currentOwner()) {
      throw new StateError('STATE_FENCED_OUT', `锁已易主：holder=${this.lockRecord.owner}`, {
        holder: this.lockRecord.owner,
        self: this.currentOwner(),
      });
    }
    if (Date.parse(this.lockRecord.heartbeatAt) + this.lockRecord.ttlMs <= this.clock()) {
      throw new StateError('STATE_LOCKED', '本 writer 的锁已过期（疑似被抢占），拒绝写入', {
        heartbeatAt: this.lockRecord.heartbeatAt,
        ttlMs: this.lockRecord.ttlMs,
      });
    }
  }

  private async acquireLock(
    stealIfStale: boolean,
  ): Promise<{ lock: LockRecord; previous: LockRecord } | null> {
    const raw = await this.fsPort.readText(this.paths.lock);
    if (raw === null) {
      const now = this.clock();
      const record: LockRecord = {
        pid: process.pid,
        host: hostname(),
        owner: this.owner,
        epoch: 1,
        startedAt: nowIso(now),
        heartbeatAt: nowIso(now),
        ttlMs: this.ttlMs,
      };
      try {
        await this.fsPort.writeCas(
          this.paths.lock,
          `${canonicalJson(record as unknown as Record<string, unknown>)}\n`,
          { kind: 'createIfAbsent' },
        );
      } catch (error) {
        if (error instanceof StateError && error.code === 'STATE_STALE_VERSION') {
          throw new StateError('STATE_LOCKED', '锁竞争失败：已被并发写者创建', { file: this.paths.lock });
        }
        throw error;
      }
      this.lockRecord = record;
      this.ownerValue = this.owner;
      return null;
    }
    const current = JSON.parse(raw) as LockRecord;
    if (current.owner === this.owner && current.pid === process.pid) {
      // 同进程重入：续活心跳即可（崩溃恢复后由 recovery 决定是否信任）。
      this.lockRecord = { ...current, heartbeatAt: nowIso(this.clock()) };
      await this.fsPort.writeCas(
        this.paths.lock,
        `${canonicalJson(this.lockRecord as unknown as Record<string, unknown>)}\n`,
        { kind: 'replaceIfVersion', version: (await this.fsPort.versionOf(this.paths.lock)) as string },
      );
      return null;
    }

    const now = this.clock();
    const stale = Date.parse(current.heartbeatAt) + current.ttlMs <= now;
    if (stale && stealIfStale) {
      const next: LockRecord = {
        pid: process.pid,
        host: hostname(),
        owner: this.owner,
        epoch: current.epoch + 1,
        startedAt: nowIso(now),
        heartbeatAt: nowIso(now),
        ttlMs: this.ttlMs,
      };
      const version = await this.fsPort.versionOf(this.paths.lock);
      try {
        await this.fsPort.writeCas(
          this.paths.lock,
          `${canonicalJson(next as unknown as Record<string, unknown>)}\n`,
          { kind: 'replaceIfVersion', version: version as string },
        );
      } catch (error) {
        if (error instanceof StateError && error.code === 'STATE_STALE_VERSION') {
          throw new StateError('STATE_LOCKED', '抢占竞争失败：锁已被他人更新', { file: this.paths.lock });
        }
        throw error;
      }
      this.lockRecord = next;
      this.ownerValue = this.owner;
      return { lock: next, previous: current };
    }

    throw new StateError('STATE_LOCKED', `已有写者持有锁：${current.owner}`, {
      owner: current.owner,
      pid: current.pid,
      heartbeatAt: current.heartbeatAt,
      ttlMs: current.ttlMs,
      stale,
      hint: '过期后走 Store.open({takeover:true}) / Journal.stealStaleLock(token)',
    });
  }

  /** 读全量 + 尾部修复。只截断"末尾不完整的那一行"，中间损坏直接失败。 */
  private async loadAndRepair(): Promise<JournalStatus['repair']> {
    const text = (await this.fsPort.readText(this.paths.journal)) ?? '';
    const records: JournalRecord[] = [];
    let consumedBytes = 0;
    let droppedLines = 0;

    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const isLast = index === lines.length - 1;
      if (isLast && line === '') break; // 文件以换行结尾
      const record = parseRecordLine(line);
      if (record === null) {
        if (isLast) {
          // torn tail：末行不完整，截掉
          droppedLines += 1;
          await this.fsPort.truncate(this.paths.journal, consumedBytes);
          break;
        }
        throw new StateError('STATE_CORRUPT', `journal 中间行不可解析（line ${index + 1}）`, {
          line: index + 1,
          bytes: consumedBytes,
          hint: '中间损坏不做自动修复；需人工比对 snapshot 或从备份恢复',
        });
      }
      records.push(record);
      consumedBytes += Buffer.byteLength(line, 'utf8') + 1;
    }

    this.recordsCache = records;
    this.verifyChain();
    const truncatedBytes = Buffer.byteLength(text.slice(consumedBytes), 'utf8');
    if (droppedLines === 0) return null;
    return { truncatedBytes, droppedLines, at: nowIso(this.clock()) };
  }
}

export async function listCheckpointFiles(fsPort: StoreOptions['fs'], paths: StatePaths): Promise<DirEntry[]> {
  const entries = await fsPort.listDir(paths.checkpoints);
  return entries.filter((entry) => entry.type === 'file' && entry.name.endsWith('.json'));
}

export function journalFingerprint(records: JournalRecord[]): string {
  return sha256Hex(records.map((record) => canonicalJson(record)).join('\n'));
}
