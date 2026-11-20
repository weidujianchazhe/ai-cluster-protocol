/**
 * 分区级检查点与恢复（从 journal 派生，不另存状态）。
 *
 * 设计边界：
 *  - 检查点只存「元数据 + 分区视图」，不存完整状态（完整状态由 journal 重放恢复）；
 *  - 检查点事件 `partition_checkpointed` 落 journal，重启后可找到最近检查点 + 重放后续事件；
 *  - 恢复 = 找到最近检查点 → 新建 store → 从检查点 baseSeq 开始重放 journal。
 */
                                        
                                                                              

                                      
                          
                       
                      
                    
                              
                  
               
                      
                 
                     
                     
                                                                               
                  
                       
                                           
                                                                                             
                
                     
             
                       
 

                                 
              
                                          
                  
                   
                                                                                
                 
 

/** 分区恢复计划：防「已完成 activity 被重放」。 */
                                      
              
                                         
                  
                   
                              
                                                                                     
                                   
                          
                                             
                                                                                                    
                 
 

/** 为指定分区落检查点（追加 `partition_checkpointed` 事件）。 */
export function checkpointPartition(
  store       ,
  partitionId        ,
  coordination                         ,
)                      {
  const partition = coordination?.partitions?.find((p) => p.id === partitionId);
  if (!partition) {
    throw new Error(`partition-not-found: ${partitionId}`);
  }
  const nodeRefs = partition.nodeRefs ?? [];
  const nodeStates = nodeRefs
    .map((nodeId) => {
      const node = store.state.nodes.get(nodeId);
      if (!node) return null;
      return { nodeId, status: node.status, stage: node.stage ?? null };
    })
    .filter(Boolean)                                                                    ;

  const activeLeases = [...store.state.leases.values()].filter(
    (lease) => lease.expires_at > store.nowMs() && nodeRefs.includes(lease.node_id),
  );

  const budgetUsed = [...store.state.evidence.values()]
    .filter((ev) => nodeRefs.includes(ev.node_id))
    .reduce((sum, ev) => sum + (ev.usage_tokens ?? 0), 0);

  const checkpointId = `CKPT-${store.nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
  // 下一个 append 的 seq 就是 `count()+1`；检查点事件的 seq 即 baseSeq，
  // 恢复时只重放 seq > baseSeq，因此不会把检查点事件自己算进待重放。
  const baseSeq = store.journal.count() + 1;
  // 同时记下**检查点时刻的租约明细**：恢复时要按 fencing_token 对账，
  // 只记 activeLeases 计数无法判断「哪条租约还该续、哪条已经被接管」。
  const leaseSnapshot = [...store.state.leases.values()]
    .filter((lease) => lease.expires_at > store.nowMs() && nodeRefs.includes(lease.node_id))
    .map((lease) => ({
      nodeId: lease.node_id,
      owner: lease.owner,
      fencingToken: lease.fencing_token,
      expiresAt: lease.expires_at,
    }));

  store.journal.append("partition_checkpointed", null, {
    checkpoint: {
      checkpointId,
      createdAt: store.nowIso(),
      baseSeq,
      partitionId,
      nodeRefs,
      nodeStates,
      activeLeases: activeLeases.length,
      leases: leaseSnapshot,
      budgetUsed,
      graphVersion: Number(store.state.meta.get("graph_version") ?? "1"),
    },
  });
  // baseSeq 必须是**检查点事件自身**的 seq：重放只算它之后的事件，
  // 否则每次恢复都会把检查点事件自己算成一条待重放事件。
  const checkpoint = readLastCheckpoint(store, partitionId, checkpointId);
  if (!checkpoint) throw new Error(`checkpoint-not-recorded: ${partitionId}`);
  return checkpoint;
}

/** 取最近一次检查点（可按分区 / checkpointId 过滤）；没有则 null。 */
export function readLastCheckpoint(
  store       ,
  partitionId         ,
  checkpointId         ,
)                             {
  const events = store.journal.view();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== "partition_checkpointed") continue;
    const checkpoint = (event.payload                                        )?.checkpoint;
    if (!checkpoint) continue;
    if (partitionId && checkpoint.partitionId !== partitionId) continue;
    if (checkpointId && checkpoint.checkpointId !== checkpointId) continue;
    return checkpoint;
  }
  return null;
}

/**
 * 分区恢复计划：**真正回答「哪些已完成 activity 不该重放」**。
 *
 * 与 `recoverFromCheckpoint` 的区别：那个只数「有多少事件待重放」；
 * 这个把「检查点时刻的分区视图」与「当前 journal 折叠结果」逐节点对比，
 * 给出三类结论：
 *  - `resume`      ：检查点时未完成、现在仍未完成 → 恢复后要接着做
 *  - `skipCompleted`：检查点时已完成 → **恢复后绝不能再执行一次**（防重放）
 *  - `drift`       ：检查点时已完成、现在却不是 done → journal 与检查点矛盾，必须报警
 *
 * 判据是**状态单调性**：节点一旦 done 就不能退回。任何 drift 都说明
 * journal 被截断/改写，或检查点写在了状态回滚之后。
 */
export function planPartitionResume(
  store       ,
  partitionId         ,
)                      {
  const checkpoint = readLastCheckpoint(store, partitionId);
  if (!checkpoint) {
    return {
      ok: false,
      checkpoint: null,
      baseSeq: 0,
      replayed: 0,
      resume: [],
      skipCompleted: [],
      drift: [],
      error: partitionId ? `checkpoint-not-found: ${partitionId}` : "checkpoint-not-found",
    };
  }

  const replayed = store.journal.view().filter((event) => event.seq > checkpoint.baseSeq).length;
  const resume                                = [];
  const skipCompleted           = [];
  const drift                               = [];

  for (const recorded of checkpoint.nodeStates) {
    const live = store.state.nodes.get(recorded.nodeId);
    if (!live) {
      drift.push({
        nodeId: recorded.nodeId,
        checkpointStatus: recorded.status,
        currentStatus: "missing",
        reason: "node-missing-after-replay",
      });
      continue;
    }
    if (recorded.status === "done") {
      if (live.status === "done") {
        skipCompleted.push(recorded.nodeId);
      } else {
        // 已完成却退回 → 状态非单调，必须报警而不是静默重放
        drift.push({
          nodeId: recorded.nodeId,
          checkpointStatus: recorded.status,
          currentStatus: live.status,
          reason: "done-regressed",
        });
      }
      continue;
    }
    if (live.status !== "done") {
      resume.push({ nodeId: recorded.nodeId, checkpointStatus: recorded.status, currentStatus: live.status });
    }
    // 检查点时未完成、现在已完成 → 属于「检查点之后才做完」，既不在 resume 也不在 skip
  }

  return {
    ok: drift.length === 0,
    checkpoint,
    baseSeq: checkpoint.baseSeq,
    replayed,
    resume,
    skipCompleted,
    drift,
    error: drift.length === 0 ? undefined : `checkpoint-drift: ${drift.map((d) => d.nodeId).join(",")}`,
  };
}

/** 恢复：返回检查点元数据 + 重放计数（实际重放由调用方用 `foldEvents` 完成）。 */
export function recoverFromCheckpoint(
  store       ,
  partitionId         ,
)                 {
  const checkpoint = readLastCheckpoint(store, partitionId);
  if (!checkpoint) {
    return {
      ok: false,
      checkpoint: null,
      baseSeq: 0,
      replayed: store.journal.count(),
      state: null,
      error: partitionId ? `checkpoint-not-found: ${partitionId}` : "checkpoint-not-found",
    };
  }
  // baseSeq 是检查点事件自身的 seq；只重放它之后的事件。
  const replayed = store.journal.view().filter((event) => event.seq > checkpoint.baseSeq).length;
  return {
    ok: true,
    checkpoint,
    baseSeq: checkpoint.baseSeq,
    replayed,
    state: {
      nodes: store.state.nodes.size,
      edges: store.state.edges.length,
      done: [...store.state.nodes.values()].filter((n) => n.status === "done").length,
      leases: store.state.leases.size,
    },
  };
}


//# sourceURL=core\checkpoint.js