/**
 * 观测层类型（Lane O）。
 *
 * 设计约束：
 *  - **纯数据模块**：不 import `core/*`（避免与 core/state 的单向依赖倒灌），
 *    只在类型层面借用 `EventRecord` 的形状；core 侧需要时由 service 把 journal 事件喂进来。
 *  - 只使用「Node 类型剥离可直接执行」的语法（无 enum / 无 namespace / 无参数属性）。
 *  - 所有对外数字必须是有限值（`NaN` / `Infinity` 不得进导出），见 `redact.finite()`。
 */

/** 一次工具调用的采样（服务层每调一次工具就应产生一条）。 */
                                 
                                              
               
                            
                         
                                        
                             
                            
              
                                                             
                            
                  
                  
                    
                     
                          
                
                           
                          
                            
              
                                                        
                                 
 

/** 一次节点级采样（拿到 adapter usage 或无工具调用的节点进度时用）。 */
                             
                 
                             
                         
                    
                    
                     
                
                  
              
                                 
 

/** 单节点聚合。 */
                              
                 
                
             
                 
                   
                    
                 
               
                 
                    
                    
                  
                            
                               
                        
 

/** 单工具聚合。 */
                              
               
                
             
                 
                        
                 
                    
                 
               
 

/** 全局汇总。 */
                         
                  
                
             
                 
                        
                   
                    
                 
               
                 
                    
                    
                  
                
                
 

/** 阈值（全部可选；缺省用 `DEFAULT_LIMITS`）。 */
                                      
                                      
                     
                
                   
                                             
                     
                                        
                            
                                  
                             
                   
                      
                                             
                                
 

                                                         

/** 告警（JSON 可序列化；`rule` 与 `alertRules[].id` 一一对应）。 */
                                     
               
                          
                  
                        
                       
                       
             
 

/** 规则求值上下文（由 metrics + graphStatus 投影组装，规则本身不读全局状态）。 */
                               
             
                 
                       
                        
                                        
                                                                 
                                      
                                     
                    
                                               
                       
 

/** 健康快照（`graph_status.observability` 的主体）。 */
                                 
              
             
                                              
                 
           
                    
                         
                   
                     
                 
    
                                                               
                               
 

/** `graph_status.observability` 的完整数据形状。 */
                                          
              
                       
                                                            
                                                                                 
                 
                                                                                 
                        
                        
                               
                                        
                                                       
 

export const DEFAULT_LIMITS                                = {
  maxTokens: 0,
  maxCost: 0,
  maxWallMs: 120_000,
  maxRejectionRate: 0.3,
  minSamplesForRate: 5,
  maxRetries: 3,
  defaultNodeMaxTokens: 0,
};

/** `0` 表示「不限」，统一收敛在这里，避免各规则各写一遍。 */
export function isLimitUnset(value        )          {
  return !Number.isFinite(value) || value <= 0;
}


//# sourceURL=observability\types.js