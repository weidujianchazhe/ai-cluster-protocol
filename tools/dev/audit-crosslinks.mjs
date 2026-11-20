/**
 * 检查跨文件锚点链接：`[文字](其它文件.md#anchor)`。
 * 标题译成中文后，跨文件的英文锚点同样会失效，而且这类链接散落在
 * 多个 SKILL.md 的「先读哪一份」指引里，坏了不容易发现。
 *
 * 只读。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'F:/output/AI集群工作协议';
const SKILLS = path.join(ROOT, 'eigenflux-audit', 'skills');

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && /\.md$/i.test(e.name)) out.push(full);
  }
  return out;
}

function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

const files = walk(SKILLS);
const anchorCache = new Map();
function anchorsOf(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const set = new Set();
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^#{1,6}\s+(.+)$/gm)) set.add(slug(m[1]));
  } catch { /* 文件不存在就留空集 */ }
  anchorCache.set(file, set);
  return set;
}

const problems = [];
let checkedLinks = 0;
let checkedAnchors = 0;

for (const file of files) {
  const rel = path.relative(SKILLS, file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\[([^\]]*)\]\(([^)#\s]+\.md)(?:#([^)\s]+))?\)/g)) {
    // 外链（http/https）不在本仓库内，跳过
    if (/^[a-z]+:\/\//i.test(m[2])) continue;
    checkedLinks += 1;
    const target = path.resolve(path.dirname(file), m[2]);
    if (!fs.existsSync(target)) {
      problems.push({ rel, kind: '文件不存在', label: m[1], target: m[2] });
      continue;
    }
    if (!m[3]) continue;
    checkedAnchors += 1;
    if (!anchorsOf(target).has(m[3].toLowerCase())) {
      problems.push({
        rel,
        kind: '锚点不存在',
        label: m[1],
        target: `${m[2]}#${m[3]}`,
        candidates: [...anchorsOf(target)].slice(0, 5),
      });
    }
  }
}

console.log(`检查 ${checkedLinks} 条跨文件链接，其中 ${checkedAnchors} 条带锚点\n`);
if (!problems.length) {
  console.log('✅ 跨文件链接与锚点全部有效');
  process.exit(0);
}
console.log(`问题 ${problems.length} 处：\n`);
for (const p of problems) {
  console.log(`── ${p.rel}`);
  console.log(`   [${p.label}](${p.target})  ← ${p.kind}`);
  if (p.candidates) console.log(`   目标现有锚点：${p.candidates.join(' | ')}`);
}
process.exit(1);
