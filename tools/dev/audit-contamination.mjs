/**
 * 污染体检：找出被 git 跟踪、但不属于这个工程的东西。
 *   1. 引用了工作区外路径 / 外部产品名 / 外部项目名的文件
 *   2. 内容不是本协议产物的可疑文件
 *   3. 体积异常的第一方文件
 *
 * 只读。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'F:/output/AI集群工作协议';

const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

console.log(`git 跟踪文件: ${tracked.length}\n`);

/** 外部路径/产品名特征：出现说明是从别处搬来的 */
const FOREIGN = [
  { re: /[A-Z]:[\\/]{1,2}(Users|Documents|Desktop|Downloads)[\\/]/i, why: '绝对用户目录路径' },
  { re: /\/home\/[a-z]+\//i, why: 'Linux 用户目录绝对路径' },
  { re: /eigenflux/i, why: '外部产品名 eigenflux' },
  { re: /dsh-meow|meow\./i, why: '外部插件 dsh-meow' },
  { re: /moltbook|quantum-research|qrc\b/i, why: '外部交付物' },
  { re: /zhaixian/, why: '个人用户名' },
  { re: /openrouter|deepseek-api-key/i, why: '外部模型配置' },
  { re: /api[_-]?key\s*[:=]\s*['"][^'"]{8,}/i, why: '疑似硬编码密钥' },
];

/**
 * **占位符**：文档里写 `C:\Users\<你>\.dsh` 或 `C:\Users\…\.dsh` 是**正确写法**——
 * 它在教读者"换成你自己的路径"，本身不含任何真实用户名。
 *
 * 不加这层过滤，每次跑都会对这两行报「绝对用户目录路径」，而它们恰恰是文档该有的样子。
 * 一条永远在误报的规则，等于没有这条规则。
 */
const PLACEHOLDER = /[<{\[][^>}\]]{1,20}[>}\]]|…|\.\.\.|\bXX\b|\bYOUR\b|\bUSER\b/i;

/** 脱敏测试里的假密钥是必需的 fixture，不算污染 */
const FIXTURE_OK = [/\.test\.mjs$/, /\.test\.ts$/, /\/tests?\//];

const SKIP = /^(dist|eigenflux-audit|inbox|projects)\//;
/** `.gitignore` 的职责就是列外部目录，那些名字出现在这里是正确的 */
const IGNORE_LIST_FILE = /^\.gitignore$/;
const hits = [];

for (const rel of tracked) {
  if (SKIP.test(rel)) continue;
  if (/package-lock\.json$|\.png$|\.jpg$|\.zip$|\.exe$/.test(rel)) continue;
  const full = path.join(ROOT, rel);
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  const isFixture = FIXTURE_OK.some((re) => re.test(rel));
  const isIgnoreList = IGNORE_LIST_FILE.test(rel);
  for (let i = 0; i < lines.length; i += 1) {
    for (const f of FOREIGN) {
      if (!f.re.test(lines[i])) continue;
      // 脱敏/密钥测试文件里的假密钥是有意为之
      if (isFixture && f.why.includes('密钥')) break;
      // .gitignore 里出现外部目录名，正是它该干的事
      if (isIgnoreList) break;
      // 占位符（`C:\Users\<你>\` / `C:\Users\…\`）是文档**该有的写法**，不是泄露
      if (PLACEHOLDER.test(lines[i])) break;
      hits.push({ rel, line: i + 1, why: f.why, text: lines[i].trim().slice(0, 130) });
      break;
    }
  }
}

if (!hits.length) {
  console.log('✅ 跟踪文件里没有外部路径 / 外部产品名残留');
} else {
  console.log(`命中 ${hits.length} 处：\n`);
  let last = '';
  for (const h of hits) {
    if (h.rel !== last) {
      console.log(`── ${h.rel}`);
      last = h.rel;
    }
    console.log(`   L${h.line} [${h.why}] ${h.text}`);
  }
}

// 体积异常的第一方文件
console.log('\n── 最大的 12 个跟踪文件 ──');
const sizes = tracked
  .map((rel) => {
    try {
      return { rel, bytes: fs.statSync(path.join(ROOT, rel)).size };
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .sort((a, b) => b.bytes - a.bytes)
  .slice(0, 12);
for (const s of sizes) console.log(`  ${(s.bytes / 1024).toFixed(1).padStart(8)} KB  ${s.rel}`);

process.exit(hits.length ? 1 : 0);
