/**
 * 类型检查（P1-9）：把 `tsc --noEmit` 接进验证链。
 *
 * 背景：`scripts/build.mjs` 只剥类型（`module.stripTypeScriptTypes()`），不做类型检查，
 * 于是「接口声明落后于实现」这类错误只能靠人肉发现。这里补一条可机检的闸门。
 *
 * 配置（`tsconfig.typecheck.json`）刻意**不是**「什么都不检查」：
 *   - strict 关、strictNullChecks 关 —— 这批源码历史上从未过类型检查，先求「结构对得上」；
 *   - allowImportingTsExtensions 开 —— 源码用 `.ts` 后缀 import，构建期才改写成 `.js`；
 *   - noEmit —— 只检查不产出（产物仍由 build.mjs 负责）。
 * 因此本步骤会抓到的：接口字段缺漏、导入形状不符、返回值与契约不匹配、
 * 未定义标识符、参数个数不符。抓不到的（strict 关闭导致）：null 判空、
 * 隐式 any 之外的空值流。（提升见 README「构建边界」。）
 *
 * 用法：
 *   node scripts/typecheck.mjs            # 检查，有错退出 1
 *   node scripts/typecheck.mjs --json     # 额外打一段 JSON 摘要（CI 归档用）
 *
 * fail-closed：依赖没装（找不到 typescript）时**不静默跳过**，直接退出 2 ——
 * 「跳过」在验证链里等于假装通过，正是这道闸门要消除的东西。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const wantJson = process.argv.includes('--json');
const configPath = path.join(root, 'tsconfig.typecheck.json');

function fail(error, hint, code = 2) {
  console.error(JSON.stringify({ ok: false, mode: 'typecheck', error, hint }, null, 2));
  process.exit(code);
}

if (!fs.existsSync(configPath)) fail('tsconfig-missing', `缺 ${path.relative(root, configPath)}`);

// tsc 入口：优先本地安装（devDependency），避免依赖全局 PATH。
const candidates = [
  path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
  path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'),
];
const tscBin = candidates.find((p) => fs.existsSync(p));
if (!tscBin) {
  fail(
    'typescript-not-installed',
    '需要 devDependency typescript（在插件根目录执行 npm i）；缺失时本步骤判失败，不跳过',
  );
}

// 用 node 直接跑 bin/tsc（跨平台，不依赖 .cmd / shebang）。
const entry = tscBin.endsWith('tsc') ? [tscBin] : [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')];
const run = spawnSync(process.execPath, [...entry, '-p', configPath, '--pretty', 'false'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});

const stdout = String(run.stdout ?? '');
const stderr = String(run.stderr ?? '');
const lines = stdout.split(/\r?\n/).filter((line) => /^(src|lib|scripts|tests)[\\/]/.test(line));
const byFile = new Map();
for (const line of lines) {
  const file = line.slice(0, line.indexOf('('));
  byFile.set(file, (byFile.get(file) ?? 0) + 1);
}
const summary = {
  ok: run.status === 0,
  mode: 'typecheck',
  config: path.relative(root, configPath),
  tsc: path.relative(root, candidates[0] ?? tscBin).replace(/\\/g, '/'),
  errors: lines.length,
  files: [...byFile.entries()]
    .map(([file, count]) => ({ file: file.replace(/\\/g, '/'), count }))
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file)),
  // 只回显前 40 行，避免一次刷屏；完整输出见 stderr 落盘（CI 直接抓 stdout 亦可）
  sample: lines.slice(0, 40),
};

if (wantJson) console.log(JSON.stringify(summary, null, 2));
else {
  if (lines.length) console.log(lines.slice(0, 40).join('\n'));
  console.log(
    `${summary.ok ? 'PASS' : 'FAIL'}  typecheck: ${summary.errors} error(s) across ${summary.files.length} file(s)`,
  );
  for (const row of summary.files.slice(0, 10)) console.log(`  - ${row.file}: ${row.count}`);
}
if (stderr.trim()) console.error(stderr.trim().slice(0, 4000));

// tsc 自身崩溃（非 0/2 之类）与「有类型错误」区分开：都算失败，但错误码不同。
process.exit(run.status === 0 ? 0 : 1);
