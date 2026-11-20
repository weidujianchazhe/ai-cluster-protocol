/**
 * 语言与内容体检（只读）——检查三件事：
 *   1. 第一方文档/代码里的英文散文残留（注释、描述、提示文案）
 *   2. 用户可见文案（工具描述 / 错误 / 提示）是否英文
 *   3. 仓库里混进来的外部目录、体积分布、乱码字符
 *
 * 用法：node tools/audit-language.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const cjk = (s) => (s.match(/[\u4e00-\u9fff]/g) ?? []).length;
const words = (s) => (s.match(/[A-Za-z]{2,}/g) ?? []).length;

/** 第一方范围：本仓库自己写的代码与文档 */
const FIRST_PARTY = ['plugins', 'tools', 'fixtures', 'schema', 'presets'];
/** 第三方/本地运行物：不属于本仓库 */
const EXTERNAL = ['eigenflux-audit', 'inbox', 'dist', 'projects'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'lib']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/** 判定一行是否是「英文散文」（有实词 + 常见虚词，且不像代码/命令/路径） */
function isEnglishProse(s) {
  if (cjk(s) > 0) return false;
  if (/[{};]|=>|\$\{/.test(s)) return false;
  // 命令行、路径串、JSON 片段、纯标识符列表都不是散文
  if (/^(node|npm|pnpm|npx|yarn|git|cd|curl|wget|export|import|set|export)\s/.test(s)) return false;
  if (/^["'`]/.test(s)) return false;
  if (/^[\w./\\:-]+(\s+[\w./\\:*-]+)*$/.test(s.trim())) return false;
  if (/^[a-z-]+:/.test(s.trim())) return false;
  if (words(s) < 3) return false;
  return /\b(the|a|an|is|are|was|were|to|of|for|in|on|with|this|that|it|and|or|not|only|must|should|when|if|from|by|as|be|has|have|will|can|do|does|need|use|keep|see|note)\b/i.test(s);
}

/** 抽代码文件里的注释体（// 与 /* *\/），返回 {line, body} */
function extractComments(text) {
  const out = [];
  const lines = text.split('\n');
  let inBlock = false;
  let start = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const t = raw.trim();
    let body = null;
    if (inBlock) {
      body = t.replace(/\*\/\s*$/, '').replace(/^\*\s?/, '');
      if (/\*\//.test(t)) inBlock = false;
    } else if (/^\s*\/\*/.test(raw)) {
      body = t.replace(/^\/\*\s?/, '').replace(/\*\/\s*$/, '');
      start = i + 1;
      if (!/\*\//.test(t)) inBlock = true;
    } else {
      const m = /(?:^|\s)(?:\/\/|#)\s(.*)$/.exec(raw);
      if (m && !/https?:\/\//.test(raw)) {
        body = m[1];
        start = i + 1;
      }
    }
    if (body === null) continue;
    body = body.replace(/^\*\s?/, '').replace(/^#\s*/, '').trim();
    if (!body) continue;
    out.push({ line: start || i + 1, body });
  }
  return out;
}

// ── 1. 第一方英文散文（注释 + 文档 + yml/json 描述）──────────────────
const findings = [];
const files = [];
for (const top of FIRST_PARTY) for (const f of walk(path.join(ROOT, top))) files.push(f);
for (const name of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (name.isFile() && /\.(md|json|yml|yaml|txt)$/i.test(name.name)) files.push(path.join(ROOT, name.name));
}
files.push(path.join(ROOT, '.gitignore'), path.join(ROOT, '.gitattributes'));

for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  // 按设计就是英文的：双语 locale 的 en 表、锁文件
  if (/locale\/en\.json$|package-lock\.json$/.test(rel)) continue;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  let candidates = [];
  if (/\.(ts|tsx|js|mjs|cjs|py|ps1|sh)$/.test(rel)) {
    candidates = extractComments(text);
  } else if (/\.md$/i.test(rel)) {
    candidates = text.split('\n').map((l, i) => ({ line: i + 1, body: l.trim() }))
      .filter((x) => x.body && !/^[|>`#-]/.test(x.body));
  } else if (/\.gitignore$/.test(rel)) {
    candidates = text.split('\n').map((l, i) => ({ line: i + 1, body: l.replace(/^#\s*/, '') }))
      .filter((x) => l0startsWithHash(text, x.line));
  } else if (/\.(yml|yaml)$/.test(rel)) {
    candidates = text.split('\n').map((l, i) => ({ line: i + 1, body: l.trim().replace(/^#\s*/, '') }))
      .filter((x, i) => text.split('\n')[i].trim().startsWith('#'));
  } else if (/\.json$/i.test(rel)) {
    candidates = [...text.matchAll(/"(description|title|hint|note|comment)":\s*"([^"]{8,})"/g)]
      .map((m) => ({ line: 1, body: m[2] }));
  }
  const hits = candidates.filter((x) => isEnglishProse(x.body));
  if (hits.length) findings.push({ rel, hits });
}

function l0startsWithHash(text, lineNo) {
  const line = (text.split('\n')[lineNo - 1] ?? '').trim();
  return line.startsWith('#');
}

// ── 2. 用户可见文案 ────────────────────────────────────────────────
const copy = [];
for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (!/\.(ts|js|mjs)$/.test(rel)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    for (const key of ['description', 'hint', 'message']) {
      const m = new RegExp(`\\b${key}:\\s*'(?:[^'\\\\]|\\\\.){12,}'`).exec(lines[i]);
      if (m && isEnglishProse(m[0].replace(/^\w+:\s*'/, '').replace(/'$/, ''))) {
        copy.push({ rel, line: i + 1, key, text: m[0].slice(0, 110) });
      }
    }
    const e = /throw new Error\(\s*'([^']{15,})'/.exec(lines[i]);
    if (e && isEnglishProse(e[1])) copy.push({ rel, line: i + 1, key: 'throw', text: e[1] });
  }
}

// ── 3. 混入目录 / 体积 / 乱码 ───────────────────────────────────────
function dirStats(dir) {
  let bytes = 0;
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        try {
          bytes += fs.statSync(full).size;
          count += 1;
        } catch { /* 读不到就跳过 */ }
      }
    }
  }
  return { bytes, count };
}

const external = [];
for (const name of EXTERNAL) {
  const dir = path.join(ROOT, name);
  if (!fs.existsSync(dir)) continue;
  external.push({ name, ...dirStats(dir) });
}

const mojibake = [];
for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const n = (text.match(/\uFFFD/g) ?? []).length;
  if (n > 0) mojibake.push({ rel: path.relative(ROOT, file).replace(/\\/g, '/'), n });
}

// ── 输出 ──────────────────────────────────────────────────────────
const asJson = process.argv.includes('--json');
const summary = {
  prose: { files: findings.length, lines: findings.reduce((n, f) => n + f.hits.length, 0) },
  copy: copy.length,
  external: external.map((e) => ({ name: e.name, mb: Number((e.bytes / 1048576).toFixed(2)), files: e.count })),
  mojibake,
  detail: { findings, copy },
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

console.log('══════ 1. 第一方英文散文 ══════');
if (!findings.length) console.log('  ✅ 无');
for (const f of findings) {
  console.log(`── ${f.rel}  (${f.hits.length} 行)`);
  for (const h of f.hits) console.log(`   L${h.line}: ${h.body.slice(0, 110)}`);
}

console.log('\n══════ 2. 用户可见英文文案 ══════');
if (!copy.length) console.log('  ✅ 无');
for (const c of copy) console.log(`  ${c.rel}:${c.line} [${c.key}] ${c.text}`);

console.log('\n══════ 3. 外部混入目录 ══════');
for (const e of external) {
  console.log(`  ${(e.bytes / 1048576).toFixed(2).padStart(8)} MB  ${String(e.count).padStart(5)} 文件  ${e.name}/`);
}

console.log('\n══════ 4. 乱码（U+FFFD）══════');
if (!mojibake.length) console.log('  ✅ 无');
for (const m of mojibake) console.log(`  ${m.n} 处  ${m.rel}`);

const bad = summary.prose.lines + summary.copy + summary.mojibake.length;
console.log(`\n结论：英文散文 ${summary.prose.lines} 行 / 英文文案 ${summary.copy} 条 / 乱码 ${summary.mojibake.length} 处`);
process.exit(bad === 0 ? 0 : 1);
