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

import { Journal,                                     } from './journal.js';
import { applyRecord, emptyState, fold } from './reducer.js';
import {
  buildSnapshot,
  checkAnchor,
  readSnapshot,
  stateSha256,
  updateSnapshot,
  verifySnapshot,
                   
                           
} from './snapshot.js';
import { StateError,                                                                                      } from './types.js';

                                                                                 

                                 
           
              
                   
                        
                         
                  
                                  
             
                     
                       
                           
                     
                                      
    
                    
                 
                                                 
                                
                                                
                                 
                  
                           
 

                                 
             
                    
                            
                   
                      
                                                
                   
                     
                                      
                         
 

export async function recoverWithJournal(options                )                          {
  const { fs, paths, journal } = options;
  const foldFn = options.fold ?? ((records                 ) => fold(records, emptyState()));
  const clock = options.now ?? (() => Date.now());
  const recordEvents = options.recordEvents ?? true;

  journal.verifyChain();
  const records = journal.records();
  /**
   * 折叠前的记录数快照。
   *
   * 必须单独记：`journal.records()` 返回**缓存数组本身**，后续 `journal.append()`
   * 会就地把它推长。想判断"折叠之后有没有再追加过事件"，只能拿这个值比，
   * 不能拿 `records.length`（那时它已经变成了新长度）。
   */
  const recordCountAtFold = records.length;
  const rawJournal = await journal.rawText();
  const authoritative = foldFn(records);
  const eventsAppended           = [];
  let diverged = false;
  let snapshotWrite                             = null;
  /**
   * 权威状态的摘要，一次算好反复用。
   *
   * 为什么值得单独记：10 万节点的 state 是 34 MB，`canonicalJson` 一遍实测 0.55 s。
   * 原实现对同一份 state 调了 **8 次** `canonicalJson`、对同一批记录调了 **4 次** `fold`，
   * 9.2 s 的恢复里有约 3.5 s 是纯重复计算（逐步实测见
   * `tests/_probe-recovery-redundancy.mjs`）。摘要能替代"整对象序列化后比字符串"
   * 的地方一律换成比摘要。
   */
  const authSha = stateSha256(authoritative);

  const loaded = await readSnapshot(fs, paths);
  let source                 = 'journal';
  let snapshotExisted = false;
  let snapshotSeq                = null;
  let snapshotVersion                = null;
  /** 初始锚点判定；最后一次 `checkAnchor` 复用同一个结果（入参完全相同，重算无意义）。 */
  let anchor                     = null;

  if (loaded === null) {
    source = 'journal+bootstrap';
  } else {
    snapshotExisted = true;
    snapshotSeq = loaded.file.meta.seq;
    snapshotVersion = loaded.version;
    // `verifySnapshot` 顺带返回它自己算出的 state 摘要：快照自校验必须算一遍，
    // 之后所有"和快照内容比"的地方（锚点匹配、快路径复核）都用这个值，不再重算。
    const snapshotSha = verifySnapshot(loaded.file);

    if (loaded.file.meta.seq > authoritative.revision) {
      throw new StateError('STATE_SNAPSHOT_AHEAD', '快照超前于 journal：拒绝以快照反推历史', {
        snapshotSeq: loaded.file.meta.seq,
        journalSeq: authoritative.revision,
        hint: '若确属旧快照，删除 snapshot.json 后从 journal 重建；若 journal 被回滚，人工介入',
      });
    }

    anchor = checkAnchor(loaded.file, records, rawJournal);
    const tail = loaded.file.meta.seq < authoritative.revision
      ? records.filter((item) => item.seq > loaded.file.meta.seq)
      : [];
    /**
     * 一次比对同时回答两个问题。
     *
     * 原实现做了两轮独立的"重放 vs 全量折叠"核对：
     *   (a) `foldUntil(records, snapSeq)` + sha 对比快照内容 → 1340 ms
     *   (b) `clone(快照) + 重放增量` + sha 对比全量折叠 → 900 ms
     * 而 (a) 其实是 (b) 的前半段：如果拿快照做基线、重放到末条后与全量折叠一致，
     * 那么快照在 `snapSeq` 处也必然是对的（否则重放结果不可能追上全量折叠）。
     * 所以只保留 (b) 这一次比对，覆盖 (a) 的全部错误情形，还更快：
     *   - 快照在某处错了 → 重放结果 ≠ authSha → 判分歧；
     *   - 快照整体错位 → 同上；
     *   - 锚点前缀被改写 → `checkAnchor` 的字节指纹先拦住。
     * 唯一丢的是"错在快照本身还是错在增量"的细分诊断，用 `reason` 字段区分即可。
     */
    const replayed = tail.length
      ? (() => {
          const fast = JSON.parse(JSON.stringify(loaded.file.state))            ;
          for (const record of tail) applyRecord(fast, record);
          fast.revision = authoritative.revision;
          return stateSha256(fast);
        })()
      : snapshotSha;
    const replayedMatchesAuthoritative = replayed === authSha;
    const anchorMatches = replayedMatchesAuthoritative && anchor.status !== 'diverged';

    if (!anchorMatches) {
      diverged = true;
      source = 'journal';
      if (recordEvents) {
        const event = await journal.append({
          kind: 'snapshot_diverged',
          payload: {
            snapshotSeq: loaded.file.meta.seq,
            journalSeq: authoritative.revision,
            anchorStatus: anchor.status,
            replayed,
            expected: authSha,
            reason: tail.length ? 'incremental-replay-mismatch' : 'snapshot-content-mismatch',
            at: new Date(clock()).toISOString(),
          },
        });
        eventsAppended.push(event.eventId);
      }
    } else {
      source = 'snapshot+replay';
    }
  }

  // 用最终的 journal 记录（可能刚追加了 snapshot_diverged）重建快照。
  // 没有追加事件时 `finalRecords` 与 `records` 是同一批，`authoritative` 就是最终状态——
  // 原实现在这里又 `fold` 了一遍（174 ms）只为得到同一个结果。
  //
  // 注意：`journal.records()` 返回的是**缓存数组本身**（不是拷贝），追加会就地增长它，
  // 所以 `records.length` 事后会跟着变。判断"是否追加过"必须看这一步之前的长度快照
  // 或 `eventsAppended`，不能拿 `finalRecords.length !== records.length`（恒为 false）。
  const finalRecords = journal.records();
  const appendedAfterFold = finalRecords.length !== recordCountAtFold;
  const finalState = appendedAfterFold ? foldFn(finalRecords) : authoritative;
  const finalSha = appendedAfterFold ? stateSha256(finalState) : authSha;
  const finalRaw = appendedAfterFold ? await journal.rawText() : rawJournal;

  // 全文摘要复用：锚点比较算过「前 journalBytes 字节」的 sha256，只有当前缀恰好覆盖
  // 整份 journal **且** 该前缀校验通过时，它才等于全文摘要；否则老实重算。
  const finalBytes = Buffer.byteLength(finalRaw, 'utf8');
  const coveredWholeJournal =
    anchor !== null && anchor.journalHashMatches && anchor.anchoredBytes === finalBytes;
  const snapshotFile               = buildSnapshot(finalState, finalRecords, finalRaw, new Date(clock()).toISOString(), {
    stateSha256: finalSha,
    journalBytes: finalBytes,
    journalHash: coveredWholeJournal ? (anchor               ).prefixHash : undefined,
  });

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

  /**
   * `replayEqualsSnapshot` 的语义要说清楚：它**由构造成立**，不是独立实测。
   *
   * 返回的 `finalState` 只有两个来源：没有追加事件时就是 `authoritative`（`foldFn(records)`
   * 的结果），有追加事件时是 `foldFn(finalRecords)` 的结果。两种情况都是"journal 全量折叠"，
   * 所以"全量折叠 == 返回状态"必然为真——原实现每次再折一遍（1379 ms）只是把这个恒等式
   * 重算一次，报出的 `true` 不含任何新信息。
   *
   * 这里不再假装它是验证：值保持 `true`（契约不变），另加 `replayCheck` 说明证据来源，
   * 让报告读者知道该信到什么程度。真正有区分度的对账是快路径那次
   * `stateSha256(fast) === authSha`（快照基线 + 增量重放 vs 全量折叠）。
   */
  const replayEqualsSnapshot = true;
  const replayCheck                    = 'by-construction';

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
    anchor: loaded === null ? 'missing' : (anchor               ).status,
    replayEqualsSnapshot,
    replayCheck,
    state: finalState,
    eventsAppended,
  };
}

/** 打开 → 恢复 的一步式入口（取锁、修复尾部、对账快照）。 */
export async function openAndRecover(
  options                  
                                                  
                           
                           
   ,
)                                                        {
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


//# sourceURL=state\recovery.js