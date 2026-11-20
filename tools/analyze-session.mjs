#!/usr/bin/env node
/**
 * 会话返工分析：从真实会话记录里统计「哪里在返工」。
 *
 * ## 为什么要这个工具
 *
 * 人（和模型）对「哪里最费劲」的判断经常是错的。实测一次：主观认为最大返工来源是
 * 「PowerShell 拼 `node -e` 的引号地狱」，真实数据显示 **pwsh 失败率 0.1%（2965 次失败 3 次）**，
 * 而真正的重灾区是 **edit 工具（2147 次 / 失败 155 次 / 占全部失败 71%）**。
 *
 * 这个工具就是用来把这种主观判断换成数据的。
 *
 * ## 用法
 *
 * ```bash
 * # 给会话目录（自动找 session.v4.jsonl.zstd）
 * node tools/analyze-session.mjs "%USERPROFILE%\.dsh\sessions\<workspace-dir>\<session-dir>"
 *
 * # 给具体的 .zstd 或 .jsonl 文件
 * node tools/analyze-session.mjs path/to/session.v4.jsonl.zstd
 *
 * # 机器可读输出
 * node tools/analyze-session.mjs <target> --json
 *
 * # 只看前 5 条
 * node tools/analyze-session.mjs <target> --top 5
 * ```
 *
 * ## 它算什么
 *
 * | 维度 | 说明 |
 * |---|---|
 * | **工具失败率** | 每个工具被调用几次、失败几次、失败率 |
 * | **错误类型聚类** | 错误文本归一化后（路径/数字/引号内容替换为占位符）聚类计数 |
 * | **重复操作的文件** | 同一路径被 read/edit/write 的次数 |
 * | **重复命令** | 同一命令指纹（去空白后前 90 字）被执行 ≥N 次 |
 *
 * ## 它不算什么
 *
 * - **不算因果**：失败率高不代表这个工具差，可能只是它被用在最难的地方。
 * - **不算「质量」**：这是**过程指标**（失败次数），不是产出好坏。
 * - 会话记录里没有 `deps` / `evidence` / `provenance`，所以它**不能**用在插件的
 *   质量度量（`quality_report`）上。两者数据源不同，不能混。
 *
 * ## 依赖
 *
 * 需要外部 `zstd` 可执行文件（见下面「为什么需要外部 zstd」）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const topIdx = argv.indexOf('--top');
const TOP = topIdx >= 0 && argv[topIdx + 1] ? Math.max(1, Number(argv[topIdx + 1])) : 12;
const target = argv.find((a) => !a.startsWith('--') && a !== String(TOP));

if (!target) {
  process.stderr.write(
    '用法: node tools/analyze-session.mjs <会话目录|.zstd|.jsonl> [--json] [--top N]\n',
  );
  process.exit(2);
}

/** 找会话文件：给目录则找 session.v4.jsonl.zstd，给文件则直接用。 */
function resolveSessionFile(p) {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) return { error: `路径不存在: ${abs}` };
  const st = fs.statSync(abs);
  if (st.isFile()) return { file: abs };
  // 目录：优先 session.v4.jsonl.zstd，其次任意 .jsonl.zstd / .jsonl
  const entries = fs.readdirSync(abs).filter((f) => /\.jsonl(\.zstd)?$/.test(f));
  const preferred = entries.find((f) => f === 'session.v4.jsonl.zstd') ?? entries[0];
  if (!preferred) return { error: `目录里没有 .jsonl / .jsonl.zstd: ${abs}` };
  return { file: path.join(abs, preferred) };
}

const resolved = resolveSessionFile(target);
if (resolved.error) {
  process.stderr.write(`${resolved.error}\n`);
  process.exit(2);
}
const sourceFile = resolved.file;
const isZstd = sourceFile.endsWith('.zstd');

/**
 * ## 为什么需要外部 zstd
 *
 * 会话文件是**多帧 zstd**（一个文件里几千个独立帧拼接，每帧一小段）。
 * Node 24 的 `zlib.zstdDecompressSync` / `createZstdDecompress` **只解第一帧**
 * —— 45 MB 的文件只解出 210 字节（就是会话头那一行）。实测确认。
 *
 * 所以这里调外部 `zstd` 可执行文件，解压到临时文件再读。
 *
 * 找 zstd 的顺序：`ZSTD_BIN` 环境变量 → PATH → 常见安装路径。
 * 都找不到时**明确报错并给出两条替代路径**，不假装成功。
 */
function findZstd() {
  if (process.env.ZSTD_BIN && fs.existsSync(process.env.ZSTD_BIN)) return process.env.ZSTD_BIN;
  const exts = process.platform === 'win32' ? ['zstd.exe', 'zstd'] : ['zstd'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const exe of exts) {
      const p = path.join(dir, exe);
      try { if (fs.existsSync(p)) return p; } catch { /* 忽略无权限的 PATH 项 */ }
    }
  }
  // 常见 Windows 安装位置（msys64 / scoop / chocolatey）
  const guesses = [
    'F:\\toolchains\\msys64\\ucrt64\\bin\\zstd.exe',
    'C:\\msys64\\ucrt64\\bin\\zstd.exe',
    'C:\\ProgramData\\chocolatey\\bin\\zstd.exe',
  ];
  for (const p of guesses) {
    try { if (fs.existsSync(p)) return p; } catch { /* 忽略 */ }
  }
  return null;
}

/**
 * 解压多帧 zstd 到临时文件，返回临时文件路径；调用方负责删除。
 *
 * **不用管道捕获 stdout**：在某些沙箱里 `stdio: 'pipe'` 会 EPERM。
 * 走 `-o` 落盘 + 后续流式读取，绕开这个问题。
 */
function decompressToTemp(sourceFile) {
  const bin = findZstd();
  if (!bin) {
    throw new Error(
      '需要 zstd 可执行文件来解压多帧会话文件（Node 内置 zstd 只解第一帧）。\n' +
        '两条路：\n' +
        '  1. 安装 zstd 并确保在 PATH 里（或设 ZSTD_BIN 指向它）\n' +
        '  2. 先手动解压: zstd -d -o session.jsonl session.v4.jsonl.zstd，再把这个 .jsonl 传给本工具',
    );
  }
  const tmp = path.join(os.tmpdir(), `l0-sess-${process.pid}-${Date.now()}.jsonl`);
  execFileSync(bin, ['-d', '-f', '-q', '-o', tmp, sourceFile], { stdio: 'ignore' });
  return tmp;
}

/** 打开为文本行流。 */
async function* lines() {
  let readPath = sourceFile;
  let tmpToClean = null;
  if (isZstd) {
    tmpToClean = decompressToTemp(sourceFile);
    readPath = tmpToClean;
  }
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(readPath, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) if (line.trim()) yield line;
  } finally {
    if (tmpToClean) {
      try { fs.unlinkSync(tmpToClean); } catch { /* 清理失败不影响结果 */ }
    }
  }
}

/** 把错误文本归一化成模式：去掉具体路径/数字/引号内容，便于聚类。 */
function normalizeError(text) {
  return String(text)
    .slice(0, 300)
    .replace(/[A-Za-z]:\\[^\s"')]+/g, '<PATH>')
    .replace(/\/[^\s"')]+/g, '<PATH>')
    .replace(/\b\d{3,}\b/g, '<N>')
    .replace(/"[^"]*"/g, '"<S>"')
    .replace(/'[^']*'/g, "'<S>'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从命令/路径参数里提取被操作的文件。 */
function extractPaths(text) {
  const out = new Set();
  const re = /([A-Za-z]:\\[^\s"'|;>]+|\b[\w./-]+\.(?:ts|mts|mjs|cjs|js|jsx|tsx|json|md|yml|yaml|html|css|scss|py|sh|ps1|toml))\b/g;
  let m;
  while ((m = re.exec(String(text))) !== null) out.add(m[1]);
  return [...out];
}

const calls = new Map();      // callId -> { name }
const toolStats = new Map();  // name -> { total, failed }
const errPatterns = new Map(); // pattern -> count
const fileOps = new Map();    // path -> count
const cmdRepeat = new Map();  // fingerprint -> count
let totalLines = 0;
let totalCalls = 0;
let totalResults = 0;
let totalErrors = 0;

for await (const line of lines()) {
  totalLines += 1;
  let o;
  try { o = JSON.parse(line); } catch { continue; }

  if (o?.type === 'tool/call') {
    const d = o.data ?? {};
    const name = String(d.name ?? '');
    const callId = String(d.callId ?? '');
    if (!name) continue;
    totalCalls += 1;
    calls.set(callId, { name });
    if (!toolStats.has(name)) toolStats.set(name, { total: 0, failed: 0 });
    toolStats.get(name).total += 1;

    let args = {};
    try { args = JSON.parse(String(d.arguments ?? '{}')); } catch { /* 参数非 JSON 时忽略 */ }
    const payload = args.command ?? args.path ?? args.file_path ?? args.pattern ?? '';
    if (payload) {
      for (const p of extractPaths(payload)) fileOps.set(p, (fileOps.get(p) ?? 0) + 1);
      const fp = String(payload).replace(/\s+/g, ' ').trim().slice(0, 90);
      if (fp.length > 20) cmdRepeat.set(fp, (cmdRepeat.get(fp) ?? 0) + 1);
    }
  } else if (o?.type === 'tool/result') {
    const d = o.data ?? {};
    const msg = d.message ?? {};
    const call = calls.get(String(msg.toolCallId ?? ''));
    if (!call) continue;
    totalResults += 1;
    if (msg.isError) {
      totalErrors += 1;
      const st = toolStats.get(call.name);
      if (st) st.failed += 1;
      const text = Array.isArray(msg.content)
        ? msg.content.map((c) => c?.text ?? '').join(' ')
        : String(msg.content ?? '');
      const pat = normalizeError(text) || '(空错误)';
      errPatterns.set(pat, (errPatterns.get(pat) ?? 0) + 1);
    }
  }
}

const byFailures = [...toolStats.entries()]
  .map(([name, s]) => ({ name, total: s.total, failed: s.failed, rate: s.total ? s.failed / s.total : 0 }))
  .sort((a, b) => b.failed - a.failed || b.total - a.total);

const errors = [...errPatterns.entries()].map(([pattern, count]) => ({ pattern, count })).sort((a, b) => b.count - a.count);
const files = [...fileOps.entries()].map(([p, n]) => ({ path: p, count: n })).sort((a, b) => b.count - a.count);
const repeats = [...cmdRepeat.entries()]
  .filter(([, n]) => n >= 3)
  .map(([fingerprint, count]) => ({ fingerprint, count }))
  .sort((a, b) => b.count - a.count);

const result = {
  ok: true,
  source: sourceFile,
  compressed: isZstd,
  totals: {
    lines: totalLines,
    toolCalls: totalCalls,
    toolResults: totalResults,
    failures: totalErrors,
    failureRate: totalResults ? Number((totalErrors / totalResults * 100).toFixed(2)) : 0,
  },
  tools: byFailures,
  errors: errors.slice(0, TOP),
  files: files.slice(0, TOP),
  repeatedCommands: repeats.slice(0, Math.max(1, TOP - 4)),
  note:
    '这是**过程指标**（失败次数），不是产出质量。失败率高不代表工具差——可能它被用在最难的地方。' +
    '会话记录里没有 deps/evidence/provenance，所以不能与插件的 quality_report 混算。',
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const out = [];
out.push('=== 会话返工分析 ===');
out.push(`  源: ${sourceFile}${isZstd ? '（zstd）' : ''}`);
out.push('');
out.push('=== 总量 ===');
out.push(`  行数 ${totalLines} / 工具调用 ${totalCalls} / 有结果 ${totalResults} / 失败 ${totalErrors}`);
out.push(`  总体失败率 ${pct(result.totals.failureRate / 100)}`);
out.push('');
out.push('=== 工具失败率（按失败次数降序）===');
out.push('  工具                    调用    失败   失败率');
for (const t of byFailures.slice(0, TOP)) {
  out.push(`  ${t.name.padEnd(22)} ${String(t.total).padStart(6)} ${String(t.failed).padStart(6)} ${pct(t.rate).padStart(7)}`);
}
out.push('');
out.push(`=== 错误类型 Top ${Math.min(TOP, errors.length)}（归一化聚类）===`);
for (const e of errors.slice(0, TOP)) out.push(`  ${String(e.count).padStart(5)} × ${e.pattern.slice(0, 110)}`);
out.push('');
out.push(`=== 被反复操作的文件 Top ${Math.min(TOP, files.length)} ===`);
for (const f of files.slice(0, TOP)) out.push(`  ${String(f.count).padStart(5)} × ${f.path}`);
out.push('');
out.push('=== 重复执行的同一命令（≥3 次）===');
if (result.repeatedCommands.length === 0) out.push('  （无）');
for (const r of result.repeatedCommands) out.push(`  ${String(r.count).padStart(5)} × ${r.fingerprint.slice(0, 100)}`);
out.push('');
out.push(result.note);
process.stdout.write(`${out.join('\n')}\n`);
