/**
 * 出口归一化器：把任意值折成「纯 JSON 树」，一次遍历完成，不做 stringify↔parse 往返。
 *
 * 为什么不用 `JSON.parse(JSON.stringify(v))`：
 *   - 那是「序列化 + 再解析」两趟全量拷贝，大对象上开销翻倍；
 *   - 且它**不解决**问题本身：宿主拒绝的是类实例/代理/undefined/非有限数，
 *     我们真正需要的是「产出一棵只含 JSON 原生值的树」，一次遍历即可得到。
 *
 * 为什么不用 fast-json-stringify：它要求**精确 schema**，而工具输出里充满
 * 「可选字段为 null」「同名键不同类型」「混合类型数组」——schema 推断一旦偏差就抛错，
 * 这是关键输出路径，不能把稳定性押在推断上。
 *
 * 契约（与宿主 lossless-JSON 校验对齐）：
 *   undefined → null（对象里整键丢弃）
 *   非有限数（NaN/Infinity）→ null
 *   BigInt → 十进制字符串
 *   function / symbol → null
 *   Date → ISO 字符串
 *   Map → 普通对象；Set → 数组
 *   类实例 → 只取自有可枚举属性
 *   循环引用 → "[Circular]"
 */

                                 
                  
                   
                      
 

/** 纯 JSON 值类型。 */
                                                                                                      

/**
 * 归一化：返回纯 JSON 树。
 *
 * @param value 任意值
 * @param stats 可选统计（丢弃/循环计数，便于诊断而不污染返回值）
 */
export function toJsonValue(value         , stats                 )            {
  const seen = new WeakSet        ();
  const s                 = stats ?? { dropped: 0, circular: 0 };

  const walk = (v         )            => {
    if (v === undefined) {
      s.dropped += 1;
      return null;
    }
    if (v === null) return null;
    const t = typeof v;
    if (t === 'string' || t === 'boolean') return v             ;
    if (t === 'number') {
      if (!Number.isFinite(v          )) {
        s.dropped += 1;
        return null;
      }
      return v          ;
    }
    if (t === 'bigint') return String(v);
    if (t === 'function' || t === 'symbol') {
      s.dropped += 1;
      return null;
    }
    if (v instanceof Date) {
      const ms = v.getTime();
      return Number.isFinite(ms) ? v.toISOString() : null;
    }
    if (typeof v !== 'object') {
      s.dropped += 1;
      return null;
    }
    // 循环引用：进入时登记，回溯时移除（同一对象可在不同分支重复出现）
    const obj = v          ;
    if (seen.has(obj)) {
      s.circular += 1;
      return '[Circular]';
    }
    seen.add(obj);
    try {
      if (Array.isArray(v)) {
        return v.map((item) => walk(item));
      }
      if (v instanceof Map) {
        const out                               = {};
        for (const [k, val] of v                         ) {
          const key = typeof k === 'string' ? k : String(k);
          out[key] = walk(val);
        }
        return out;
      }
      if (v instanceof Set) {
        return [...(v                )].map((item) => walk(item));
      }
      const out                               = {};
      for (const key of Object.keys(v                           )) {
        const item = (v                           )[key];
        if (item === undefined) {
          s.dropped += 1;
          continue; // 对象里的 undefined 整键丢弃，而不是写成 null
        }
        out[key] = walk(item);
      }
      return out;
    } finally {
      seen.delete(obj);
    }
  };

  return walk(value);
}

/**
 * 工具出口硬化：与旧 `losslessOutput` 行为兼容，但只走一趟遍历。
 * 返回值保证是纯 JSON 树（宿主可直接接受）。
 */
export function losslessOutput(value         )          {
  return toJsonValue(value);
}

/** 诊断用：返回归一化结果与统计。 */
export function losslessOutputWithStats(value         )                                              {
  const stats                 = { dropped: 0, circular: 0 };
  const out = toJsonValue(value, stats);
  return { value: out, stats };
}


//# sourceURL=serializer.js