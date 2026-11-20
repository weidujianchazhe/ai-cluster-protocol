/**
 * core ↔ state 桥：把 N3 的 core 图状态挂到 N4 的持久 journal 上。
 *
 * 为什么需要独立模块：两侧的 `Store` 不是同一个类
 *   - N3 `core/store.ts`：`new Store({clock?, journal?, state?})`，持图状态 + 内存 journal；
 *   - N4 `state/store.ts`：构造函数私有，只能 `Store.open({dir, fs, ...})`，负责 append-only journal、
 *     锁、快照、恢复报告。
 * 桥由 N4 提供：`restoreCoreJournal(stateStore, coreJournal)` 把持久记录回灌进 core；
 * `persistCoreEvents(stateStore, events)` 把 core 的新事件写盘（一次 write + 一次 fsync）。
 *
 * 顺序（Lead 定的四步）：openAndRecover(Store.open) → new CoreStore → restoreCoreJournal → configureCore。
 */
import { Store as CoreStore, foldEvents, rehydrate } from './core/index.js';
import { Store as StateStore } from './state/store.js';
import { MemoryFsPort, NodeFsPort } from './state/fs-port.js';
import { journalFingerprint } from './state/journal.js';
import { persistCoreEvents, restoreCoreJournal } from './state/bridge.js';

                                                

                                     
              
                         
                 
                 
                                               
                  
                 
                     
     
                                                     
    
                                                
                                                        
                                         
                                                   
              
    
                                             
                                             
                               
     
                           
     
                                           
    
                                                           
                                                                    
                                             
     
                           
 

                                      
                        
              
                   
                      
                  
                   
                                                                                           
                     
                   
                      
                      
                       
                                                         
                          
                                                                                            
 

function errorInfo(error         ) {
  const err = error                                                                  ;
  return { name: err?.name ?? 'Error', code: err?.code ?? null, message: String(err?.message || error) };
}

export class CorePersistence {
           mode                 ;
           dir        ;
                   state            ;
                   core           ;
                   restored        ;
                   restoredCounts                                                                          ;
                   restoreMeta                                                                    ;
          persistedSeq        ;
          lastError                                                  = null;
          lastGapAt                = null;
          closed = false;
          heartbeatTimer                                        = null;
          lastHeartbeatError                                                  = null;

          constructor(
    mode                 ,
    dir        ,
    state            ,
    core           ,
    restored        ,
    restoredCounts                                                                           = null,
    restoreMeta                                                                     = { adopted: false, coreSeq: null },
  ) {
    this.mode = mode;
    this.dir = dir;
    this.state = state;
    this.core = core;
    this.restored = restored;
    this.restoredCounts = restoredCounts;
    this.restoreMeta = restoreMeta;
    // 恢复后 core seq 的基准以 N4 游标为准（N4-R6：cursorOf('core').coreSeq）
    this.persistedSeq = Number(restoreMeta.coreSeq ?? core.journal.count());
  }

  static async open(options                    )                           {
    const mode                  = options.mode ?? 'memory';
    const fs = mode === 'node' ? new NodeFsPort() : new MemoryFsPort();
    const opened = await StateStore.open({
      dir: options.dir,
      fs,
      ...(options.owner ? { owner: options.owner } : {}),
      ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}),
      // N4 锁等待：open 时若锁被占，最多等 waitMs 再判定（避免换代竞态直接 STATE_LOCKED）
      waitMs: Number(options.waitMs ?? 5000)         ,
      ...(Number(options.segmentMaxBytes) > 0 ? { segmentMaxBytes: Number(options.segmentMaxBytes) } : {}),
      retryBaseMs: 25         ,
      retryMaxMs: 500         ,
      takeover: options.takeover === true,
    }         );
    const core = new CoreStore({});
    // 重开路径（N4-R6 之后）：`restoreCoreJournal` 变 async，负责「回灌 + 认领游标写盘」，
    // 返回 {restored, coreSeq, revisionBefore, revision, cursor, adopted}；
    // 再 `rehydrate(core)` 把 state 折回来（只回灌不折会出现 records=N 但 counts={0,0,0,0}）。
    // N4 最终口径：`restoreCoreJournal(store, core.journal)`（renumber 默认 true —— 回灌稀疏 seq 重编号，
    // 这是"恢复后基准错位"的根因修复），再 `rehydrate(core)` 把 state 折回来。
    let restored = 0;
    let adopted = false;
    let coreSeq                = null;
    let renumbered = false;
    let state                                       = null;
    const restoredJournal = await restoreCoreJournal(opened, core.journal);
    restored = Number(restoredJournal?.restored ?? 0);
    adopted = restoredJournal?.adopted === true;
    coreSeq = Number(restoredJournal?.coreSeq ?? 0);
    renumbered = (restoredJournal                            )?.renumbered === true;
    state = rehydrate(core);
    const counts = state
      ? { nodes: state.nodes.size, edges: state.edges.length, evidence: state.evidence.size, gates: state.gates.size }
      : null;
    const instance = new CorePersistence(mode, options.dir, opened, core, restored, counts, {
      adopted,
      coreSeq,
      renumbered,
    });
    // 自动续租：默认按 TTL 的 1/3 起跳（留两轮重试余量）。
    // 显式传 0 可关闭（调用方自己 `heartbeat()`）。
    const autoMs = options.autoHeartbeatMs;
    const ttl = Number(options.ttlMs ?? 0);
    const interval =
      autoMs === 0
        ? 0
        : Number.isFinite(autoMs) && Number(autoMs) > 0
          ? Number(autoMs)
          : ttl > 0
            ? Math.max(50, Math.floor(ttl / 3))
            : 0;
    if (interval > 0) instance.startHeartbeat(interval);
    return instance;
  }

  /**
   * 启动自动续租。`intervalMs` 必须显著小于锁 TTL（这里按 TTL 的 1/3 兜底）。
   *
   * 单个 tick 的失败**不抛出**：续租是尽力而为，失败记录下来由
   * `snapshot().heartbeatError` 透出，真正的写入会被 `assertWriter()` 拦住。
   */
          startHeartbeat(intervalMs        )       {
    this.stopHeartbeat();
    const period = Math.max(50, Math.floor(intervalMs));
    this.heartbeatTimer = setInterval(() => {
      void this.state
        .heartbeat()
        .then(() => {
          this.lastHeartbeatError = null;
        })
        .catch((error         ) => {
          this.lastHeartbeatError = errorInfo(error);
        });
    }, period);
    // 不要因为这个定时器把进程钉住（测试/CLI 用完就走）
    this.heartbeatTimer.unref?.();
  }

          stopHeartbeat()       {
    if (this.heartbeatTimer === null) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /**
   * 主动停止续租（**此后本 writer 会自然失权**）。
   *
   * 两个正当用途：
   *  1. 优雅让位：准备交接给别人时先停续租，不必等满 TTL；
   *  2. 故障演练：`kill -9` 的语义是「进程消失，不再续租」，在同一个进程里
   *     只能靠显式停续租来复现 —— 否则定时器还在跑，锁永远 fresh，
   *     演练的 takeover 会永远等不到 stale（这不是被测逻辑的问题，是演练失真）。
   */
  suspendHeartbeat()       {
    this.stopHeartbeat();
  }

  /** 手动续租一次（自动续租未启用时用）。 */
  async heartbeat()                {
    await this.state.heartbeat();
    this.lastHeartbeatError = null;
  }

  get coreStore()            {
    return this.core;
  }

  get stateStore()             {
    return this.state;
  }

  /**
   * 落盘（N4-R6 最终口径，**不做本地过滤/排序**）：
   *   `persistCoreEvents(store, core.journal.raw())` —— 事件排序、连续前缀、缺口识别都由 N4 负责，
   *   返回 `{appended, revisionAfter, cursorAfter, gapAt, remaining, incomplete}`。
   *   `incomplete === true` 时最多再补两轮（每轮都会推进到下一个缺口），仍不完整就把 `gapAt/remaining`
   *   记进 `lastError` 由 `graph_status.persistence.error` 透出，**不静默吞**。
   */
  /**
   * 只交出**还没落盘的那一段** core 事件（且不做深拷贝）。
   *
   * 为什么必须这么做：原来的写法是 `persistCoreEvents(state, journal.raw())`，而
   * `Journal.raw()` 对**每一条**事件做 `cloneEvent`（payload 走 JSON 深拷贝）。
   * 于是每次 `withCore` 之后的 `persist()` 都要付 O(全史) 的深拷贝——13000 条事件时
   * 单次约 10 ms，而一个 worker 动作链（claim → evidence → verify）要 persist 多次。
   *
   * 后果不是「慢一点」，是**吞吐随运行时长持续下降**：service 层 1000 节点实测
   * 83 s（12.0 节点/秒），同一次跑里 `taskNext` 前 50 次 16 ms → 后 50 次 26 ms、
   * `verifyDone` ×2.19。这正是 `Journal.view()` 上那条注释描述的同一个坑——它在
   * **core 内部读路径**上已经修过（改用零拷贝 `view()`），但**持久化路径漏了**，
   * 仍走 `raw()`。
   *
   * 现在的取法：从尾部倒扫出 `seq > 已落盘游标` 的后缀，成本 O(未落盘数)；
   * 无待落事件时直接给空数组（下游 `persistCoreEvents` 会 O(1) 早退）。
   *
   * 安全边界：
   *   - 传的是**内部事件对象**（同 `view()` 的契约：调用方只读）。`persistCoreEvents`
   *     只做排序/过滤/序列化，不写回，因此不会破坏「只追加」不变量。
   *   - 倒扫要求 tail 的 seq 单调递增。`restore()` / 恢复期重编号可能让数组非序，
   *     一旦发现逆序**回退到 `raw()`**（O(n) 深拷贝，罕见路径换正确性）。
   */
          pendingCoreEvents()          {
    const events = this.core.journal.view()                                  ;
    const cursorSeq = Number(
      (typeof this.state.cursorOf === 'function' ? this.state.cursorOf('core')?.coreSeq : undefined) ?? this.persistedSeq ?? 0,
    );
    const baseSeq = Number.isFinite(cursorSeq) ? Math.max(0, cursorSeq) : 0;
    let start = events.length;
    while (start > 0 && Number(events[start - 1].seq) > baseSeq) {
      // 逆序（恢复期重编号 / rollback 后的形状）→ 交给 raw() 走全量，别猜
      if (start < events.length && Number(events[start].seq) < Number(events[start - 1].seq)) {
        return this.core.journal.raw()         ;
      }
      start -= 1;
    }
    if (start >= events.length) return []         ;
    return events.slice(start)         ;
  }

  async persist()           
                     
                     
                   
                         
                     
                     
                        
                         
                                                           
     {
    const snapshotCursor = () => {
      const cursorRecord = typeof this.state.cursorOf === 'function' ? this.state.cursorOf('core') : null;
      return Number(cursorRecord?.coreSeq ?? this.persistedSeq);
    };

    // 已关闭：不再写盘（锁已释放），返回 no-op 结果，避免 "锁已过期" 噪声
    if (this.closed) {
      return {
        appended: 0,
        revision: this.state.revision,
        cursor: snapshotCursor(),
        baseRevision: this.state.revision,
        adopted: this.restoreMeta.adopted,
        deferred: 0,
        incomplete: false,
        gapAt: null,
        error: null,
      };
    }

    let appended = 0;
    let outcome                                                                                                                                                  = null;
    let attempts = 0;
    try {
      // 最多三轮：每轮 N4 落掉一段连续前缀，缺口推进后再补
      do {
        outcome = await persistCoreEvents(this.state, this.pendingCoreEvents(), { cursorName: 'core' });
        appended += Array.isArray((outcome                            )?.appended)
          ? ((outcome                           ).appended.length)
          : 0;
        attempts += 1;
      } while (outcome?.incomplete === true && attempts < 3);
      this.persistedSeq = Number(outcome?.cursorAfter ?? snapshotCursor());
      const incomplete = outcome?.incomplete === true;
      this.lastGapAt = incomplete ? (outcome?.gapAt ?? null) : null;
      this.lastError = incomplete
        ? {
            code: 'PERSIST_INCOMPLETE',
            message: `gapAt=${outcome?.gapAt ?? 'n/a'}，remaining=${outcome?.remaining ?? 'n/a'}（已落 ${appended} 条）`,
          }
        : null;
      return {
        appended,
        revision: Number(outcome?.revisionAfter ?? this.state.revision),
        cursor: this.persistedSeq,
        baseRevision: Number(outcome?.baseRevision ?? this.state.revision),
        adopted: this.restoreMeta.adopted,
        deferred: Number(outcome?.remaining ?? 0),
        incomplete,
        gapAt: outcome?.gapAt ?? null,
        error: this.lastError,
      };
    } catch (error) {
      this.lastError = { code: errorInfo(error).code, message: String(errorInfo(error).message) };
      return {
        appended,
        revision: this.state.revision,
        cursor: snapshotCursor(),
        baseRevision: this.state.revision,
        adopted: this.restoreMeta.adopted,
        deferred: 0,
        incomplete: true,
        gapAt: null,
        error: this.lastError,
      };
    }
  }

  /**
   * journal 全史指纹的**缓存**。
   *
   * 为什么要缓存：`journalFingerprint()` 是对每条记录 `canonicalJson()` 后 join 再做
   * sha256 —— O(全史)。而 `snapshot()` 每次调用都算它，`service.graphStatus()` 又调了
   * **两次** `snapshot()`。实测 4005 条记录时单次 **24.19 ms**，于是 `graphStatus`
   * 单次 50 ms，其中 48 ms 是在重复计算同一个不变的摘要。
   *
   * 缓存键取 `(记录数, 末条 seq, 末条 hash)`：journal 只追加，键随追加必然变化；
   * `atomically()` 回滚会截短（记录数变），回滚后重写会产生新的 seq/hash。
   *
   * **残留风险（明写而不是假装没有）**：若有人把中段某条原地改写、同时保持
   * 记录数/末条 seq/末条 hash 完全不变，这里会返回旧指纹。真正的完整性保证在
   * `verifyChain()` 与快照锚点（`stateSha256` / `journalHash`）那两条链上，
   * 本字段是**诊断值**，不承担 fail-closed 职责。
   */
          fingerprintCache                                                                              = null;

          fingerprintOf(records                    )         {
    const last = records.length ? (records[records.length - 1]                                     ) : null;
    const length = records.length;
    const lastSeq = Number(last?.seq ?? 0);
    const lastHash = String(last?.hash ?? '');
    const cache = this.fingerprintCache;
    if (cache && cache.length === length && cache.lastSeq === lastSeq && cache.lastHash === lastHash) {
      return cache.value;
    }
    const value = journalFingerprint(records         );
    this.fingerprintCache = { length, lastSeq, lastHash, value };
    return value;
  }

  snapshot()                      {
    const records = this.state.journal.records();
    const cursor = typeof this.state.cursorOf === 'function' ? this.state.cursorOf('core') : null;
    return {
      mode: this.mode,
      dir: this.dir,
      revision: this.state.revision,
      fingerprint: this.fingerprintOf(records),
      records: records.length,
      restored: this.restored,
      restoredCounts: this.restoredCounts,
      coreCursor: Number(cursor?.coreSeq ?? this.persistedSeq),
      adopted: this.restoreMeta.adopted,
      renumbered: this.restoreMeta.renumbered === true,
      incomplete: this.lastError?.code === 'PERSIST_INCOMPLETE',
      gapAt: this.lastError?.code === 'PERSIST_INCOMPLETE' ? this.lastGapAt : null,
      error: this.lastError,
      recoveryReport: this.state.lastRecovery,
      heartbeat: {
        auto: this.heartbeatTimer !== null,
        lastError: this.lastHeartbeatError,
      },
    };
  }

  async checkpoint(meta                                                         = {}) {
    const outcome = await this.persist();
    if (outcome.error || outcome.incomplete) {
      throw Object.assign(new Error(outcome.error?.message ?? 'persistence-incomplete'), {
        code: outcome.error?.code ?? 'PERSIST_INCOMPLETE',
      });
    }
    return this.state.checkpoint(meta);
  }

  /**
   * 关闭：先落盘，再 `state.close()`（**释放 journal lock**）。幂等。
   *
   * 这是 STATE_LOCKED 的根治点：插件 dispose/disable 时必须走到这里，
   * 否则上一个写者仍持锁，下一次 open 会互相抢占。
   */
  async close(options                         = {}) {
    if (this.closed) return;
    this.stopHeartbeat();
    let flushError          = null;
    try {
      const outcome = await this.persist();
      if (outcome.error || outcome.incomplete) {
        flushError = Object.assign(new Error(outcome.error?.message ?? 'persistence-incomplete'), {
          code: outcome.error?.code ?? 'PERSIST_INCOMPLETE',
        });
      }
    } finally {
      this.closed = true;
      await this.state.close(options);
    }
    if (flushError) throw flushError;
  }

  get isClosed()          {
    return this.closed;
  }

  static errorInfo = errorInfo;
}


//# sourceURL=persistence.js