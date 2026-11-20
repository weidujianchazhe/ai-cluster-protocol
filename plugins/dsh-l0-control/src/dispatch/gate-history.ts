/**
 * 闸门命中的**跨轮累积**：回答「这一段时间主要卡在哪道闸门」。
 *
 * 上一轮（第 19/20 轮）把「这一轮为什么只派了 3 个」做成可归因：每轮 `dispatch_tick`
 * 事件带 `gates` 分组计数。但那只是**最近一轮**的答案。
 *
 * 最近一轮回答不了排障时最常问的那个问题：
 *
 *   派了半小时，一共 600 轮，其中 580 轮只派了 1 个——**到底卡在哪**？
 *
 * 逐轮看要么翻 600 行 journal，要么正好撞上一轮「没被挡」的（瞬时原因会让相邻两轮
 * 完全不同），于是结论随取样时刻漂移。累积视图把窗口内所有轮次的 `gates` 加起来，
 * 得到一个与取样时刻无关的分布。
 *
 * ## 为什么必须从 journal 折叠
 *
 * 累积量是**派生量**，不是新状态。存成计数器就有「计数器与事件不一致」的维护点，
 * 而且进程重启后归零——恰恰在最需要它的时候（崩了重启）失效。这与 `rate-window.ts`
 * 和 `enqueue-state.ts` 是同一条判断：journal 是单一事实源，累积量从它推。
 *
 * ## 未知轮次要单列，不能当成「没被挡」
 *
 * 旧版本写的 `dispatch_tick` 行没有 `gates` 字段。那种行**不能**算进「本轮没被挡」——
 * 我们只是不知道，不是知道没有。混进去会让命中率被系统性低估，而低估的方向正好是
 * 「看起来一切正常」。所以 `unknownTicks` 单独计数，并且只要它非零，`explain` 里
 * 就必须说明「有 N 轮无归因数据」，不让人把「没数据」读成「没问题」。
 */
import type { DispatchGate } from '../core/dispatcher.js';

/** 折叠需要的最小行形状——只读 `kind` / `at` / `gates`。 */
export interface GateHistoryRow {
  kind?: unknown;
  at?: unknown;
  gates?: unknown;
}

export interface GateHistory {
  /** 窗口覆盖的时间范围（毫秒）；0 = 不限时间，只按 `maxTicks` 取。 */
  windowMs: number;
  /** 窗口内计入的 tick 数（含 `unknownTicks`）。 */
  ticks: number;
  /** 窗口内各闸门累计命中节点数（不是轮次数：一轮挡 4 个节点就计 4）。 */
  counts: Partial<Record<DispatchGate, number>>;
  /** 命中节点数最多的闸门；窗口内没有任何命中时为 null。 */
  dominant: DispatchGate | null;
  /** dominant 那句人话：该做什么。 */
  explain: string;
  /** 窗口内确实「一个都没挡」的轮次数（`gates` 存在但为空）。 */
  cleanTicks: number;
  /** 窗口内 `gates` 字段缺失的轮次数（旧版本写的行；不等于「没挡」）。 */
  unknownTicks: number;
  /** 最早/最晚一轮的时间；窗口内无 tick 时为 null。 */
  since: string | null;
  until: string | null;
}

export interface GateHistoryOptions {
  /** 默认 5 分钟：足够跨过瞬时波动，又不至于把一小时前的旧配置混进来。 */
  windowMs?: number;
  /** 硬上限，防止有人把 windowMs 设成很大时扫全部历史。默认 5000 轮。 */
  maxTicks?: number;
}

/**
 * 按「越难恢复的越优先」排 —— 与 `core/dispatcher.ts` 的 `limitingGate` **同一顺序**。
 *
 * 为什么必须同一顺序：两个视图对同一批数据给出不同的「主要瓶颈」是最坏的情况——
 * 面板说「主要是 capacity」，逐轮归因说「主要是 queue」，看的人只会认为统计坏了。
 */
const GATE_PRIORITY: readonly DispatchGate[] = [
  // 宿主退避排最前：它生效时**任何**节点都派不出去，其余闸门此刻都没在决定什么。
  // 排在后面的话，面板会在「宿主满载 20 轮」里报出「主要是 capacity」——
  // 而 capacity 的处置（调 maxParallel）对这个现象完全无效。
  'host-backoff',
  'capacity',
  'partition',
  'queue',
  'rate',
  'budget',
  'guard',
  'replay',
  'tick',
];

const KNOWN_GATES = new Set<string>(GATE_PRIORITY);

function gateAdviceText(gate: DispatchGate): string {
  switch (gate) {
    case 'capacity':
      return '全图容量触顶：等 worker 完成或租约释放，或调大 maxParallel';
    case 'host-backoff':
      return '宿主退避窗口内：调本插件的任何上限都无效，等到点或降低整体派发速率';
    case 'partition':
      return '某个协调域满员：换域外节点，或调大该分区 maxActive（调全图额度无用）';
    case 'queue':
      return '已派未领取的积压触顶：等 claim 或释放，或调大 maxQueuedTasks';
    case 'rate':
      return '派发速率触顶：等下一窗口，或调大 dispatchRatePerSecond';
    case 'budget':
      return '预算耗尽：须加预算或缩范围，重试无用';
    case 'guard':
      return '巡检 critical：先看一眼节点为什么卡住';
    case 'replay':
      return '检查点显示已完成：避免重做，先核对 journal 是否被改写';
    case 'tick':
      return '单轮限额到量：下一轮自动继续，或调大 dispatchMaxPerTick';
    default:
      return '未知闸门';
  }
}

/** 从一行里取 `gates`，做类型收敛；返回 null 表示「这行没有归因数据」。 */
function gatesOf(row: GateHistoryRow): Partial<Record<DispatchGate, number>> | null {
  const raw = row?.gates;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    // 缺字段 = 旧版本写的行 = 不知道，不是「没挡」。
    return null;
  }
  const out: Partial<Record<DispatchGate, number>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const count = Number(value);
    if (!Number.isFinite(count) || count <= 0) continue;
    // 未知闸门名按原样保留（前向兼容：新版本加了闸门，旧面板不该崩，也不该悄悄丢掉）。
    out[key as DispatchGate] = (out[key as DispatchGate] ?? 0) + Math.floor(count);
  }
  return out;
}

/**
 * 折叠窗口内的闸门命中分布。
 *
 * 从尾部往前扫、遇到超出窗口就停——journal 只追加、时间单调，所以单轮成本是
 * O(窗口内行数)，不是 O(全部历史)。
 */
export function foldGateHistory(
  rows: readonly GateHistoryRow[],
  now: number,
  options: GateHistoryOptions = {},
): GateHistory {
  const windowMs = Number.isFinite(Number(options.windowMs)) && Number(options.windowMs) > 0
    ? Math.floor(Number(options.windowMs))
    : 300_000;
  const maxTicks = Number.isFinite(Number(options.maxTicks)) && Number(options.maxTicks) > 0
    ? Math.floor(Number(options.maxTicks))
    : 5_000;
  const since = now - windowMs;

  const counts: Partial<Record<DispatchGate, number>> = {};
  let ticks = 0;
  let cleanTicks = 0;
  let unknownTicks = 0;
  let sinceAt: string | null = null;
  let untilAt: string | null = null;

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (String(row?.kind ?? '') !== 'dispatch_tick') continue;
    const at = Date.parse(String(row?.at ?? ''));
    // 时间戳解析失败：跳过而不是当成「很久以前」——宁可少算也不误判。
    if (!Number.isFinite(at)) continue;
    if (at <= since) break;
    if (ticks >= maxTicks) break;

    ticks += 1;
    const atText = String(row.at);
    if (!untilAt || atText > untilAt) untilAt = atText;
    if (!sinceAt || atText < sinceAt) sinceAt = atText;

    const gates = gatesOf(row);
    if (gates === null) {
      unknownTicks += 1;
      continue;
    }
    const entries = Object.entries(gates) as Array<[DispatchGate, number]>;
    if (entries.length === 0) {
      cleanTicks += 1;
      continue;
    }
    for (const [gate, count] of entries) counts[gate] = (counts[gate] ?? 0) + count;
  }

  // 聚合交给 summarize()：与增量折叠共用同一份 dominant/explain 逻辑，
  // 两处各写一套就会出现「同一个面板在不同窗口下说法不一样」。
  return summarize({ windowMs, ticks, counts, cleanTicks, unknownTicks, sinceAt, untilAt });
}

/** 环里的一条：一轮 tick 的时间与归因（`null` = 旧版本写的、没有归因）。 */
interface TickEntry {
  at: number;
  atText: string;
  gates: Partial<Record<DispatchGate, number>> | null;
}

/**
 * 增量折叠器：**每次只处理新增行**，窗口内聚合只走 ring，不重扫 journal。
 *
 * 为什么需要它：`foldGateHistory` 每次从尾部往前扫到窗口边界，成本是
 * **窗口内的 journal 行数**。默认 5 分钟窗口通常只有几十行 tick、可忽略；
 * 但把 `windowMs` 调到 1 小时，窗口里是**万行**（journal 里绝大多数行不是 tick），
 * 而 `dispatchView()` 每轮派发都会被调一次。
 *
 * 增量版把成本拆成两块：
 *   - 新行：只扫上次游标之后的（与历史长度无关）；
 *   - 聚合：只遍历 ring（长度上界 = `maxTicks`），不再碰行数组。
 *
 * ## 为什么存 ring 而不是只存累加值
 *
 * 滑动窗口需要**过期**。只存 `{counts, ticks, ...}` 的累加值就删不掉过期项——
 * 要么把过期项也加进去（越算越多，一小时前的旧原因永远不清零），
 * 要么每次重算（回到原问题）。所以保留窗口内的逐轮条目，聚合时现算。
 *
 * ring 有硬上限：超过 `maxTicks` 就从头丢。丢的是**最旧**的，与
 * `foldGateHistory` 的「超过 maxTicks 就不再往前扫」语义一致。
 *
 * ## 与全量折叠的等价性
 *
 * `snapshot()` 的结果与 `foldGateHistory(rows, now, options)` 逐字段相同——
 * 这是本类唯一的正确性标准，测试里对同一批行做双向比对。
 */
export class GateHistoryFolder {
  private entries: TickEntry[] = [];
  private cursor = 0;
  private options: Required<GateHistoryOptions>;

  constructor(options: GateHistoryOptions = {}) {
    this.options = {
      windowMs: Number.isFinite(Number(options.windowMs)) && Number(options.windowMs) > 0
        ? Math.floor(Number(options.windowMs))
        : 300_000,
      maxTicks: Number.isFinite(Number(options.maxTicks)) && Number(options.maxTicks) > 0
        ? Math.floor(Number(options.maxTicks))
        : 5_000,
    } as Required<GateHistoryOptions>;
  }

  /** 换窗口时清空——旧 ring 是按旧窗口裁的，混用会让聚合口径不一致。 */
  reconfigure(options: GateHistoryOptions = {}): void {
    const next = {
      windowMs: Number.isFinite(Number(options.windowMs)) && Number(options.windowMs) > 0
        ? Math.floor(Number(options.windowMs))
        : 300_000,
      maxTicks: Number.isFinite(Number(options.maxTicks)) && Number(options.maxTicks) > 0
        ? Math.floor(Number(options.maxTicks))
        : 5_000,
    } as Required<GateHistoryOptions>;
    if (next.windowMs === this.options.windowMs && next.maxTicks === this.options.maxTicks) return;
    this.options = next;
    this.entries = [];
    this.cursor = 0;
  }

  /**
   * 把新行折进 ring，返回窗口内的聚合结果。
   *
   * journal 变短（旋转/截断）时整块重来：沿用旧 ring 会把已被裁掉的轮次算进去。
   *
   * 用下标循环而不是 `rows.slice(cursor)`：**两者实测同价**（70000 行稳态
   * 0.0003 ms vs 0.0004 ms），因为 `slice(cursor)` 本身就是 O(尾部长度)，
   * 而稳态尾部是 0——它从来不是瓶颈。改成下标循环只是为了省一个中间数组，
   * 不是性能优化；这里不宣称任何提速。
   */
  fold(rows: readonly GateHistoryRow[], now: number): GateHistory {
    if (rows.length < this.cursor) {
      this.entries = [];
      this.cursor = 0;
    }
    for (let index = this.cursor; index < rows.length; index += 1) {
      const row = rows[index];
      if (String(row?.kind ?? '') !== 'dispatch_tick') continue;
      const at = Date.parse(String(row?.at ?? ''));
      // 时间戳解析失败：跳过而不是当成「很久以前」——与全量折叠同口径。
      if (!Number.isFinite(at)) continue;
      this.entries.push({ at, atText: String(row.at), gates: gatesOf(row) });
    }
    this.cursor = rows.length;
    // 过期裁剪 + 硬上限：两件事都是「丢最旧的」，合并成一次从头部切。
    const since = now - this.options.windowMs;
    let start = 0;
    while (start < this.entries.length && this.entries[start].at <= since) start += 1;
    if (this.entries.length - start > this.options.maxTicks) {
      start = this.entries.length - this.options.maxTicks;
    }
    if (start > 0) this.entries = this.entries.slice(start);
    return this.aggregate(now);
  }

  /**
   * 聚合当前 ring。**与 `foldGateHistory` 逐字段同口径**（含 `explain` 措辞）——
   * 两处如果各写一套，面板和测试就会对同一批数据给出不同答案。
   */
  private aggregate(now: number): GateHistory {
    const windowMs = this.options.windowMs;
    const counts: Partial<Record<DispatchGate, number>> = {};
    let ticks = 0;
    let cleanTicks = 0;
    let unknownTicks = 0;
    let sinceAt: string | null = null;
    let untilAt: string | null = null;

    for (const entry of this.entries) {
      ticks += 1;
      if (!untilAt || entry.atText > untilAt) untilAt = entry.atText;
      if (!sinceAt || entry.atText < sinceAt) sinceAt = entry.atText;
      if (entry.gates === null) {
        unknownTicks += 1;
        continue;
      }
      const entries = Object.entries(entry.gates) as Array<[DispatchGate, number]>;
      if (entries.length === 0) {
        cleanTicks += 1;
        continue;
      }
      for (const [gate, count] of entries) counts[gate] = (counts[gate] ?? 0) + count;
    }
    void now;
    return summarize({ windowMs, ticks, counts, cleanTicks, unknownTicks, sinceAt, untilAt });
  }
}

/**
 * 把已聚合的计数整理成对外结果（`dominant` / `explain` 的唯一实现处）。
 *
 * 全量折叠与增量折叠都走这里——两处各写一套 `explain` 措辞，就会出现
 * 「同一个面板在不同窗口下说法不一样」，看的人只会认为统计坏了。
 */
function summarize(input: {
  windowMs: number;
  ticks: number;
  counts: Partial<Record<DispatchGate, number>>;
  cleanTicks: number;
  unknownTicks: number;
  sinceAt: string | null;
  untilAt: string | null;
}): GateHistory {
  const { windowMs, ticks, counts, cleanTicks, unknownTicks, sinceAt, untilAt } = input;

  // dominant：命中最多；并列时按「越难恢复越优先」，与逐轮归因同序。
  //
  // 未知闸门（新版本加的，比如未来的 `host`）**只看计数**：它不在优先表里，
  // 没有「恢复难度」可依据，所以只允许它**严格多于**已知闸门时胜出；打平则
  // 让已知的赢——已知的处置建议是确定的，未知的只能给个名字。
  //
  // 第一版写成 `if (!dominant) { …未知… }`，于是「未知 5、capacity 1」报的是
  // capacity——把真正的瓶颈藏了。这种错不会崩，只会让面板答错问题。
  let dominant: DispatchGate | null = null;
  let bestCount = 0;
  for (const gate of GATE_PRIORITY) {
    const count = counts[gate] ?? 0;
    if (count > bestCount) {
      bestCount = count;
      dominant = gate;
    }
  }
  for (const [gate, count] of Object.entries(counts) as Array<[DispatchGate, number]>) {
    if (KNOWN_GATES.has(gate)) continue;
    if (count > bestCount) {
      bestCount = count;
      dominant = gate;
    }
  }

  const parts: string[] = [];
  if (ticks === 0) {
    parts.push(`最近 ${Math.round(windowMs / 1000)} 秒内没有派发轮次`);
  } else if (dominant === null) {
    parts.push(`最近 ${ticks} 轮没有被挡下的节点`);
  } else {
    const advice = KNOWN_GATES.has(dominant)
      ? gateAdviceText(dominant)
      : `未知闸门 ${dominant}（本版本不认识，可能来自更新的日志），只能给出名字，无法给出处置建议`;
    parts.push(`最近 ${ticks} 轮里主要卡在 ${dominant}（累计 ${bestCount} 个节点）：${advice}`);
    // 分布排序必须**完全确定**：只按计数降序时，打平的项保留插入顺序，
    // 而全量折叠是尾部倒扫、增量折叠是头部顺扫——同一批数据会产出
    // 不同的 `explain` 文本（实测 `capacity×4 host×4` 与 `host×4 capacity×4`）。
    // 这类差异不会崩，只会让面板、日志、测试三处说法不一致，最难查。
    // 排序键：计数降序 → 已知闸门按 GATE_PRIORITY → 未知闸门按名字字典序。
    const rank = (gate: string): number => {
      const index = GATE_PRIORITY.indexOf(gate as DispatchGate);
      return index >= 0 ? index : GATE_PRIORITY.length;
    };
    const dist = (Object.entries(counts) as Array<[DispatchGate, number]>)
      .sort((a, b) => (b[1] - a[1]) || (rank(a[0]) - rank(b[0])) || String(a[0]).localeCompare(String(b[0])))
      .map(([gate, count]) => `${gate}×${count}`)
      .join(' ');
    if (dist) parts.push(`分布 ${dist}`);
  }
  if (unknownTicks > 0) {
    parts.push(`其中 ${unknownTicks} 轮无归因数据（旧版本写的日志），不计入命中统计`);
  }

  return {
    windowMs,
    ticks,
    counts,
    dominant,
    explain: parts.join('；'),
    cleanTicks,
    unknownTicks,
    since: sinceAt,
    until: untilAt,
  };
}
