/**
 * 文档对齐检查：文档里声明的事实与代码里的实际值是否一致。
 *
 * 检查六项：
 *   1. 工具数（声明 vs capabilities.ts 的 toolCount）
 *   2. 验收链步数（声明 vs package.json 的 verify）
 *   3. docs 篇数（文件数 vs 索引条目数）
 *   4. 相对链接有效性
 *   5. 代码块配平
 *   6. 文档里提到的工具名是否真实存在
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 自动探测工作区根 —— **不能写死层级**。
 *
 * 这个测试要在两种布局下都能跑：
 *
 *   ① 原始工作区：`<ws>/plugins/dsh-l0-control/tests/`  → 往上三级是 `<ws>`
 *   ② 解压出来的发布包：`<pkg>/dsh-l0-control/tests/`   → 往上两级是 `<pkg>`
 *
 * 写死三级的话，在包内会算到包的**上一级**，然后读不到 `plugins/dsh-l0-control/package.json`
 * ——而"包内自足可验证"正是这个项目反复强调的性质。所以改成**上溯找 `docs/README.md`**。
 */
function findRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'docs', 'README.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const root = findRoot(here);
if (!root) {
  console.log('  ⚠ 找不到含 docs/README.md 的工作区根 —— 跳过文档对齐检查（不在预期布局里）');
  console.log('\n=== 结果 ===');
  console.log('  跳过：未找到 docs/README.md');
  process.exit(0);
}

/** 插件目录：原工作区在 `plugins/` 下，包内与根同级。 */
const pluginDir = fs.existsSync(path.join(root, 'plugins', 'dsh-l0-control'))
  ? path.join(root, 'plugins', 'dsh-l0-control')
  : path.join(root, 'dsh-l0-control');

// ── 实际值 ──
const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
const actualSteps = pkg.scripts.verify.split('&&').length;
const capText = fs.readFileSync(path.join(pluginDir, 'src', 'capabilities.ts'), 'utf8');
const toolNames = [...capText.matchAll(/^\s{2}([a-z][a-z0-9_]+):\s*\{\s*grade:/gm)].map((m) => m[1]);
const actualTools = toolNames.length;

console.log(`实际值: 工具 ${actualTools} / 验收链 ${actualSteps} 步`);
console.log('工具名:', toolNames.join(', '));

// ── 收集文档 ──
const mdFiles = [];
const collect = (dir, depth = 0) => {
  if (depth > 3) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collect(full, depth + 1);
    else if (e.name.endsWith('.md')) mdFiles.push(full);
  }
};
collect(root);

let problems = 0;
const bad = (msg) => { console.log(`  ❌ ${msg}`); problems += 1; };

// ── ① 工具数 ──
console.log('\n=== ① 工具数声明 ===');
for (const f of mdFiles) {
  const rel = path.relative(root, f);
  const t = fs.readFileSync(f, 'utf8');
  for (const m of t.matchAll(/(\d+)\s*个工具/g)) {
    if (Number(m[1]) !== actualTools) bad(`${rel}: 声明 "${m[0]}"，实际 ${actualTools}`);
  }
  for (const m of t.matchAll(/工具面（(\d+)）/g)) {
    if (Number(m[1]) !== actualTools) bad(`${rel}: 声明 "工具面（${m[1]}）"，实际 ${actualTools}`);
  }
}

// ── ② 步数 ──
console.log('=== ② 验收链步数声明 ===');
for (const f of mdFiles) {
  const rel = path.relative(root, f);
  const t = fs.readFileSync(f, 'utf8');
  for (const m of t.matchAll(/(\d+)\s*步/g)) {
    const n = Number(m[1]);
    // 只看 40–80 区间的（避免把"第 3 步"这类当步数）
    if (n >= 40 && n <= 80 && n !== actualSteps) bad(`${rel}: 声明 "${m[0]}"，实际 ${actualSteps}`);
  }
}

// ── ③ docs 篇数 ──
console.log('=== ③ docs 索引一致性 ===');
const docsDir = path.join(root, 'docs');
const docFiles = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md') && f !== 'README.md');
const indexText = fs.readFileSync(path.join(docsDir, 'README.md'), 'utf8');
/**
 * 索引里指的是「docs 目录内、同级的 .md」，前缀**不写死**：
 * 正文是 `01-`…`14-`（递归），附录是 `A1-`/`A2-`（不占正文编号）。
 * 早先这里只匹配 `\d{2}-`，于是任何采用别的编号体系（附录、AD）都会被判成「存在但未进索引」——
 * 那是把「命名风格」检查混进了「完整性」检查。现在只认「同级 .md」，风格由索引本身表达。
 */
const indexed = [...indexText.matchAll(/\]\(([A-Za-z0-9][^)/\\]*\.md)\)/g)]
  .map((m) => m[1])
  .filter((f) => f !== 'README.md');
const notIndexed = docFiles.filter((f) => !indexed.includes(f));
const dangling = indexed.filter((f) => !docFiles.includes(f) && !fs.existsSync(path.join(docsDir, f)));
console.log(`  docs 文件 ${docFiles.length} 篇 / 索引引用 ${indexed.length} 条`);
for (const f of notIndexed) bad(`docs/${f} 存在但未进索引`);
for (const f of dangling) bad(`索引引用了不存在的 docs/${f}`);

// ── ④ 链接有效性 ──
console.log('=== ④ 相对链接有效性 ===');
for (const f of mdFiles) {
  const rel = path.relative(root, f);
  const t = fs.readFileSync(f, 'utf8');
  for (const m of t.matchAll(/\]\((?!https?:|#|mailto:)([^)]+)\)/g)) {
    const target = m[1].split('#')[0].trim();
    if (!target) continue;
    const resolved = path.resolve(path.dirname(f), target);
    if (!fs.existsSync(resolved)) bad(`${rel}: 断链 -> ${target}`);
  }
}

// ── ⑤ 代码块配平 ──
console.log('=== ⑤ 代码块配平 ===');
for (const f of mdFiles) {
  const t = fs.readFileSync(f, 'utf8');
  const n = (t.match(/^```/gm) ?? []).length;
  if (n % 2 !== 0) bad(`${path.relative(root, f)}: 围栏 ${n} 个（应为偶数）`);
}

// ── ⑥ 文档提到的工具名真实性 ──
console.log('=== ⑥ 文档提到的工具名 ===');
const known = new Set(toolNames);
// 只检查形如 `xxx_yyy` 且在反引号里的、疑似工具名的
const suspicious = new Set();
for (const f of mdFiles) {
  const t = fs.readFileSync(f, 'utf8');
  for (const m of t.matchAll(/`([a-z][a-z0-9]*_[a-z0-9_]+)\(/g)) {
    const name = m[1];
    if (!known.has(name) && !['get_goal', 'create_goal', 'update_goal', 'ask_user_question', 'write_file', 'read_file', 'exec_command'].includes(name)) {
      suspicious.add(`${path.relative(root, f)}: ${name}`);
    }
  }
}
for (const s of suspicious) bad(`文档提到不存在的工具: ${s}`);

// ── 结论 ──
console.log(`\n=== 结果 ===`);
console.log(problems === 0 ? `  ✅ 文档对齐：${mdFiles.length} 个 md 文件全部一致` : `  ⚠ ${problems} 处不一致`);
process.exit(problems === 0 ? 0 : 1);
