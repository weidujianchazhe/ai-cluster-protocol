/**
 * 「这个节点已经有活 worker 吗」——**从 journal 推导，不靠进程内 Set**。
 *
 * 为什么必须从 journal 推：
 *
 * 旧实现是 `private enqueuedNodes = new Set<string>()`。它有两个反向的错：
 *
 *   1. **重启即失忆**：进程重启后集合空了，同一节点会被再派一个 worker。
 *      两个 worker 抢同一个节点，一个 claim 成功、另一个被拒后停手——浪费一次
 *      spawn，而且现场看起来像「幽灵 worker」。
 *   2. **永不释放**：worker claim 被拒（容量满）后按契约停手，但节点仍被标记
 *      「已派」。租约后来过期了，节点重新 ready，却再也没有 worker 看它 ——
 *      **永久停滞**。这个比第一个严重得多：它不会报错，只会安静地卡住。
 *
 * 所以判据必须是「有可信证据表明那个 worker 还活着」：
 *
 * | journal 事件 | 含义 | 处置 |
 * |---|---|---|
 * | `node_enqueued` | 派了一个 worker | 登记（未确认） |
 * | `task_claimed` | worker 真的拿到租约 | 确认存活 |
 * | `task_heartbeat_ok` | worker 还在续租 | 确认存活 + 刷新时间 |
 * | `task_heartbeat_failed` | 续租失败 = 契约要求停手 | 释放 |
 * | `task_claim_rejected` | 准入拒绝 = worker 停手 | 释放 |
 * | `verify_done_requested` | 该节点已完成 | 释放 |
 * | `agent_reap_applied` | worker 会话被回收 | 释放 |
 *
 * 最后一道：**沉默即失联**。worker 崩掉不会留下任何事件。所以登记/心跳时间超过
 * `maxAgeMs` 就视为失联并释放——不是猜它死了，而是承认「无法证明它活着」，
 * 而「无法证明活着」不能用来永久阻塞调度。
 */
export interface EnqueueJournalRow {
  kind?: unknown;
  nodeId?: unknown;
  node_id?: unknown;
  instanceId?: unknown;
  instance_id?: unknown;
  sessionId?: unknown;
  session_id?: unknown;
  at?: unknown;
  applied?: unknown;
  archived?: unknown;
  /** `node_enqueue_failed` 上的可重试标记；只有显式 `false` 才算确定性失败。 */
  retryable?: unknown;
  failureCode?: unknown;
  /**
   * `node_enqueue_failed` 上宿主自己报的退避毫秒数。
   *
   * 只有数字才算数：字符串（如 `"30s"`）在写入侧就已经解析成毫秒了，
   * 这里再解析一遍等于给同一个值两套格式，日后必然只改一处。
   */
  retryAfterMs?: unknown;
  error?: unknown;
  /** `task_claim_rejected` 上的闸门归因（capacity/partition/rate/budget）。 */
  gate?: unknown;
}

export interface EnqueueRecord {
  nodeId: string;
  instanceId: string | null;
  sessionId: string | null;
  /** 最后一次可信活动时间（派发或心跳），ISO 字符串。 */
  at: string;
  /**
   * `at` 的毫秒值，**折叠时算一次**。
   *
   * 为什么缓存：失联判定每轮要对**全部** live 记录 `Date.parse(at)`。
   * 实测 68600 条时这一项是 17 ms，而 live 的规模不是并发数——它是
   * 「派出去了但还没被任何终态事件释放」的累积量，`maxAgeMs` 默认 30 分钟、
   * 派发 100/s 时上界是 18 万条。也就是说这个成本每轮 tick 都要付一次。
   * 时间戳在折叠时已知，没有理由每轮重新解析。
   */
  atMs: number;
  /** 是否观察到 worker 真的拿到租约。 */
  claimed: boolean;
}

export type EnqueueReleaseReason =
  | 'completed'
  | 'claim-rejected'
  | 'heartbeat-failed'
  | 'reaped'
  | 'stale'
  | 'lease-expired'
  | 'never-claimed';

export interface EnqueueRelease {
  nodeId: string;
  sessionId: string | null;
  reason: EnqueueReleaseReason;
  at: string;
  /**
   * 若因准入拒绝而释放，命中的是哪道闸门（`capacity` / `partition` / `rate` / `budget`）。
   *
   * 为什么必须记：`explainRelease` 原来只会说「task_claim 被准入拒绝后按契约停手」，
   * 而四种闸门对应的运维动作完全不同——容量要等、分区要换域、速率要退避、
   * **预算要人工加额度**。一句「被准入拒绝」把「再等等就好」和「永远好不了」
   * 说成同一件事。
   */
  gate?: string;
}

/**
 * 一次**确定性**的派发失败（重试不会变好）。
 *
 * 只有 `retryable === false` 的失败会进这里：组装失败（preset 不存在、prompt 超长、
 * role 非法…）。宿主满载（并发/配额）**不**入册——那种失败过一会儿重试就会成功，
 * 记成永久失败会让节点在宿主短暂繁忙时被永久判死。
 */
export interface EnqueueFailure {
  nodeId: string;
  /** 失败性质（来自 `native/spawn-failure.ts` 的分类）。 */
  code: string;
  /** 原始错误文本（截断到合理长度，够排障即可）。 */
  message: string;
  at: string;
}

/**
 * 宿主自己报的**全局退避**：这段时间内不要再派任何节点。
 *
 * 为什么必须是全局而不是逐节点：`host-capacity` 描述的是**宿主**的状态
 * （并发/配额/速率上限），不是某个节点的属性。记成逐节点就等于「每个节点各自
 * 撞一次宿主」，而宿主满载时它们会一起撞——越撞越满。
 *
 * 为什么从 journal 推而不存计数器：与 `enqueue-state` / `rate-window` /
 * `gate-history` 同一条判断。存成字段就有「字段与事件不一致」的维护点，
 * 而且重启后归零——宿主还在满载，调度器却以为可以派了。
 */
export interface EnqueueBackoff {
  /** 退避截止时刻（毫秒）。 */
  untilMs: number;
  /** 截止时刻的 ISO 形式（对外展示用，避免调用方各自 `new Date()`）。 */
  until: string;
  /** 这条退避是从什么时候开始算的（那次失败的 `at`）。 */
  since: string;
  /** 宿主当时报的退避时长；缺失时按 0 处理（=没有依据的满载，不进退避）。 */
  retryAfterMs: number;
  /** 触发退避的节点（便于回答「那次是派谁撞上的」）。 */
  nodeId: string | null;
  /** 宿主原始错误文本（截断），够排障即可。 */
  message: string;
}

export interface EnqueueState {
  /** nodeId → 仍认为有活 worker 的登记。 */
  live: Map<string, EnqueueRecord>;
  /** 已被终态事件释放的节点（用于解释「为什么又派了一次」）。 */
  released: Map<string, EnqueueRelease>;
  /**
   * 确定性派发失败的节点（重试无用，必须改配置/改任务）。
   *
   * 为什么单列而不是并进 `released`：`released` 的语义是「可以重派了」，
   * 而这里恰好相反——「不要再派了」。混在一起会让 `explainRelease` 说出
   * 自相矛盾的话，也会让调度器把永不成功的节点当成可重试。
   *
   * 清除条件：该节点后来**成功**派发（`node_enqueued`）。这给出了一条自然的
   * 恢复路径——人改完配置后手动派一次，登记自动失效。
   */
  failed: Map<string, EnqueueFailure>;
  /**
   * 最近一次**宿主满载**留下的全局退避；`null` = 没有退避在生效。
   *
   * 语义：`backoff.untilMs > now` 时，任何派发都该被挡住，而不是每 tick 硬撞。
   * 只由 `retryable !== false` 且带 `retryAfterMs` 的 `node_enqueue_failed` 产生。
   */
  backoff: EnqueueBackoff | null;
  /** 缺 nodeId 而被忽略的行数（数据质量问题，值得暴露而不是静默）。 */
  ignored: number;
}

export interface DeriveOptions {
  /** 当前毫秒时间；不传则不做过期判定。 */
  now?: number;
  /**
   * **已 claim** 的登记超过该毫秒数无活动即视为失联（worker 崩了）。
   * 0 或缺省 = 用 `unclaimedMaxAgeMs` 兜底（保持旧行为）。
   * 建议取租约 TTL 的 2–3 倍：短于 TTL 会把正常干活的 worker 判死。
   */
  maxAgeMs?: number;
  /**
   * **未 claim** 的登记超过该毫秒数即视为失联。
   *
   * 为什么必须与 `maxAgeMs` 分开：这两个数回答的是**两个不同的问题**。
   *
   *   - `claimed === false`：worker 派出去了，但从没拿到租约。它连 claim 都没走到，
   *     说明它要么崩在启动阶段、要么宿主根本没把它拉起来。这个状态**没有任何
   *     能证明它活着的信号**——`task_claimed` 会在几秒内到达，等 30 分钟只是
   *     让一个已经死掉的登记把 `queuedWorkers()` 的计数撑满，把 queue 闸门堵死。
   *   - `claimed === true`：worker 拿到过租约，之后可能在长时间干活（一次工具调用
   *     跑十几分钟很正常），这时沉默是**可疑但不致命**的，必须等更久。
   *
   * 用一个常数同时回答这两个问题是第 26 轮之前的状态：worker 崩在 claim 之前，
   * 节点被"已派"占着 30 分钟，期间 `maxQueuedTasks` 被这些幽灵登记吃满，
   * 新节点一个都派不出去（实测 100 个崩在启动的 worker ⇒ queue 闸门 100% 卡死）。
   *
   * 0 或缺省 = 不单独判定，沿用 `maxAgeMs`（向后兼容）。
   */
  unclaimedMaxAgeMs?: number;
}

const RELEASE_REASONS = new Set<EnqueueReleaseReason>([
  'completed',
  'claim-rejected',
  'heartbeat-failed',
  'reaped',
  'stale',
  'lease-expired',
  'never-claimed',
]);

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nodeIdOf(row: EnqueueJournalRow): string {
  return text(row.nodeId) || text(row.node_id);
}

function atOf(row: EnqueueJournalRow): string {
  const at = text(row.at);
  return at || new Date(0).toISOString();
}

/**
 * ISO 时间串 → 毫秒。解析失败返回 `NaN`（调用方一律「跳过而不是当成很久以前」）。
 *
 * 抽成函数是为了让「解析失败怎么办」只有一处定义：`sweepStale` 与 `trimReleased`
 * 各自 `Date.parse` 过一次的写法，在改判据时极易只改一处。
 */
function msOf(at: string): number {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function sessionIdsOf(row: EnqueueJournalRow): string[] {
  const ids: string[] = [];
  for (const field of [row.applied, row.archived]) {
    if (!Array.isArray(field)) continue;
    for (const item of field) {
      const id = text(item);
      if (id) ids.push(id);
    }
  }
  return ids;
}

/**
 * 逐行折叠出「当前哪些节点有活 worker」。
 *
 * 纯函数：不改入参、不读时钟以外的外部状态，可对历史 journal 反复重放。
 */
export function deriveEnqueueState(
  rows: readonly EnqueueJournalRow[],
  options: DeriveOptions = {},
): EnqueueState {
  const state = emptyEnqueueState();
  applyEnqueueRows(state, rows);
  return sweepStale(state, options);
}

/** 空状态（增量折叠的起点，也是 `deriveEnqueueState` 的初值）。 */
export function emptyEnqueueState(): EnqueueState {
  return { live: new Map(), released: new Map(), failed: new Map(), backoff: null, ignored: 0 };
}

/**
 * 把新行**追加折叠**进已有状态（原地修改 `state`）。
 *
 * 为什么需要增量：journal 只追加，70000 行重折叠要 22 ms，而派发每轮都要问一次
 * 「这个节点有活 worker 吗」。增量折叠把每轮成本降到「新增行数」，与历史长度无关。
 *
 * **本函数不做失联判定**：超时是「此刻的判定」，不是行本身的语义。如果在这里
 * 顺手做，分块折叠时中间那块边界就会把后面还会续租的 worker 判死，结果与全量折叠
 * 不等价（实测 60 组随机 journal 里有 17 组不一致）。所以折叠只忠于行序，
 * 失联交给 `sweepStale()` 在折叠完成后做一次。
 *
 * 调用方负责只传**未折叠过的**新行，且保持顺序。
 */
export function applyEnqueueRows(
  state: EnqueueState,
  rows: readonly EnqueueJournalRow[],
): EnqueueState {
  const { live, released, failed } = state;
  let { ignored } = state;
  // sessionId → nodeId 的索引在增量下必须能从 live 现算（live 只含活跃 worker，规模等于并发数）。
  const sessionIndex = () => {
    const map = new Map<string, string>();
    for (const record of live.values()) {
      if (record.sessionId) map.set(record.sessionId, record.nodeId);
    }
    return map;
  };

  const release = (nodeId: string, reason: EnqueueReleaseReason, at: string, gate?: string) => {
    const record = live.get(nodeId);
    if (!record) return;
    live.delete(nodeId);
    released.set(nodeId, { nodeId, sessionId: record.sessionId, reason, at, ...(gate ? { gate } : {}) });
  };

  const touch = (nodeId: string, at: string, claimed: boolean) => {
    const record = live.get(nodeId);
    if (!record) return;
    // 只在时间前进时更新：journal 乱序时不要把记录改旧。
    if (at >= record.at) {
      record.at = at;
      record.atMs = msOf(at);
    }
    if (claimed) record.claimed = true;
  };

  for (const row of rows) {
    const kind = text(row.kind);
    if (!kind) continue;
    const nodeId = nodeIdOf(row);
    const at = atOf(row);

    if (kind === 'node_enqueued') {
      if (!nodeId) {
        ignored += 1;
        continue;
      }
      const sessionId = text(row.sessionId ?? row.session_id) || null;
      live.set(nodeId, {
        nodeId,
        instanceId: text(row.instanceId ?? row.instance_id) || null,
        sessionId,
        at,
        atMs: msOf(at),
        claimed: false,
      });
      // 重新登记能解释掉上一次的释放记录。
      released.delete(nodeId);
      // 成功派发 ⇒ 之前的确定性失败登记失效（人改完配置后手动派一次就是这条路）。
      failed.delete(nodeId);
      // 成功派发也**证明了**退避已过期——真的派进去了。不清掉就会出现
      // 「退避还没到期、但宿主其实已经缓过来」的假卡顿。
      state.backoff = null;
      continue;
    }

    if (kind === 'node_enqueue_failed') {
      // 派发失败不是状态变更：不能释放已有登记，也不能登记新节点。
      // 但**确定性**失败要入册，否则调度器下一轮还会派它，每轮白烧一次 spawn。
      // 宿主满载（retryable!==false）不入册——那种失败重试就会成功。
      if (row.retryable === false && nodeId) {
        failed.set(nodeId, {
          nodeId,
          code: text(row.failureCode) || 'assembly-failed',
          message: text(row.error).slice(0, 400),
          at,
        });
      }
      // 宿主自己报了退避时长 ⇒ 记成**全局**退避（它不是某个节点的属性）。
      // 只认可重试的失败：组装失败永远不再派，它的退避时长没有任何意义。
      if (row.retryable !== false) {
        const retryAfterMs = Number(row.retryAfterMs);
        const atMs = msOf(at);
        if (Number.isFinite(retryAfterMs) && retryAfterMs > 0 && Number.isFinite(atMs)) {
          const untilMs = atMs + retryAfterMs;
          // 多条并存时取**最晚**的那条：宿主连续满载两次，第二次往往报得更久；
          // 取最早会因为「上一轮已经等过一会儿」而提前解除退避。
          if (!state.backoff || untilMs > state.backoff.untilMs) {
            state.backoff = {
              untilMs,
              until: new Date(untilMs).toISOString(),
              since: at,
              retryAfterMs,
              nodeId: nodeId || null,
              message: text(row.error).slice(0, 200),
            };
          }
        }
      }
      continue;
    }

    if (kind === 'task_claimed') {
      touch(nodeId, at, true);
      continue;
    }

    if (kind === 'task_heartbeat_ok') {
      touch(nodeId, at, true);
      continue;
    }

    if (kind === 'task_heartbeat_failed') {
      release(nodeId, 'heartbeat-failed', at);
      continue;
    }

    if (kind === 'task_claim_rejected') {
      // 预算耗尽与另外三种闸门**不是同一类**：容量/分区/速率都是瞬时条件，
      // 放回可派是正确处置（下一轮条件会变）；预算耗尽不会自己变好，放回可派
      // 只会「派一个 → 被拒 → 再放回」无限空转，每轮白烧一次 spawn。
      // 所以预算拒绝要像 `node_enqueue_failed` 那样进 `failed`（=别再派了），
      // 而不是进 `released`（=可以重派）。
     
      const gate = text(row.gate);
      if (gate === 'budget') {
        if (nodeId) {
          failed.set(nodeId, {
            nodeId,
            code: 'budget-exhausted',
            message: text(row.error).slice(0, 400) || '预算耗尽（准入拒绝）',
            at,
          });
        }
        // 登记仍要清掉：worker 已经按契约停手了，不能当成还活着。
        release(nodeId, 'claim-rejected', at, gate);
        continue;
      }
      release(nodeId, 'claim-rejected', at, gate || undefined);
      continue;
    }

    if (kind === 'verify_done_requested') {
      release(nodeId, 'completed', at);
      continue;
    }

    if (kind === 'agent_reap_applied') {
      const index = sessionIndex();
      for (const sessionId of sessionIdsOf(row)) {
        const target = index.get(sessionId);
        if (target) release(target, 'reaped', at);
      }
      continue;
    }

    // 租约到期回收：租约是权威的存活证明；过期 = 不再持有，释放登记。
    // 比 `stale`（30 分钟沉默）更早，且不需要猜。
    if (kind === 'lease_reaped') {
      release(nodeId, 'lease-expired', at);
      continue;
    }
  }

  state.ignored = ignored;
  return state;
}

/**
 * 失联判定（**不修改入参**，返回新状态）。
 *
 * 语义：fold 完成后对当前活登记做一次"还能不能证明它活着"的判定。
 *
 * 两种登记用**两个不同的阈值**，因为它们能拿到的证据不同：
 *
 * | 登记状态 | 证据 | 阈值 | 释放原因 |
 * |---|---|---|---|
 * | `claimed === false` | 什么都没有（连 claim 都没到） | `unclaimedMaxAgeMs`（短） | `never-claimed` |
 * | `claimed === true` | 拿到过租约，之后可能在长跑 | `maxAgeMs`（长） | `stale` |
 *
 * 为什么单独一步、且不回写折叠状态：超时是**观测时刻的判定**，不是历史事实。
 * 把它写回折叠状态会污染增量续折的等价性（见 `applyEnqueueRows` 的说明）。
 */
export function sweepStale(state: EnqueueState, options: DeriveOptions = {}): EnqueueState {
  const now = Number(options.now);
  if (!Number.isFinite(now)) return state;
  const claimedRaw = Number(options.maxAgeMs);
  const unclaimedRaw = Number(options.unclaimedMaxAgeMs);
  const claimedLimit = Number.isFinite(claimedRaw) && claimedRaw > 0 ? claimedRaw : 0;
  // 未给 `unclaimedMaxAgeMs` 时沿用 `maxAgeMs`：旧调用方行为**逐字节不变**，
  // 连释放原因也仍是 `stale`（不把新枚举偷偷塞给没启用新口径的调用方）。
  const splitByClaim = Number.isFinite(unclaimedRaw) && unclaimedRaw > 0;
  const unclaimedLimit = splitByClaim ? unclaimedRaw : claimedLimit;
  if (claimedLimit <= 0 && unclaimedLimit <= 0) return state;

  // **先扫、再拷**：旧实现无条件 `new Map(state.live)` + `new Map(state.released)`，
  // 68600 条 live 时仅拷贝就 12 ms，而绝大多数调用根本没有过期项。
  // 现在先收集待删名单，`changed=false` 时直接返回原状态（零分配）。
  const expired: EnqueueRecord[] = [];
  for (const record of state.live.values()) {
    // 用折叠时算好的 atMs：旧实现每轮对全部 live 重新 Date.parse，
    // 68600 条时 17 ms。live 的规模是「已派未释放」的累积量（默认上界 18 万条），
    // 不是并发数，所以这个成本每轮 tick 都要付。
    if (!Number.isFinite(record.atMs)) continue;
    const limit = record.claimed ? claimedLimit : unclaimedLimit;
    if (limit <= 0) continue;
    if (now - record.atMs <= limit) continue;
    expired.push(record);
  }
  if (expired.length === 0) return state;

  const live = new Map(state.live);
  const released = new Map(state.released);
  const at = new Date(now).toISOString();
  for (const record of expired) {
    live.delete(record.nodeId);
    released.set(record.nodeId, {
      nodeId: record.nodeId,
      sessionId: record.sessionId,
      reason: splitByClaim && !record.claimed ? 'never-claimed' : 'stale',
      at,
    });
  }
  return { live, released, failed: state.failed, backoff: state.backoff, ignored: state.ignored };
}

/** 释放原因是否属已知枚举（供测试与 schema 校验用）。 */
export function isEnqueueReleaseReason(value: unknown): value is EnqueueReleaseReason {
  return typeof value === 'string' && RELEASE_REASONS.has(value as EnqueueReleaseReason);
}

/**
 * 裁剪 `released` 到最近 `keep` 条（按 `at` 倒序保留）。
 *
 * 为什么必须裁：`released` 是**解释性**数据（"这个节点上次为什么被释放"），
 * 不参与判定。只增不减的话，长跑之后它会随节点数线性膨胀，而它只用来回答
 * 「刚才那次派发为什么可以重派」。保留最近一小段足够，判定仍以 `live` 为准。
 */
export function trimReleased(state: EnqueueState, keep = 200): EnqueueState {
  if (state.released.size > keep) {
    const rows = [...state.released.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    state.released.clear();
    for (const row of rows.slice(0, keep)) state.released.set(row.nodeId, row);
  }
  // `failed` 同样只作解释用，也必须有界：长跑中每轮都失败的老节点会把它撑大。
  if (state.failed.size > keep) {
    const rows = [...state.failed.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    state.failed.clear();
    for (const row of rows.slice(0, keep)) state.failed.set(row.nodeId, row);
  }
  return state;
}

/** 给调用方看的简短说明：为什么这个节点允许被再次派发。 */
export function explainRelease(release: EnqueueRelease | undefined | null): string {
  if (!release) return '无派发登记：从未派过或早已释放';
  switch (release.reason) {
    case 'completed':
      return `节点已完成（${release.at}），无需再派`;
    case 'claim-rejected':
      return `上一个 worker 的 task_claim 被准入拒绝后按契约停手（${release.at}）${gateNote(release.gate)}`;
    case 'heartbeat-failed':
      return `上一个 worker 续租失败，已按契约停手（${release.at}）`;
    case 'reaped':
      return `上一个 worker 的会话被回收（${release.at}）`;
    case 'stale':
      return `上一个 worker 长时间无心跳，无法证明仍在运行（判定于 ${release.at}）`;
    case 'lease-expired':
      return `上一个 worker 的租约到期被回收：租约是权威的存活证明，过期即不再持有（${release.at}）`;
    case 'never-claimed':
      return `上一个 worker 派出去后一直没 claim 到租约（崩在启动或未被拉起），宽限期到后释放（${release.at}）`;
    default:
      return '已释放';
  }
}

/**
 * 闸门 → 一句处置建议。故意与 `dispatch/dispatcher.ts` 的 `gateAdvice` 分开写：
 * 那份面向「计划层为什么没派」，这份面向「上一个 worker 为什么停手」，
 * 两者措辞不同但结论必须一致。
 */
function gateNote(gate: string | undefined): string {
  switch (gate) {
    case 'capacity':
      return '；原因=全图容量触顶，等 worker 完成或租约释放';
    case 'partition':
      return '；原因=所属协调域满员，换域外节点或等域内完成';
    case 'rate':
      return '；原因=领取速率超限，退避到下一窗口即自动恢复';
    case 'budget':
      return '；原因=预算耗尽，**重试无用**——须加预算或缩范围';
    default:
      return '';
  }
}

/**
 * 给调用方看的说明：为什么这个节点**不该再派**。
 *
 * 与 `explainRelease` 是相反的两件事，所以分开写而不是加一个布尔参数——
 * 一句说明里同时包含「可以重派」和「别再派了」两种含义，读的人必然误判。
 */
export function explainFailure(failure: EnqueueFailure | undefined | null): string {
  if (!failure) return '无确定性失败登记';
  // 预算耗尽与组装失败的**解除方式不同**：前者要加预算/缩范围，后者要改配置/改任务。
  // 共用一句「改配置或改任务后手动派一次」会让预算问题被当成配置问题查半天。
  if (failure.code === 'budget-exhausted') {
    return `预算耗尽（${failure.at}）：${failure.message}；重试无用——加预算或缩范围后手动派一次才会解除`;
  }
  return `确定性派发失败（${failure.code}，${failure.at}）：${failure.message}；改配置或改任务后手动派一次才会解除`;
}

/**
 * 当前是否处在宿主退避窗口内；在窗口内返回一句人话，否则 null。
 *
 * 判据只有 `untilMs > now` 这一条，**不猜**「宿主可能已经好了」——
 * 提前解除退避正是这轮要修的那个行为（每 tick 硬撞）。
 * 而「宿主其实提前恢复」的场景由 `node_enqueued` 清空退避兜住：
 * 只要有一次成功派发，退避立刻作废，不会留下假卡顿。
 */
export function backoffReason(backoff: EnqueueBackoff | null | undefined, now: number): string | null {
  if (!backoff) return null;
  if (!Number.isFinite(backoff.untilMs) || !Number.isFinite(now)) return null;
  const remaining = backoff.untilMs - now;
  if (remaining <= 0) return null;
  const seconds = Math.ceil(remaining / 1000);
  const who = backoff.nodeId ? `（${backoff.nodeId}）` : '';
  return `宿主退避中${who}：${backoff.since} 那次派发失败，宿主报 ${Math.round(backoff.retryAfterMs / 1000)} 秒后再试，还剩约 ${seconds} 秒`;
}
