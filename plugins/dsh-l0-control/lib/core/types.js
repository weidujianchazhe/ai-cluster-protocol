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
                                            
                                                         

                             
                  
                
               
                            
                      
                     
                 
                              
                             
                   
                          
                         
                                  
                     
                     
 

                       
               
             
                 
 

                        
                  
                
                        
                     
                       
 

                           
                      
               
                 
                        
                         
                                 
 

                                 
                      
                  
               
                      
                      
                   
                     
             
     
                                                    
                                                                         
     
                            
     
                                                             
                                          
     
                                  
 

                                 
                    
                 
 

                                 
                      
                         
                       
                   
                            
                                   
                                  
                      
                 
                         
                      
                            
                      
                     
                             
 

                              
              
                   
             
               
                         
                                   
 

                            
               
                     
                          
                            
 

                              
                   
             
                 
                        
                  
                    
                      
 

/** `done` 凭证（与 Python `graph.done_credential()` 同形）。 */
                                 
                  
                     
                         
                    
 

                                
                                    
                
 

                        
                   
                  
 

export const systemClock        = {
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};


//# sourceURL=core\types.js