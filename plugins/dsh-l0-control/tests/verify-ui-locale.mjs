#!/usr/bin/env node
/**
 * UI 文案完整性：**`t()` 查不到的 key 会原样显示 key 名**。
 *
 * 这类 bug 不报错、不崩、不影响功能——面板上直接出现 `bbTotal 13984` 这种半截英文，
 * 只有人肉看截图才能发现。所以必须机检：
 *
 *   1. 每个 `t('key')` 在 ZH / EN 里都得有值；
 *   2. ZH 与 EN 的 key 集合必须一致（否则切语言会掉文案）；
 *   3. 不得出现空串（空串等于没翻译，且比缺 key 更难发现）。
 *
 * 顺带盯住一条历史教训：`locale/*.json` 是给宿主语言包用的，
 * 面板自己的 `t()` **不读它**——两处必须同步，否则改了 locale 以为生效了其实没有。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..', '..');
const clientPath = path.join(root, 'dsh-l0-control-ui', 'client.js');
const src = fs.readFileSync(clientPath, 'utf8');

const used = new Set([...src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'\)/g)].map((m) => m[1]));
assert.ok(used.size > 0, '没找到任何 t(\'key\') 调用，解析逻辑可能失效了');

const zhStart = src.indexOf('const ZH = {');
const enStart = src.indexOf('const EN = {');
const pageStart = src.indexOf('const page = {');
assert.ok(zhStart > 0 && enStart > zhStart && pageStart > enStart, 'ZH/EN 字典边界没找到（格式变了就更新本测试）');

const keysOf = (block) => new Map(
  [...block.matchAll(/^\s{6}([a-zA-Z0-9_]+):\s*(.*)$/gm)].map((m) => [m[1], m[2]]),
);
const zh = keysOf(src.slice(zhStart, enStart));
const en = keysOf(src.slice(enStart, pageStart));

const missingZh = [...used].filter((k) => !zh.has(k));
const missingEn = [...used].filter((k) => !en.has(k));
assert.equal(missingZh.length, 0, `ZH 缺这些 key（会原样显示 key 名）：${missingZh.join(', ')}`);
assert.equal(missingEn.length, 0, `EN 缺这些 key：${missingEn.join(', ')}`);

const onlyZh = [...zh.keys()].filter((k) => !en.has(k));
const onlyEn = [...en.keys()].filter((k) => !zh.has(k));
assert.equal(onlyZh.length, 0, `这些 key 只在 ZH 有：${onlyZh.join(', ')}`);
assert.equal(onlyEn.length, 0, `这些 key 只在 EN 有：${onlyEn.join(', ')}`);

// 空串：`key: '',` 或 `key: "",`
const empty = [...zh.entries()].filter(([, v]) => /^(['"])\1,?$/.test(v.trim())).map(([k]) => k);
assert.equal(empty.length, 0, `这些 key 的文案是空串：${empty.join(', ')}`);

// locale/*.json 与内联表的关键 key 必须都有，且不得有 JSON 里的 key 却漏在面板里
const localeZh = JSON.parse(fs.readFileSync(path.join(root, 'dsh-l0-control-ui', 'locale', 'zh.json'), 'utf8'));
const localeEn = JSON.parse(fs.readFileSync(path.join(root, 'dsh-l0-control-ui', 'locale', 'en.json'), 'utf8'));
for (const key of ['sessions', 'bbTotal', 'bbShown', 'bbOlder', 'bbFailed', 'newProject', 'preview', 'create']) {
  assert.ok(Object.prototype.hasOwnProperty.call(localeZh, key), `locale/zh.json 缺 ${key}`);
  assert.ok(Object.prototype.hasOwnProperty.call(localeEn, key), `locale/en.json 缺 ${key}`);
  assert.ok(zh.has(key), `面板 ZH 表缺 ${key}（locale 有但面板不读它，会显示 key 名）`);
  assert.ok(en.has(key), `面板 EN 表缺 ${key}`);
}

console.log(
  `PASS ui-locale: ${used.size} 个 t() key 全部有 ZH/EN 文案，两表 ${zh.size}/${en.size} 键一致，无空串`,
);
