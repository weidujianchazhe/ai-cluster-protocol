/**
 * 多工作区服务池（task-39）：每个工作区一份独立的 L0ControlService，
 * 各自 stateDir / journal / lock / snapshot，互不混、互不抢锁。
 *
 * 规则（见 `control_plane/MULTI-WORKSPACE独立journal.md`）：
 *   - 主工作区（实例配置的 workspaceRoot）**沿用旧 stateDir**（如 `.l0-control-autonomy-2`，兼容已有数据）；
 *   - 其他工作区默认 `<workspaceRoot>/.l0-control`；
 *   - registry（`<primaryStateDir>/workspaces.json`）记录 `workspaceRoot → stateDir`，重启据此恢复；
 *   - 工作目录解析：DSH `workingDirectory.ensure(agent)` → 失败回退主工作区。
 */
import fs from 'node:fs';
import path from 'node:path';

const REGISTRY_FILE = 'workspaces.json';

                                 
                        
                   
                    
 

                           
                        
                   
                      
 

/** 懒建 + 注册表的最小实现；不依赖 core/state 内部。 */
export class ServicePool {
                   ctx     ;
                   config     ;
                   meta     ;
                   createService                                           ;
                   primaryRoot        ;
                   primaryStateDir        ;
                   services = new Map             ();
                   journalPaths = new Map                ();
          registry                              = new Map();

  constructor(options   
             
                
               
                                                             
                        
                            
   ) {
    this.ctx = options.ctx;
    this.config = options.config;
    this.meta = options.meta ?? {};
    this.createService = options.createService;
    this.primaryRoot = path.resolve(options.primaryRoot);
    this.primaryStateDir = path.resolve(options.primaryRoot, options.primaryStateDir);
    this.loadRegistry();
  }

  get registryPath()         {
    return path.join(this.primaryStateDir, REGISTRY_FILE);
  }

          loadRegistry()       {
    try {
      if (!fs.existsSync(this.registryPath)) return;
      const raw = JSON.parse(fs.readFileSync(this.registryPath, 'utf8'))                                     ;
      for (const row of raw?.workspaces ?? []) {
        if (!row?.workspaceRoot) continue;
        this.registry.set(path.resolve(row.workspaceRoot), {
          workspaceRoot: path.resolve(row.workspaceRoot),
          stateDir: path.resolve(row.stateDir ?? path.join(row.workspaceRoot, '.l0-control')),
          updatedAt: String(row.updatedAt ?? ''),
        });
      }
    } catch {
      // registry 损坏 → 从空开始（懒建时会重新写）
    }
  }

          saveRegistry()       {
    try {
      fs.mkdirSync(path.dirname(this.registryPath), { recursive: true });
      const payload = {
        schema: 1,
        updatedAt: new Date().toISOString(),
        workspaces: [...this.registry.values()].sort((a, b) => a.workspaceRoot.localeCompare(b.workspaceRoot)),
      };
      fs.writeFileSync(this.registryPath, JSON.stringify(payload, null, 2), 'utf8');
    } catch {
      // 写失败不影响运行
    }
  }

  /** 会话工作目录 → workspaceRoot；取不到回退主工作区。 */
  resolveWorkspaceRoot(agent     )         {
    try {
      const workingDirectory = this.ctx?.get?.('workingDirectory');
      const cwd =
        (typeof workingDirectory?.ensure === 'function' ? workingDirectory.ensure(agent) : null) ??
        workingDirectory?.defaultDirectory ??
        null;
      const value = typeof cwd === 'string' ? cwd : cwd?.path ?? cwd?.directory ?? null;
      if (value && path.isAbsolute(String(value))) return path.resolve(String(value));
    } catch {
      // 回退
    }
    return this.primaryRoot;
  }

  /** 该工作区应使用的 stateDir（主工作区沿用旧目录，其他 `.l0-control`）。 */
  stateDirFor(workspaceRoot        )         {
    const root = path.resolve(workspaceRoot);
    if (root === this.primaryRoot) return this.primaryStateDir;
    const registered = this.registry.get(root);
    if (registered?.stateDir) return registered.stateDir;
    return path.join(root, '.l0-control');
  }

  /** 懒建实例；同一 workspaceRoot 只建一次。 */
  get(workspaceRoot                )      {
    const root = path.resolve(String(workspaceRoot ?? this.primaryRoot));
    const cached = this.services.get(root);
    if (cached) return cached;
    const stateDir = this.stateDirFor(root);
    const relativeStateDir = root === this.primaryRoot ? this.config.stateDir : path.relative(root, stateDir) || '.l0-control';
    const service = this.createService(
      this.ctx,
      { ...this.config, workspaceRoot: root, stateDir: relativeStateDir },
      this.meta,
    );
    this.services.set(root, service);
    this.journalPaths.set(root, String(service?.journalPath ?? path.join(stateDir, this.config.journalFile)));
    this.registry.set(root, { workspaceRoot: root, stateDir, updatedAt: new Date().toISOString() });
    this.saveRegistry();
    return service;
  }

  /** 已建实例（不触发懒建），用于 /ui/workspaces 的轻量列举。 */
  peek(workspaceRoot        )             {
    return this.services.get(path.resolve(String(workspaceRoot))) ?? null;
  }

  /** 认领一个已建实例（主实例不重复构造）。 */
  adopt(service     )      {
    const root = path.resolve(String(service?.workspaceRoot ?? this.primaryRoot));
    this.services.set(root, service);
    this.journalPaths.set(root, String(service?.journalPath ?? ''));
    this.registry.set(root, { workspaceRoot: root, stateDir: String(service?.stateDir ?? this.stateDirFor(root)), updatedAt: new Date().toISOString() });
    this.saveRegistry();
    return service;
  }

  /** registry 列表 + 各实例的 journal 事件数与图计数（实例已建才有 counts）。 */
  async list()                                                                                                                                 {
    const roots = new Set        ([this.primaryRoot, ...this.registry.keys(), ...this.services.keys()]);
    const rows                                                                                                                        = [];
    for (const root of [...roots].sort()) {
      const entry = this.registry.get(root);
      const stateDir = this.stateDirFor(root);
      const service = this.services.get(root) ?? null;
      const journalPath = service?.journalPath ?? path.join(stateDir, this.config.journalFile);
      let journalEvents                = null;
      try {
        journalEvents = (service ? service.readJournal() : readJournalRows(journalPath)).length;
      } catch {
        journalEvents = null;
      }
      let counts          = null;
      if (service && typeof service.graphStatus === 'function') {
        try {
          const status = await service.graphStatus();
          counts = status?.graph?.result?.counts ?? status?.graph?.counts ?? null;
        } catch {
          counts = null;
        }
      }
      rows.push({
        workspaceRoot: root,
        stateDir,
        updatedAt: entry?.updatedAt ?? '',
        journalPath: String(journalPath),
        journalEvents,
        counts,
        instantiated: Boolean(service),
      });
    }
    return rows;
  }

  async listRoots()                    {
    return (await this.list()).map((row) => row.workspaceRoot);
  }
}

function readJournalRows(file        )            {
  try {
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}


//# sourceURL=workspaces\pool.js