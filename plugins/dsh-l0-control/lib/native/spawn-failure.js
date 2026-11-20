/**
 * spawn 失败的**分类**：宿主满了 vs 组装失败。
 *
 * 为什么必须分开：这两种失败对调度器的含义完全相反。
 *
 * | 失败 | 含义 | 正确处置 |
 * |---|---|---|
 * | 宿主并发/配额/容量上限 | 现在派不进去，**过一会儿可以** | 节点保持 ready，下一轮重试 |
 * | 组装失败（role 非法 / preset 不存在 / prompt 超长 / provider 未注册） | 重试多少次都一样 | 标 blocked，让人介入 |
 *
 * 旧实现把两者都塞进 `spawn-failed`，于是调度器只能选一种行为，而两种都是错的：
 * 一律重试 = 对一个永远失败的节点每轮白烧一次 spawn（还会淹掉日志）；
 * 一律不重试 = 宿主短暂满载就把整张图的就绪节点全判死。
 *
 * 判据只能靠**错误文本**：宿主（DSH `subagents.startActivation`）没有给我们稳定的
 * 错误码清单，抛出来的可能是 `Error`、带 `code` 的对象、或纯字符串。所以这里
 * 用「先看结构化字段、再看关键字」的两段式判定，并且**默认按可重试处理**——
 * 因为把「可重试」误判成「永久失败」会让节点永久卡死，而把「永久失败」误判成
 * 「可重试」只是多派几次。两种误判的成本不对称，所以朝安全方向倒。
 */

                                                                                    

                               
                                       
                         
                                                        
                     
                                  
                  
                                       
                          
               
               
     
                                             
    
                                                
                                                 
                                              
                                                     
                                           
    
                                                        
     
                              
 

/**
 * 退避时长的**上限**：1 小时。
 *
 * 为什么需要上限：这个数值来自宿主的错误文本，可能是被截断/拼接过的字符串，
 * 解析出「86400000 秒」这种数字时若照单全收，派发会被冻住一整天——故障从
 * 「宿主忙」变成「调度器自己罢工」。封顶之后最坏情况是 1 小时后重试一次，
 * 而 1 小时已远长于任何合理的瞬时过载窗口。
 */
export const RETRY_AFTER_CAP_MS = 3_600_000;

/** 单位 → 倍数；不写单位按 HTTP 惯例视为**秒**。 */
const UNIT_MS                         = {
  ms: 1,
  msec: 1,
  msecs: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  毫秒: 1,
  秒: 1_000,
  分钟: 60_000,
};

/**
 * 文本里的退避时长。顺序即优先级：`retry-after` 这种显式写法最先认。
 *
 * 为什么要三种写法：宿主的错误文本没有统一格式，实测见过
 * `retry-after: 30`、`try again in 45 seconds`、`请 30 秒后重试`。
 * 只认一种的话，另外两种会静默退化成「每 tick 硬撞」——而这正是要修的行为。
 */
const RETRY_AFTER_TEXT                    = [
  /retry[\s_-]*after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*([a-z\u4e00-\u9fa5]+)?/i,
  /\btry\s+again\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*([a-z\u4e00-\u9fa5]+)?/i,
  /(\d+(?:\.\d+)?)\s*(毫秒|秒|分钟)\s*(?:之?后)?\s*(?:再|重)?试/,
];

/**
 * 从一段文本里抠出退避毫秒数；抠不到返回 null。
 *
 * **抠不到一律返回 null，不猜默认值**：没有依据时编一个「比如 30 秒」会让调度器
 * 在宿主明明 200 ms 就好了的情况下白等 30 秒。宁可继续按 tick 试——
 * 那是本函数出现之前的既有行为，不是新引入的退化。
 */
export function parseRetryAfterMs(message        )                {
  const text = String(message ?? '');
  if (!text) return null;
  for (const pattern of RETRY_AFTER_TEXT) {
    const match = pattern.exec(text);
    if (!match) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < 0) continue;
    const unit = String(match[2] ?? '').toLowerCase();
    const factor = unit ? UNIT_MS[unit] : UNIT_MS.s;
    if (!factor) continue;
    const ms = value * factor;
    if (!Number.isFinite(ms) || ms <= 0) continue;
    return Math.min(Math.round(ms), RETRY_AFTER_CAP_MS);
  }
  return null;
}

/**
 * 从结构化字段里取退避时长（比文本可信，所以先问它）。
 *
 * 认三种写法：`retryAfterMs`（明确毫秒）、`retryAfter`（按 HTTP 惯例是秒，
 * 但宿主若给了 `{seconds}` 对象也认）、以及 `headers['retry-after']`。
 * 单位不能靠猜——把毫秒当秒会白等 1000 倍，所以只在字段名自己写明 `Ms` 时按毫秒。
 */
function retryAfterFromFields(error         )                {
  const err = error                                       ;
  if (!err || typeof err !== 'object') return null;
  const explicitMs = Number(err.retryAfterMs ?? (err                                ).retry_after_ms);
  if (Number.isFinite(explicitMs) && explicitMs > 0) {
    return Math.min(Math.round(explicitMs), RETRY_AFTER_CAP_MS);
  }
  const httpSeconds = Number(err.retryAfter ?? (err                             ).retry_after);
  if (Number.isFinite(httpSeconds) && httpSeconds > 0) {
    return Math.min(Math.round(httpSeconds * 1_000), RETRY_AFTER_CAP_MS);
  }
  const headers = err.headers                                       ;
  const header = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (header !== undefined) {
    const raw = String(header).trim();
    // HTTP 的 Retry-After 也可以是 HTTP-date；那种情况不猜，交给文本解析与下次实测。
    if (/^\d+(?:\.\d+)?$/.test(raw)) {
      const seconds = Number(raw);
      if (Number.isFinite(seconds) && seconds > 0) {
        return Math.min(Math.round(seconds * 1_000), RETRY_AFTER_CAP_MS);
      }
    }
  }
  return null;
}

/** 宿主**满载**类信号：现在派不进去，稍后可以。 */
const HOST_CAPACITY_PATTERNS                    = [
  /max(?:imum)?[\s_-]*(?:concurrent|parallel|active|children|sessions?|activations?)/i,
  /concurren(?:cy|t)[\s_-]*(?:limit|reached|exceeded|cap)/i,
  /\btoo many (?:children|sessions?|activations?|agents?|subagents?|workers?)\b/i,
  /\b(?:capacity|limit|cap)\s*(?:reached|exceeded|hit)\b/i,
  /\brate[\s_-]*limit(?:ed|ing)?\b/i,
  /\bquota\b/i,
  /\b(?:pool|slot)s?\s*(?:is\s*)?(?:full|exhausted)\b/i,
  /\b(?:busy|overloaded|unavailable)\b.*\b(?:try again|later|retry)\b/i,
  /请稍后重试|稍后再试|并发(?:已满|超限|上限)|数量已达上限|超出并发/,
];

/** 宿主**满载**类结构化错误码（宿主若给了 code，优先用它）。 */
const HOST_CAPACITY_CODES = new Set([
  'EDSH_LIMIT',
  'EDSH_CAPACITY',
  'EDSH_RATE_LIMITED',
  'EDSH_BUSY',
  'EDSH_QUOTA',
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'RATE_LIMIT_EXCEEDED',
  'TOO_MANY_REQUESTS',
  'EAGAIN',
  'EBUSY',
  'ENOMEM',
]);

/** 组装**永久**失败类信号：重试无用，必须改配置或改任务。 */
const ASSEMBLY_PATTERNS                    = [
  // `preset` 与「不存在」的任意组合：宿主可能写 `agent preset "x" not found`、
  // `unknown preset: x`、`preset is not registered`、`preset not found`。
  /\bpreset\b.*\b(?:not\s*found|unknown|missing|not\s*registered|does\s*not\s*exist)\b/i,
  /\bunknown\s+(?:agent[\s_-]*)?preset\b/i,
  /\b(?:maxDepth|max_depth)\b.*\b(?:exceed(?:s|ed)?|invalid|too\s*small)\b/i,
  // `exceed(?:s|ed)?`：宿主常写 "prompt exceeds N tokens"，只写 `exceed\b` 会漏掉复数形态。
  /\bprompt\b.*\b(?:too\s*(?:long|large)|exceed(?:s|ed|ing)?|over\s*limit)\b/i,
  /\bcontext\s*(?:length|window)\b.*\bexceed/i,
  /\binvalid\s+(?:agent\s*)?(?:name|label|role|provider)\b/i,
  /\b(?:role|capability)\b.*\b(?:not\s*supported|unsupported|illegal)\b/i,
  /\bprovider\b.*\b(?:not\s*registered|unknown)\b/i,
  /预设.*(?:不存在|未注册)|未知预设|提示词.*(?:过长|超限)|上下文.*超限/,
];

function textOf(error         )         {
  if (typeof error === 'string') return error;
  const err = error                                                                     ;
  const message = typeof err?.message === 'string' ? err.message : '';
  if (message) return message;
  try {
    return String(error ?? '');
  } catch {
    return '';
  }
}

/**
 * 判定一次 spawn 失败的性质。
 *
 * 顺序：结构化 code（最可信）→ 组装失败关键字 → 宿主满载关键字 → 默认可重试。
 *
 * 为什么组装失败先于宿主满载：两组关键字可能同时出现（"cannot spawn: preset not found
 * (capacity check skipped)"）。组装失败是**确定性**的，一旦成立重试必然同样失败，
 * 所以它的优先级更高。
 */
export function classifySpawnFailure(error         )               {
  const err = error                                                                     ;
  const message = textOf(error);
  const hostCode = typeof err?.code === 'string' && err.code.trim() ? err.code.trim() : null;
  const name = typeof err?.name === 'string' && err.name.trim() ? err.name.trim() : 'Error';
  // 退避时长只对**可重试**的失败有意义；组装失败永远不再派，记一个时长无意义。
  // 取数顺序：结构化字段（宿主明说的毫秒/秒）→ 文本（`retry-after: 30` 等）。
  const retryAfterMs = retryAfterFromFields(error) ?? parseRetryAfterMs(message);

  if (hostCode && HOST_CAPACITY_CODES.has(hostCode.toUpperCase())) {
    return {
      code: 'host-capacity',
      retryable: true,
      message: `宿主满载（${hostCode}）：${message || '无详细信息'}；节点保持就绪，下一轮重试`,
      hostCode,
      name,
      retryAfterMs,
    };
  }

  for (const pattern of ASSEMBLY_PATTERNS) {
    if (pattern.test(message)) {
      return {
        code: 'assembly-failed',
        retryable: false,
        message: `组装失败（重试无用，需要改配置或改任务）：${message}`,
        hostCode,
        name,
        // 确定性失败不重试，退避时长无意义——不带上，免得下游误以为等一会儿会好。
        retryAfterMs: null,
      };
    }
  }

  for (const pattern of HOST_CAPACITY_PATTERNS) {
    if (pattern.test(message)) {
      return {
        code: 'host-capacity',
        retryable: true,
        message: `宿主满载：${message}；节点保持就绪，下一轮重试`,
        hostCode,
        name,
        retryAfterMs,
      };
    }
  }

  // 认不出来：按可重试处理。把「可重试」误判成永久失败会让节点永久卡死，
  // 反过来的代价只是多派几次——成本不对称，朝安全方向倒。
  return {
    code: 'spawn-failed',
    retryable: true,
    message: message || '未知 spawn 失败',
    hostCode,
    name,
    retryAfterMs,
  };
}

/** 只有真正的「确定性失败」才该把节点判死。 */
export function isPermanentSpawnFailure(failure              )          {
  return failure.retryable === false && failure.code === 'assembly-failed';
}


//# sourceURL=native\spawn-failure.js