/**
 * 派发速率窗口：**从 journal 推导**，不用进程内数组。
 *
 * 为什么必须改：旧实现是 `private dispatchTimes: number[] = []`。它是进程内的，
 * 因此 `dispatchRatePerSecond` 实际只是「单进程生命周期内的速率」，重启一次
 * 窗口就归零。实测证据（node 持久化 + 同一 stateDir）：
 *
 *   第 1 轮派出 Z1 Z2  →  进程窗口 = 2
 *   重启                 →  进程窗口 = 0   ← 归零
 *   释放 Z1 Z2 的登记后再派 → 又派出 Z1 Z2
 *   journal 里 1 秒内 node_enqueued = 4，而上限是 2
 *
 * 也就是说：**所谓「全局速率控制」被一次重启绕过了**。它不报错、不告警，
 * 只是在你最需要限速的时刻（崩溃重启后立刻抢跑）失效。
 *
 * 判据改法与 claim 层一致（`budget.claimsInWindow`）：速率额度是「最近
 * windowMs 内**实际发生过**的派发」，而实际发生过的派发在 journal 里有
 * 唯一权威记录 —— `node_enqueued` 事件（带 `at` 时间戳）。
 * 于是窗口随 journal 一起持久化，跨重启、跨 tick、跨实例都成立。
 *
 * 为什么不直接把 `dispatchTimes` 存盘：
 *  - 又要多一个「计数器 vs 事件」一致性维护点，重放后可能对不上；
 *  - journal 已经是单一事实源，从它推导天然与重放结果一致。
 */
                                  
                 
               
 

/** 计入速率额度的 journal 事件：只有「真的派出去」才烧额度。 */
const RATE_KINDS = new Set(['node_enqueued']);

/**
 * 最近 `windowMs` 内实际派发的次数（从 journal 行推导）。
 *
 * 语义边界（与旧 `dispatchTimes` 逐条对齐）：
 *  - `node_enqueue_failed` **不**计入：spawn 失败没有产生 worker，不该烧额度；
 *  - 候选、dryRun、`already-enqueued` 都**不**计入：它们不写 `node_enqueued`；
 *  - 时间戳解析失败的行**跳过**而不是当成「很久以前」——宁可少算也不误挡。
 *
 * 复杂度：journal 是追加写、时间单调，所以**从尾部倒着扫、遇到超出窗口就停**。
 * 单轮典型成本是 O(窗口内事件数)，不是 O(全部历史)。
 */
export function dispatchedInWindow(
  rows                            ,
  now        ,
  windowMs = 1000,
)         {
  const since = now - Math.max(0, windowMs);
  let count = 0;
  let missingTs = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const at = Date.parse(String(row?.at ?? ''));
    if (!Number.isFinite(at)) {
      // 缺时间戳的行：计数但不作为「可以停」的依据（它可能是刚写进去的）。
      // 上限保护：连续 64 行都没有可用时间戳就不再往下扫，避免退化成全量扫描。
      missingTs += 1;
      if (missingTs > 64) break;
      continue;
    }
    if (at <= since) break;
    if (RATE_KINDS.has(String(row?.kind ?? ''))) count += 1;
  }
  return count;
}

/**
 * 把 journal 推导出的使用量作为**下限**，与进程内计数取较大者。
 *
 * 为什么不能直接用 journal 值替换进程内计数：`appendJournal` 是本层直接写文件，
 * 而 `dispatchTimes` 在 `noteDispatched` 时立刻记账。两者之间有一瞬间的窗口
 * （事件已写、`readJournal` 增量游标还没推进），此时只看 journal 会把刚派出去的
 * 那几次算漏，于是同一秒里多派几个。
 *
 * 取较大者是安全方向：宁可少派，不可超速。
 */
export function effectiveDispatched(
  journalCount        ,
  processCount        ,
)         {
  const a = Number.isFinite(journalCount) && journalCount > 0 ? Math.floor(journalCount) : 0;
  const b = Number.isFinite(processCount) && processCount > 0 ? Math.floor(processCount) : 0;
  return Math.max(a, b);
}


//# sourceURL=dispatch\rate-window.js