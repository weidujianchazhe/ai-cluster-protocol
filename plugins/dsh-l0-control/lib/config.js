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
  updateRepo: { type: 'string', default: 'weidujianchazhe/ai-cluster-protocol', description: '检查更新用的 GitHub 仓库（owner/name；空=关闭检查）' },
  updateRef: { type: 'string', default: 'main', description: '检查更新用的分支/标签' },
};

                               
                        
                   
                      
                       
                      
                      
                              
                             
                     
                      
                         
                         
                         
                     
                    
                 
                      
                  
                  
                 
                 
                     
                    
  

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