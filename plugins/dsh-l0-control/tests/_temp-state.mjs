/**
 * 测试用的临时状态目录：用完自己删。
 *
 * 为什么需要这个：11 个 e2e 测试各自用「.l0-control-xxx-时间戳」当 stateDir，
 * 跑完就留在工作区里。这些目录被 .gitignore 里的 .l0-control 通配规则挡住，
 * 所以 git status 永远是干净的——问题看不见，但每跑一次 npm run verify 就多
 * 11 个，累积到 660 个 / 4.11 MB 才被人注意到。看不见的泄漏比看得见的更难修，
 * 因为没有任何一个时间点会提醒你。
 *
 * 用法：
 *   const dir = tempStateDir('queue');
 *   try { ...work... } finally { cleanupTempStateDirs(); }
 *
 * 为什么不用 OS 的 tmp 目录：这些状态的语义是「工作区内的运行时目录」，
 * 放到系统临时盘会改变 workspaceRoot 与 stateDir 的相对关系，
 * 测到的路径拼接行为与线上不一致。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 本次进程创建的全部目录（进程退出时兜底清理）。 */
const created = [];

/**
 * 递归删除；**不用 `fs.rmSync`**。
 *
 * 实测（Node v24.9.0 / Windows）：`fs.rmSync(dir, { recursive: true })` 返回成功、
 * 不抛错，目录及其文件**仍然存在**；同一路径的 `fs.rmdirSync`、`fs.unlinkSync`
 * 与异步 `fs.rm` 都正常工作。也就是说这个环境里 `rmSync` 会**静默失败**——
 * 依赖它写清理逻辑，得到的是「看起来删了、其实没删」，而清理代码本身不会报错，
 * 于是残留目录会一直涨。这里改成自己走一遍：先删文件再删目录，
 * 每一步失败都记下来，最后能删掉多少算多少。
 */
function removeTree(target) {
  let entry;
  try {
    entry = fs.lstatSync(target, { throwIfNoEntry: false });
  } catch {
    return true;
  }
  if (!entry) return true;
  if (!entry.isDirectory()) {
    try {
      fs.unlinkSync(target);
      return true;
    } catch {
      return false;
    }
  }
  let names;
  try {
    names = fs.readdirSync(target);
  } catch {
    return false;
  }
  let clean = true;
  for (const name of names) {
    if (!removeTree(path.join(target, name))) clean = false;
  }
  // 目录非空会抛 ENOTEMPTY：那种情况说明上面有删不掉的子项，如实返回 false。
  try {
    fs.rmdirSync(target);
    return clean;
  } catch {
    return false;
  }
}

/** 进程退出时兜底：正常路径都走 finally，这里只接住断言抛错与 process.exit。 */
process.on('exit', () => {
  for (const dir of created) removeTree(dir);
});

/**
 * 建一个唯一临时状态目录并登记清理。
 *
 * 唯一性用「毫秒 + 6 位随机」而不是计数器：同一毫秒内并发跑多个测试文件时，
 * 纯计数器会撞名，而撞名后的失败表现是「上一个测试的 journal 还在」，
 * 排查方向完全错。
 */
export function tempStateDir(tag) {
  const root = process.cwd();
  const name = `.l0-control-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  fs.mkdirSync(path.join(root, name), { recursive: true });
  created.push(name);
  return name;
}

/**
 * 登记一个**派生**目录用于清理（如 `${stateDir}-tick`）。
 *
 * 为什么需要：有些测试要在一份状态旁边再开一个"干净"的状态目录做对照
 * （`-tick` / `-many` / `-broken`），名字由基名拼出来。基名登记了、派生名没登记，
 * 于是每跑一次就漏一个——这类泄漏最容易被忽略，因为泄漏量比主目录小一个数量级，
 * 看起来"基本干净"。派生名必须和基名一样被跟踪。
 */
export function trackTempStateDir(name) {
  if (!created.includes(name)) created.push(name);
  return name;
}

/** 立刻删掉本次进程创建的全部目录（可重复调用）。 */
export function cleanupTempStateDirs() {
  while (created.length) removeTree(created.pop());
}

/**
 * 在**系统临时目录**建一个唯一目录并登记清理 —— 给「可以离开工作区」的测试用。
 *
 * 为什么需要它（第 40 轮的教训）：`verify-journal-incremental.mjs` 与
 * `verify-journal-shared-cache.mjs` 各自 `fs.mkdtempSync(os.tmpdir(), 'l0-jr-'/'l0-jcache-')`，
 * **既无 finally 也无 exit 钩子**。跑一次 verify 就留下成百上千个目录：
 *
 *   l0-jcache  546 个 / 1101.9 MB
 *   l0-jr     1234 个 /  368.0 MB   ← 合计 1.63 GB，全在 C 盘
 *
 * 而泄漏闸门当时只查 `plugins/` 目录，**根本没看系统临时目录**，所以这些一直没被发现。
 *
 * 用法：
 *   const dir = tempSystemDir('l0-jcache-');   // 自动登记，进程退出兜底删
 *   try { ...work... } finally { cleanupTempStateDirs(); }
 *
 * 与 `tempStateDir()` 的区别：那个建在**工作区内**（要保持 workspaceRoot 与 stateDir 的
 * 相对关系）；这个建在系统临时目录（测试不关心相对关系时用，避免污染工作区）。
 */
export function tempSystemDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/**
 * 精确删掉**一个**已登记的临时目录，并把它从登记表里移除。
 *
 * 为什么需要它：测试常在 `finally` 里只想清自己建的这一个，而 `cleanupTempStateDirs()`
 * 会把本次进程建的**全部**删掉（可能波及并行跑的其它测试）。
 *
 * 但它存在的**更重要的理由**是统一删除方式：不少测试原来写的是
 * `fs.rmSync(dir, { recursive: true, force: true })`——那个调用在这个环境里
 * **返回成功、不抛错、目录仍然存在**（见文件顶部 `removeTree` 的注释）。
 * 于是一边有清理代码、一边在泄漏，而清理代码本身永远"成功"。
 *
 * 实测证据：`verify-partition-recovery-drill.mjs` 用 `fs.rmSync` 清
 * `l0-recovery-drill-*`，在系统临时目录里积了 **29 个**；`verify-dispatch-view-bounded.mjs`
 * 用同样的写法清 `l0-bounded-*`，也一直在漏。**删不掉的清理比没有清理更危险**，
 * 因为它让人以为已经处理了。
 */
export function removeTempDir(target) {
  const i = created.indexOf(target);
  if (i >= 0) created.splice(i, 1);
  return removeTree(target);
}
