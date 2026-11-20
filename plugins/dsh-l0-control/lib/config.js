/**
 * Config：schemastery 优先、Standard Schema 兜底。
 *
 * 与 dsh-l0-adapter 同样的实测约束：bundle 以 `link:` 装进 profile，模块按**真实路径**解析，
 * 因此不能静态 `import '@deepseek-ai/schemastery'`；改为运行时按 profile 目录动态 import，
 * 拿不到就退 Standard Schema（cordis `resolveConfig` 只要求 `Config['~standard'].validate`）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

                                                        

                            
                  
                                     
                      
 

export const CONFIG_SPEC                            = {
  workspaceRoot: { type: 'string', default: '', description: '工程根（空则用宿主 cwd）' },
  managementRoot: { type: 'string', default: '', description: '管理区根目录（空时按工作区候选和兼容默认路径发现）' },
  collaborationMode: { type: 'string', default: 'standard', description: '协作模式：card | light | standard | coordination' },
  maxQueuedTasks: { type: 'number', default: 10000, description: '调度最大排队节点数（满时施加背压）' },
  dispatchRatePerSecond: { type: 'number', default: 100, description: '派活计划的全局候选速率上限；当前在每个 tick 内预留额度' },
  coordinatorFanout: { type: 'number', default: 16, description: '协调域默认最大委派分支数' },
  stateDir: { type: 'string', default: '.l0-control', description: '状态目录（相对 workspaceRoot）' },
  journalFile: { type: 'string', default: 'journal.jsonl', description: 'append-only 日志文件名' },
  snapshotFile: { type: 'string', default: 'snapshot.json', description: '快照文件名（fs CAS）' },
  sandboxMode: { type: 'string', default: 'danger-full-access', description: '写文件用的宿主沙箱档位' },
  maxParallel: { type: 'number', default: 6, description: '并发实例上限（planner 可覆盖）' },
  defaultBudgetTokens: { type: 'number', default: 0, description: '默认 token 预算（0=不限）' },
  projectionEnabled: { type: 'boolean', default: true, description: '是否把图投影到原生 TeamTask 板' },
  toolPrefix: { type: 'string', default: '', description: '工具名前缀（空=原名）' },
  persistence: { type: 'string', default: 'memory', description: 'core↔state 桥的 FsPort：memory | node' },
  persistenceDir: { type: 'string', default: 'core-state', description: 'journal/快照目录（相对 stateDir）' },
  nativeProvider: { type: 'string', default: 'spawn', description: 'subagents provider（spawn / fork / …）' },
  nativeMaxDepth: { type: 'number', default: 2, description: '子 Agent 递归深度上限（防无界递归）' },
  lockWaitMs: { type: 'number', default: 15000, description: '打开持久层时等待 journal 锁的毫秒数（N4 waitMs；默认 15s，覆盖 dispose/close 窗口）' },
  lockTtlMs: { type: 'number', default: 1800000, description: 'journal 锁 TTL（毫秒）；默认 30min，按本仓最长空闲 8.7min 取 3.4x 余量' },
  tenant: { type: 'string', default: 'default', description: '租户（default 与现有路径逐字节一致；非 default 落 tenants/<tenant>/）' },
  tokenSecret: { type: 'string', default: '', description: 'A2A bearer token（空=关闭 A2A；非空需 ≥16 字符）' },
  a2aHost: { type: 'string', default: '127.0.0.1', description: 'A2A 服务绑定地址' },
  a2aPort: { type: 'number', default: 0, description: 'A2A 服务端口（0=随机分配；tokenSecret 为空时不启动）' },
  uiHost: { type: 'string', default: '127.0.0.1', description: '只读 UI 侧车绑定地址' },
  uiPort: { type: 'number', default: 47831, description: '只读 UI 侧车端口（0=随机；面板默认 47831）' },
  // CORS：回环 host（127.0.0.1 / localhost / [::1]，端口不限）默认放行——GUI 端口会变，
  // 写死端口会让面板直接「Failed to fetch」。这里只补非回环场景（反代 / 自定义域名）。
  uiAllowedOrigins: { type: 'string', default: '', description: '额外允许的 UI 请求 Origin，逗号分隔（回环 host 已默认放行）' },
  updateRepo: { type: 'string', default: 'weidujianchazhe/ai-cluster-protocol', description: '检查更新用的 GitHub 仓库（owner/name；空=关闭检查）' },
  updateRef: { type: 'string', default: 'main', description: '检查更新用的分支/标签' },
  contextTrimEnabled: { type: 'boolean', default: true, description: '启用对话的 Agent pre-step 上下文裁剪（只保留最近 N 个用户轮次）' },
  contextRecentTurns: { type: 'number', default: 30, description: '上下文裁剪保留的最近用户轮次数（1–100）' },
  // ── 派活循环：默认不激活，由用户显式选择模式 ──
  dispatchMode: { type: 'string', default: 'off', description: '派活循环模式：off（默认，纯手动）| interval（定时）| resident（常驻）' },
  dispatchIntervalMs: { type: 'number', default: 300000, description: 'interval 间隔毫秒（resident 时作为最小冷却）；最小 30 秒' },
  dispatchMaxPerTick: { type: 'number', default: 3, description: '单轮最多派几个节点（上限 32）' },
  dispatchDryRun: { type: 'boolean', default: true, description: '派活计划使用只读候选模式（默认开）；dispatch 只输出候选，不领取节点。' },
  dispatchInstance: { type: 'string', default: 'ROLE-DISPATCH-01', description: '派活时使用的实例 ID' },
  // 闸门命中累积窗口：面板「最近这段主要卡在哪道闸门」的统计范围。
  // 默认 5 分钟——足够跨过瞬时波动（相邻两轮的原因常完全不同），又不至于把
  // 一小时前改过的配置带来的旧原因混进来。
  dispatchGateWindowMs: { type: 'number', default: 300000, description: '闸门命中累积窗口（毫秒，默认 5 分钟）；面板据此汇总「最近主要卡在哪道闸门」' },
  // ── 派发登记的失联判定 ──
  // worker 崩掉不会留下任何 journal 事件，所以「无法证明还活着」不能用来永久阻塞调度。
  // 登记/最后心跳超过该毫秒数即释放；默认 30 分钟（远大于租约 600s，不会误杀正常 worker）。
  enqueueStaleMs: { type: 'number', default: 1800000, description: '派发登记超过该毫秒数无心跳即视为失联并释放（默认 30 分钟；0=不判定）' },
  // ── 宿主 Team 成员上限 ──
  // 宿主 `agentTeams` 的 `maxMembers` 默认 16（Cordis Config 项，不是硬编码常量）。
  // 超了 `spawnTeammate` 抛 TEAM_MEMBER_LIMIT，插件自动降级 activation —— 能跑，但实例
  // `ownerCapable:false`，不能当原生 TeamTask owner。跑集群本身就要超过 16，所以
  // **启用协作即自动把它提到本值**（不需要额外开关：开插件=放开，关协作=不动宿主）。
  // 0 = 不动宿主（保持 16）。
  teamMemberLimit: { type: 'number', default: 256, description: '启用协作时把宿主 agentTeams.maxMembers 提到的值（默认 256；0=不动宿主，保持 16）' },
  // ── journal 分段滚动阈值 ──
  // 不是性能项，是**物理上限**：readFileSync 要建字符串，V8 MAX_STRING_LENGTH = 512 MB，
  // 实测 512 MB 直接 ERR_STRING_TOO_LONG。真实 journal 528 B/行 ⇒ 约 102 万行（≈50 万节点）到顶。
  // 默认 64 MB：绝大多数部署永远只有一个 journal.jsonl（行为与以前完全一致）。
  journalSegmentMaxBytes: { type: 'number', default: 67108864, description: 'journal 单段滚动阈值（字节，默认 64 MB；0=不滚动）。单文件有 512 MB 物理上限（V8 MAX_STRING_LENGTH）' },
  // ── 审计窗口的租约长度 ──
  // `verify_done` 要求活租约，而默认 60s TTL 是给「生产阶段」定的（快速失败）。
  // 证据提交后进入等审计，一轮真审计要复核产物哈希、复算数值，很容易超过 60s；
  // 而 worker 提交后通常不再心跳、审计方又没有 fencingToken —— 没人能续租，
  // 于是到期后节点卡在 submitted（本轮就这样连环卡死 7 个节点）。
  // 所以证据落账时由系统把租约延到这个窗口。0 = 不延长。
  auditLeaseTtlSec: { type: 'number', default: 600, description: '证据提交后系统把租约延长到的审计窗口（秒，默认 600；0=不延长）' },
  // ── 真并发的天花板：宿主子会话数 ──
  // 宿主 `subagents.maxActiveSubagents` 默认 **8**（与 Team 成员数是两层不同的限制）。
  // 不改它：maxParallel 配 64、maxMembers 配 256 都没用，第 9 个子会话起就报
  // `subagent limit reached (active child limit: 8)`。
  // 它是 Cordis 响应式 Config（每次开子会话现读），所以启用协作时改它**立即生效**，不用重启。
  subagentMaxActive: { type: 'number', default: 256, description: '启用协作时把宿主 subagents.maxActiveSubagents 提到的值（默认 256；0=不动）。这是真并发天花板，宿主默认只允许 8 个子会话同时活' },
  // ── 常驻协调器 ──
  // 把「维护职责」从 dispatch 与 Lead 手里拿出来：reap 只挂在 dispatch 上时，
  // mode=off 就没人回收；审计路由全靠 Lead 手工转发，worker 一多就不可扩展。
  // 它**不派活**（那是 dispatch 的职责），只做确定性的 reap + 审计路由。
  coordinatorEnabled: { type: 'boolean', default: true, description: '常驻协调器：定时 reap（过期租约 + 孤儿）并按需自动派审计实例（不派活）' },
  coordinatorIntervalMs: { type: 'number', default: 30000, description: '协调器间隔毫秒（最小 5000）' },
  auditDispatchAfterMs: { type: 'number', default: 120000, description: '节点 submitted 超过该毫秒数仍无人验，则自动派审计实例（0=不自动派审计）' },
  auditRole: { type: 'string', default: 'AUDIT_CODE', description: '自动审计使用的职务码（必须是审计职务，否则会被授权层拒）' },
  // ── 子实例的 Agent 预设 ──
  // **默认空 = 继承父会话的预设**。不要默认填 `memory-first`：
  // 宿主对「指定了但不存在的预设」是**直接抛 PRESET_UNAVAILABLE**，spawn 会失败——
  // 不是降级，是派不出去。而空值走「继承父」的路径，不需要任何额外包存在。
  // 要用特定预设，先自行安装那个包，再把名字填这里。
  defaultAgentPreset: { type: 'string', default: '', description: '子实例默认使用的 Agent 预设名（空=继承父会话；填了但没装那个包会导致派发失败）' },
  // ── 未 claim 登记的宽限期（与 enqueueStaleMs 是两个问题）──
  // worker 派出去了、却一直没 claim 到租约 = 崩在启动阶段或宿主根本没拉起它。
  // 这种登记**没有任何能证明它活着的信号**（task_claimed 会在秒级到达），
  // 用 30 分钟等它只是在让幽灵登记吃满 maxQueuedTasks，把 queue 闸门堵死。
  // 默认 120 秒：覆盖「冷启动 + 模型首包」的常见延迟，又远短于 30 分钟。
  enqueueUnclaimedStaleMs: { type: 'number', default: 120000, description: '未 claim 的派发登记宽限期（毫秒，默认 2 分钟；0=沿用 enqueueStaleMs）' },
  // ── P2-12 reap 策略（只配置+注释，不加定时器；由 Lead 在 service reapAgents 接线时消费）──
  // reapPolicy.enabled：默认 false —— 不主动回收任何空闲子 Agent；改 true 仍默认 dry-run（见 reapDryRun）。
  reapEnabled: { type: 'boolean', default: false, description: 'reapPolicy.enabled：是否启用空闲子 Agent 回收（默认关）' },
  // reapPolicy.idleThresholdMinutes：空闲阈值（分钟，默认 30）—— 子 Agent 空闲超过该时长才进候选；running 永不候选。
  reapIdleThresholdMinutes: { type: 'number', default: 30, description: 'reapPolicy.idleThresholdMinutes：空闲阈值分钟（默认 30）' },
  // reapPolicy.dryRun：默认 true —— 只列候选不释放/归档；改 false 才会真的 drain/archive。
  reapDryRun: { type: 'boolean', default: true, description: 'reapPolicy.dryRun：只出候选不执行（默认开）' },
  // reapPolicy.requireNoRunningDescendants：默认 true —— 候选会话的子孙树里只要有 running 就整棵跳过（无 running 子孙才候选）。
  reapRequireNoRunningDescendants: { type: 'boolean', default: true, description: 'reapPolicy.requireNoRunningDescendants：无 running 子孙才候选（默认开）' },
};

                               
                        
                                   
                              
                           
                                
                                           
                               
                            
                    
                                  
                             
                                                            
                            
                                     
                           
                                                               
                          
                         
                            
                         
                                
                            
                   
                      
                       
                      
                      
                              
                             
                     
                      
                         
                         
                         
                     
                    
                 
                      
                  
                  
                 
                 
                           
                     
                    
                              
                             
                       
                             
                             
                          
                           
                               
                         
                                  
                       
                                   
                      
                                           
  

/**
 * P2-12 reapPolicy 嵌套视图（供 Lead 接线时按字段消费；无定时器，是否/何时触发由调用方决定）：
 *   - enabled=false（默认）：不回收；
 *   - idleThresholdMinutes：空闲阈值，低于阈值不候选；
 *   - dryRun=true（默认）：只列候选；
 *   - requireNoRunningDescendants=true（默认）：候选会话子孙树含 running 时整棵跳过。
 */
                             
                   
                               
                  
                                       
 

export function reapPolicyFromConfig(cfg                          )             {
  return {
    enabled: cfg.reapEnabled === true,
    idleThresholdMinutes: Number(cfg.reapIdleThresholdMinutes ?? 30) || 30,
    dryRun: cfg.reapDryRun !== false,
    requireNoRunningDescendants: cfg.reapRequireNoRunningDescendants !== false,
  };
}

function coerce(value         , type           )          {
  if (type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  if (type === 'boolean') return value === true || value === 'true';
  return String(value);
}

export function normalizeConfig(input         )                  {
  const source = (input && typeof input === 'object' ? input : {})                           ;
  const out                          = {};
  for (const [key, spec] of Object.entries(CONFIG_SPEC)) {
    const raw = source[key];
    out[key] = raw === undefined || raw === null ? spec.default : coerce(raw, spec.type);
  }
  // tokenSecret：空 = 关闭 A2A；非空必须 ≥16 字符（否则 config 直接抛，fail-fast）
  const secret = String(out.tokenSecret ?? '');
  if (secret && secret.length < 16) {
    throw new Error(`tokenSecret 太短（${secret.length}）：非空时必须 ≥16 字符，或留空关闭 A2A`);
  }
  return out                   ;
}

function jsonSchemaOf(spec           ) {
  return { type: spec.type, default: spec.default, description: spec.description };
}

function standardSchema() {
  return {
    '~standard': {
      version: 1         ,
      vendor: 'dsh-l0-control',
      validate(value         ) {
        return { value: normalizeConfig(value) };
      },
    },
    toJSON() {
      return {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(CONFIG_SPEC).map(([key, spec]) => [key, jsonSchemaOf(spec)]),
        ),
        additionalProperties: false,
      };
    },
  };
}

                           
                                                      
                                                        
                                                        
                                                          
 

async function loadSchemastery()                                                       {
  const roots           = [];
  const push = (dir         ) => {
    if (dir && !roots.includes(dir)) roots.push(dir);
  };
  push(process.env.DSH_PROFILE_DIR);
  if (process.env.DSH_HOME) push(path.join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE ?? 'desktop'));
  for (const profile of [process.env.DSH_PROFILE, 'desktop']) {
    if (profile) push(path.join(os.homedir(), '.dsh', 'profiles', profile));
  }
  for (const root of roots) {
    const base = path.join(root, 'node_modules', '@deepseek-ai', 'schemastery');
    for (const rel of ['lib/index.mjs', 'lib/index.js', 'index.js']) {
      const file = path.join(base, rel);
      if (!fs.existsSync(file)) continue;
      try {
        const mod = await import(pathToFileURL(file).href);
        const z = (mod                                 ).default ?? (mod                              );
        if (typeof z?.object === 'function') return { z, file };
      } catch {
        // 换下一个候选
      }
    }
  }
  return null;
}

function buildSchemastery(z                 ) {
  const shape                          = {};
  for (const [key, spec] of Object.entries(CONFIG_SPEC)) {
    const field = z[spec.type]();
    shape[key] = field.default(spec.default         );
  }
  return z.object(shape);
}

const loaded = await loadSchemastery();

export const Config = loaded ? buildSchemastery(loaded.z) : standardSchema();
export const ConfigSource         = loaded ? 'schemastery' : 'standard-schema-fallback';
export const ConfigSourceFile                = loaded?.file ?? null;


//# sourceURL=config.js