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
import { Store as CoreStore, configureCore, foldEvents, rehydrate } from './core/index.js';
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
      retryBaseMs: 25         ,
      retryMaxMs: 500         ,
      takeover: options.takeover === true,
    }         );
    const core = new CoreStore({});
    configureCore({ store: core });
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
    return new CorePersistence(mode, options.dir, opened, core, restored, counts, { adopted, coreSeq, renumbered });
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
        outcome = await persistCoreEvents(this.state, this.core.journal.raw(), { cursorName: 'core' });
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

  snapshot()                      {
    const records = this.state.journal.records();
    const cursor = typeof this.state.cursorOf === 'function' ? this.state.cursorOf('core') : null;
    return {
      mode: this.mode,
      dir: this.dir,
      revision: this.state.revision,
      fingerprint: journalFingerprint(records),
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
    };
  }

  async checkpoint(meta                                                         = {}) {
    await this.persist();
    const cp = await this.state.checkpoint(meta);
    return cp;
  }

  /**
   * 关闭：先落盘，再 `state.close()`（**释放 journal lock**）。幂等。
   *
   * 这是 STATE_LOCKED 的根治点：插件 dispose/disable 时必须走到这里，
   * 否则上一个写者仍持锁，下一次 open 会互相抢占。
   */
  async close(options                         = {}) {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.persist();
    } catch {
      // 落盘失败也要释放锁
    }
    await this.state.close(options);
  }

  get isClosed()          {
    return this.closed;
  }

  static errorInfo = errorInfo;
}


//# sourceURL=persistence.js