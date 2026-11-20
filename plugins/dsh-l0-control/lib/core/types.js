/**
 * 控制面核心类型（Python `control_plane` schema v4 的 TS 投影）。
 *
 * 说明：只用可被 Node 类型剥离（type stripping）直接执行的语法——
 * 不用 enum / namespace / 参数属性，保证 `node src/core/*.ts` 可直接跑。
 */

/** 节点状态（与 Python `graph.STATUSES` 一致，10 态）。 */
export const NODE_STATUSES = [
  "planned",
  "ready",
  "claimed",
  "running",
  "submitted",
  "verifying",
  "accepted",
  "rejected",
  "blocked",
  "done",
]         ;
                                                        

export const EDGE_KINDS = ["blocks", "artifact", "review"]         ;
                                                   

export const VERDICTS = ["pass", "fail", "unknown"]         ;
                                                

export const DECISION_LEVELS = ["L0", "L1", "L2", "L3"]         ;
                                                             

export const DECISION_STATUSES = [
  "proposed",
  "auto",
  "confirmed",
  "overridden",
  "timed_out",
  "blocked",
]         ;
                                                                

export const STAGES = ["research", "design", "build", "audit", "deliver"]         ;
                                            
                                                         

                             
                  
                
               
                            
                      
                     
                 
                              
                             
                   
                          
                         
                                  
                     
                     
 

                       
               
             
                 
 

                        
                  
                
                        
                     
                       
 

                           
                      
               
                 
                        
                         
                                 
 

/**
 * 证据来源标记（provenance）。
 *
 * 区分「对事实核验过」与「从线索推断出来的」——前者才能支撑节点进 done，
 * 后者只能进 journal 供人读。这是 duami 在 The Colony 讨论里提的规则：
 * 「推断出来的状态可以进 journal，只有核验过的状态才能据此对他人采取动作」。
 *
 * 缺省 `verified`：老证据（本字段引入前落账的）一律视为已验证，避免历史图翻车。
 */
                                                             

export const PROVENANCES                        = ["verified", "inferred", "assumed"];

/**
 * 因果标注：**我读了谁的什么，因此做了什么不同**。
 *
 * 这是 worker 之间唯一的横向信息流，而且是**声明的、单向的、可审计的**——
 * 不是实时通信。它解决的是「C 看到 B 的产出，但看不到 B 受谁影响」这个问题。
 *
 * 三条刻意的约束：
 *   1. **只声明不强制**：不填就是没有（`[]`），不影响完成判定；
 *   2. **只引用已完成或已存在的节点**：引用不存在的节点是明确错误（拼写/幻觉），拒收；
 *   3. **不能引用自己**：自引用会造成假的耦合度。
 *
 * 注意它**不改变运行时行为**：被引用的节点不知道谁读了它，两边的执行顺序也不变。
 * 所以可复现性、审计独立性、成本线性这三条都不受影响。
 */
                             
                         
                 
                                 
                      
                                       
               
 

                                 
                      
                  
               
                      
                      
                   
                     
             
     
                                                    
                                                                         
     
                            
     
                                                             
                                          
     
                                  
                                                                 
                         
     
                               
                               
     
                        
     
                                               
                                                 
     
                              
 

                                 
                    
                 
 

                                 
                      
                         
                       
                   
                            
                                   
                                  
                      
                 
                         
                      
                            
                      
                     
                             
 

                              
              
                   
             
               
                         
                                   
 

                            
               
                     
                          
                            
 

                              
                   
             
                 
                        
                  
                    
                      
 

/** `done` 凭证（与 Python `graph.done_credential()` 同形）。 */
                                 
                  
                     
                         
                    
 

                                
                                    
                
 

                        
                   
                  
 

export const systemClock        = {
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};


//# sourceURL=core\types.js