/**
 * 故障注入矩阵：把「存储层坏了」的每种形态都真的造一遍，看系统怎么反应。
 *
 * 为什么要有这个：前 10 轮只演练过「进程被杀 + 锁 TTL 过期」一种故障。
 * 而真实崩溃/损坏有六七种形态，它们的正确处理方式完全不同：
 *
 *   故障                        正确反应                    错误反应
 *   末行写了一半（torn tail）   截掉末行，其余照用          整个 journal 打不开
 *   中间行损坏                  拒绝打开并指认行号          静默跳过 → 状态与事实不符
 *   记录被篡改（哈希不自洽）    STATE_HASH_BREAK            照单全收 → 审计链失效
 *   seq 出现空洞                STATE_SEQ_GAP               把后续事件当连续的
 *   写入失败（磁盘满 / IO 错）  显式报错，状态不前进        假装成功 → 内存与盘不一致
 *   锁文件不可解析              STATE_CORRUPT，不猜         当没锁 → 双写
 *   两个 writer 同时抢          一个赢，另一个 STATE_LOCKED  两个都写 → 哈希链断裂
 *
 * 静默修复比崩溃更危险：崩溃你至少知道要查；静默跳过会让系统带着错误的状态
 * 继续跑，产出的证据、完成的节点、算出的预算全都是假的。
 *
 * 本测试逐条构造上述形态并断言「该拒的拒、该修的修、该报的报」。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const lib = (name) => pathToFileURL(path.join(root, 'lib', name)).href;
const { Store: StateStore, MemoryFsPort, statePaths } = await import(lib('state/index.js'));
const { canonicalJson } = await import(lib('state/canonical.js'));

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}\n`);
};

/** 打开一个内存 store 并写入 count 条真实记录，返回 { fs, dir, paths, lines }。 */
async function seedJournal(count) {
  const fs = new MemoryFsPort();
  const dir = '/state';
  const opened = await StateStore.open({ dir, fs, owner: 'seed', ttlMs: 60000, waitMs: 0 });
  for (let index = 0; index < count; index += 1) {
    await opened.append({ kind: 'node_added', nodeId: `N${index}`, payload: { node: { node_id: `N${index}` } } });
  }
  await opened.close({ snapshot: false });
  const paths = statePaths(dir);
  const text = (await fs.readText(paths.journal)) ?? '';
  return { fs, dir, paths, lines: text.split('\n').filter((line) => line.length > 0) };
}

const rejoin = (lines) => lines.map((line) => `${line}\n`).join('');

async function replaceJournal(paths, fs, content) {
  await fs.writeCas(paths.journal, content, {
    kind: 'replaceIfVersion',
    version: await fs.versionOf(paths.journal),
  });
}

async function openExpecting(dir, fs, owner) {
  try {
    const opened = await StateStore.open({ dir, fs, owner, ttlMs: 60000, waitMs: 0, takeover: true });
    return { opened, error: null };
  } catch (error) {
    return { opened: null, error };
  }
}

process.stdout.write('\n故障注入矩阵\n' + '─'.repeat(70) + '\n');

// ═══ 1. torn tail：末行写了一半 ═════════════════════════════════════════════
// 真实撕裂写的样子是**没有行尾换行**：`append("line\n")` 只落了 `line` 的前半截。
// 如果连换行都落了，说明那行写完了 —— 那时不可解析就是真损坏，不是撕裂，
// 必须拒绝打开而不是截掉（见第 2 项）。本项严格按真实形态构造。
{
  const { fs, dir, paths, lines } = await seedJournal(4);
  const last = lines[lines.length - 1];
  await replaceJournal(paths, fs, rejoin(lines.slice(0, -1)) + last.slice(0, Math.floor(last.length / 2)));

  const { opened, error } = await openExpecting(dir, fs, 'torn');
  record('torn tail: 打开成功', error === null, `error=${error?.code ?? String(error?.message ?? '')}`);
  if (opened) {
    const status = opened.journal.status();
    record(
      'torn tail: 末行被截掉、其余 3 条可用',
      status.records === 3 && (status.repair?.droppedLines ?? 0) === 1,
      `records=${status.records} repair=${JSON.stringify(status.repair)}`,
    );
    record(
      'torn tail: 修复进 recovery 报告（不静默）',
      opened.lastRecovery?.repair?.droppedLines === 1,
      JSON.stringify(opened.lastRecovery?.repair ?? null),
    );
    await opened.close({ snapshot: false });
  }
}

// ═══ 1b. 末行写了换行但内容损坏：必须拒绝，不能当撕裂截掉 ═══════════════════
// 这是第 1 项的**对照面**：同样是「末行不可解析」，但落盘了换行 = 那行写完了。
// 此时静默截掉等于丢一条**可能有效**的记录（seq 会空洞、状态会错），必须拒绝。
{
  const { fs, dir, paths, lines } = await seedJournal(4);
  const corrupted = [...lines];
  corrupted[corrupted.length - 1] = '{"seq":4,"eventId":"EVT';
  await replaceJournal(paths, fs, rejoin(corrupted));

  const { opened, error } = await openExpecting(dir, fs, 'tail-corrupt');
  if (opened) await opened.close({ snapshot: false });
  record(
    '末行有换行但损坏 → 拒绝打开（不静默截掉已完成行）',
    error?.code === 'STATE_CORRUPT',
    `code=${error?.code ?? 'none'}（若 PASS 说明被静默截断，会丢有效记录）`,
  );
}

// ═══ 2. 中间行损坏：必须拒绝打开并指认行号 ══════════════════════════════════
{
  const { fs, dir, paths, lines } = await seedJournal(4);
  const corrupted = [...lines];
  corrupted[1] = '{ this is not json';
  await replaceJournal(paths, fs, rejoin(corrupted));

  const { opened, error } = await openExpecting(dir, fs, 'mid');
  if (opened) await opened.close({ snapshot: false });
  record('中间行损坏 → 拒绝打开', error !== null, '居然打开了');
  record(
    '中间行损坏 → STATE_CORRUPT',
    error?.code === 'STATE_CORRUPT',
    `code=${error?.code ?? 'none'} msg=${String(error?.message ?? '').slice(0, 60)}`,
  );
  record(
    '错误指出是第几行',
    typeof error?.message === 'string' && /line\s*2/.test(error.message),
    error?.message,
  );
  record(
    '错误提示不做自动修复',
    String(error?.detail?.hint ?? '').includes('人工'),
    JSON.stringify(error?.detail ?? null),
  );
}

// ═══ 3. 记录被篡改：哈希不自洽必须拒绝 ══════════════════════════════════════
{
  const { fs, dir, paths, lines } = await seedJournal(4);
  const tampered = [...lines];
  const third = JSON.parse(tampered[2]);
  third.payload = { node: { node_id: 'EVIL' } }; // 改内容但保留原 hash
  tampered[2] = canonicalJson(third);
  await replaceJournal(paths, fs, rejoin(tampered));

  const { opened, error } = await openExpecting(dir, fs, 'tamper');
  if (opened) await opened.close({ snapshot: false });
  record(
    '篡改记录 → STATE_HASH_BREAK',
    error?.code === 'STATE_HASH_BREAK',
    `code=${error?.code ?? 'none'} msg=${String(error?.message ?? '').slice(0, 60)}`,
  );
}

// ═══ 4. seq 空洞：必须拒绝 ═════════════════════════════════════════════════
{
  const { fs, dir, paths, lines } = await seedJournal(5);
  // 删掉第 3 行（seq=3）→ 后面 seq 不连续，prevHash 也对不上。
  // 两种错误码都算正确拒绝（seq 空洞或哈希断裂）。
  await replaceJournal(paths, fs, rejoin([...lines.slice(0, 2), ...lines.slice(3)]));

  const { opened, error } = await openExpecting(dir, fs, 'gap');
  if (opened) await opened.close({ snapshot: false });
  record('seq 空洞 → 拒绝打开', error !== null, '居然打开了');
  record(
    'seq 空洞 → SEQ_GAP 或 HASH_BREAK',
    error?.code === 'STATE_SEQ_GAP' || error?.code === 'STATE_HASH_BREAK',
    `code=${error?.code ?? 'none'}`,
  );
}

// ═══ 5. 写入失败（磁盘满）：显式报错，状态不前进 ═════════════════════════════
{
  class EnospcFs extends MemoryFsPort {
    failOnAppend = false;
    async append(file, chunk) {
      if (this.failOnAppend) {
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      return super.append(file, chunk);
    }
  }
  const fs = new EnospcFs();
  const dir = '/enospc';
  const opened = await StateStore.open({ dir, fs, owner: 'enospc', ttlMs: 60000, waitMs: 0 });
  await opened.append({ kind: 'node_added', nodeId: 'A', payload: { node: { node_id: 'A' } } });
  const before = opened.journal.status().records;

  fs.failOnAppend = true;
  let error = null;
  try {
    await opened.append({ kind: 'node_added', nodeId: 'B', payload: { node: { node_id: 'B' } } });
  } catch (caught) {
    error = caught;
  }
  record('磁盘满 → 显式抛错', error?.code === 'ENOSPC', `code=${error?.code ?? 'none'}`);
  record(
    '磁盘满 → 记录数不前进（没假装成功）',
    opened.journal.status().records === before,
    `before=${before} after=${opened.journal.status().records}`,
  );

  fs.failOnAppend = false;
  await opened.append({ kind: 'node_added', nodeId: 'C', payload: { node: { node_id: 'C' } } });
  record(
    '恢复后能继续写、链仍连续',
    opened.journal.status().records === before + 1,
    `records=${opened.journal.status().records}`,
  );
  await opened.close({ snapshot: false });
}

// ═══ 6. 锁文件不可解析：必须报错，不能当没锁 ═══════════════════════════════
{
  const { fs, dir, paths } = await seedJournal(2);
  // seed 结束时 close() 已释放锁（文件被删），所以这里用 createIfAbsent 造一个新锁。
  await fs.writeCas(paths.lock, 'not-json-at-all\n', { kind: 'createIfAbsent' });
  const { opened, error } = await openExpecting(dir, fs, 'badlock');
  if (opened) await opened.close({ snapshot: false });
  record(
    '锁文件不可解析 → 显式报错（不猜、不当没锁）',
    error !== null && (error.code === 'STATE_CORRUPT' || error instanceof SyntaxError),
    `code=${error?.code ?? error?.name ?? 'none'}`,
  );
}

// ═══ 7. 两个 writer 同时抢：只有一个赢 ═══════════════════════════════════════
{
  const fs = new MemoryFsPort();
  const dir = '/race';
  const first = await StateStore.open({ dir, fs, owner: 'writer-A', ttlMs: 60000, waitMs: 0 });

  let secondError = null;
  let secondOpened = null;
  try {
    secondOpened = await StateStore.open({ dir, fs, owner: 'writer-B', ttlMs: 60000, waitMs: 0 });
  } catch (caught) {
    secondError = caught;
  }
  record('并发第二个 writer → STATE_LOCKED', secondError?.code === 'STATE_LOCKED', `code=${secondError?.code ?? 'none'}`);

  await first.append({ kind: 'node_added', nodeId: 'A', payload: { node: { node_id: 'A' } } });
  record('赢家仍可写', first.journal.status().records === 1, `records=${first.journal.status().records}`);

  if (secondOpened) await secondOpened.close({ snapshot: false });
  await first.close({ snapshot: false });
}

// ═══ 8. 被接管后的老 writer：写入必须被 fencing 拒绝 ═════════════════════════
{
  const fs = new MemoryFsPort();
  const dir = '/fenced';
  const oldWriter = await StateStore.open({ dir, fs, owner: 'old', ttlMs: 1, waitMs: 0 });
  await oldWriter.append({ kind: 'node_added', nodeId: 'A', payload: { node: { node_id: 'A' } } });

  // 让锁过期，新 writer 显式接管
  await new Promise((resolve) => setTimeout(resolve, 30));
  const newWriter = await StateStore.open({ dir, fs, owner: 'new', ttlMs: 60000, waitMs: 300, takeover: true });
  await newWriter.append({ kind: 'node_added', nodeId: 'B', payload: { node: { node_id: 'B' } } });

  let fencedError = null;
  try {
    await oldWriter.append({ kind: 'node_added', nodeId: 'C', payload: { node: { node_id: 'C' } } });
  } catch (caught) {
    fencedError = caught;
  }
  record(
    '被接管的老 writer 写入 → 被拒（FENCED_OUT 或 LOCKED）',
    fencedError?.code === 'STATE_FENCED_OUT' || fencedError?.code === 'STATE_LOCKED',
    `code=${fencedError?.code ?? 'none'}`,
  );

  const journalText = (await fs.readText(statePaths(dir).journal)) ?? '';
  const hasC = journalText.includes('"node_id":"C"');
  record('老 writer 的写入没有落盘', !hasC, `C 落盘=${hasC}`);
  record(
    '新 writer 记录数正确',
    newWriter.journal.status().records >= 2,
    `records=${newWriter.journal.status().records}`,
  );
  await newWriter.close({ snapshot: false });
}

// ═══ 9. torn tail 截断后仍能继续追加，且链自洽 ══════════════════════════════
{
  const { fs, dir, paths, lines } = await seedJournal(3);
  // 同样按真实撕裂形态构造：末行无换行、内容被截
  await replaceJournal(paths, fs, rejoin(lines.slice(0, -1)) + lines[lines.length - 1].slice(0, 10));

  const { opened, error } = await openExpecting(dir, fs, 'cont');
  record('截断后能重新打开', error === null && opened !== null, `error=${error?.code ?? 'none'}`);
  if (opened) {
    await opened.append({ kind: 'node_added', nodeId: 'X', payload: { node: { node_id: 'X' } } });
    let chainOk = true;
    try {
      opened.verify();
    } catch {
      chainOk = false;
    }
    // 原始 3 条，末行被截 → 剩 2 条；再追加 1 条 → 3
    record('截断后可继续追加', opened.journal.status().records === 3, `records=${opened.journal.status().records}`);
    record('追加后链仍自洽', chainOk, 'verify 失败');
    await opened.close({ snapshot: false });
  }
}

const failed = results.filter((row) => !row.ok);
process.stdout.write('─'.repeat(70) + '\n');
process.stdout.write(
  `${failed.length === 0 ? 'PASS' : 'FAIL'} fault injection matrix: ${results.length - failed.length}/${results.length} 项通过\n`,
);
if (failed.length) {
  for (const row of failed) process.stdout.write(`  FAILED: ${row.name} — ${row.detail ?? ''}\n`);
  process.exit(1);
}
