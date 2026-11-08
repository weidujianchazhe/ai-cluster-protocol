/**
 * N4 状态层导出面（N2 `l0control` / N5 e2e 从这里 import 即可）
 *
 * 只导出稳定符号；`self-test.ts` / `crash-child.ts` 属测试资产，不从 barrel 导出。
 * 关键入口：`Store.open()` → `persistCoreEvents()` / `appendFromSeq()` → `rebuildProjection()`。
 */

             
              
                 
                 
             
               
           
           
                 
             
           
         
             
            
            
                
       
             
              
             
             
                
               
               
           
                 
               
                     
                    
export { STATE_SCHEMA, StateError } from './types.js';

export { Journal, statePaths } from './journal.js';
                                                              

export { DEFAULT_WAIT_MS, Store } from './store.js';
             
                      
                   
                 
                      
           
                    

export { openAndRecover, recoverWithJournal } from './recovery.js';
                                                                    

export { DIAGNOSTIC_KINDS, emptyState, fold, foldUntil, graphProjection } from './reducer.js';

export { buildSnapshot, checkAnchor, readSnapshot, updateSnapshot, verifySnapshot, writeSnapshot } from './snapshot.js';

export {
  projectTeamTasks,
  projectionStatus,
  readProjection,
  rebuildProjection,
  diffProjection,
} from './projection.js';
                                                                                       

export {
  businessRecords,
  persistCoreEvents,
  pythonEventView,
  restoreCoreJournal,
  toCoreGraph,
  toEventRecords,
} from './bridge.js';
                                                                                                   

export { MemoryFsPort, NodeFsPort, DshFsPort } from './fs-port.js';
                                                  

export { checkEventIdFormat, diffOracle, parseOracleFixture, resolveFixturePath, runOracleScript } from './python-diff.js';
                                                                                          

export { canonicalJson, eventIdOf, nowIso, sha256Hex } from './canonical.js';


//# sourceURL=state\index.js