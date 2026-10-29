/**
 * N4 · 文件系统端口实现
 *
 * 三套：
 *   - `NodeFsPort`：node:fs；追加走 `open('a') + writeSync + fsyncSync`；
 *     发布走「临时文件 + fsync + rename」（与 N2 的 `dsh.bundle.patch` 无关，纯运行时）。
 *   - `MemoryFsPort`：单测/故障注入（可模拟断电、ENOSPC、torn write）。
 *   - `DshFsPort`：宿主 `fs` 服务适配（`resolve` / `stat` / `readText` / `writeText` / `listDir`）。
 *     宿主 `fs` 没有 append 原语，`append()` 用「读 + CAS 写回 + 重试」实现并显式标注代价。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { StateError,                                                                } from './types.js';

function sha256(text        )         {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isNotFound(error         )          {
  return (error                            )?.code === 'ENOENT';
}

export class NodeFsPort                   {
           kind = 'node';

  async readText(file        )                         {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async versionOf(file        )                         {
    const text = await this.readText(file);
    return text === null ? null : sha256(text);
  }

  async writeCas(
    file        ,
    content        ,
    expected                ,
  )                                                               {
    const exists = fs.existsSync(file);
    if (expected.kind === 'createIfAbsent' && exists) {
      throw new StateError('STATE_STALE_VERSION', `目标已存在，拒绝 createIfAbsent：${file}`, {
        file,
        current: sha256(fs.readFileSync(file, 'utf8')),
      });
    }
    if (expected.kind === 'replaceIfVersion') {
      if (!exists) {
        throw new StateError('STATE_STALE_VERSION', `目标不存在，无法 replaceIfVersion：${file}`, { file });
      }
      const current = sha256(fs.readFileSync(file, 'utf8'));
      if (current !== expected.version) {
        throw new StateError('STATE_STALE_VERSION', `CAS 版本不匹配：${file}`, {
          file,
          expected: expected.version,
          current,
        });
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, content, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    return { operation: exists ? 'update' : 'create', version: sha256(content) };
  }

  async append(file        , chunk        )                  {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'a');
    try {
      const bytes = fs.writeSync(fd, chunk, null, 'utf8');
      fs.fsyncSync(fd);
      return bytes;
    } finally {
      fs.closeSync(fd);
    }
  }

  async stat(file        )                           {
    try {
      const info = fs.statSync(file);
      return { size: info.size, mtimeMs: info.mtimeMs };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async listDir(dir        )                      {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .map((entry) => ({
          name: entry.name,
          type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  async remove(file        )                {
    fs.rmSync(file, { force: true, recursive: false });
  }

  async mkdirp(dir        )                {
    fs.mkdirSync(dir, { recursive: true });
  }

  async truncate(file        , size        )                {
    fs.truncateSync(file, size);
  }
}

                       
                  
                  
 

/** 内存端口：单测与故障注入。`failNextAppend` / `tornBytes` 用于模拟强杀。 */
export class MemoryFsPort                   {
           kind = 'memory';
           files = new Map                     ();
           dirs = new Set        ();
  failNextAppend                             = null;
          clock = 0;

  seed(file        , content        )       {
    this.files.set(file, { content, mtimeMs: ++this.clock });
    const dir = path.dirname(file);
    while (dir && dir !== '.' && dir !== '/') {
      this.dirs.add(dir);
      break;
    }
  }

  async readText(file        )                         {
    return this.files.get(file)?.content ?? null;
  }

  async versionOf(file        )                         {
    const entry = this.files.get(file);
    return entry ? sha256(entry.content) : null;
  }

  async writeCas(
    file        ,
    content        ,
    expected                ,
  )                                                               {
    const existing = this.files.get(file);
    if (expected.kind === 'createIfAbsent' && existing) {
      throw new StateError('STATE_STALE_VERSION', `目标已存在，拒绝 createIfAbsent：${file}`, { file });
    }
    if (expected.kind === 'replaceIfVersion' && !existing) {
      throw new StateError('STATE_STALE_VERSION', `目标不存在，无法 replaceIfVersion：${file}`, { file });
    }
    if (expected.kind === 'replaceIfVersion' && existing) {
      const current = sha256(existing.content);
      if (current !== expected.version) {
        throw new StateError('STATE_STALE_VERSION', `CAS 版本不匹配：${file}`, {
          file,
          expected: expected.version,
          current,
        });
      }
    }
    this.files.set(file, { content, mtimeMs: ++this.clock });
    return { operation: existing ? 'update' : 'create', version: sha256(content) };
  }

  async append(file        , chunk        )                  {
    const mode = this.failNextAppend;
    this.failNextAppend = null;
    if (mode === 'throw') throw new StateError('STATE_CORRUPT', `注入写入失败：${file}`, { file });
    const entry = this.files.get(file);
    const before = entry?.content ?? '';
    if (mode === 'partial') {
      // 模拟"写了一半就被强杀"：只落一部分字节，无换行。
      const half = chunk.slice(0, Math.max(1, Math.floor(chunk.length / 2)));
      this.files.set(file, { content: before + half, mtimeMs: ++this.clock });
      return half.length;
    }
    this.files.set(file, { content: before + chunk, mtimeMs: ++this.clock });
    return chunk.length;
  }

  async stat(file        )                           {
    const entry = this.files.get(file);
    return entry ? { size: entry.content.length, mtimeMs: entry.mtimeMs } : null;
  }

  async listDir(dir        )                      {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const seen = new Map                  ();
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      seen.set(rest, { name: rest, type: 'file' });
    }
    for (const sub of this.dirs) {
      if (!sub.startsWith(prefix)) continue;
      const rest = sub.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      seen.set(rest, { name: rest, type: 'directory' });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async remove(file        )                {
    this.files.delete(file);
  }

  async mkdirp(dir        )                {
    this.dirs.add(dir);
  }

  async truncate(file        , size        )                {
    const entry = this.files.get(file);
    if (!entry) return;
    this.files.set(file, { content: entry.content.slice(0, size), mtimeMs: ++this.clock });
  }
}

/** 宿主 `fs` 服务的最小结构（只声明我们用到的成员）。 */
                                
                                                                                                      
                                                                  
                                             
            
                    
                    
                                                                                          
                                                                                                        
                                                                                                                    
                                        
 

/**
 * 宿主 `fs` 适配。版本即宿主 `FsVersion`（不透明字符串）。
 * 注意：宿主 `fs` 无 append，`append()` 用 read → concat → CAS 写回 + 重试；
 * 因此 journal 越长大，单次追加越贵。生产路径优先 `NodeFsPort`（本地状态目录），
 * `DshFsPort` 用于需要走沙箱/远端文件系统的场景。
 */
export class DshFsPort                   {
           kind = 'dsh';
                   service               ;
                   cwd        ;
                   maxRetries        ;

  constructor(service               , cwd = process.cwd(), maxRetries = 3) {
    this.service = service;
    this.cwd = cwd;
    this.maxRetries = maxRetries;
  }

  async readText(file        )                         {
    const target = await this.service.resolve(file, { cwd: this.cwd });
    const info = await this.service.stat(target);
    if (!info) return null;
    return this.service.readText(target);
  }

  async versionOf(file        )                         {
    const target = await this.service.resolve(file, { cwd: this.cwd });
    const info = await this.service.stat(target);
    return info ? info.version : null;
  }

  async writeCas(
    file        ,
    content        ,
    expected                ,
  )                                                               {
    const target = await this.service.resolve(file, { cwd: this.cwd });
    const intent =
      expected.kind === 'createIfAbsent'
        ? { kind: 'createIfAbsent'          }
        : expected.kind === 'replaceIfVersion'
          ? { kind: 'replaceIfVersion'         , version: expected.version }
          : undefined;
    try {
      const outcome = await this.service.writeText(target, content, intent);
      return { operation: outcome.operation, version: String(outcome.version) };
    } catch (error) {
      const code = (error                            )?.code;
      if (code === 'FS_STALE_VERSION' || code === 'FS_EXISTS') {
        throw new StateError('STATE_STALE_VERSION', `宿主 fs CAS 拒绝：${file}`, { file, hostCode: String(code) });
      }
      throw error;
    }
  }

  async append(file        , chunk        )                  {
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      const current = await this.readText(file);
      const next = (current ?? '') + chunk;
      const expected                 =
        current === null
          ? { kind: 'createIfAbsent' }
          : { kind: 'replaceIfVersion', version: (await this.versionOf(file))           };
      try {
        await this.writeCas(file, next, expected);
        return chunk.length;
      } catch (error) {
        if (error instanceof StateError && error.code === 'STATE_STALE_VERSION') continue;
        throw error;
      }
    }
    throw new StateError('STATE_STALE_VERSION', `宿主 fs 追加重试耗尽：${file}`, { file });
  }

  async stat(file        )                           {
    const target = await this.service.resolve(file, { cwd: this.cwd });
    const info = await this.service.stat(target);
    if (!info) return null;
    const text = await this.service.readText(target);
    return { size: text.length, mtimeMs: Date.now() };
  }

  async listDir(dir        )                      {
    const target = await this.service.resolve(dir, { cwd: this.cwd });
    const info = await this.service.stat(target);
    if (!info) return [];
    const entries = await this.service.listDir(target);
    return entries
      .map((entry) => ({ name: entry.name, type: entry.type }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async remove()                {
    throw new StateError('STATE_READONLY', '宿主 fs 端口不提供删除；由调用方决定策略');
  }

  async mkdirp(dir        )                {
    const target = await this.service.resolve(dir, { cwd: this.cwd });
    // 目录创建在宿主侧是隐式能力：写一个占位标记失败时忽略（不改变契约）。
    try {
      await this.service.writeText(await this.service.resolve(`${dir}/.keep`, { cwd: this.cwd }), '', { kind: 'createIfAbsent' });
    } catch {
      void target;
    }
  }

  async truncate(file        , size        )                {
    const current = await this.readText(file);
    if (current === null) return;
    await this.writeCas(file, current.slice(0, size), {
      kind: 'replaceIfVersion',
      version: (await this.versionOf(file))          ,
    });
  }
}


//# sourceURL=state\fs-port.js