/**
 * N4 · 状态层契约（lane N4 / task-13）
 *
 * 依据：
 *   - 管理区 `designs/_research/DSH原生插件-60轮长任务.md` §2 权威边界、§4 P3
 *   - 宿主 `fs` 服务 CAS 契约：`writeText(target, content, expected?: FsWriteIntent)`
 *     `FsWriteIntent = {kind:'createIfAbsent'} | {kind:'replaceIfVersion', version}`
 *     `FsWriteOutcome = {operation, version, before, after}`
 *   - Python `control_plane/events.py` + `graph.replay_snapshot()` 作为语义 oracle
 *
 * 本文件只放**类型与错误码**，不放实现；N3（core）与 N5（e2e）按此契约编码。
 * 语义约束（实现见 store.ts / recovery.ts）：
 *   1. journal 只追加，`seq` 严格 +1；`hash` 形成链，断链即 `STATE_HASH_BREAK`（fail-closed）。
 *   2. `revision === seq`（状态序），`graphRevision` 对应 Python `graph_version`（replan 递增）。
 *   3. journal 是权威；快照只是可重建缓存（plan §2）。快照超前于 journal → `STATE_SNAPSHOT_AHEAD`。
 *   4. 单写者：进程内串行 + 跨进程锁文件；锁不新鲜切需 `takeover()` 签发的 fencing token。
 */

export const STATE_SCHEMA = 1         ;

                                                          
                                                                 
                                                 

/** 状态错误码（全部 fail-closed，绝不静默覆盖）。 */
                            
                  
                    
                         
                          
                    
                   
                      
                   
                      
                     

export class StateError extends Error {
           code                ;
           detail            ;

  constructor(code                , message        , detail             = {}) {
    super(`[${code}] ${message}`);
    this.name = 'StateError';
    this.code = code;
    this.detail = detail;
  }
}

/** journal 单条记录：Python `events` 表的一行 + 哈希链。 */
                                
                                          
              
                                                  
                  
                                                       
             
                                                               
               
                        
                      
                                
                   
                                                  
               
 

/** 图节点（字段名与 Python tasks 表一一对应，便于差分）。 */
                            
                 
                
               
                            
                       
                     
                 
                             
                            
                          
                   
                        
                     
                    
                    
 

                        
             
           
             
             
               
               
              
              
             
           

                                                        

                            
                 
               
                 
 

                                 
                     
               
                 
                              
                        
 

                                 
                     
                 
               
                     
                     
                                       
             
 

                                 
                     
                        
                                   
                 
                                
                                 
                            
                           
 

                             
                
                                          
                         
 

                              
                 
                
                       
                    
                      
 

/** 外部序列空间游标：把「core 的 seq」映射到「journal revision」。 */
                               
                           
               
                                    
                  
                                                         
                   
             
 

/** 物化状态（journal 折叠结果）。`revision === seq`。 */
                           
                 
                   
                        
                    
                                   
                     
                                           
                                            
                                            
                                    
                                      
                                  
                                        
 

/** fs CAS 期望：映射宿主 `FsWriteIntent`；`unconditional` 仅测试/初始化使用。 */
                            
                              
                                                 
                              

                           
               
                  
 

                           
               
                                       
 

/**
 * 文件系统端口。两套实现：
 *   - `NodeFsPort`（node:fs，追加 + fsync + 临时文件 rename 发布）
 *   - `DshFsPort`（宿主 `fs` 服务，写走 `writeText` + `FsVersion`）
 * 测试用 `MemoryFsPort`（含 CAS 与故障注入）。
 */
                         
                                                 
                                                          
                                                  
           
                 
                    
                             
                                                                  
                               
                                                       
                                               
                                             
                                      
                                      
                                  
                                                      
 

                             
              
               
                
                
                    
                      
                
 

                             
                
                
                   
                    
                        
 

                             
                       
              
                   
                        
                
             
                      
                                                      
                           
                         
 

                               
                 
              
                   
                        
                       
                      
                      
                    
 

                               
                     
                  
 

                               
                            
              
             
                                       
                 
                   
                 
                                         
                       
                                        
                     
                     
 

                              
               
                         
                       
                               
              
                                                        
                               
 

/** TeamTask 投影（N1/N2 的投影目标；本层只负责"可重建"）。 */
                                
                  
                      
                                 
                       
                 
                       
                 
 

                                     
              
                   
                        
                         
                         
                        
 


//# sourceURL=state\types.js