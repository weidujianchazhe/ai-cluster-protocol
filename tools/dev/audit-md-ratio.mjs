/**
 * 全仓库 Markdown 中文占比体检（排除 node_modules / .md-originals / .git）。
 * 只读。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'F:/output/AI集群工作协议';
const SKIP = /[\\/](node_modules|\.md-originals|\.git)[\\/]/;

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

const files = walk(ROOT).filter((f) => !SKIP.test(f));
const rows = [];
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  const prose = t.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  const c = (prose.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const w = (prose.match(/[A-Za-z]{2,}/g) ?? []).length;
  const r = c + w === 0 ? 1 : c / (c + w);
  rows.push({ r, rel: path.relative(ROOT, f).replace(/\\/g, '/'), bytes: fs.statSync(f).size });
}

const bad = rows.filter((x) => x.r < 0.6).sort((a, b) => a.r - b.r);
console.log(`总 MD 数: ${rows.length}   中文占比 < 0.6 的: ${bad.length}\n`);
for (const b of bad) console.log(`  ${b.r.toFixed(2)}  ${String(b.bytes).padStart(7)} B  ${b.rel}`);
process.exit(bad.length ? 1 : 0);
