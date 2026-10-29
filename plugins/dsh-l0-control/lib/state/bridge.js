/**
 * N4 ↔ N3 core / Python oracle 的互操作桥
 *
 * 背景：N3 的 `core/journal.ts` 是**内存**只追加日志，事件字段沿用 Python 的 snake_case
 * （`EventRecord{seq, event_id, ts, kind, node_id, payload}`）；N4 的持久层用 camelCase
 * （`JournalRecord{seq, eventId, ts, kind, nodeId, payload, prevHash, hash}`）。
 * 两边都不改命名，靠本桥双向转换，避免 core 依赖磁盘格式、N4 依赖业务词汇。
 *
 * 关键不变量（fail-closed）：
 *   - **两个序列空间**：core 的 `seq` 是本地业务计数，N4 的 `revision` 还含诊断事件
 *     （`writer_taken_over` / `snapshot_diverged` / `cursor_aligned`）。二者**不要求相等**。
 *   - 落盘以 `baseSeq`（core 已消费到的序号）为基准：新记录从 `max(revision, baseSeq) + 1` 起，
 *     并把 `coreSeq ↔ revision` 映射写成 `cursor_aligned` 事件（幂等、可重开）。
 *   - 重复（baseSeq < 游标）/ 回退 / 中间缺口 / core 领先 → `STATE_SEQ_GAP`。
 *   - `restoreCoreJournal()` 只回灌**业务事件**（诊断事件不进 core），并认领游标；
 *     这样 core 的 seq 起点（如 27）与 N4 的 revision（如 39）本来就可以不同。
 */

                                                                                             
import { StateError } from './types.js';
                                               
import { DIAGNOSTIC_KINDS } from './reducer.js';
                                        

/** 与 N3 `core/types.ts` 的 `EventRecord` 结构一致（结构类型，不 import，避免跨 lane 耦合）。 */
                                  
              
                   
             
               
                         
                                   
 

                                  
                  
                           
                                           
 

/** 与 N3 `core/types.ts` 的 `NodeRecord` 结构一致。 */
                                 
                  
                
               
                            
                       
                 
                 
                              
                             
                   
                          
                         
                                  
                     
                     
 

/** 与 N3 `core/types.ts` 的 `Edge` 结构一致。 */
                                 
               
             
               
 

export function toAppendInput(event                 )              {
  return {
    kind: event.kind,
    nodeId: event.node_id,
    payload: event.payload                          ,
    ts: event.ts,
  };
}

export function toAppendInputs(events                   )                {
  return events.map(toAppendInput);
}

                                 
                                             
                   
                      
                         
              
     
                                             
                                         
     
                   
 

                                
                  
                       
                         
                            
                        
                      
                                        
                  
                                          
                       
                           
                    
                                           
                      
                                                                   
                     
 

/** 业务事件（排除 N4 自身的诊断事件）；core 只该看到这些。 */
export function businessRecords(records                 )                  {
  return records.filter((record) => !DIAGNOSTIC_KINDS.includes(record.kind));
}

/**
 * 持久化 core 的增量事件（一次 write + 一次 fsync），**以 core 的 seq 为基准**。
 *
 * 容错口径（P1 真实宿主暴露：末两步 persist 返回 null）：
 *   - **不要求入参有序**：按 `seq` 排序后再处理（core 经 `restore()` 后 `raw()` 可能非序）；
 *   - 跳过 `seq ≤ baseSeq` 的已消费/重复事件（计入 `skipped`，不报错）；
 *   - 只落盘**从 `baseSeq + 1` 起的连续前缀**；遇到缺口返回 `gapAt` / `remaining`，
 *     **不整体拒绝**（`strict: true` 时才抛 `STATE_SEQ_GAP`）。
 *
 * 调用方若想"补完再说"，用 `incomplete` 判断并先补 `gapAt` 这一段。
 */
export async function persistCoreEvents(
  store       ,
  events                   ,
  options                 = {},
)                         {
  const cursorName = options.cursorName ?? 'core';
  const cursor = store.cursorOf(cursorName);
  const minSeq = events.length ? events.reduce((min, event) => Math.min(min, event.seq), Number.POSITIVE_INFINITY) : 1;
  const baseSeq = options.baseSeq ?? cursor?.coreSeq ?? Math.max(0, minSeq - 1);

  const reordered = events.some((event, index) => index > 0 && event.seq < events[index - 1].seq);
  const sorted = [...events].sort((left, right) => left.seq - right.seq);
  const fresh = sorted.filter((event) => event.seq > baseSeq);
  const skipped = sorted.length - fresh.length;

  // 同 seq 重复只留第一条（幂等重放）
  const bySeq = new Map                         ();
  for (const event of fresh) if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);

  // 取从 baseSeq+1 起的连续前缀
  const prefix                    = [];
  let expected = baseSeq + 1;
  while (bySeq.has(expected)) {
    prefix.push(bySeq.get(expected)                   );
    bySeq.delete(expected);
    expected += 1;
  }
  const remaining = bySeq.size;
  const gapAt = remaining > 0 ? expected : null;

  if (options.strict && (skipped > 0 || remaining > 0)) {
    throw new StateError('STATE_SEQ_GAP', `core 批次不连续（strict）：skipped=${skipped} remaining=${remaining}`, {
      baseSeq,
      skipped,
      gapAt,
      remaining,
      revision: store.revision,
      hint: 'strict 模式要求"已消费 + 连续"；默认模式会落盘连续前缀并回报缺口',
    });
  }

  if (!prefix.length) {
    // 没有可落的连续前缀：要么全部是重复（幂等），要么开头就是缺口
    return {
      baseSeq,
      baseRevision: store.revision,
      appended: [],
      revisionAfter: store.revision,
      cursorAfter: cursor?.coreSeq ?? baseSeq,
      skipped,
      gapAt,
      remaining,
      incomplete: gapAt !== null,
      reordered,
    };
  }

  const result = await store.appendFromSeq(baseSeq, toAppendInputs(prefix), {
    cursorName,
    ts: options.at,
  });
  return {
    baseSeq,
    baseRevision: result.baseRevision,
    appended: result.appended,
    revisionAfter: result.revisionAfter,
    cursorAfter: result.cursorAfter,
    skipped,
    gapAt,
    remaining,
    incomplete: gapAt !== null,
    reordered,
  };
}

export function toEventRecords(records                 )                    {
  return records.map((record) => ({
    seq: record.seq,
    event_id: record.eventId,
    ts: record.ts,
    kind: record.kind,
    node_id: record.nodeId,
    payload: record.payload                           ,
  }));
}

/**
 * 把 journal 回灌进 core 的内存日志（重启后 core 从这里恢复）。
 *
 * **重编号（默认 `renumber: true`）= 根因修复**：journal 的 seq 含诊断事件跳号
 * （如 `1,3,4,…,93`），而 N3 的 `Journal.append()` 用 `count + 1` 分配 seq。
 * 若原样灌入，core 的 `raw()` 会变成「…93, 79, 80…」这种**非有序带洞**数组，
 * 后续 `persistCoreEvents` 的批次必然不连续（P1 末两步 persist 返回 null 即此因）。
 * 因此回灌时把 seq/event_id 重编号为稠密 `1..N`（顺序不变，映射靠游标定位）。
 *
 * 默认只回灌**业务事件**；诊断事件不进 core。
 */
export async function restoreCoreJournal(
  store       ,
  coreJournal                 ,
  options   
                                 
                          
                        
                                                                    
                       
    = {},
)           
                   
                  
                               
                         
                                        
                   
                              
                   
                 
                      
   {
  const cursorName = options.cursorName ?? 'core';
  const revisionBefore = store.revision;
  const all = store.journal.records();
  const list = options.includeDiagnostics ? all : businessRecords(all);
  const renumber = options.renumber !== false;
  const raw = toEventRecords(list);
  const events = renumber
    ? raw.map((event, index) => ({
        ...event,
        seq: index + 1,
        event_id: `EVT-${String(index + 1).padStart(6, '0')}`,
      }))
    : raw;
  coreJournal.restore(events);
  const coreSeq = coreJournal.count();
  if (coreSeq !== list.length) {
    throw new StateError('STATE_DIVERGED', '回灌后 core 日志长度与预期不一致', {
      core: coreSeq,
      expected: list.length,
    });
  }
  let adopted = false;
  if (options.adoptCursor !== false) {
    const result = await store.adoptCursor(coreSeq, cursorName);
    adopted = result.changed;
  }
  return {
    restored: list.length,
    coreSeq,
    revisionBefore,
    revision: store.revision,
    cursor: store.cursorOf(cursorName),
    adopted,
    renumbered: renumber,
  };
}

export function toCoreNode(node           )                 {
  return {
    node_id: node.nodeId,
    title: node.title,
    spec: node.spec,
    capability: node.capability,
    stage: node.stage,
    status: node.status,
    deps: [...node.deps],
    evidence_required: [...node.evidenceRequired],
    decision_id: node.decisionId,
    attempts: node.attempts,
    assignee: node.assignee,
    verifier_ids: [...node.verifierIds],
    budget: node.budget                           ,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
  };
}

export function toCoreEdge(edge           )                 {
  return { from: edge.fromId, to: edge.toId, kind: edge.kind };
}

/** 供 N5 / core 做 `graph.snapshot()` 差分：只含节点与边（Python 同义子集）。 */
export function toCoreGraph(state          )   
                                        
                          
  {
  const nodes                                 = {};
  for (const [nodeId, node] of Object.entries(state.nodes)) nodes[nodeId] = toCoreNode(node);
  return { nodes, edges: state.edges.map(toCoreEdge) };
}

/**
 * Python oracle 形状（`control_plane/events.py` 一行事件）：
 * `{seq, event_id, ts, kind, node_id, payload}`，用于与 Python 生成的 fixture 直接比对。
 */
export function pythonEventView(record               )                  {
  return toEventRecords([record])[0];
}


//# sourceURL=state\bridge.js