/**
 * 探针：单文件 journal 的**硬上限**在哪。
 *
 * 第 26 轮说过一句「分段的首要理由从『快』变成『绕开单文件上限 + 让恢复可并行』」，
 * 但这两条一直没量过。动手做分段之前必须先答两个问题：
 *
 *   1. 单文件到底在多大时**读不进来**（不是慢，是抛错/无法表示）？
 *      V8 的字符串长度有硬上限，`readFileSync(path,'utf8')` 直接撞它。
 *   2. 「让恢复可并行」成立吗？——哈希链是 `hash = sha256(prevHash + …)`，
 *      天然**串行**。这一条如果证伪，分段的立项理由就只剩第 1 条。
 */
import fs from 'node:fs';
import { constants as bufferConstants } from 'node:buffer';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-limit-'));
const line = JSON.stringify({
  seq: 1,
  eventId: 'EVT-000001',
  ts: '2026-11-20T00:00:00.000Z',
  kind: 'status_changed',
  nodeId: 'NODE-XXXX',
  payload: { from: 'planned', to: 'ready', at: '2026-11-20T00:00:00.000Z' },
  prevHash: '0'.repeat(64),
  hash: 'a'.repeat(64),
}) + '\n';
const perLine = Buffer.byteLength(line, 'utf8');
console.log(`单行 ${perLine} B（真实 journal 实测均值 528 B，这里用同数量级）`);

// V8 字符串上限（Node 里由 buffer 常量决定）
const maxStr = bufferConstants.MAX_STRING_LENGTH;
console.log(`V8 MAX_STRING_LENGTH = ${maxStr} B = ${(maxStr / 1024 / 1024).toFixed(0)} MB`);

const results = [];
for (const mb of [64, 256, 512]) {
  const target = mb * 1024 * 1024;
  const file = path.join(dir, `j-${mb}.jsonl`);
  const lines = Math.ceil(target / perLine);
  // 用 writev 风格的分块写，避免自己先 OOM
  const chunkLines = 20000;
  const chunk = line.repeat(chunkLines);
  const fd = fs.openSync(file, 'w');
  let written = 0;
  for (let i = 0; i < lines; i += chunkLines) {
    const n = Math.min(chunkLines, lines - i);
    fs.writeSync(fd, n === chunkLines ? chunk : line.repeat(n));
    written += n * perLine;
  }
  fs.closeSync(fd);
  const size = fs.statSync(file).size;

  let read = 'ok';
  let readMs = Number.NaN;
  let splitMs = Number.NaN;
  let parseMs = Number.NaN;
  let rows = 0;
  try {
    const t0 = performance.now();
    const text = fs.readFileSync(file, 'utf8');
    readMs = performance.now() - t0;
    const t1 = performance.now();
    const parts = text.split('\n');
    splitMs = performance.now() - t1;
    const t2 = performance.now();
    for (const p of parts) {
      if (!p) continue;
      try { JSON.parse(p); rows += 1; } catch { /* 忽略坏行 */ }
    }
    parseMs = performance.now() - t2;
  } catch (error) {
    read = `${error?.code ?? 'ERR'} ${String(error?.message ?? error).slice(0, 80)}`;
  }

  results.push({ mb, sizeMB: (size / 1024 / 1024).toFixed(1), rows, read, readMs, splitMs, parseMs });
  console.log(
    `${String(mb).padStart(4)} MB（${lines} 行）→ 读 ${read === 'ok' ? 'ok' : '失败: ' + read}` +
    (read === 'ok'
      ? `   readFileSync ${readMs.toFixed(0)} ms · split ${splitMs.toFixed(0)} ms · JSON.parse ${parseMs.toFixed(0)} ms · 堆 ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)} MB`
      : ''),
  );
  fs.rmSync(file, { force: true });
}

console.log('\n结论：');
const failed = results.filter((r) => r.read !== 'ok');
console.log(failed.length ? `  读失败起点：${failed[0].sizeMB} MB（${failed[0].read}）` : '  三档全部读成功');
console.log(`  单行 ${perLine} B ⇒ V8 上限约对应 ${(maxStr / perLine / 10000).toFixed(1)} 万行`);
console.log('  真实 journal 528 B/行 ⇒ 也就是约 ' + (maxStr / 528 / 10000).toFixed(0) + ' 万行 / ' + (maxStr / 528 * 528 / 1024 / 1024).toFixed(0) + ' MB 封顶');

fs.rmSync(dir, { recursive: true, force: true });
