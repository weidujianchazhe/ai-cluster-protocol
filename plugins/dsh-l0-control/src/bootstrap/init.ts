/**
 * Bootstrap 阶段：`project_init`。
 *
 * 规格：`control_plane/BOOTSTRAP-阶段.md`。要点：
 *   - **默认 dry-run**：`dryRun !== false` 时零写入，只返回 would-create / would-init；
 *   - **根目录白名单**：root 必须落在 workspaceRoot 下，`..` 逃逸拒绝；
 *   - **幂等**：marker `.l0-control/project.json` 存在且 slug 匹配 → 返回现有，不重写；
 *   - **防覆盖**：目标目录非空且无 marker → `conflict:not-empty`，零写入；
 *   - **git**：只在 `.git` 不存在时 `git init`，**绝不 commit/push**；git 缺失 fail-soft（`git.missing`）；
 *   - **先 preflight 后写**：任何 conflict 都零写入；execute 失败尽力清理本次创建的目录。
 *
 * 本模块不碰 core/state，只做文件系统与 git 的最小动作，便于单测注入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type ActionStatus =
  | 'would-create'
  | 'created'
  | 'skipped'
  | 'conflict'
  | 'would-init'
  | 'initialized';

export interface ProjectInitInput {
  projectName?: string;
  wish?: string;
  slug?: string;
  root?: string;
  /** 选中工作区（工程区/管理区都必须落在它下面）；别名 `selectedWorkspace` / `workspacePath`。 */
  workspaceRoot?: string;
  selectedWorkspace?: string;
  workspacePath?: string;
  /** 管理区目录：默认同级 `<root>-管理区`；相对路径按选中 workspaceRoot 解析。 */
  managementRoot?: string;
  dryRun?: boolean;
  gitInit?: boolean;
  management?: boolean;
  allowEmptyExisting?: boolean;
}

export interface ProjectInitAction {
  kind: string;
  path: string;
  status: ActionStatus;
}

export interface ProjectInitResult {
  ok: boolean;
  dryRun: boolean;
  project: { name: string; slug: string; workspaceRoot: string; root: string; managementDir: string; marker: string };
  actions: ProjectInitAction[];
  conflicts: string[];
  git: { state: 'existing' | 'initialized' | 'skipped' | 'missing' | 'would-init'; detail?: string };
  next: string;
}

export interface BootstrapDeps {
  workspaceRoot: string;
  existsSync?: (p: string) => boolean;
  readFileSync?: (p: string, enc: 'utf8') => string;
  mkdirSync?: (p: string, opts: { recursive: boolean }) => unknown;
  writeFileSync?: (p: string, data: string, enc: 'utf8') => unknown;
  readdirSync?: (p: string) => string[];
  rmSync?: (p: string, opts: { recursive: boolean; force: boolean }) => unknown;
  /** 注入 git 探测，便于测试 "git 缺失"。 */
  gitAvailable?: () => boolean;
  gitInit?: (root: string) => { ok: boolean; detail?: string };
}

const MARKER_REL = path.join('.l0-control', 'project.json');

export function slugify(value: string): string {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'project';
}

/** root 是否在 workspaceRoot 内（解析后逐段比较，挡 `..` 逃逸）。 */
export function isInside(workspaceRoot: string, candidate: string): boolean {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(candidate);
  if (target === root) return true;
  return target.startsWith(root + path.sep);
}

function defaultGitAvailable(): boolean {
  const probe = spawnSync('git', ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

function defaultGitInit(root: string): { ok: boolean; detail?: string } {
  const result = spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
  if (result.error) return { ok: false, detail: String(result.error.message ?? result.error) };
  if (result.status !== 0) return { ok: false, detail: `${result.stderr || result.stdout || 'git init failed'}`.trim() };
  return { ok: true, detail: 'git init' };
}

function depsOf(deps: BootstrapDeps) {
  return {
    existsSync: deps.existsSync ?? ((p: string) => fs.existsSync(p)),
    readFileSync: deps.readFileSync ?? ((p: string, enc: 'utf8') => fs.readFileSync(p, enc)),
    mkdirSync: deps.mkdirSync ?? ((p: string, opts: { recursive: boolean }) => fs.mkdirSync(p, opts)),
    writeFileSync: deps.writeFileSync ?? ((p: string, data: string, enc: 'utf8') => fs.writeFileSync(p, data, enc)),
    readdirSync: deps.readdirSync ?? ((p: string) => fs.readdirSync(p)),
    rmSync: deps.rmSync ?? ((p: string, opts: { recursive: boolean; force: boolean }) => fs.rmSync(p, opts)),
    gitAvailable: deps.gitAvailable ?? defaultGitAvailable,
    gitInit: deps.gitInit ?? defaultGitInit,
  };
}

/** 目标结构：`target` 是绝对路径（工程区相对 root，管理区相对 managementDir）。 */
function layout(input: { management: boolean; name: string; slug: string; wish: string; root: string; managementDir: string }) {
  const engine: Array<{ target: string; kind: string; dir?: boolean; content?: string }> = [
    {
      target: path.join(input.root, 'README.md'),
      kind: 'file:README',
      content: `# ${input.name}\n\n${input.wish ? `${input.wish}\n\n` : ''}- slug: \`${input.slug}\`\n- 由 dsh-l0-control \`project_init\` 生成（bootstrap 阶段）\n`,
    },
    { target: path.join(input.root, '.gitignore'), kind: 'file:gitignore', content: 'node_modules/\n.l0-control/core-state/\n*.log\n' },
    { target: path.join(input.root, 'src'), kind: 'dir:src', dir: true },
    { target: path.join(input.root, 'docs'), kind: 'dir:docs', dir: true },
  ];
  if (input.management) {
    const mgmt = input.managementDir;
    engine.push(
      {
        target: path.join(mgmt, 'INDEX.md'),
        kind: 'file:mgmt-index',
        content: `# 管理区 · INDEX\n\n- 项目：${input.name}（${input.slug}）\n- STATE：\`STATE.md\`\n- 任务：\`tasks/\`\n- 设计：\`designs/\`\n- 报告：\`reports/\`\n- 位置：\`${mgmt}\`\n`,
      },
      {
        target: path.join(mgmt, 'STATE.md'),
        kind: 'file:mgmt-state',
        content: `# STATE\n\n- 阶段：bootstrap\n- 图：未创建（下一步 \`wish_submit\`）\n- 更新时间：${new Date().toISOString()}\n`,
      },
      {
        target: path.join(mgmt, 'tasks', 'BOOTSTRAP.md'),
        kind: 'file:mgmt-tasks',
        content: `# tasks · BOOTSTRAP\n\n- [x] 工程区骨架\n- [x] 管理区骨架\n- [x] marker \`.l0-control/project.json\`\n- [ ] \`wish_submit\` 建 6 节点图\n- [ ] closeout / new-card 接管\n`,
      },
      {
        target: path.join(mgmt, 'designs', 'BOOTSTRAP.md'),
        kind: 'file:mgmt-designs',
        content: `# designs · BOOTSTRAP\n\n初始态说明：本文件是管理区可被 closeout/new-card 接管的起点，不是完整协议实现。\n`,
      },
      { target: path.join(mgmt, 'reports'), kind: 'dir:mgmt-reports', dir: true },
    );
  }
  return engine;
}

function markerContent(input: { name: string; slug: string; wish: string; marker: string; root: string; managementDir: string }) {
  return `${JSON.stringify(
    {
      schema: 1,
      name: input.name,
      slug: input.slug,
      wish: input.wish || null,
      root: input.root,
      managementDir: input.managementDir,
      marker: input.marker,
      createdAt: new Date().toISOString(),
      generator: 'dsh-l0-control/project_init',
    },
    null,
    2,
  )}\n`;
}

/**
 * 规划（不做任何写）：返回完整结果对象。`execute=true` 时才真正 mkdir/write/git。
 * dry-run 与 execute 共用同一套 preflight，保证"dry-run 说能做的，execute 一定做得一样"。
 */
export function runProjectInit(input: ProjectInitInput, deps: BootstrapDeps): ProjectInitResult {
  const d = depsOf(deps);
  const instanceWorkspace = path.resolve(deps.workspaceRoot);
  const dryRun = input?.dryRun !== false;
  const gitInitEnabled = input?.gitInit !== false;
  const management = input?.management !== false;
  const allowEmptyExisting = input?.allowEmptyExisting === true;

  // 选中工作区：必须存在，等于实例 workspaceRoot 或位于其父目录下（同父工作区）
  const selectedRaw = input?.workspaceRoot ?? input?.selectedWorkspace ?? input?.workspacePath;
  const workspaceRoot = selectedRaw ? path.resolve(String(selectedRaw)) : instanceWorkspace;
  const allowedParent = path.dirname(instanceWorkspace);
  const workspaceAllowed =
    workspaceRoot === instanceWorkspace || isInside(allowedParent, workspaceRoot);
  const workspaceExists = workspaceRoot === instanceWorkspace ? true : d.existsSync(workspaceRoot);

  const name = String(input?.projectName ?? input?.slug ?? input?.wish ?? 'project').trim() || 'project';
  const slug = slugify(String(input?.slug ?? input?.projectName ?? input?.wish ?? 'project'));
  const rootInput = input?.root ? String(input.root) : path.join(workspaceRoot, 'projects', slug);
  const root = path.isAbsolute(rootInput) ? path.resolve(rootInput) : path.resolve(workspaceRoot, rootInput);
  const managementInput = input?.managementRoot ? String(input.managementRoot) : null;
  // 默认管理区：**同级** `<projectRoot>-管理区`（对齐 AI集群工作协议-管理区 的命名习惯）
  const managementDir = managementInput
    ? path.isAbsolute(managementInput)
      ? path.resolve(managementInput)
      : path.resolve(workspaceRoot, managementInput)
    : `${root}-管理区`;
  const marker = path.join(root, MARKER_REL);

  const project = { name, slug, workspaceRoot, root, managementDir, marker };
  const actions: ProjectInitAction[] = [];
  const conflicts: string[] = [];

  // ── 安全阀 0：选中工作区必须存在且在允许的父目录范围内 ──────
  if (!workspaceAllowed || !workspaceExists) {
    return {
      ok: false,
      dryRun,
      project,
      actions: [{ kind: 'workspace', path: workspaceRoot, status: 'conflict' }],
      conflicts: [workspaceAllowed ? 'workspace-root-not-found' : 'workspace-root-outside-allowed-parent'],
      git: { state: 'skipped' },
      next: `workspaceRoot 必须是已存在目录，且等于 ${instanceWorkspace} 或位于 ${allowedParent} 下`,
    };
  }

  // ── 安全阀 1：root 必须在 workspaceRoot 下 ──────────────────
  if (!isInside(workspaceRoot, root)) {
    return {
      ok: false,
      dryRun,
      project,
      actions: [{ kind: 'root', path: root, status: 'conflict' }],
      conflicts: ['root-outside-workspace'],
      git: { state: 'skipped' },
      next: '把 root 换成 workspaceRoot 下的路径（不允许 .. 逃逸）',
    };
  }

  // ── 安全阀 1b：managementRoot 也必须在 workspaceRoot 下 ────
  if (!isInside(workspaceRoot, managementDir)) {
    return {
      ok: false,
      dryRun,
      project,
      actions: [{ kind: 'management', path: managementDir, status: 'conflict' }],
      conflicts: ['management-root-outside-workspace'],
      git: { state: 'skipped' },
      next: '把 managementRoot 换成 workspaceRoot 下的路径（相对路径按 workspaceRoot 解析）',
    };
  }

  // ── 安全阀 2：marker 幂等 / slug 冲突（旧 marker 的 managementDir 保持原样）──
  const markerExists = d.existsSync(marker);
  if (markerExists) {
    let existing: { slug?: string; managementDir?: string; root?: string } = {};
    try {
      existing = JSON.parse(d.readFileSync(marker, 'utf8')) as typeof existing;
    } catch {
      existing = {};
    }
    const existingSlug = existing.slug ? String(existing.slug) : null;
    if (existingSlug && existingSlug !== slug) {
      return {
        ok: false,
        dryRun,
        project,
        actions: [{ kind: 'marker', path: marker, status: 'conflict' }],
        conflicts: ['marker-slug-mismatch'],
        git: { state: 'skipped' },
        next: `marker 里已有 slug=${existingSlug}，与请求 ${slug} 不一致；换 root 或显式改名`,
      };
    }
    // 旧项目：沿用 marker 里记录的管理区（可能还是 `<root>/管理区`）
    const legacyProject = {
      ...project,
      managementDir: existing.managementDir ? String(existing.managementDir) : project.managementDir,
    };
    const gitState = d.existsSync(path.join(root, '.git')) ? 'existing' : gitInitEnabled ? 'skipped' : 'skipped';
    return {
      ok: true,
      dryRun,
      project: legacyProject,
      actions: [{ kind: 'marker', path: marker, status: 'skipped' }],
      conflicts: [],
      git: { state: gitState as 'existing' | 'skipped', detail: 'already-initialized' },
      next: '项目已初始化；直接 wish_submit 建图，无需重复 init',
    };
  }

  // ── 安全阀 3：非空目录且无 marker → conflict，零写入 ────────
  const rootExists = d.existsSync(root);
  if (rootExists) {
    let entries: string[] = [];
    try {
      entries = d.readdirSync(root);
    } catch {
      entries = [];
    }
    if (entries.length > 0 && !allowEmptyExisting) {
      return {
        ok: false,
        dryRun,
        project,
        actions: [{ kind: 'root', path: root, status: 'conflict' }],
        conflicts: ['not-empty'],
        git: { state: 'skipped' },
        next: `目标非空（${entries.length} 项）且无 marker；换 root，或确认后用 allowEmptyExisting`,
      };
    }
  }

  // ── preflight 通过：规划动作 ───────────────────────────────
  const layoutItems = layout({ management, name, slug, wish: String(input?.wish ?? ''), root, managementDir });
  for (const item of layoutItems) {
    const target = item.target;
    const exists = d.existsSync(target);
    actions.push({
      kind: item.kind,
      path: target,
      status: exists ? 'skipped' : dryRun ? 'would-create' : 'created',
    });
  }
  actions.push({
    kind: 'file:project.json',
    path: marker,
    status: dryRun ? 'would-create' : 'created',
  });

  const hasGit = d.existsSync(path.join(root, '.git'));
  let git: ProjectInitResult['git'] = { state: 'skipped' };
  let needGitInit = false;
  if (hasGit) {
    git = { state: 'existing', detail: '.git 已存在，不做任何 git 动作' };
  } else if (!gitInitEnabled) {
    git = { state: 'skipped', detail: 'gitInit=false' };
  } else if (!d.gitAvailable()) {
    git = { state: 'missing', detail: '宿主未安装 git；文件创建不受影响' };
  } else if (dryRun) {
    git = { state: 'would-init' };
    needGitInit = true;
  } else {
    git = { state: 'initialized', detail: 'git init（不 commit/push）' };
    needGitInit = true;
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      project,
      actions,
      conflicts: [],
      git,
      next: 'dry-run：确认 actions 后把 dryRun 设为 false 再执行',
    };
  }

  // ── 执行（失败清理本次创建的目录）────────────────────────────
  const createdDirs: string[] = [];
  try {
    if (!rootExists) {
      d.mkdirSync(root, { recursive: true });
      createdDirs.push(root);
    }
    for (const item of layoutItems) {
      const target = item.target;
      if (item.dir) {
        if (!d.existsSync(target)) {
          d.mkdirSync(target, { recursive: true });
          createdDirs.push(target);
        }
        continue;
      }
      if (d.existsSync(target)) continue;
      d.mkdirSync(path.dirname(target), { recursive: true });
      d.writeFileSync(target, item.content ?? '', 'utf8');
    }
    d.mkdirSync(path.dirname(marker), { recursive: true });
    if (!d.existsSync(marker)) {
      d.writeFileSync(marker, markerContent({ name, slug, wish: String(input?.wish ?? ''), marker: MARKER_REL, root, managementDir }), 'utf8');
    }
    if (needGitInit) {
      const result = d.gitInit(root);
      git = result.ok
        ? { state: 'initialized', detail: result.detail ?? 'git init' }
        : { state: 'missing', detail: result.detail ?? 'git init 失败（fail-soft）' };
    }
    return {
      ok: true,
      dryRun: false,
      project,
      actions,
      conflicts: [],
      git,
      next: '工程区已就绪：下一步 wish_submit 建 6 节点图',
    };
  } catch (error) {
    for (const dir of createdDirs.reverse()) {
      try {
        d.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 尽力清理
      }
    }
    return {
      ok: false,
      dryRun: false,
      project,
      actions,
      conflicts: ['write-failed'],
      git: { state: 'skipped', detail: String((error as Error)?.message ?? error) },
      next: '写入失败，已尽力清理本次创建的目录；检查权限后重试',
    };
  }
}
