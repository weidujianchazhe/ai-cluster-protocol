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
  dispatchDryRun: { type: 'boolean', default: true, description: '只出计划不实际派活（默认开；改 false 才会真的 claim）' },
  dispatchInstance: { type: 'string', default: 'ROLE-DISPATCH-01', description: '派活时使用的实例 ID' },
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