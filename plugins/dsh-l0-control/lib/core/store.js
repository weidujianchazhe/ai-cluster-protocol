/**
 * 进程内状态表（Python SQLite 表在 TS 侧的等价物）。
 *
 *  - 权威是「状态 + 只追加事件日志」；本类只负责状态容器与**原子区间**语义；
 *  - 持久化（JSONL journal / fs CAS）归 N4，本层不落盘；
 *  - `atomically()` 提供 replan 需要的「全成或全不成」语义：
 *    任何一步抛错 → 状态与日志一起回滚（等价 Python `with conn:`）。
 */
import { Journal } from "./journal.js";
             
           
        
                 
       
                 
              
        
             
              
            
                    
import { systemClock } from "./types.js";

                        
                                 
                
                             
                                     
                                   
                                        
                                         
                                
                              
                            
 

export function emptyState()        {
  return {
    nodes: new Map(),
    edges: [],
    leases: new Map(),
    leaseCounters: new Map(),
    artifacts: new Map(),
    evidence: new Map(),
    decisions: new Map(),
    gates: new Map(),
    replanEvents: [],
    meta: new Map([["graph_version", "1"]]),
  };
}

function cloneState(state       )        {
  return structuredClone(state);
}

export class Store {
  state       ;
           journal         ;
           clock       ;

  constructor(options                                                      = {}) {
    this.clock = options.clock ?? systemClock;
    this.journal = options.journal ?? new Journal(this.clock);
    this.state = options.state ?? emptyState();
  }

  nowIso()         {
    return this.clock.nowIso();
  }

  nowMs()         {
    return this.clock.nowMs();
  }

  /** 状态 + 日志的一致快照（用于回滚与差分）。 */
  capture()                                          {
    return { state: cloneState(this.state), events: this.journal.raw() };
  }

  restore(snapshot                                         )       {
    this.state = cloneState(snapshot.state);
    this.journal.restore(snapshot.events);
  }

  /** 单事务区间：fn 抛错 → 状态与日志一起回滚后原样抛出。 */
  atomically   (fn         )    {
    const snapshot = this.capture();
    try {
      return fn();
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }
}


//# sourceURL=core\store.js