/**
 * Bootstrap 验收：`project_init` 的 6 类用例（规格：`control_plane/BOOTSTRAP-阶段.md`）。
 *
 *   1. dry-run：零写入、would-create/would-init；
 *   2. execute：结构 + marker 齐全、git init（不 commit）；
 *   3. 幂等：重复 execute 返回 skipped、不改内容；
 *   4. 非空冲突：零写入、`conflict:not-empty`；
 *   5. 越界 root：拒绝（`root-outside-workspace`）；
 *   6. git 缺失：文件创建成功、`git.missing`。
 *
 * 用临时 workspaceRoot，真写盘（不是 mock），退出码 0 = 全绿。
 * 用法：`node scripts/bootstrap-check.mjs [--json]`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const mod = await import(pathToFileURL(path.join(root, 'lib', 'bootstrap', 'init.js')).href);

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'l0-bootstrap-'));
const deps = { workspaceRoot: base };

const checks = [];
function check(name, fn) {
  try {
    const result = fn();
    checks.push({ name, ok: result?.ok === true, detail: result?.detail ?? null });
  } catch (error) {
    checks.push({ name, ok: false, detail: { error: String(error?.message || error) } });
  }
}

// 工程区结构（管理区是**同级**目录，单独校验）
const FILES = [
  'README.md',
  '.gitignore',
  'src',
  'docs',
  path.join('.l0-control', 'project.json'),
];
const MGMT_REL = [
  'INDEX.md',
  'STATE.md',
  path.join('tasks', 'BOOTSTRAP.md'),
  path.join('designs', 'BOOTSTRAP.md'),
  'reports',
];

// ── 1. dry-run 零写入 ──────────────────────────────────────
check('dry-run: 默认 dryRun=true，零写入，状态 would-create/would-init', () => {
  const target = path.join(base, 'projects', 'alpha');
  const result = mod.runProjectInit({ projectName: 'Alpha', wish: 'demo', root: target }, deps);
  const created = result.actions.filter((row) => row.status === 'created').length;
  return {
    ok:
      result.ok === true &&
      result.dryRun === true &&
      !fs.existsSync(target) &&
      created === 0 &&
      result.actions.some((row) => row.status === 'would-create') &&
      ['would-init', 'missing', 'skipped'].includes(result.git.state),
    detail: { statuses: [...new Set(result.actions.map((row) => row.status))], git: result.git, exists: fs.existsSync(target) },
  };
});

// ── 2. execute 结构 + marker + git ─────────────────────────
const target = path.join(base, 'projects', 'alpha');
const executed = mod.runProjectInit(
  { projectName: 'Alpha', wish: 'demo', root: target, dryRun: false, gitInit: false },
  deps,
);
check('execute: 工程区结构齐全 + marker 落盘 + 管理区在**同级** <root>-管理区', () => {
  const missing = FILES.filter((rel) => !fs.existsSync(path.join(target, rel)));
  const marker = JSON.parse(fs.readFileSync(path.join(target, '.l0-control', 'project.json'), 'utf8'));
  const mgmtDir = `${target}-管理区`;
  const missingMgmt = MGMT_REL.filter((rel) => !fs.existsSync(path.join(mgmtDir, rel)));
  return {
    ok:
      executed.ok === true &&
      executed.dryRun === false &&
      missing.length === 0 &&
      missingMgmt.length === 0 &&
      executed.project.managementDir === mgmtDir &&
      marker.slug === 'alpha' &&
      // 旧默认（root 内的 管理区/）不应再被创建
      !fs.existsSync(path.join(target, '管理区')),
    detail: {
      missing,
      missingMgmt,
      managementDir: executed.project.managementDir,
      marker: { slug: marker.slug, name: marker.name, schema: marker.schema },
      git: executed.git,
    },
  };
});

check('execute: README 带上项目名与愿望', () => {
  const readme = fs.readFileSync(path.join(target, 'README.md'), 'utf8');
  return { ok: readme.includes('Alpha') && readme.includes('demo'), detail: { head: readme.split('\n').slice(0, 3) } };
});

// ── 3. 幂等 ───────────────────────────────────────────────
check('幂等: 重复 execute 全部 skipped，marker 不改写', () => {
  const before = fs.readFileSync(path.join(target, '.l0-control', 'project.json'), 'utf8');
  const again = mod.runProjectInit({ projectName: 'Alpha', root: target, dryRun: false }, deps);
  const after = fs.readFileSync(path.join(target, '.l0-control', 'project.json'), 'utf8');
  return {
    ok: again.ok === true && again.actions.every((row) => row.status === 'skipped') && before === after,
    detail: { statuses: [...new Set(again.actions.map((row) => row.status))], git: again.git.state },
  };
});

// ── 4. 非空冲突零写入 ─────────────────────────────────────
check('冲突: 非空目录无 marker → conflict:not-empty 且零写入', () => {
  const busy = path.join(base, 'busy');
  fs.mkdirSync(busy, { recursive: true });
  fs.writeFileSync(path.join(busy, 'keep.txt'), 'x', 'utf8');
  const result = mod.runProjectInit({ projectName: 'Busy', root: busy, dryRun: false }, deps);
  return {
    ok:
      result.ok === false &&
      result.conflicts.includes('not-empty') &&
      !fs.existsSync(path.join(busy, 'README.md')) &&
      !fs.existsSync(path.join(busy, '.l0-control')) &&
      fs.readFileSync(path.join(busy, 'keep.txt'), 'utf8') === 'x',
    detail: { conflicts: result.conflicts, git: result.git.state },
  };
});

// ── 5. 越界 root 拒绝 ─────────────────────────────────────
check('安全阀: root 越出 workspaceRoot → 拒绝', () => {
  const outside = path.resolve(base, '..', 'escape-target');
  const result = mod.runProjectInit({ projectName: 'Escape', root: outside, dryRun: false }, deps);
  const viaDotDot = mod.runProjectInit({ projectName: 'Escape2', root: '../escape-2', dryRun: false }, deps);
  return {
    ok:
      result.ok === false &&
      result.conflicts.includes('root-outside-workspace') &&
      !fs.existsSync(outside) &&
      viaDotDot.ok === false,
    detail: { conflicts: result.conflicts, dotDot: viaDotDot.conflicts },
  };
});

// ── 6. git 缺失 fail-soft ─────────────────────────────────
check('git 缺失: 文件创建成功、git.missing、不阻断', () => {
  const soft = path.join(base, 'projects', 'soft');
  const result = mod.runProjectInit(
    { projectName: 'Soft', root: soft, dryRun: false },
    { workspaceRoot: base, gitAvailable: () => false },
  );
  return {
    ok:
      result.ok === true &&
      result.git.state === 'missing' &&
      fs.existsSync(path.join(soft, 'README.md')) &&
      fs.existsSync(path.join(soft, '.l0-control', 'project.json')),
    detail: { git: result.git, files: fs.readdirSync(soft) },
  };
});

check('git init 成功路径: gitInit=true → initialized 且未 commit', () => {
  const repo = path.join(base, 'projects', 'withgit');
  const calls = [];
  const result = mod.runProjectInit(
    { projectName: 'WithGit', root: repo, dryRun: false },
    {
      workspaceRoot: base,
      gitAvailable: () => true,
      gitInit: (dir) => {
        calls.push(dir);
        fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
        return { ok: true, detail: 'git init' };
      },
    },
  );
  return {
    ok:
      result.ok === true &&
      result.git.state === 'initialized' &&
      calls.length === 1 &&
      fs.existsSync(path.join(repo, '.git')) &&
      !fs.existsSync(path.join(repo, '.git', 'COMMIT_EDITMSG')),
    detail: { git: result.git, calls: calls.length },
  };
});

// ── 7. managementRoot 自定义（相对 workspaceRoot 解析）─────────
check('managementRoot: 自定义相对路径按 workspaceRoot 解析并落位', () => {
  const proj = path.join(base, 'projects', 'custom-mgmt');
  const rel = path.join('管理区-custom');
  const result = mod.runProjectInit(
    { projectName: 'CustomMgmt', root: proj, managementRoot: rel, dryRun: false, gitInit: false },
    deps,
  );
  const expected = path.join(base, rel);
  return {
    ok:
      result.ok === true &&
      result.project.managementDir === expected &&
      fs.existsSync(path.join(expected, 'INDEX.md')) &&
      fs.existsSync(path.join(expected, 'reports')) &&
      // 工程区默认不再自带 管理区/
      !fs.existsSync(path.join(proj, '管理区')),
    detail: { managementDir: result.project.managementDir, expected },
  };
});

check('managementRoot: 自定义后重复 execute 幂等（不重写）', () => {
  const proj = path.join(base, 'projects', 'custom-mgmt');
  const expected = path.join(base, '管理区-custom');
  const indexFile = path.join(expected, 'INDEX.md');
  const before = fs.readFileSync(indexFile, 'utf8');
  const again = mod.runProjectInit(
    { projectName: 'CustomMgmt', root: proj, managementRoot: '管理区-custom', dryRun: false, gitInit: false },
    deps,
  );
  return {
    ok:
      again.ok === true &&
      again.actions.every((row) => row.status === 'skipped') &&
      fs.readFileSync(indexFile, 'utf8') === before,
    detail: { statuses: [...new Set(again.actions.map((row) => row.status))] },
  };
});

// ── 8. managementRoot 越界拒绝 ─────────────────────────────
check('managementRoot: 越界 → management-root-outside-workspace 且零写入', () => {
  const proj = path.join(base, 'projects', 'escape-mgmt');
  const outside = path.resolve(base, '..', 'mgmt-escape');
  const result = mod.runProjectInit(
    { projectName: 'EscapeMgmt', root: proj, managementRoot: outside, dryRun: false, gitInit: false },
    deps,
  );
  const viaDotDot = mod.runProjectInit(
    { projectName: 'EscapeMgmt2', root: proj, managementRoot: '../mgmt-escape-2', dryRun: false },
    deps,
  );
  return {
    ok:
      result.ok === false &&
      result.conflicts.includes('management-root-outside-workspace') &&
      !fs.existsSync(outside) &&
      !fs.existsSync(proj) &&
      viaDotDot.ok === false,
    detail: { conflicts: result.conflicts, dotDot: viaDotDot.conflicts },
  };
});

// ── 9. 选中工作区（workspaceRoot 别名）─────────────────────
check('workspaceRoot: 选中工作区落位（建在选中工作区下，不在实例默认目录）', () => {
  const selected = path.join(base, 'ws-selected');
  fs.mkdirSync(selected, { recursive: true });
  const result = mod.runProjectInit(
    { projectName: 'Selected', workspaceRoot: selected, dryRun: false, gitInit: false },
    deps,
  );
  const expectedRoot = path.join(selected, 'projects', 'selected');
  return {
    ok:
      result.ok === true &&
      result.project.workspaceRoot === selected &&
      result.project.root === expectedRoot &&
      result.project.managementDir === `${expectedRoot}-管理区` &&
      fs.existsSync(path.join(expectedRoot, 'README.md')) &&
      fs.existsSync(path.join(`${expectedRoot}-管理区`, 'INDEX.md')) &&
      // 没有落到实例默认的 projects/ 下
      !fs.existsSync(path.join(base, 'projects', 'selected')),
    detail: {
      workspaceRoot: result.project.workspaceRoot,
      root: result.project.root,
      managementDir: result.project.managementDir,
    },
  };
});

check('workspaceRoot: 别名 selectedWorkspace / workspacePath 等价', () => {
  const selected = path.join(base, 'ws-selected');
  const viaAlias = mod.runProjectInit({ projectName: 'Alias One', selectedWorkspace: selected }, deps);
  const viaPath = mod.runProjectInit({ projectName: 'Alias Two', workspacePath: selected }, deps);
  return {
    ok:
      viaAlias?.project?.workspaceRoot === selected &&
      viaPath?.project?.workspaceRoot === selected &&
      viaAlias?.dryRun === true &&
      viaPath?.dryRun === true,
    detail: { alias: viaAlias?.project?.workspaceRoot, path: viaPath?.project?.workspaceRoot },
  };
});

check('workspaceRoot: 越界（不在允许父目录下）→ 拒绝且零写入', () => {
  const outside = path.resolve(base, '..', '..', 'outside-ws');
  const result = mod.runProjectInit({ projectName: 'OutsideWs', workspaceRoot: outside, dryRun: false }, deps);
  const missing = mod.runProjectInit({ projectName: 'MissingWs', workspaceRoot: path.join(base, 'nope-ws'), dryRun: false }, deps);
  return {
    ok:
      result.ok === false &&
      result.conflicts.includes('workspace-root-outside-allowed-parent') &&
      missing.ok === false &&
      missing.conflicts.includes('workspace-root-not-found') &&
      !fs.existsSync(outside),
    detail: { outside: result.conflicts, missing: missing.conflicts },
  };
});

// ── 10. 旧 marker 兼容（记录里的 managementDir 保持原样）────
check('旧 marker: 沿用 marker 里的 managementDir（`<root>/管理区`）', () => {
  const legacyRoot = path.join(base, 'projects', 'legacy');
  fs.mkdirSync(path.join(legacyRoot, '.l0-control'), { recursive: true });
  fs.writeFileSync(
    path.join(legacyRoot, '.l0-control', 'project.json'),
    JSON.stringify({ schema: 1, name: 'Legacy', slug: 'legacy', managementDir: path.join(legacyRoot, '管理区') }),
    'utf8',
  );
  const result = mod.runProjectInit({ projectName: 'Legacy', root: legacyRoot, dryRun: false }, deps);
  return {
    ok:
      result.ok === true &&
      result.actions.every((row) => row.status === 'skipped') &&
      result.project.managementDir === path.join(legacyRoot, '管理区'),
    detail: { managementDir: result.project.managementDir, statuses: [...new Set(result.actions.map((row) => row.status))] },
  };
});

fs.rmSync(base, { recursive: true, force: true });

const failed = checks.filter((row) => !row.ok);
const report = { ok: failed.length === 0, total: checks.length, failed: failed.length, checks };
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2));
else {
  for (const row of checks) process.stdout.write(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}${row.ok ? '' : `  → ${JSON.stringify(row.detail).slice(0, 200)}`}\n`);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
}
process.exit(report.ok ? 0 : 1);
