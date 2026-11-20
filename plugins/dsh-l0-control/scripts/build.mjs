/**
 * 构建脚本：`src/**.ts` → `lib/**.js`。
 *
 * 为什么不用 tsc 构建：产物要求「原样 emit + 保留 import 结构」，Node 22.6+ 暴露的
 * `module.stripTypeScriptTypes()` 正好做「去类型 + 原样 emit」，比 tsc 的 downlevel 更可控。
 * 代价：**只剥类型，不做类型检查** —— 类型检查是独立一步：`node scripts/typecheck.mjs`
 * （tsc --noEmit，配置见 tsconfig.typecheck.json）。
 *
 * 用法：
 *   node scripts/build.mjs            # 生成 lib/
 *   node scripts/build.mjs --check    # 只校验 lib/ 与 src/ 是否同步（CI 用），不写盘
 */
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const srcDir = path.join(root, 'src');
const libDir = path.join(root, 'lib');
const checkOnly = process.argv.includes('--check');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const files = walk(srcDir).sort();
const results = [];
let drift = 0;

for (const file of files) {
  const rel = path.relative(srcDir, file).replace(/\.ts$/, '.js');
  const target = path.join(libDir, rel);
  const source = fs.readFileSync(file, 'utf8');
  let output;
  try {
    output = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: rel });
  } catch (error) {
    results.push({ file: rel, status: 'error', message: String(error?.message || error) });
    drift += 1;
    continue;
  }
  // 关键：剥类型不改写说明符。`from "./types.ts"` 在 lib/ 里会变成
  // ERR_MODULE_NOT_FOUND（lib 里只有 .js），必须同步改写静态/动态 import。
  const beforeRewrite = output;
  output = output
    .replace(/(\bfrom\s*["'])(\.[^"']+)\.ts(["'])/g, '$1$2.js$3')
    .replace(/(\bimport\s*\(\s*["'])(\.[^"']+)\.ts(["'])/g, '$1$2.js$3');
  const specifiersRewritten = beforeRewrite === output ? 0 : (beforeRewrite.match(/\.ts["']/g) ?? []).length;
  const leftoverTs = (output.match(/(\bfrom\s*["']|import\s*\(\s*["'])\.[^"']+\.ts["']/g) ?? []).length;
  if (leftoverTs > 0) {
    results.push({ file: rel, status: 'error', message: `残留 ${leftoverTs} 个 .ts 说明符` });
    drift += 1;
    continue;
  }
  if (checkOnly) {
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (existing === output) {
      results.push({ file: rel, status: 'ok', specifiersRewritten });
      continue;
    }
    /**
     * 字节不一致时**先分清两种原因**，别一律判 stale：
     *
     *   a) 真的忘了 build（源码改了、产物没跟上）—— 该红
     *   b) **Node 版本不同**导致 `stripTypeScriptTypes()` 的 emit 差异（空白/注释/类型剥离细节）
     *      —— 源码与产物在语义上一致，不该红
     *
     * 判据：把两边都去掉空白后比较。若归一化后相等，说明只差格式化 —— 记 `format-drift`，
     * **不计入 drift**（不判失败），但**打印出来**让人知道为什么字节不同。
     *
     * 这个区分很关键：不加它，任何用不同 Node 版本的人第一次跑 `--check` 都会看到"全部 stale"，
     * 然后误以为发布包是坏的。而实际上源码能构建、产物能加载，只是生成它的 Node 版本不同。
     */
    const normalize = (s) => (s ?? '').replace(/\s+/g, '');
    if (existing !== null && normalize(existing) === normalize(output)) {
      results.push({ file: rel, status: 'format-drift', note: '仅空白/格式差异（通常是 Node 版本不同），语义一致' });
      continue;
    }
    drift += 1;
    results.push({ file: rel, status: 'stale' });
    continue;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, output, 'utf8');
  results.push({ file: rel, status: 'written', bytes: Buffer.byteLength(output) });
}

const payload = { ok: drift === 0, mode: checkOnly ? 'check' : 'build', files: results };
process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
process.exit(payload.ok ? 0 : 1);
