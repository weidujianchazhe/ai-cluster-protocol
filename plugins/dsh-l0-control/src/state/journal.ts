/**
 * N4 · 单写者 JSONL journal（权威状态日志）
 *
 * 语义（对齐 Python 早期原型的事件定义 + 本模块 的加固项）：
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

/**
 * 分段命名：已封存段 `journal.0001.jsonl`、`journal.0002.jsonl`…
 *
 * **活动段永远是 `journal.jsonl`**（不带段号）。这个选择是为了 fail-closed：
 * 老版本只认 `journal.jsonl`，滚动后它看到的是**从中间开始**的 seq（不是 1），
 * `verifyChain()` 会直接报 `STATE_SEQ_GAP` —— 响亮地失败。
 * 反过来若让活动段带段号、`journal.jsonl` 变成第一段，老版本只会读到**一个合法前缀**，
 * 于是安静地少看一半历史——那是本仓最不能接受的一种"看起来正常"。
 */
export const SEGMENT_PREFIX = 'journal.';
export const SEGMENT_SUFFIX = '.jsonl';

/** 段文件名（`index` 从 1 起）。 */
export function segmentName(index: number): string {
  return `${SEGMENT_PREFIX}${String(index).padStart(4, '0')}${SEGMENT_SUFFIX}`;
}

/** 从目录条目里挑出已封存段并按段号升序返回 `{index, name}`。 */
export function sealedSegments(entries: DirEntry[]): Array<{ index: number; name: string }> {
  const out: Array<{ index: number; name: string }> = [];
  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    if (!entry.name.startsWith(SEGMENT_PREFIX) || !entry.name.endsWith(SEGMENT_SUFFIX)) continue;
    const middle = entry.name.slice(SEGMENT_PREFIX.length, entry.name.length - SEGMENT_SUFFIX.length);
    if (!/^\d{4,}$/.test(middle)) continue;
    const index = Number(middle);
    if (!Number.isSafeInteger(index) || index < 1) continue;
    out.push({ index, name: entry.name });
  }
  return out.sort((a, b) => a.index - b.index);
}

export const DEFAULT_SEGMENT_MAX_BYTES = 64 * 1024 * 1024;

export interface JournalStatus {
  seq: number;
  revision: number;
  bytes: number;
  owner: string;
  epoch: number;
  lock: LockRecord | null;
  repair: { truncatedBytes: number; droppedLines: number; at: string } | null;
  records: number;
  /** 已封存段数（不含活动段）；0 表示还没滚动过（与旧版本完全一致）。 */
  sealedSegments: number;
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
  /**
   * 已落盘字节数的**增量**计数（与 `recordsCache` 同步推进）。
   *
   * 为什么不能现算：`status().bytes` 原来是
   * `recordsCache.reduce((sum, r) => sum + JSON.stringify(r).length + 1, 0)`
   * ——为了报一个数字，把每条记录都序列化一遍。20 万条实测 **280 ms**，
   * 而 `recoverWithJournal()` 返回报告时就要调一次 `journal.status()`，
   * 也就是说**每次冷启动都付这笔钱，只为填一个诊断字段**。
   *
   * 增量维护的代价是 0：记录压入缓存时顺手累加它序列化后的字节数。
   * 两者必须同步——`pushRecords` 是唯一入口，在那里加既不会漏也不会重复。
   */
  private bytesCache = 0;
  /**
   * 打开时读到的 journal 原文（不含被截掉的 torn tail）；追加后置为 `null`（见 `appendBatch`）。
   *
   * 为什么留这一份：`recoverWithJournal()` 需要整文件原文来算锚点（`checkAnchor`
   * 比对前缀 sha256、`buildSnapshot` 算 `journalBytes`/`journalHash`）。原实现
   * 每次调用都 `fs.readText(paths.journal)` 重读一遍，10 万节点 / 100.7 MB 时
   * **一次恢复读 3 遍全文**（约 1.1 s，另有 200 MB 临时字符串）。
   * `loadAndRepair()` 刚读过同一份内容，留着它，后面都复用。
   *
   * 为什么追加时要丢弃而不是拼接：拼接是 O(长度)。每 tick 追加一行就复制一遍全文，
   * 100 MB 的 journal 跑 1000 次追加就是 100 GB 的内存拷贝——比每次重读还糟。
   * 丢弃后下次需要时重读一次（O(n)），总代价回到 O(n) 而不是 O(n²)。
   */
  private rawTextCache: string | null = null;

  /** 单段滚动阈值（0 = 不滚动）。见 `StoreOptions.segmentMaxBytes`。 */
  private readonly segmentMaxBytes: number;

  private constructor(options: StoreOptions, paths: StatePaths) {
    this.paths = paths;
    this.fsPort = options.fs;
    this.owner = options.owner ?? defaultOwner();
    this.ttlMs = options.ttlMs ?? 30_000;
    this.clock = options.now ?? (() => Date.now());
    this.readonly = options.readonly ?? false;
    const seg = Number(options.segmentMaxBytes);
    this.segmentMaxBytes = Number.isFinite(seg) && seg > 0 ? Math.floor(seg) : DEFAULT_SEGMENT_MAX_BYTES;
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

  /**
   * journal 原文（已加载 + 本次进程追加后的最新字节）。
   *
   * 有缓存就返回缓存；缓存被一次追加作废时就重读一次盘。调用方不必关心缓存状态，
   * 也不需要自己做 `readText`。**不要**拿它当业务数据源（业务数据是 `records()`）。
   */
  async rawText(): Promise<string> {
    if (this.rawTextCache !== null) return this.rawTextCache;
    // **必须跨段**：锚点（`journalBytes` / `journalHash`）比的是「逻辑全文」，
    // 只读活动段会让锚点在滚动之后恒不匹配——那就是一次假的分歧告警。
    const { text } = await this.readAllSegments();
    this.rawTextCache = text;
    return text;
  }

  /** 是否有无需读盘即可返回的原文缓存（诊断/测试用）。 */
  hasRawText(): boolean {
    return this.rawTextCache !== null;
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
      bytes: this.bytesCache,
      owner: this.owner,
      epoch: this.lockRecord?.epoch ?? 0,
      lock: this.lockRecord,
      sealedSegments: this.sealedCount,
      repair: this.repairInfo,
      records: this.recordsCache.length,
    };
  }

  /**
   * 把当前活动段 `journal.jsonl` 封存为 `journal.NNNN.jsonl`（下一个段号），
   * 之后活动段从空文件重新开始。
   *
   * 为什么用 rename 而不是「复制 + 清空」：rename 是原子的，崩溃点只有"改名前/改名后"
   * 两种；而「复制 + 清空」在中间崩溃会**同时**留下完整旧文件与半清空的新文件。
   *
   * 段号取"现有最大段号 + 1"。若改名成功后新活动段还没建就崩溃，目录里只有已封存段、
   * 没有 `journal.jsonl` —— 下次 `journalSegments()` 仍能按段序读全，只是没有活动段，
   * 第一次 append 会重新创建它（`append` 是 open('a')，文件不存在即创建）。
   */
  private async sealActiveSegment(): Promise<void> {
    const entries = await this.fsPort.listDir(this.paths.root);
    const sealed = sealedSegments(entries);
    const nextIndex = (sealed.length ? sealed[sealed.length - 1].index : 0) + 1;
    const target = path.join(this.paths.root, segmentName(nextIndex));
    await this.fsPort.rename(this.paths.journal, target);
    this.sealedCount = sealed.length + 1;
    this.activeBytes = 0;
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
    await this.ensureWriter();
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
    // ── 滚动：活动段写不下这一批时先封存它 ────────────────────────────────
    // 判据用**本批字节 + 活动段当前字节 > 阈值**。一批本身超过阈值也允许（否则
    // 大批量持久化会永远写不进去），只是写完立刻在下一批前封存。
    const chunk = lines.join('');
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    if (this.segmentMaxBytes > 0 && this.activeBytes > 0 && this.activeBytes + chunkBytes > this.segmentMaxBytes) {
      await this.sealActiveSegment();
    }
    await this.fsPort.append(this.paths.journal, chunk);
    this.activeBytes += chunkBytes;
    this.pushRecords(out);
    // 原文缓存作废（不是拼接）：拼接是 O(全文长度)，每 tick 一次会把追加变成 O(n²)。
    // 作废后下一次 `rawText()` 重读一次盘，仍是 O(n)。
    this.rawTextCache = null;
    return out;
  }

  /**
   * 把刚落盘的记录挂进缓存（**不用 `push(...records)`**）。
   *
   * 为什么不能用展开：`arr.push(...many)` 走的是**函数实参**路径，实参数量受
   * 引擎栈大小限制。实测（Node v24.9.0）：12 万条成功、12.5 万条抛
   * `RangeError: Maximum call stack size exceeded`。而 `appendBatch` 的批量
   * 恰恰可能是十万级——`persistCoreEvents` 一次就把 core 的全部新增事件交过来，
   * 10 万节点建图时一次约 20 万条。
   *
   * 后果比抛错本身严重得多：抛出点在**磁盘写入之后**。于是盘上已经有 20 万行，
   * 内存缓存仍是空的，`Store.appendBatch()` 的折叠循环根本没跑到，
   * `doc.revision` 停在旧值、游标也没推进。下一次打开会把这些事件当成新事件，
   * 而当前进程继续以「盘上有、内存里没有」的状态工作——同一份 journal 对两个
   * 读者给出两套状态。这是整轮里最该修的一条：它不是慢，是错。
   *
   * 用「预分配 + 下标赋值」而不是逐条 `push()`：同样 20 万条实测 2.17 ms，
   * 逐条 push 7.59 ms，分块展开 3.68 ms。下标赋值既最快又完全不碰实参栈。
   */
  private pushRecords(records: JournalRecord[]): void {
    if (!records.length) return;
    const base = this.recordsCache.length;
    this.recordsCache.length = base + records.length;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      this.recordsCache[base + index] = record;
      // 与缓存同步推进：`status().bytes` 的数值必须等于「这些记录序列化后的字节数」。
      // 用 `JSON.stringify` 的长度（不是 `canonicalJson`）：`status().bytes` 的历史口径
      // 就是前者，换成后者会让同一个字段在重构前后报出不同的数。
      this.bytesCache += JSON.stringify(record).length + 1;
    }
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

  /** 单写者断言（同步快路）：锁必须属于本 writer 且未过期。 */
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

  /**
   * 写入前的写者校验（异步）：内存判定过期后**先看盘上的锁到底是谁的**，再决定。
   *
   * 为什么不能一过期就拒：锁有 TTL，而有些合法操作本身耗时超过 TTL ——
   * 典型是 `open()`：`acquireLock()` 拿到新锁（heartbeatAt=now）之后还要
   * `loadAndRepair()` 把整条 journal 读出来并逐条校验哈希链，几百毫秒到
   * 几秒都可能。这段时间里**没有任何人抢占**，但内存里的 heartbeatAt
   * 已经超时，接着写就被自己的 TTL 拦死，报「疑似被抢占」。
   *
   * 这在短 TTL 下必现（演练用 ttlMs=800，open 期间就过期），长 TTL 下则是
   * 低频偶发（大 journal 的冷启动）。两种都是假警报。
   *
   * 正确的语义是租约系统的标准做法：
   *  - 盘上的锁仍是**本 writer 同一 epoch** → 没人抢，续租后继续写；
   *  - 盘上的锁已换人 / epoch 更高 → 真的被接管了，抛 `STATE_FENCED_OUT`；
   *  - 锁文件消失 → 抛 `STATE_LOCKED`。
   *
   * 续租用 CAS：与真正的抢占者竞争时只有一方能赢，输的那方拿不到锁。
   */
  private async ensureWriter(): Promise<void> {
    if (!this.lockRecord) throw new StateError('STATE_NOT_OPEN', '未持有锁，拒绝写入');
    if (this.lockRecord.owner !== this.currentOwner()) {
      throw new StateError('STATE_FENCED_OUT', `锁已易主：holder=${this.lockRecord.owner}`, {
        holder: this.lockRecord.owner,
        self: this.currentOwner(),
      });
    }
    const fresh = Date.parse(this.lockRecord.heartbeatAt) + this.lockRecord.ttlMs > this.clock();
    if (fresh) return;

    const raw = await this.fsPort.readText(this.paths.lock);
    if (raw === null) {
      throw new StateError('STATE_LOCKED', '锁文件已消失，拒绝写入', { file: this.paths.lock });
    }
    let onDisk: LockRecord;
    try {
      onDisk = JSON.parse(raw) as LockRecord;
    } catch {
      throw new StateError('STATE_CORRUPT', '锁文件不可解析，拒绝写入', { file: this.paths.lock });
    }
    if (onDisk.owner !== this.currentOwner() || Number(onDisk.epoch) !== Number(this.lockRecord.epoch)) {
      throw new StateError('STATE_FENCED_OUT', '锁已被他人接管，拒绝写入', {
        holder: onDisk.owner,
        holderEpoch: Number(onDisk.epoch),
        self: this.currentOwner(),
        selfEpoch: Number(this.lockRecord.epoch),
      });
    }
    const version = await this.fsPort.versionOf(this.paths.lock);
    const next: LockRecord = { ...onDisk, heartbeatAt: nowIso(this.clock()) };
    try {
      await this.fsPort.writeCas(
        this.paths.lock,
        `${canonicalJson(next as unknown as Record<string, unknown>)}\n`,
        version === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version },
      );
    } catch (error) {
      if (error instanceof StateError && error.code === 'STATE_STALE_VERSION') {
        throw new StateError('STATE_LOCKED', '续租竞争失败：锁已被他人更新', { file: this.paths.lock });
      }
      throw error;
    }
    this.lockRecord = next;
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
  /**
   * 按顺序列出**所有**段：已封存段（段号升序）+ 活动段 `journal.jsonl`。
   *
   * 返回空数组表示目录里还没有任何 journal（全新工作区）。
   */
  private async journalSegments(): Promise<string[]> {
    const entries = await this.fsPort.listDir(this.paths.root);
    const sealed = sealedSegments(entries).map((row) => path.join(this.paths.root, row.name));
    // 活动段的存在性用 `stat` 判，**不依赖目录列举**：`listDir` 的实现细节（路径分隔符、
    // 端口是否实现该能力）不该决定「读不读得到活动段」。漏掉活动段 = 读到一半历史。
    const activeStat = await this.fsPort.stat(this.paths.journal);
    const active = activeStat ? [this.paths.journal] : [];
    // 活动段**排在最后**：它的 seq 一定大于所有已封存段。
    return [...sealed, ...active];
  }

  /** 已封存段数（诊断用；不读盘时按缓存值）。 */
  private sealedCount = 0;

  /** 当前活动段的字节数（滚动判定用；等于 `bytesCache` 减去已封存段字节）。 */
  private activeBytes = 0;

  /**
   * 把所有段按顺序读出来，拼成一份「逻辑全文」。
   *
   * 单段时等价于旧的 `readText(paths.journal)`；多段时是段间直接拼接——
   * 每段都以换行结尾（写入侧保证），所以拼接不会粘行。
   */
  private async readAllSegments(): Promise<{ text: string; segments: string[]; sealedBytes: number }> {
    const segments = await this.journalSegments();
    if (!segments.length) return { text: '', segments, sealedBytes: 0 };
    let text = '';
    let sealedBytes = 0;
    for (let index = 0; index < segments.length; index += 1) {
      const chunk = (await this.fsPort.readText(segments[index])) ?? '';
      text += chunk;
      if (index < segments.length - 1) sealedBytes += Buffer.byteLength(chunk, 'utf8');
    }
    return { text, segments, sealedBytes };
  }

  private async loadAndRepair(): Promise<JournalStatus['repair']> {
    const { text, segments, sealedBytes } = await this.readAllSegments();
    const records: JournalRecord[] = [];
    let consumedBytes = 0;
    let droppedLines = 0;
    this.sealedCount = Math.max(0, segments.length - 1);
    this.activeBytes = Math.max(0, Buffer.byteLength(text, 'utf8') - sealedBytes);
    // 只有**活动段**允许有 torn tail。已封存段是 rename 过来的完整文件，出现不可解析行
    // 说明中间损坏（或有人改过），必须 fail-closed 而不是悄悄截掉别人一半历史。
    const activeStart = sealedBytes;

    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const isLast = index === lines.length - 1;
      if (isLast && line === '') break; // 文件以换行结尾
      const isInActive = consumedBytes >= activeStart;
      const record = parseRecordLine(line);
      if (record === null) {
        if (isLast && isInActive) {
          // torn tail：末行不完整，截掉（只动活动段，且按活动段内偏移截）
          droppedLines += 1;
          await this.fsPort.truncate(this.paths.journal, consumedBytes - activeStart);
          this.activeBytes = consumedBytes - activeStart;
          break;
        }
        throw new StateError('STATE_CORRUPT', `journal 中间行不可解析（line ${index + 1}）`, {
          line: index + 1,
          bytes: consumedBytes,
          inActiveSegment: isInActive,
          hint: isInActive
            ? '中间损坏不做自动修复；需人工比对 snapshot 或从备份恢复'
            : '损坏发生在**已封存段**：该段被 rename 封存后本应保持不变，出现坏行意味着被外部改过，拒绝截断',
        });
      }
      records.push(record);
      consumedBytes += Buffer.byteLength(line, 'utf8') + 1;
    }

    // 字节数直接复用本循环已算出的 `consumedBytes`（就是这些行在盘上的真实字节数），
    // 不需要再过一遍 `JSON.stringify`。torn tail 被截掉时 `consumedBytes` 恰好停在
    // 最后一条完整记录之后，所以它和 `records` 严格对应。
    this.recordsCache = records;
    this.bytesCache = consumedBytes;
    // 原文也留着：截断后的那一段才是 journal 真正有效的字节，
    // 后续锚点比对/快照构建都用它，不必再读盘（更不能用含 torn tail 的 text）。
    this.rawTextCache = consumedBytes === text.length ? text : text.slice(0, consumedBytes);
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
