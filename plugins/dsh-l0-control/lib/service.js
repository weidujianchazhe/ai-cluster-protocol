/**
 * `l0control` 服务：插件内门面（进程内单实例）。
 *
 * 边界（N2 只做壳）：
 *   - 图/ready/证据/done/决策/租约的**不变量**属 `src/core`（N3 写域）；这里只做
 *     参数校验、caller 取用、journal 追加与结果整形；
 *   - core 缺失时所有图操作 **fail-closed** 返回 `core-unavailable`，不假装成功；
 *   - `team_status` 是本层唯一直接打 `agentTeams` 的动作（验收要证明原生通道可用）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { CONFIG_SPEC, normalizeConfig } from './config.js';
import { AUDITOR_ROLES, CAPABILITIES, capabilitiesDigest, isAuditorInstance, roleOfInstance } from './capabilities.js';
import { CorePersistence } from './persistence.js';
import { NativeTeam } from './native/team.js';
import { runProjectInit } from './bootstrap/index.js';
                                                   

/** 工作区管理三态：off（默认，AI 不能自行建）/ auto（AI 自行决定）/ on（允许并鼓励）。 */
                                                   

export function normalizeManagement(value         )                 {
  const text = String(value ?? '').toLowerCase();
  return text === 'auto' || text === 'on' ? (text                  ) : 'off';
}

                              
                        
                                   
 

                             
                                                                                                                    
                                                 
                                                                      
                                                                                                            
                                                                                  
                                                                              
                                                                          
                                                                    
                                                                                 
                            
                                       
 

/** 阶段闸门的 5 段枚举（与 core `stages.ts` / Python STAGES 对齐）。 */
export const GATE_STAGES                    = ['research', 'design', 'build', 'audit', 'deliver'];

/**
 * 输入键名归一化：工具边界同时接受 snake_case 与 camelCase。
 *
 * 口径（Lead 2026-10-29 定）：**默认合并保留两种拼写**，让 core 自己挑
 * （core `facade.ts/evidence.ts` 读 `producerInstance` camel；Python 侧读 snake）。
 * 只有两种拼写同时存在且**值不同**才判 `key-conflict` —— 既不丢别名，也不要求"两种都得传"。
 *
 * `target` 仍可显式指定 'snake' | 'camel'，用于必须单选的调用点。
 */
const KEY_PAIRS                                                         = [
  ['producer_instance', 'producerInstance'],
  ['auditor_instance', 'auditorInstance'],
  ['option_id', 'optionId'],
  ['default_option_id', 'defaultOptionId'],
  ['timeout_sec', 'timeoutSec'],
  ['evidence_refs', 'evidenceRefs'],
];

export function normalizeKeys                                               (
  input   ,
  target                              = 'merge',
)    {
  if (!input || typeof input !== 'object') return input     ;
  const out                          = { ...(input                           ) };
  for (const [snake, camel] of KEY_PAIRS) {
    const hasSnake = snake in out;
    const hasCamel = camel in out;
    if (!hasSnake && !hasCamel) continue;
    if (hasSnake && hasCamel && out[snake] !== out[camel]) {
      throw new Error(`key-conflict:${snake}!=${camel}`);
    }
    const value = hasSnake ? out[snake] : out[camel];
    if (target === 'merge' || target === 'snake') out[snake] = value;
    if (target === 'merge' || target === 'camel') out[camel] = value;
    if (target === 'snake') delete out[camel];
    if (target === 'camel') delete out[snake];
  }
  return out     ;
}

/** 两种拼写都补齐（值相同），供 core 直接取用。 */
export function withAliases(input                         )                          {
  return normalizeKeys({ ...input }, 'merge');
}

function errorInfo(error         ) {
  const err = error                                                                  ;
  return { name: err?.name ?? 'Error', code: err?.code ?? null, message: String(err?.message || error) };
}

/** 读本插件 package.json 的 version（`lib/../package.json`）。 */
function readLocalVersion()         {
  try {
    const pkgPath = new URL('../package.json', import.meta.url);
    const raw = fs.readFileSync(pkgPath, 'utf8');
    return String((JSON.parse(raw)                        )?.version ?? '').trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 轻量 semver 比较：只按数字段比，缺失段补 0；返回 -1 / 0 / 1。 */
function compareSemver(a        , b        )         {
  const norm = (value        ) =>
    String(value ?? '')
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = norm(a);
  const right = norm(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const x = left[index] ?? 0;
    const y = right[index] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * 工具输出必须是 lossless JSON：宿主会拒收含类实例/代理/branded 的值
 * （`Agent` 句柄、`TeamMembership.root` 都会踩）。
 *
 * 策略（N1 spike 后收紧）：
 *   1. 只取**标量白名单**；嵌套结构降级成字符串或直接丢弃；
 *   2. 整段 `JSON.parse(JSON.stringify(...))` 兜底；
 *   3. 任何一步失败 → `{ok:false, error:'projection-failed'}`，绝不把原值抛给宿主。
 */
function scalar(value         )                                   {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return null;
}

function projectTeam(caller     , membership     , members       , tasks       ) {
  return {
    ok: true,
    native: true,
    caller: scalar(caller?.id),
    membership: {
      rootId: scalar(membership?.root?.id),
      id: scalar(membership?.id),
      role: scalar(membership?.role),
      name: scalar(membership?.name),
    },
    memberCount: members.length,
    members: members.map((member     ) => ({
      id: scalar(member?.id),
      name: scalar(member?.name),
      role: scalar(member?.role),
      status: scalar(member?.status),
      model: scalar(member?.model),
      provider: scalar(member?.provider),
    })),
    taskCount: tasks.length,
    tasks: tasks.map((task     ) => ({
      id: scalar(task?.id),
      revision: scalar(task?.revision),
      subject: scalar(task?.subject),
      status: scalar(task?.status),
      ownerName: scalar(task?.ownerName),
      ready: scalar(task?.ready),
      blockedByCount: Array.isArray(task?.blockedBy) ? task.blockedBy.length : 0,
    })),
  };
}
function toLossless(value         )          {
  return JSON.parse(JSON.stringify(value));
}

function listEntries(dir        , limit = 40)                                                {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'dir'          : 'file'          }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
      .slice(0, limit);
  } catch {
    return [];
  }
}

function readManagementCards(dir        , limit = 30)                                                                                             {
  try {
    const tasksDir = path.join(dir, 'tasks');
    if (!fs.existsSync(tasksDir)) return [];
    return fs.readdirSync(tasksDir)
      .filter((name) => name.endsWith('.md') && !name.endsWith('.lock'))
      .sort()
      .slice(0, limit)
      .map((name) => {
        let text = '';
        try {
          text = fs.readFileSync(path.join(tasksDir, name), 'utf8');
        } catch {
          return { name: name.replace(/\.md$/, ''), status: null, next: null, taskId: null };
        }
        const status = /\*\*状态\*\*：(.+)/.exec(text)?.[1]?.trim() ?? null;
        const next = /\*\*下一步\*\*：(.+)/.exec(text)?.[1]?.trim()
          ?? /-\s*①\s*(.+)/.exec(text)?.[1]?.trim() ?? null;
        const taskId = /\*\*TASK-ID\*\*：(.+)/.exec(text)?.[1]?.trim() ?? null;
        return { name: name.replace(/\.md$/, ''), status, next, taskId };
      });
  } catch {
    return [];
  }
}

export class L0ControlService {
           ctx     ;
           config                 ;
           meta             ;
           workspaceRoot        ;
           stateDir        ;
           journalPath        ;
           snapshotPath        ;
          corePromise                                    = null;
          persistenceRef                         = null;
          persistenceError                = null;
          nativeTeamRef                    = null;
          lastCaller      = null;
  /** 每个 session（对话窗口）最近一次成功投影的团队板快照；reload 后从 journal 逐 session 恢复。 */
          teamSnapshots = new Map                                                               ();
  /** 按对话的子 Agent（递归）快照；team_snapshot 只存团队板，descendants 要单独存。 */
          descendantSnapshots = new Map                                                                          ();
  /** 按对话的双轴状态：coordination（协作，默认 false）+ management（管理区，默认 'off'）。 */
          enabledSessions = new Map                                                                                              ();
          observability                                                                                                                         = null;

  constructor(ctx     , config          = {}, meta              = {}) {
    this.ctx = ctx;
    this.config = normalizeConfig(config);
    this.meta = meta;
    const configuredRoot = String(this.config.workspaceRoot ?? '').trim();
    let hostRoot = '';
    try {
      const workingDirectory = this.ctx.get?.('workingDirectory');
      hostRoot = String(workingDirectory?.defaultDirectory ?? '').trim();
    } catch {
      hostRoot = '';
    }
    const effectiveRoot = configuredRoot && configuredRoot !== '.' ? configuredRoot : (hostRoot || process.cwd());
    this.workspaceRoot = path.resolve(effectiveRoot);
    this.stateDir = path.resolve(this.workspaceRoot, this.config.stateDir);
    this.journalPath = path.join(this.stateDir, this.config.journalFile);
    this.snapshotPath = path.join(this.stateDir, this.config.snapshotFile);
    // reload 后恢复每个 session 的团队板快照：没有 live caller 时 UI 也能按对话窗口显示
    this.restoreTeamSnapshots();
    this.restoreAccess();
    this.restoreDescendantSnapshots();
  }

  /**
   * 从 journal 恢复**每个 session** 的最后一条 `team_snapshot`（后写覆盖前写）。
   * 旧格式（无 sessionId）的行忽略：跨 session 复用正是要修掉的 bug。
   */
          restoreTeamSnapshots()       {
    try {
      if (!fs.existsSync(this.journalPath)) return;
      const rows = this.readJournal();
      for (const row of rows) {
        if (row?.kind !== 'team_snapshot') continue;
        const sessionId = String(row.sessionId ?? '');
        const team = row.team                                       ;
        if (!sessionId || !team || typeof team !== 'object') continue;
        this.teamSnapshots.set(sessionId, {
          capturedAt: String(row.capturedAt ?? row.at ?? ''),
          team,
        });
      }
    } catch {
      // 恢复失败不阻断：UI 会显示 source='none'
    }
  }

  /** 原生执行层（懒建；实例表从 journal 回放，重启后 send_message 仍可用）。 */
  get native()             {
    if (!this.nativeTeamRef) {
      this.nativeTeamRef = new NativeTeam(this.ctx, {
        provider: this.config.nativeProvider,
        maxDepth: this.config.nativeMaxDepth,
      });
      try {
        this.nativeTeamRef.restoreFromJournal(this.readJournal());
      } catch {
        // 回放失败不阻断：实例表空着，spawn 会重新登记
      }
    }
    return this.nativeTeamRef;
  }

  // ── 宿主访问 ────────────────────────────────────────────────
  get agentTeams()      {
    return this.ctx.get('agentTeams');
  }

  get toolNames()           {
    const prefix = this.config.toolPrefix || '';
    return Object.keys(CAPABILITIES.tools).map((name) => `${prefix}${name}`);
  }

  // ── core 装载（N3 的模块；缺失则 fail-closed） ──────────────
  /** 打开 core↔state 桥（含 configureCore）；失败只记录，不阻断工具面。 */
  async persistence()                                  {
    if (!this.persistenceRef && !this.persistenceError) {
      try {
        const dir = path.resolve(this.stateDir, this.config.persistenceDir || 'core-state');
        this.persistenceRef = await CorePersistence.open({
          dir,
          mode: this.config.persistence === 'node' ? 'node' : 'memory',
          owner: 'dsh-l0-control',
          waitMs: Number((this.config                           ).lockWaitMs ?? 15000),
          ttlMs: Number((this.config                          ).lockTtlMs ?? 1800000),
        });
      } catch (error) {
        this.persistenceError = String((error                        )?.message || error);
      }
    }
    return this.persistenceRef;
  }

  /**
   * 落盘（**不吞错**）：返回 `{appended, revision, cursor, deferred, error}`；
   * 失败时把 `{code,message}` 记进 `persistenceError`，由 `graph_status.persistence.error` 透出。
   */
  async persist()           
                     
                     
                   
                      
                                                            
            {
    const persistence = await this.persistence();
    if (!persistence) {
      return { appended: 0, revision: 0, cursor: 0, error: { code: 'PERSISTENCE_UNAVAILABLE', message: this.persistenceError ?? 'not-opened' } };
    }
    try {
      const outcome = await persistence.persist();
      this.persistenceError = outcome?.error ? `${outcome.error.code}: ${outcome.error.message}` : null;
      return outcome;
    } catch (error) {
      const info = { code: (error                     )?.code ?? null, message: String((error                        )?.message || error) };
      this.persistenceError = `${info.code}: ${info.message}`;
      return { appended: 0, revision: persistence.snapshot().revision, cursor: persistence.snapshot().coreCursor, error: info };
    }
  }

  /**
   * 插件卸载 / disable 时调用：**释放 journal lock**（STATE_LOCKED 的根治点）。
   * 幂等；即使落盘失败也会 close（N4 的 close 负责释放锁）。
   */
  async dispose()                                                     {
    const persistence = this.persistenceRef;
    this.persistenceRef = null;
    if (!persistence) return { closed: false, error: null };
    try {
      await persistence.close({ snapshot: true });
      this.persistenceError = null;
      return { closed: true, error: null };
    } catch (error) {
      const message = String((error                        )?.message || error);
      this.persistenceError = message;
      return { closed: false, error: message };
    }
  }

  async core()                             {
    if (!this.corePromise) {
      this.corePromise = (async () => {
        try {
          // 先开桥：configureCore 必须在任何 core 调用前完成，否则 core 会用自己的内存单例
          await this.persistence();
          const mod = await import('./core/index.js');
          return (mod?.default ?? mod)              ;
        } catch {
          return null;
        }
      })();
    }
    return this.corePromise;
  }

          async withCore(
    action        ,
    fn                                                  ,
  )                   {
    const core = await this.core();
    if (!core) {
      return {
        ok: false,
        error: 'core-unavailable',
        action,
        hint: 'src/core 归 N3；core 缺失时插件不得假装成功',
        stateAuthority: 'plugin-journal',
      };
    }
    try {
      const result = await fn(core);
      // core 的语义拒绝必须**冒泡**到顶层 ok，否则调用方会把 {ok:true, result:{ok:false}} 当成功
      const rejected = Boolean(result && typeof result === 'object' && (result                    ).ok === false);
      if (rejected) {
        const typed = result                                     ;
        return {
          ok: false,
          action,
          error: typed.error ?? 'core-rejected',
          result,
          ...(typed.hint ? { hint: typed.hint } : {}),
          persistence: await this.persist(),
        };
      }
      return { ok: true, action, result, persistence: await this.persist() };
    } catch (error) {
      return { ok: false, action, error: 'core-failed', detail: errorInfo(error), persistence: await this.persist() };
    }
  }

  // ── journal（append-only；N4 会把它升级成带 revision 的权威日志） ──
  ensureStateDir()       {
    fs.mkdirSync(this.stateDir, { recursive: true });
  }

  appendJournal(kind        , payload                         )                          {
    this.ensureStateDir();
    const row = { at: new Date().toISOString(), kind, ...payload };
    fs.appendFileSync(this.journalPath, JSON.stringify(row) + '\n', 'utf8');
    return row;
  }

  /** 读全量 journal 行（用于实例表回放；坏行跳过，不抛出）。 */
  readJournal()                                 {
    if (!fs.existsSync(this.journalPath)) return [];
    const rows                                 = [];
    for (const line of fs.readFileSync(this.journalPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line)                           ;
        if (parsed && typeof parsed === 'object') rows.push(parsed);
      } catch {
        // 坏行跳过
      }
    }
    return rows;
  }

  journalSummary()                                                            {
    if (!fs.existsSync(this.journalPath)) return { path: this.journalPath, events: 0, lastKind: null };
    const lines = fs
      .readFileSync(this.journalPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
    let lastKind                = null;
    if (lines.length) {
      try {
        lastKind = (JSON.parse(lines[lines.length - 1])                     ).kind ?? null;
      } catch {
        lastKind = 'unparsable';
      }
    }
    return { path: this.journalPath, events: lines.length, lastKind };
  }

  // ── 9 个工具的实现 ─────────────────────────────────────────
  async wishSubmit(input                                                               ) {
    if (!input?.text || !String(input.text).trim()) {
      return { ok: false, error: 'wish-text-required' };
    }
    this.appendJournal('wish_submitted', {
      text: String(input.text),
      maxParallel: input.maxParallel ?? this.config.maxParallel,
      budgetTokens: input.budgetTokens ?? this.config.defaultBudgetTokens,
    });
    return this.withCore('wish_submit', (core) =>
      core.submitWish
        ? core.submitWish({ text: String(input.text), maxParallel: input.maxParallel, budgetTokens: input.budgetTokens })
        : Promise.resolve({ delegated: false, reason: 'core.submitWish 未实现' }),
    );
  }

  /**
   * 工作图**组成因子**：`graph_plan` —— 纯校验 + 预览（errors/warnings/ready），零写入。
   * 不做固定模板：节点/依赖由调用方按需求给出。
   */
  async graphPlan(input                                                                                                          ) {
    const spec = input?.spec ?? { wish: input?.wish ?? '', nodes: input?.nodes ?? [], policies: input?.policies ?? {} };
    this.appendJournal('graph_plan_preview', {
      wish: String((spec                     ).wish ?? '').slice(0, 200),
      nodes: Array.isArray((spec                         ).nodes) ? ((spec                        ).nodes             ).length : 0,
    });
    return this.withCore('graph_plan', (core) =>
      core.graphPlan ? core.graphPlan(spec) : Promise.resolve({ delegated: false, reason: 'core.graphPlan 未实现' }),
    );
  }

  /** 工作图组成因子：`graph_commit` —— 校验通过后落图；同一份图重复提交幂等。 */
  async graphCommit(input                                                                                                          ) {
    const spec = input?.spec ?? { wish: input?.wish ?? '', nodes: input?.nodes ?? [], policies: input?.policies ?? {} };
    const result = await this.withCore('graph_commit', (core) =>
      core.graphCommit ? core.graphCommit(spec) : Promise.resolve({ delegated: false, reason: 'core.graphCommit 未实现' }),
    );
    const row = result                                                                                                   ;
    this.appendJournal('graph_committed', {
      ok: row?.ok === true,
      committed: row?.committed === true,
      idempotent: row?.idempotent === true,
      counts: row?.counts ?? null,
      errors: Array.isArray(row?.errors) ? (row.errors             ).length : 0,
    });
    return result;
  }

  // ── 子 Agent（递归）快照：team_snapshot 不含 descendants，单独持久化 ──
  /** 从 journal 恢复每个 session 最后一条 `descendants_snapshot`。 */
          restoreDescendantSnapshots()       {
    try {
      if (!fs.existsSync(this.journalPath)) return;
      for (const row of this.readJournal()) {
        if (row?.kind !== 'descendants_snapshot') continue;
        const sessionId = String(row.sessionId ?? '');
        if (!sessionId) continue;
        this.descendantSnapshots.set(sessionId, {
          count: Number(row.count ?? 0) || 0,
          active: Number(row.active ?? 0) || 0,
          at: String(row.at ?? ''),
          items: Array.isArray(row.items) ? (row.items             ) : [],
        });
      }
    } catch {
      // 恢复失败 → 只能显示 —（不伪造 0）
    }
  }

  /** `teamStatus` 成功后异步抓一次递归子 Agent 数，落 `descendants_snapshot`。 */
          async captureDescendants(sessionId        , caller     )                {
    try {
      const subagents = this.ctx.get?.('subagents');
      if (!sessionId || !caller?.id || typeof subagents?.listDescendants !== 'function') return;
      const rows = await subagents.listDescendants(caller.id);
      const items = Array.isArray(rows) ? rows : [];
      const children = items.filter((row     ) => row?.kind === 'child');
      const record = {
        count: children.length,
        active: children.filter((row     ) => row?.activity === 'running').length,
        at: new Date().toISOString(),
        items: children.slice(0, 60).map((row     ) => ({
          id: row.id ?? null,
          parentId: row.parentId ?? null,
          depth: row.depth ?? null,
          mode: row.mode ?? null,
          label: row.label ?? null,
          activity: row.activity ?? null,
        })),
      };
      this.descendantSnapshots.set(sessionId, record);
      try {
        this.appendJournal('descendants_snapshot', { sessionId, ...record });
      } catch {
        // 落盘失败不影响返回
      }
    } catch {
      // 抓取失败保持上一次快照
    }
  }

  // ── 按对话（session）双开关：协作 coordination / 工作区管理 management ──
  /** 恢复：按 journal 逐 session 重建（后写覆盖）；旧记录只有 `enabled` 时迁移为 coordination + management='off'。 */
          restoreAccess()       {
    try {
      if (!fs.existsSync(this.journalPath)) return;
      for (const row of this.readJournal()) {
        if (row?.kind !== 'access_changed') continue;
        const sessionId = String(row.sessionId ?? '');
        if (!sessionId) continue;
        const migrated = !('coordination' in row);
        this.enabledSessions.set(sessionId, {
          coordination: migrated ? row.enabled === true : row.coordination === true,
          management: migrated ? 'off' : normalizeManagement(row.management),
          at: String(row.at ?? ''),
          by: row.by ? String(row.by) : null,
        });
      }
    } catch {
      // 恢复失败 → 全部按默认（协作关、管理 off）处理（fail-closed）
    }
  }

  /** guard 只看协作：没有记录 / coordination=false 都算未启用。 */
  isSessionEnabled(sessionId                           )          {
    const id = String(sessionId ?? '');
    if (!id) return false;
    return this.enabledSessions.get(id)?.coordination === true;
  }

  /** 该对话的工作区管理态：`off`（默认）| `auto` | `on`。 */
  managementFor(sessionId                           )                 {
    const id = String(sessionId ?? '');
    if (!id) return 'off';
    return this.enabledSessions.get(id)?.management ?? 'off';
  }

  /**
   * 启用/停用：两个轴独立更新（只传一个轴时另一个保持不变）。
   * 每次变更落 journal `access_changed {sessionId, coordination, management, at, by}`。
   */
  setSessionAccess(
    sessionId        ,
    patch                                                                  ,
    by         ,
  ) {
    const id = String(sessionId ?? '').trim();
    if (!id) return { ok: false, error: 'session-id-required' };
    const current = this.enabledSessions.get(id) ?? { coordination: false, management: 'off'                  , at: '', by: null };
    const coordination = typeof patch?.coordination === 'boolean' ? patch.coordination : current.coordination;
    const management = patch?.management === undefined ? current.management : normalizeManagement(patch.management);
    const at = new Date().toISOString();
    const record = { coordination, management, at, by: by ? String(by) : null };
    this.enabledSessions.set(id, record);
    try {
      this.appendJournal('access_changed', { sessionId: id, coordination, management, at, by: record.by });
    } catch {
      // journal 写失败不改变内存态，但下次 reload 会回到旧值
    }
    return { ok: true, sessionId: id, coordination, management, enabled: coordination, at, by: record.by };
  }

  /** 兼容旧入口：只改协作轴（第一次入口 / 旧调用点）。 */
  setSessionEnabled(sessionId        , enabled         , by         ) {
    return this.setSessionAccess(sessionId, { coordination: enabled === true }, by);
  }

  /** 访问态势：`default` 恒为「协作关 + 管理 off」，`sessions` 只列有显式记录的。 */
  accessSnapshot() {
    return {
      default: 'disabled'         ,
      managementDefault: 'off'         ,
      sessions: [...this.enabledSessions.entries()]
        .map(([sessionId, value]) => ({
          sessionId,
          coordination: value.coordination,
          enabled: value.coordination,
          management: value.management,
          at: value.at,
          by: value.by,
        }))
        .sort((a, b) => String(b.at).localeCompare(String(a.at))),
    };
  }

  /** 某个对话的双轴状态（给 UI 侧车 / 面板用）。 */
  accessFor(sessionId                ) {
    const id = sessionId ? String(sessionId) : null;
    return {
      ok: true,
      sessionId: id,
      coordination: id ? this.isSessionEnabled(id) : false,
      enabled: id ? this.isSessionEnabled(id) : false,
      management: id ? this.managementFor(id) : ('off'                  ),
      default: 'disabled'         ,
      managementDefault: 'off'         ,
    };
  }

  /**
   * 检查更新（**只检查，不自动 apply**）。
   *
   * 读本地插件 `package.json` 的 version，拉 `raw.githubusercontent.com/<repo>/<ref>/plugins/dsh-l0-control/package.json`，
   * 做 semver 比较。网络失败 / 404 / 仓库没传 → `{ok:false, error}`（**不抛**）。
   * `fetchImpl` 可注入，便于测试。
   */
  async checkUpdate(options                               = {}) {
    const repo = String(this.config.updateRepo ?? '').trim();
    const ref = String(this.config.updateRef ?? 'main').trim() || 'main';
    const currentVersion = readLocalVersion();
    const base = { repo, ref, currentVersion, latestVersion: null                 , available: false, url: null                  };
    if (!repo) {
      return { ...base, ok: false, error: 'update-repo-not-configured', message: '检查更新未配置仓库（updateRepo 为空）' };
    }
    const url = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/plugins/dsh-l0-control/package.json`;
    const fetchUrl = `https://api.github.com/repos/${repo}/contents/plugins/dsh-l0-control/package.json?ref=${encodeURIComponent(ref)}`;
    const fetchImpl = options.fetchImpl ?? (globalThis.fetch                            );
    if (typeof fetchImpl !== 'function') {
      return { ...base, ok: false, url, error: 'fetch-unavailable', message: '当前运行环境没有 fetch' };
    }
    try {
      const res = await fetchImpl(fetchUrl, { headers: { accept: 'application/vnd.github+json' } });
      if (res.status === 404) {
        return { ...base, ok: false, url, error: 'remote-not-found', message: '仓库里还没有发布版本（404）；上传后再检查' };
      }
      if (!res.ok) {
        return { ...base, ok: false, url, error: `http-${res.status}`, message: `远端返回 ${res.status}` };
      }
      const payload = (await res.json())                                                             ;
      let remote                       = payload;
      if (typeof payload?.content === 'string' && payload.content) {
        try {
          remote = JSON.parse(Buffer.from(payload.content, 'base64').toString('utf8'))                        ;
        } catch {
          return { ...base, ok: false, url, error: 'remote-version-missing', message: '远端 package.json 无法解析' };
        }
      }
      const latestVersion = String(remote?.version ?? '').trim();
      if (!latestVersion) {
        return { ...base, ok: false, url, error: 'remote-version-missing', message: '远端 package.json 没有 version' };
      }
      const cmp = compareSemver(latestVersion, currentVersion);
      return {
        ...base,
        ok: true,
        latestVersion,
        available: cmp > 0,
        url,
        ...(cmp > 0 ? {} : { message: '已是最新版本' }),
      };
    } catch (error) {
      return { ...base, ok: false, url, error: 'network-failed', message: String((error         )?.message ?? error) };
    }
  }

  /** O lane：注入观测层（`graph_status.observability` 由它派生）。 */
  attachObservability(obs                                                                                                                        ) {
    this.observability = obs;
    return this;
  }

  get tenant()         {
    return String((this.config                       ).tenant ?? 'default');
  }

  async graphStatus() {
    const journal = this.journalSummary();
    const coreResult = await this.withCore('graph_status', (core) =>
      core.graphStatus ? core.graphStatus() : Promise.resolve({ delegated: false, reason: 'core.graphStatus 未实现' }),
    );
    const persistence = await this.persistence();
    const persistenceView = persistence
      ? { ...persistence.snapshot(), error: persistence.snapshot().error ?? (this.persistenceError ? { code: 'LAST_ERROR', message: this.persistenceError } : null) }
      : { mode: this.config.persistence, error: { code: 'PERSISTENCE_UNAVAILABLE', message: this.persistenceError ?? 'not-opened' } };
    let observability          = null;
    try {
      if (this.observability?.projection) {
        observability = this.observability.projection({ health: this.observability.health?.() ?? null });
      }
    } catch (error) {
      observability = { degraded: true, error: String((error         )?.message ?? error) };
    }
    return {
      ok: true,
      tenant: this.tenant,
      journal,
      stateDir: this.stateDir,
      snapshotExists: fs.existsSync(this.snapshotPath),
      capabilities: capabilitiesDigest(),
      persistence: persistenceView,
      observability,
      graph: coreResult,
    };
  }

  /**
   * 写回工程记忆：把本轮结论/证据/下一步写成一篇短报告；有任务卡时在卡末追加指针。
   * 只写结论与指针，不复制整段上下文。
   */
  async memoryWriteback(input                                                                            = {}) {
    const managementDir = path.resolve(this.workspaceRoot, '..', 'AI集群工作协议-管理区');
    const summary = String(input?.summary ?? '').trim();
    if (!summary) return { ok: false, error: 'summary-required' };
    const cleanName = (value         , ext        )                => {
      const raw = String(value ?? '').trim();
      if (!raw) return null;
      const base = path.basename(raw);
      if (!base || base === '.' || base === '..' || base !== raw) return null;
      return base.endsWith(ext) ? base : `${base}${ext}`;
    };
    const taskCard = cleanName(input?.taskCard, '.md');
    const next = String(input?.next ?? '').trim();
    const evidence = String(input?.evidence ?? '').trim();
    const reportsDir = path.join(managementDir, 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportName = `MEM-${stamp}.md`;
    const reportPath = path.join(reportsDir, reportName);
    const body = [
      `# 记忆写回 ${new Date().toISOString()}`,
      '',
      `- 任务卡：${taskCard ?? '—'}`,
      '',
      '## 本轮结论',
      summary,
      '',
      '## 下一步',
      next || '—',
      '',
      '## 证据/指针',
      evidence || '—',
      '',
    ].join('\n');
    fs.writeFileSync(reportPath, body, 'utf8');
    let cardPath                = null;
    if (taskCard) {
      const candidate = path.join(managementDir, 'tasks', taskCard);
      if (fs.existsSync(candidate)) {
        cardPath = candidate;
        const block = [
          '',
          `## 记忆写回 ${new Date().toISOString()}`,
          `- 结论：${summary.replace(/\n/g, ' ').slice(0, 500)}`,
          `- 下一步：${(next || '—').replace(/\n/g, ' ').slice(0, 300)}`,
          `- 报告：reports/${reportName}`,
          '',
        ].join('\n');
        fs.appendFileSync(candidate, block, 'utf8');
      }
    }
    return {
      ok: true,
      action: 'memory_writeback',
      result: {
        managementDir,
        report: { name: reportName, path: reportPath, chars: body.length },
        taskCard: taskCard ? { name: taskCard, path: cardPath, appended: Boolean(cardPath) } : null,
        hint: '后续只读报告/任务卡指针；不要把完整本轮上下文重新塞回对话。',
      },
    };
  }

  /**
   * 按需读取管理区/工程记忆，返回紧凑任务包；不自动注入，不返回全量历史。
   * 只读：任务卡 + STATE + 一篇报告 + 可用引用列表；总字符数有上限。
   */
  async memoryLoad(input                                                            = {}) {
    const managementDir = path.resolve(this.workspaceRoot, '..', 'AI集群工作协议-管理区');
    const maxChars = Math.max(1000, Math.min(30000, Number(input?.maxChars ?? 12000)));
    const cleanName = (value         , ext        )                => {
      const raw = String(value ?? '').trim();
      if (!raw) return null;
      const base = path.basename(raw);
      if (!base || base === '.' || base === '..' || base !== raw) return null;
      return base.endsWith(ext) ? base : `${base}${ext}`;
    };
    const taskCard = cleanName(input?.taskCard, '.md');
    const record = cleanName(input?.record, '.md');
    const read = (file        )                                                       => {
      try {
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
        const text = fs.readFileSync(file, 'utf8');
        return { path: file, text, chars: text.length };
      } catch {
        return null;
      }
    };
    const state = read(path.join(managementDir, 'STATE.md'));
    const card = taskCard ? read(path.join(managementDir, 'tasks', taskCard)) : null;
    const report = record ? read(path.join(managementDir, 'reports', record)) : null;
    const list = (dir        , max = 20)           => {
      try {
        return fs.readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
          .map((entry) => entry.name)
          .sort()
          .slice(0, max);
      } catch {
        return [];
      }
    };
    const parts           = [];
    if (card) parts.push(`# TASK CARD ${taskCard}\n${card.text}`);
    if (state) parts.push(`# STATE.md\n${state.text}`);
    if (report) parts.push(`# RECORD ${record}\n${report.text}`);
    let text = parts.join('\n\n');
    const truncated = text.length > maxChars;
    if (truncated) text = text.slice(0, maxChars);
    return {
      ok: true,
      action: 'memory_load',
      result: {
        workspaceRoot: this.workspaceRoot,
        managementDir,
        taskCard: card ? { name: taskCard, path: card.path, chars: card.chars } : null,
        state: state ? { path: state.path, chars: state.chars } : null,
        record: report ? { name: record, path: report.path, chars: report.chars } : null,
        refs: { tasks: list(path.join(managementDir, 'tasks')), reports: list(path.join(managementDir, 'reports')) },
        text,
        chars: text.length,
        maxChars,
        truncated,
        hint: '只按需读取；读完把结论/下一步写回任务卡或报告，不把全文带进后续轮次。',
      },
    };
  }

  /**
   * 只保留最近 N 个用户轮次（从最近 user 消息边界开始），避免把整段历史发给模型。
   * 工具按轮次成组，切在 user 边界上，避免产生孤立的 tool 结果。
   */
  installContextGuard()             {
    const agents = this.ctx.get?.('agents');
    if (!agents?.on || typeof this.ctx.on !== 'function') return () => {};
    const attached = new WeakSet        ();
    const attach = (agent     ) => {
      if (!agent?.ctx || typeof agent.ctx.on !== 'function' || attached.has(agent)) return;
      attached.add(agent);
      const sessionId = String(agent.id ?? '');
      agent.ctx.on('agent/pre-step', async (payload     , next                    ) => {
        const decision = await next();
        if (!this.config.contextTrimEnabled || !sessionId || !this.isSessionEnabled(sessionId)) return decision;
        if (!decision || decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision;
        const maxTurns = Math.max(1, Math.min(100, Number(this.config.contextRecentTurns ?? 10)));
        const messages = decision.messages;
        const userIndexes           = [];
        for (let i = 0; i < messages.length; i += 1) {
          if (String(messages[i]?.role ?? '') === 'user') userIndexes.push(i);
        }
        if (userIndexes.length <= maxTurns) return decision;
        const start = userIndexes[userIndexes.length - maxTurns];
        return { ...decision, messages: messages.slice(start) };
      });
    };
    try {
      for (const agent of agents.list?.() ?? []) attach(agent);
    } catch {
      // 宿主没有可枚举的 Agent 时，只靠后续 agent/created 事件
    }
    const off = this.ctx.on('agent/created', (event     ) => attach(event?.agent));
    return typeof off === 'function' ? off : () => {};
  }

  /**
   * 只读 UI 快照（侧车专用，不参与决策）。
   *
   * **按对话窗口（session）隔离**：`uiSnapshot({sessionId})` 只返回该 session 的团队板；
   * 有 live caller 且 caller.id === sessionId 才走实时投影，否则用该 session 的 `team_snapshot`；
   * 未知 session / 未指定 session 一律 `source='none'`，**不跨 session 复用**。
   */
  async uiSnapshot(input                                            = {}) {
    const graphView = await this.graphStatus();
    const coreGraph = (graphView       )?.graph?.result ?? (graphView       )?.graph ?? null;
    // core 内存态偶尔落后于持久层（例如 graph_commit 后 UI 侧实例未重放）；
    // 显示计数时以 recoveryReport.state 兜底，避免“图已落盘但面板 0 nodes”。
    const recovered = (graphView       )?.persistence?.recoveryReport?.state;
    const recoveredNodes = recovered?.nodes && typeof recovered.nodes === 'object' ? Object.values(recovered.nodes) : [];
    const recoveredEdges = Array.isArray(recovered?.edges) ? recovered.edges : [];
    const recoveredDone = recoveredNodes.filter((node     ) => node?.status === 'done').length;
    const effectiveCounts = coreGraph?.counts && Number(coreGraph.counts.nodes) > 0
      ? coreGraph.counts
      : recoveredNodes.length
        ? { nodes: recoveredNodes.length, edges: recoveredEdges.length, done: recoveredDone, blocked: 0 }
        : coreGraph?.counts ?? null;
    // 只认调用方显式给的 sessionId：不拿 lastCaller 兜底，避免把本窗口数据喂给别的窗口
    const requested = input?.sessionId ? String(input.sessionId) : null;
    let team                         ;
    let teamSource                               = 'none';
    let teamCapturedAt                = null;
    if (requested && this.lastCaller?.id && String(this.lastCaller.id) === requested) {
      const live = this.teamStatus(this.lastCaller, { capture: false })                           ;
      team = live;
      teamSource = live?.ok === true ? 'live' : 'none';
      teamCapturedAt = new Date().toISOString();
    } else if (requested && this.teamSnapshots.has(requested)) {
      const cached = this.teamSnapshots.get(requested) ;
      team = cached.team;
      teamSource = 'snapshot';
      teamCapturedAt = cached.capturedAt;
    } else {
      team = {
        ok: false,
        error: requested ? 'no-snapshot-for-session' : 'session-required',
        hint: requested
          ? '该对话窗口还没有团队快照（未接入 / 未调用过 team_status）'
          : 'UI 必须带 sessionId：每个对话窗口各自统计，不跨 session 复用',
      };
    }
    team = { ...team, sessionId: requested, source: teamSource, capturedAt: teamCapturedAt };
    const sessions = [...this.teamSnapshots.entries()]
      .map(([sessionId, value]) => ({ sessionId, capturedAt: value.capturedAt }))
      .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
    const managementDir = path.resolve(this.workspaceRoot, '..', 'AI集群工作协议-管理区');
    const workspaces = [
      { id: 'code', label: '工程目录', path: this.workspaceRoot, exists: fs.existsSync(this.workspaceRoot), entries: listEntries(this.workspaceRoot) },
      { id: 'management', label: '管理区', path: managementDir, exists: fs.existsSync(managementDir), entries: listEntries(managementDir) },
      { id: 'plugins', label: '插件目录', path: path.join(this.workspaceRoot, 'plugins'), exists: fs.existsSync(path.join(this.workspaceRoot, 'plugins')), entries: listEntries(path.join(this.workspaceRoot, 'plugins')) },
      { id: 'state', label: '状态目录', path: this.stateDir, exists: fs.existsSync(this.stateDir), entries: listEntries(this.stateDir) },
    ];
    // 黑板：**增量**（sinceSeq 之后的新行，最多 40 条）+ 摘要（不全量回传历史）
    const journalRows = this.readJournal();
    const journalTotal = journalRows.length;
    const sinceRaw = Number((input                         )?.sinceSeq);
    const sinceSeq = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? Math.floor(sinceRaw) : null;
    const BLACKBOARD_LIMIT = 40;
    const toRow = (row                         ) => ({
      at: row.at ?? null,
      kind: row.kind ?? null,
      nodeId: row.nodeId ?? row.node_id ?? null,
      text: row.text ?? row.message ?? row.reason ?? null,
      action: row.action ?? null,
      status: row.status ?? null,
      actor: row.actor ?? row.instanceId ?? row.instance_id ?? null,
    });
    let blackboardMode                                         = 'initial';
    let sliceStart = Math.max(0, journalTotal - BLACKBOARD_LIMIT);
    if (sinceSeq !== null) {
      if (sinceSeq <= journalTotal) {
        // 增量：从 cursor 到末尾；超过上限就取末尾 40 并标记 truncated
        sliceStart = sinceSeq;
        blackboardMode = 'incremental';
      } else {
        // cursor 超界 / 倒回（journal 被截断或换了状态目录）→ 回退最近 40
        blackboardMode = 'fallback';
      }
    }
    const pendingRows = journalRows.slice(sliceStart);
    const blackboardTruncated = blackboardMode !== 'incremental' && journalTotal > BLACKBOARD_LIMIT
      ? true
      : pendingRows.length > BLACKBOARD_LIMIT;
    const blackboardRows = pendingRows.slice(-BLACKBOARD_LIMIT);
    const blackboard = blackboardRows.reverse().map(toRow);

    // 摘要：总数 / 按 kind / 最近失败与决策 / 旧事件数（UI 只显示摘要，不拉历史）
    const byKind                         = {};
    for (const row of journalRows) {
      const kind = String(row?.kind ?? 'unknown');
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
    const failedDecisions = journalRows
      .filter((row) => {
        const status = String(row?.status ?? '').toLowerCase();
        const kind = String(row?.kind ?? '');
        return (
          status === 'rejected' ||
          status === 'failed' ||
          kind.includes('rejected') ||
          kind.includes('failed') ||
          row?.error != null
        );
      })
      .slice(-5)
      .reverse()
      .map((row) => ({
        at: row.at ?? null,
        kind: row.kind ?? null,
        reason: row.reason ?? row.error ?? row.message ?? null,
        nodeId: row.nodeId ?? row.node_id ?? null,
      }));
    const blackboardSummary = {
      total: journalTotal,
      shown: blackboardRows.length,
      older: Math.max(0, journalTotal - blackboardRows.length),
      byKind,
      failedDecisions,
      cursor: journalTotal,
    };
    let managementRevision                = null;
    try {
      const statePath = path.join(managementDir, 'STATE.md');
      if (fs.existsSync(statePath)) {
        managementRevision = /revision：(\d+)/.exec(fs.readFileSync(statePath, 'utf8'))?.[1] ?? null;
      }
    } catch {
      managementRevision = null;
    }
    const management = {
      dir: managementDir,
      exists: fs.existsSync(managementDir),
      revision: managementRevision,
      cards: readManagementCards(managementDir),
    };
    let descendants   
                  
                    
                      
                        
                     
                                            
                                 
      = { ok: false, count: 0, source: 'none', capturedAt: null };
    try {
      const subagents = this.ctx.get?.('subagents');
      if (requested && subagents?.listDescendants) {
        // 只要 UI 指定了 sessionId，就直接以它作为 root 拉实时 descendants；
        // 不要求 lastCaller 等于该 session——子 Agent 调工具后 lastCaller 会变成子 Agent，
        // 此时 lead 窗口仍应看到“正在运行”的子孙。
        const rows = await subagents.listDescendants(requested);
        const items = Array.isArray(rows) ? rows : [];
        const children = items.filter((row     ) => row?.kind === 'child');
        descendants = {
          ok: true,
          count: children.length,
          active: children.filter((row     ) => row?.activity === 'running').length,
          source: 'live',
          capturedAt: new Date().toISOString(),
          items: items.slice(0, 60).map((row     ) => ({
            id: row.id ?? null,
            parentId: row.parentId ?? null,
            depth: row.depth ?? null,
            mode: row.mode ?? null,
            label: row.label ?? null,
            activity: row.activity ?? null,
            kind: row.kind ?? null,
            reason: row.reason ?? null,
          })),
        };
        this.descendantSnapshots.set(requested, {
          count: descendants.count,
          active: Number(descendants.active ?? 0),
          at: String(descendants.capturedAt),
        });
      } else if (requested && this.descendantSnapshots.has(requested)) {
        // reload 后没有 live caller：用该 session 的快照（含 items）
        const cached = this.descendantSnapshots.get(requested) ;
        descendants = {
          ok: true,
          count: cached.count,
          active: cached.active,
          source: 'snapshot',
          capturedAt: cached.at,
          items: cached.items ?? [],
        };
      }
    } catch (error) {
      descendants = { ok: false, count: 0, source: 'none', capturedAt: null, error: String((error         )?.message ?? error) };
    }
    return {
      ok: true,
      at: new Date().toISOString(),
      tenant: this.tenant,
      sessionId: requested,
      sessions,
      access: {
        default: 'disabled'         ,
        enabled: requested ? this.isSessionEnabled(requested) : false,
        coordination: requested ? this.isSessionEnabled(requested) : false,
        management: requested ? this.managementFor(requested) : ('off'                  ),
        managementDefault: 'off'         ,
        sessionId: requested,
      },
      suggestedSessionId: this.lastCaller?.id ? String(this.lastCaller.id) : null,
      workspaceRoot: this.workspaceRoot,
      stateDir: this.stateDir,
      journal: this.journalSummary(),
      team,
      descendants,
      graph: coreGraph ? {
        version: coreGraph.version ?? null,
        ready: coreGraph.ready ?? [],
        counts: effectiveCounts,
      } : null,
      blackboard,
      blackboardCursor: journalTotal,
      blackboardTruncated,
      blackboardMode,
      sinceSeq,
      blackboardSummary,
      workspaces,
      management,
    };
  }

  async taskNext(input                   ) {
    return this.withCore('task_next', (core) =>
      core.nextTask ? core.nextTask({ role: input?.role }) : Promise.resolve({ delegated: false, reason: 'core.nextTask 未实现' }),
    );
  }

  async taskClaim(input                                                        ) {
    if (!input?.nodeId) return { ok: false, error: 'node-id-required' };
    this.appendJournal('task_claimed', { nodeId: input.nodeId, role: input.role ?? null, instanceId: input.instanceId ?? null });
    return this.withCore('task_claim', (core) =>
      core.claimTask
        ? core.claimTask({ nodeId: input.nodeId, role: input.role, instanceId: input.instanceId })
        : Promise.resolve({ delegated: false, reason: 'core.claimTask 未实现' }),
    );
  }

  /**
   * caller 绑定的实例：用 `l0adapter` 服务按 sessionId 反查（同一宿主进程内可取到）。
   * 取不到返回 null —— 调用方必须显式传 producer_instance / auditor_instance。
   */
  callerInstance(caller     )                {
    const sessionId = caller?.id;
    if (!sessionId) return null;
    const adapter = this.ctx.get('l0adapter');
    if (!adapter?.report || typeof adapter.report !== 'function') return null;
    try {
      const report = adapter.report();
      const hit = (report?.instances ?? []).find((row     ) => row.sessionId === sessionId);
      return hit?.instanceId ?? null;
    } catch {
      return null;
    }
  }

  /** acceptance → verdict（显式 verdict 优先；判定不了就是 unknown，绝不当 pass）。 */
  verdictFor(acceptance     , resolved        )                              {
    const kind = acceptance?.kind ?? 'exists';
    if (!acceptance || typeof acceptance !== 'object') return 'unknown';
    if (kind === 'exists') return 'pass';
    try {
      if (kind === 'sha256') {
        const expected = String(acceptance.expected ?? '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(expected)) return 'unknown';
        const actual = createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
        return actual === expected ? 'pass' : 'fail';
      }
      if (kind === 'contains') {
        const expected = acceptance.expected;
        if (typeof expected !== 'string' || expected.length === 0) return 'unknown';
        return fs.readFileSync(resolved, 'utf8').includes(expected) ? 'pass' : 'fail';
      }
    } catch {
      return 'unknown';
    }
    return 'unknown';
  }

  async evidenceSubmit(rawInput                         , caller      ) {
    let input                         ;
    try {
      input = normalizeKeys(rawInput);
    } catch (error) {
      return { ok: false, error: 'key-conflict', detail: String((error         )?.message || error) };
    }
    if (!input?.nodeId || !input?.artifactPath) {
      return { ok: false, error: 'nodeId 与 artifactPath 必填' };
    }
    const producer = String(input.producer_instance ?? this.callerInstance(caller) ?? '');
    if (!producer) {
      return {
        ok: false,
        error: 'producer-unknown',
        hint: '传 producer_instance，或让 caller 绑定一个 ROLE-<职务>-<序号> 实例',
      };
    }
    const resolved = path.isAbsolute(String(input.artifactPath))
      ? String(input.artifactPath)
      : path.resolve(this.workspaceRoot, String(input.artifactPath));
    const exists = fs.existsSync(resolved);
    if (!exists) {
      this.appendJournal('evidence_rejected', { nodeId: input.nodeId, producer_instance: producer, reason: 'artifact-missing' });
      return { ok: false, error: 'artifact-missing', resolved, producer_instance: producer };
    }
    const explicit = typeof input.verdict === 'string' ? String(input.verdict).toLowerCase() : null;
    if (explicit && !['pass', 'fail', 'unknown'].includes(explicit)) {
      return { ok: false, error: 'verdict-invalid', hint: 'verdict ∈ pass|fail|unknown' };
    }
    // 门禁（Lead 2026-10-29 裁决）：既无 acceptance 又无 verdict → 不得提交
    // （core 对 `kind:'none'` 曾按 caller-asserts-pass 记 pass，等于 unknown 变 pass）
    const hasAcceptance = Boolean(input.acceptance && typeof input.acceptance === 'object');
    if (!hasAcceptance && !explicit) {
      this.appendJournal('evidence_rejected', {
        nodeId: input.nodeId,
        producer_instance: producer,
        reason: 'acceptance-required',
      });
      return {
        ok: false,
        error: 'acceptance-required',
        hint: '传 acceptance:{kind: exists|sha256|contains} 或显式 verdict；无判据不得 pass',
        producer_instance: producer,
      };
    }
    const verdict = explicit ?? this.verdictFor(input.acceptance, resolved);
    if (verdict === 'unknown') {
      // 判定不了就是 unknown：可以记录，但不能被下游当 pass
      this.appendJournal('evidence_recorded_unknown', { nodeId: input.nodeId, producer_instance: producer });
    }
    const result = await this.withCore('evidence_submit', (core) =>
      core.submitEvidence
        ? core.submitEvidence(
            withAliases({ ...input, resolved, producer_instance: producer, producerInstance: producer, verdict }),
          )
        : Promise.resolve({ delegated: false, reason: 'core.submitEvidence 未实现', resolved, producer_instance: producer, verdict }),
    );
    const accepted = (result                    )?.ok === true;
    this.appendJournal(accepted ? 'evidence_submitted' : 'evidence_rejected', {
      nodeId: input.nodeId,
      artifactPath: String(input.artifactPath),
      verifier: input.verifier ?? null,
      producer_instance: producer,
      verdict,
      verdictSource: explicit ? 'explicit' : 'acceptance',
      exists,
      reason: accepted ? null : (result                      )?.error ?? 'unknown',
    });
    return result;
  }

  async verifyDone(rawInput                         , caller      ) {
    let input                         ;
    try {
      input = normalizeKeys(rawInput);
    } catch (error) {
      return { ok: false, error: 'key-conflict', detail: String((error         )?.message || error) };
    }
    if (!input?.nodeId) return { ok: false, error: 'node-id-required' };
    const auditor = String(input.auditor_instance ?? this.callerInstance(caller) ?? '');
    if (!auditor) {
      return {
        ok: false,
        error: 'auditor-required',
        hint: '传 auditor_instance（ROLE-AUDIT_* 实例），或让 caller 绑定审计实例',
      };
    }
    const producer = String(input.producer_instance ?? '');
    if (!producer) {
      return { ok: false, error: 'producer-required', hint: '审计独立性需要 producer_instance 才能机检' };
    }
    // 硬门禁：同实例生产+审计一律拒（不放宽）
    if (producer === auditor) {
      this.appendJournal('verify_done_rejected', { nodeId: input.nodeId, producer_instance: producer, auditor_instance: auditor, reason: 'audit-independence' });
      return {
        ok: false,
        error: 'audit-independence-violated',
        hint: '同一产物的生产实例与审计实例不得相同（复合实例含审计职务时亦然）',
        producer_instance: producer,
        auditor_instance: auditor,
      };
    }
    if (!isAuditorInstance(auditor)) {
      return {
        ok: false,
        error: 'auditor-role-required',
        hint: `auditor_instance 的职务必须属审计职务（${AUDITOR_ROLES.join('/')}）`,
        auditorRole: roleOfInstance(auditor),
      };
    }
    const result = await this.withCore('verify_done', (core) =>
      core.verifyDone
        ? core.verifyDone(
            withAliases({
              ...input,
              producer_instance: producer,
              producerInstance: producer,
              auditor_instance: auditor,
              auditorInstance: auditor,
            }),
          )
        : Promise.resolve({ delegated: false, reason: 'core.verifyDone 未实现' }),
    );
    const accepted = (result                    )?.ok === true;
    this.appendJournal(accepted ? 'verify_done_requested' : 'verify_done_rejected', {
      nodeId: input.nodeId,
      acceptance: input.acceptance ?? null,
      producer_instance: producer,
      auditor_instance: auditor,
      auditorRole: roleOfInstance(auditor),
      reason: accepted ? null : (result                      )?.error ?? 'unknown',
    });
    return result;
  }

  async decide(rawInput                         ) {
    let input                         ;
    try {
      input = normalizeKeys(rawInput);
    } catch (error) {
      return { ok: false, error: 'key-conflict', detail: String((error         )?.message || error) };
    }
    if (!input?.decisionId && !input?.nodeId) return { ok: false, error: 'decisionId 或 nodeId 必填' };
    this.appendJournal('decision_requested', {
      decisionId: input.decisionId ?? null,
      nodeId: input.nodeId ?? null,
      optionId: input.optionId ?? null,
      level: input.level ?? null,
    });
    return this.withCore('decide', (core) =>
      core.decide ? core.decide(input) : Promise.resolve({ delegated: false, reason: 'core.decide 未实现' }),
    );
  }

  /** 阶段闸门：只接受 5 段枚举；直接调 core.passGate，**不允许改节点状态**。 */
  async passGate(rawInput                         ) {
    let input                         ;
    try {
      input = normalizeKeys(rawInput);
    } catch (error) {
      return { ok: false, error: 'key-conflict', detail: String((error         )?.message || error) };
    }
    const stage = String(input?.stage ?? '').toLowerCase();
    if (!GATE_STAGES.includes(stage)) {
      return { ok: false, error: 'stage-invalid', stage, allowed: [...GATE_STAGES] };
    }
    const refs = Array.isArray(input.evidence_refs) ? (input.evidence_refs             ).map(String) : [];
    const result = await this.withCore('pass_gate', (core) => {
      if (typeof core.passGate !== 'function' || typeof core.coreStore !== 'function') {
        return { ok: false, error: 'core-gate-unavailable' };
      }
      const store = core.coreStore();
      const gate = core.passGate(store, stage, refs);
      return { ok: true, stage, evidence_refs: refs, gate };
    });
    this.appendJournal((result                    )?.ok ? 'gate_passed' : 'gate_rejected', {
      stage,
      evidence_refs: refs,
      reason: (result                      )?.error ?? null,
    });
    return result;
  }

  /**
   * 原生通道：直接读 agentTeams 团队板（caller 必须是活 Agent）。
   * 成功时把**投影后的安全快照**写 journal `team_snapshot`（`capture:false` 可关，UI 轮询不刷盘）。
   */
  teamStatus(caller     , options                        = {}) {
    this.lastCaller = caller ?? null;
    if (!caller?.id) {
      return {
        ok: false,
        error: 'caller-required',
        hint: 'agentTeams 的每个方法都要活 Agent 作 caller；工具入口用 exec.agent',
      };
    }
    const teams = this.agentTeams;
    if (!teams) {
      return { ok: false, error: 'agentTeams-absent', hint: '该部署未挂载 Agent Teams 服务' };
    }
    try {
      const membership = teams.membership(caller);
      const members = teams.listMembers(caller) ?? [];
      const tasks = teams.listTasks(caller) ?? [];
      // 先投影成纯标量，再 JSON 兜底；两步任一失败都走 projection-failed
      const projected = toLossless(projectTeam(caller, membership, members, tasks))                           ;
      // 同时带出本插件派生的真实子 Agent 实例（native 执行层的登记表）
      const value = {
        ...projected,
        nativeInstanceCount: this.native.listInstances().length,
        nativeInstances: this.native.listInstances().map((row) => ({
          instanceId: row.instanceId,
          sessionId: row.sessionId,
          role: row.role,
          mode: row.mode,
        })),
      };
      if (options.capture !== false) {
        const capturedAt = new Date().toISOString();
        const sessionId = String(caller?.id ?? '');
        if (sessionId) {
          this.teamSnapshots.set(sessionId, { capturedAt, team: value });
          try {
            this.appendJournal('team_snapshot', { sessionId, capturedAt, team: value });
          } catch {
            // 落 journal 失败不影响本次返回
          }
          // 异步补子 Agent 快照（不阻塞团队板返回）
          void this.captureDescendants(sessionId, caller);
        }
      }
      return value;
    } catch (error) {
      return { ok: false, error: 'projection-failed', detail: errorInfo(error) };
    }
  }

  /**
   * Bootstrap：`project_init`。
   * 先写 `project_init_planned`，再跑（dry-run 同样是纯读），最后写 `project_init_result`。
   */
  async projectInit(input   
                         
                  
                  
                  
                                                       
                           
                               
                           
                            
                     
                      
                         
                                 
   , sessionId                ) {
    const safeInput = input ?? {};
    // 第二个轴：工作区管理。off → 直接拒绝（AI 不能自行建管理区）；auto/on 放行
    const managementMode = this.managementFor(sessionId);
    if (managementMode === 'off') {
      this.appendJournal('project_init_blocked', { sessionId: sessionId ? String(sessionId) : null, reason: 'management-disabled' });
      return {
        ok: false,
        error: 'management-disabled',
        sessionId: sessionId ? String(sessionId) : null,
        management: managementMode,
        hint: '本对话的「工作区管理」是关；在面板把它设为 自动/开 后再调用 project_init',
      };
    }
    this.appendJournal('project_init_planned', {
      projectName: safeInput.projectName ?? null,
      slug: safeInput.slug ?? null,
      root: safeInput.root ?? null,
      workspaceRoot: safeInput.workspaceRoot ?? safeInput.selectedWorkspace ?? safeInput.workspacePath ?? null,
      managementRoot: safeInput.managementRoot ?? null,
      dryRun: safeInput.dryRun !== false,
      gitInit: safeInput.gitInit !== false,
      management: safeInput.management !== false,
      allowEmptyExisting: safeInput.allowEmptyExisting === true,
    });
    const result = runProjectInit(safeInput, { workspaceRoot: this.workspaceRoot });
    this.appendJournal('project_init_result', {
      ok: result.ok,
      dryRun: result.dryRun,
      root: result.project.root,
      managementDir: result.project.managementDir,
      workspaceRoot: result.project.workspaceRoot,
      slug: result.project.slug,
      created: result.actions.filter((row) => row.status === 'created').length,
      skipped: result.actions.filter((row) => row.status === 'skipped').length,
      conflicts: result.conflicts,
      git: result.git.state,
    });
    return result;
  }

  async exportProjection(input                     ) {
    const outDir = path.resolve(this.workspaceRoot, input?.outDir || path.join(this.config.stateDir, 'export'));
    this.ensureStateDir();
    fs.mkdirSync(outDir, { recursive: true });
    const files           = [];
    const capsPath = path.join(outDir, 'capabilities.json');
    fs.writeFileSync(capsPath, JSON.stringify(CAPABILITIES, null, 2), 'utf8');
    files.push(capsPath);
    const statePath = path.join(outDir, 'STATE.md');
    const journal = this.journalSummary();
    fs.writeFileSync(
      statePath,
      ['# L0 控制面快照（导出）', '', `- 导出时间：${new Date().toISOString()}`, `- 状态目录：${this.stateDir}`, `- journal 事件：${journal.events}`, `- 最新事件：${journal.lastKind ?? '-'}`, ''].join('\n'),
      'utf8',
    );
    files.push(statePath);
    const coreResult = await this.withCore('export', (core) =>
      core.exportProjection ? core.exportProjection(outDir) : Promise.resolve({ delegated: false, reason: 'core.exportProjection 未实现' }),
    );
    return { ok: true, outDir, files, core: coreResult, persistence: await this.persist() };
  }

  // ── 原生执行层（真实 Agent / 原生团队板） ──────────────────
  async spawnAgent(input   
                 
                 
                   
                   
                      
                         
                 
                                                      
                      
                        
                           
                                                                                                        
   , caller      ) {
    // 能力包可以在顶层或 worker 子对象里给（顶层写法更顺手）
    const parentEnabled = Boolean(caller?.id) && this.isSessionEnabled(String(caller.id));
    const parentContextPack = Array.isArray(input?.contextPack) ? input.contextPack : [];
    const worker = {
      ...(input?.worker ?? {}),
      ...(input?.capability ? { capability: input.capability } : {}),
      contextPack: parentContextPack.length ? parentContextPack : (parentEnabled ? ['父会话只提供任务定位；不继承完整历史。'] : []),
      enabled: parentEnabled || input?.worker?.enabled === true || Boolean(input?.capability) || parentContextPack.length > 0,
    };
    const agentPreset = input?.agentPreset ?? (parentEnabled ? 'memory-first' : undefined);
    const result = await this.native.spawnAgent({ ...input, agentPreset, worker, cwd: input?.cwd ?? this.workspaceRoot }, caller);
    if (result.ok && result.sessionId && parentEnabled) {
      this.setSessionAccess(
        String(result.sessionId),
        {
          coordination: true,
          management: this.managementFor(String(caller.id)),
        },
        'inherit',
      );
    }
    this.appendJournal(result.ok ? 'agent_spawned' : 'agent_spawn_failed', {
      instanceId: result.instanceId ?? null,
      sessionId: result.sessionId ?? null,
      role: result.role ?? String(input?.role ?? '').toUpperCase(),
      label: input?.label ?? null,
      parentSessionId: caller?.id ?? null,
      parentEnabled,
      agentPreset: agentPreset ?? null,
      messageId: result.messageId ?? null,
      error: result.error ?? null,
    });
    return { ...result, persistence: await this.persist(), memorySensitivity: {
      strategy: input?.via ?? 'auto',
      parentEnabled,
      contextTrimEnabled: Boolean(this.config.contextTrimEnabled),
      recentTurns: Number(this.config.contextRecentTurns ?? 30),
      agentPreset: agentPreset ?? null,
      contextPackSize: worker.contextPack?.length ?? 0,
      hint: parentEnabled
        ? '父会话已启用裁剪与记忆；A=team 记忆 prompt，B=activation preset，C=provider。读大文件前先 memory_load，读完 memory_writeback。'
        : '父会话未启用插件：子 Agent 不继承 access/裁剪；需要时先启用父会话再选 B/C。',
    } };
  }

  async sendMessage(input                                                                                 , caller      ) {
    const result = await this.native.sendMessage(input, caller);
    this.appendJournal(result.ok ? 'agent_message_sent' : 'agent_message_failed', {
      instanceId: result.instanceId ?? input?.instanceId ?? null,
      sessionId: result.sessionId ?? null,
      messageId: result.messageId ?? null,
      awaitOutput: input?.awaitOutput === true,
      settled: (result       )?.output?.settled ?? null,
      turnEndReason: (result       )?.output?.turnEnd?.reason ?? null,
      replyText: (result       )?.output?.text ?? null,
      error: result.error ?? null,
    });
    return { ...result, persistence: await this.persist() };
  }

  async createTeamTask(input                                                                                                                                 , caller      ) {
    const result = await this.native.createTeamTask(input, caller);
    this.appendJournal(result.ok ? 'team_task_created' : 'team_task_create_failed', {
      taskId: (result       )?.task?.id ?? null,
      nodeId: input?.nodeId ?? null,
      subject: input?.subject ?? null,
      error: (result       )?.error ?? null,
    });
    return { ...result, persistence: await this.persist() };
  }

  async updateTeamTask(input                                                                              , caller      ) {
    const result = await this.native.updateTeamTask(input, caller);
    this.appendJournal(result.ok ? 'team_task_updated' : 'team_task_update_failed', {
      taskId: input?.taskId ?? null,
      action: input?.action ?? null,
      revision: (result       )?.task?.revision ?? null,
      error: (result       )?.error ?? null,
    });
    return { ...result, persistence: await this.persist() };
  }

  nativeStatus() {
    return {
      ok: true,
      provider: this.config.nativeProvider,
      maxDepth: this.config.nativeMaxDepth,
      instances: this.native.listInstances(),
      capabilities: {
        spawnAgent: typeof this.native.subagents?.startActivation === 'function',
        sendMessage: typeof this.native.subagents?.sendMessage === 'function',
        agentTeams: Boolean(this.native.agentTeams?.createTask),
      },
    };
  }

  // ── 自述 ──────────────────────────────────────────────────
  describe() {
    return {
      plugin: CAPABILITIES.plugin,
      contractVersion: CAPABILITIES.contractVersion,
      tools: this.toolNames,
      toolCount: this.toolNames.length,
      config: this.config,
      configSpec: Object.fromEntries(Object.entries(CONFIG_SPEC).map(([key, spec]) => [key, spec.default])),
      configSource: this.meta.configSource ?? null,
      configSourceFile: this.meta.configSourceFile ?? null,
      workspaceRoot: this.workspaceRoot,
      stateDir: this.stateDir,
      journal: this.journalSummary(),
      capabilities: CAPABILITIES,
    };
  }
}


//# sourceURL=service.js