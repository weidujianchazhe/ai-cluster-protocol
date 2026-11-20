/**
 * 泄漏闸门：插件目录里**不许**出现状态目录。
 *
 * 为什么需要这条测试：这个仓库在泄漏上栽过四次——
 *   第 25/26 轮各清掉 690 / 79 个残留，第 30 轮换了形态，本轮（第 40 轮）又攒到
 *   **611 个 / 605 MB**。共同根因不是「谁写错了」，而是：
 *
 *   > `_temp-state.mjs` 只**提供**了正确写法，没有任何**机制**强制测试用它；
 *   > 而泄漏目录被 `.gitignore` 挡住，`git status` 永远干净，没人会发现。
 *
 * 本轮的具体触发点最典型：某个测试写了
 *   `stateDir: path.basename(absPath)`  →  service 按 `workspaceRoot` 重新解释
 *   → 状态落进插件目录，而清理删的是 `os.tmpdir()` 下的空路径。
 * 「路径被重新解释，清理钩子覆盖不到」——**同一形态第三次**。
 *
 * 所以这条测试的判据只有一句：**插件目录下的目录项必须在白名单里**。
 * 它把「泄漏」从"不痛不痒、看不见"变成"verify 直接红"。
 *
 * 注意：工作区根的 `.l0-control-autonomy-2` / `.l0-adapter` 是**活跃状态**，不在此列——
 * 本测试只扫 `plugins/dsh-l0-control/` 自己。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd(); // plugins/dsh-l0-control

/** 允许存在的目录：源码、构建产物、依赖、测试夹具、文档。 */
const ALLOWED = new Set([
  'lib', 'src', 'tests', 'scripts', 'node_modules', 'fixtures', 'locale',
  'docs', // 按模块展开的文档（状态/派发/租约/证据/协调器/容量/存储/工具/测试）
  '.git', 'coverage', 'dist',
]);

const offenders = [];
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if (ALLOWED.has(entry.name)) continue;
  // 统计大小，方便直接看出严重程度
  let bytes = 0;
  let files = 0;
  const walk = (dir) => {
    for (const row of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, row.name);
      if (row.isDirectory()) walk(full);
      else {
        files += 1;
        try { bytes += fs.statSync(full).size; } catch { /* 忽略 */ }
      }
    }
  };
  try { walk(path.join(root, entry.name)); } catch { /* 忽略 */ }
  offenders.push({ name: entry.name, files, mb: bytes / 1024 / 1024 });
}

if (offenders.length) {
  const totalMb = offenders.reduce((sum, row) => sum + row.mb, 0);
  const sample = offenders.slice(0, 8).map((row) => `  ${row.name}（${row.files} 文件 / ${row.mb.toFixed(1)} MB）`).join('\n');
  assert.fail(
    `插件目录里有 ${offenders.length} 个非白名单目录，合计 ${totalMb.toFixed(1)} MB：\n${sample}\n` +
    '最常见原因：测试把 `stateDir` 写成相对路径（或 `path.basename(...)`），service 按 workspaceRoot 重解释后落到了插件目录，' +
    '而清理钩子删的是另一个路径。修法：用绝对路径（或 `tests/_temp-state.mjs` 的 `tempStateDir()` 并确保传绝对路径）。',
  );
}
console.log(`PASS 无状态目录泄漏（插件目录下 ${ALLOWED.size} 类白名单目录之外为空）`);

/**
 * 第二道：**系统临时目录**里也不许留本项目命名的残留。
 *
 * 为什么补这一道：第一道只查 `plugins/` 目录，而 `verify-journal-incremental.mjs` 与
 * `verify-journal-shared-cache.mjs` 用的是 `fs.mkdtempSync(os.tmpdir(), ...)`——
 * 建在 **C 盘临时目录**、且既无 finally 也无 exit 钩子。实测累积：
 *
 *   l0-jcache  546 个 / 1101.9 MB
 *   l0-jr     1234 个 /  368.0 MB     ← 共 1.63 GB，全在系统盘
 *
 * 第一道闸门完全看不见它们，所以一直涨到 1782 项才被人注意到。
 * **泄漏在哪都算泄漏，闸门就必须看到哪。**
 *
 * 只匹配本项目独有的前缀，不用 `st-` / `at-` 这类短名（会误伤别人的文件）。
 */
/**
 * 本项目在系统临时目录里用过的**全部**前缀。
 *
 * 演进过程（每次都是被真实泄漏打醒的）：
 *   第一版只列 `l0-jcache-` / `l0-jr-` / `^\.l0-probe-` / `n4-crash-` / `n4-chain-`
 *     → 漏了 `l0-recovery-drill-*`（29 个）和 `l0-bounded-*`，因为它们是 `l0-` 不带点
 *   第二版放宽到 `^\.?l0-`
 *     → 仍漏 `n5-*`（e2e 全套用 `n5-chain` / `n5-oracle` / `n5-ts` / `n5-native` / `n5-g5`）
 *
 * 所以现在按**族**匹配，而不是逐个枚举：`n\d-` 覆盖 n4/n5/n6…，`\.?l0-` 覆盖带不带点。
 * 枚举式白名单在这个仓库已经漏过两次，不该有第三次。
 */
const PROJECT_PREFIXES = [/^\.?l0-/, /^l0control-/, /^n\d-/, /^dshhome-/];
const sysTmp = os.tmpdir();
const tmpOffenders = [];
try {
  for (const e of fs.readdirSync(sysTmp, { withFileTypes: true })) {
    if (!PROJECT_PREFIXES.some((p) => p.test(e.name))) continue;
    let mb = 0;
    const full = path.join(sysTmp, e.name);
    const walk = (d) => {
      let rows = [];
      try { rows = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const r of rows) {
        const f = path.join(d, r.name);
        if (r.isDirectory()) walk(f);
        else { try { mb += fs.statSync(f).size / 1024 / 1024; } catch { /* 忽略 */ } }
      }
    };
    if (e.isDirectory()) walk(full);
    else { try { mb = fs.statSync(full).size / 1024 / 1024; } catch { /* 忽略 */ } }
    tmpOffenders.push({ name: e.name, mb });
  }
} catch { /* 读不到临时目录就跳过这道 */ }

if (tmpOffenders.length) {
  const totalMb = tmpOffenders.reduce((s, r) => s + r.mb, 0);
  const byPrefix = new Map();
  for (const r of tmpOffenders) {
    const k = PROJECT_PREFIXES.find((p) => p.test(r.name))?.source ?? '?';
    byPrefix.set(k, (byPrefix.get(k) ?? 0) + 1);
  }
  assert.fail(
    `系统临时目录 ${sysTmp} 里有 ${tmpOffenders.length} 项本项目残留，合计 ${totalMb.toFixed(1)} MB：\n` +
    [...byPrefix.entries()].map(([k, n]) => `  ${k}  ×${n}`).join('\n') +
    '\n修法：用 `tests/_temp-state.mjs` 的 `tempSystemDir(prefix)`（自动登记 + 进程退出兜底删除），' +
    '不要裸用 `fs.mkdtempSync(os.tmpdir(), ...)`。',
  );
}
console.log(`PASS 无系统临时目录泄漏（${sysTmp} 下本项目前缀残留 0 项）`);
