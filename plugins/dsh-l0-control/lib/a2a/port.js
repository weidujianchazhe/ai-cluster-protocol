/**
 * 端口：传输层与控制面的唯一接缝（主窗口 M4 接线）。
 *
 * 设计约束：
 *  - 只 3 个方法，全部返回**扁平 NodeRow**，不返回 core 的类实例/闭包
 *    （否则会踩「工具/HTTP 输出必须 lossless JSON」的坑）；
 *  - 端口自己负责 S/T 两层的鉴权与租户校验；传输层只传 `actor`；
 *  - 端口抛 `PortError` → 由 router 映射成 HTTP 状态码；非 PortError 一律 500，
 *    **不把内部堆栈透给外部**。
 */
                                                                                                                  

                              
                                          
                                                                      
                               
                                                                       
                                                            
                                                                                                     
 

export class PortError extends Error {
  code        ;
  status        ;
  details         ;

  constructor(code        , message        , status = 502, details          = undefined) {
    super(message);
    this.name = 'PortError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** 端口不可用/依赖缺失时用，便于 router 判 503 而不是 500。 */
export function portUnavailable(detail          = undefined)            {
  return new PortError('port-unavailable', '控制面端口不可用（未接线或依赖缺失）', 503, detail);
}

export function isPortError(value         )                     {
  return value instanceof PortError
    || (typeof value === 'object' && value !== null && typeof (value                      ).code === 'string'
      && typeof (value                        ).status === 'number');
}


//# sourceURL=a2a\port.js