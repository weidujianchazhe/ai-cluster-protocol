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
 * *inferred state may enter the journal, only verified state may act toward others*。
 *
 * 缺省 `verified`：老证据（本字段引入前落账的）一律视为已验证，避免历史图翻车。
 */
                                                             

export const PROVENANCES                        = ["verified", "inferred", "assumed"];

                                 
                      
                  
               
                      
                      
                   
                     
             
     
                                                    
                                                                         
     
                            
     
                                                             
                                          
     
                                  
                                                                 
                         
 

                                 
                    
                 
 

                                 
                      
                         
                       
                   
                            
                                   
                                  
                      
                 
                         
                      
                            
                      
                     
                             
 

                              
              
                   
             
               
                         
                                   
 

                            
               
                     
                          
                            
 

                              
                   
             
                 
                        
                  
                    
                      
 

/** `done` 凭证（与 Python `graph.done_credential()` 同形）。 */
                                 
                  
                     
                         
                    
 

                                
                                    
                
 

                        
                   
                  
 

export const systemClock        = {
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};


//# sourceURL=core\types.js