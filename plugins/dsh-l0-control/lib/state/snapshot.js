/**
 * N4 · 快照（fs CAS 发布 + 三元锚）
 *
 * 三元锚 = `journalBytes` + `journalHash` + `stateSha256`：
 *   - `journalBytes`：快照对应的 journal 字节长度（尾部截断/追加都能定位）；
 *   - `journalHash`：该长度下 journal 原文的 sha256（不是记录的哈希链，而是字节指纹，
 *     用来发现"journal 被就地改写"这类哈希链无法覆盖的破坏）；
 *   - `stateSha256`：`canonicalJson(state)` 的 sha256（快照自校验）。
 *
 * 发布策略：宿主 `fs` 无多文件事务 → 单文件原子写 `writeCas()`：
 *   - 首次发布 `createIfAbsent`；
 *   - 更新 `replaceIfVersion`（陈旧版本 → `STATE_STALE_VERSION`，绝不覆盖别人刚写的快照）。
 */

import { canonicalJson, sha256Hex } from './canonical.js';
import { StateError,                                                                  } from './types.js';
import { STATE_SCHEMA } from './types.js';
                                                
import { journalFingerprint,                 } from './journal.js';

export function stateSha256(state          )         {
  return sha256Hex(canonicalJson(state           ));
}

export function journalBytesOf(records                 )         {
  return records.reduce((sum, record) => sum + Buffer.byteLength(`${canonicalJson(record)}\n`, 'utf8'), 0);
}

export function buildSnapshot(
  state          ,
  records                 ,
  rawJournalText        ,
  at        ,
)               {
  const meta               = {
    schema: STATE_SCHEMA,
    seq: state.revision,
    revision: state.revision,
    graphRevision: state.graphRevision,
    journalBytes: Buffer.byteLength(rawJournalText, 'utf8'),
    journalHash: sha256Hex(rawJournalText),
    stateSha256: stateSha256(state),
    createdAt: at,
  };
  return { meta, state };
}

                                 
                     
                  
 

export async function readSnapshot(fsPort        , paths            )                                 {
  const raw = await fsPort.readText(paths.snapshot);
  if (raw === null) return null;
  let parsed         ;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StateError('STATE_CORRUPT', `快照不是合法 JSON：${paths.snapshot}`);
  }
  const file = parsed                ;
  if (!file || typeof file !== 'object' || !file.meta || !file.state) {
    throw new StateError('STATE_CORRUPT', `快照缺少 meta/state：${paths.snapshot}`);
  }
  const version = (await fsPort.versionOf(paths.snapshot))          ;
  return { file, version };
}

/** 快照自校验：`stateSha256` 与内容一致，且 meta.seq 与 state.revision 一致。 */
export function verifySnapshot(file              )       {
  if (file.meta.schema !== STATE_SCHEMA) {
    throw new StateError('STATE_CORRUPT', `快照 schema=${file.meta.schema} != ${STATE_SCHEMA}`);
  }
  const actual = stateSha256(file.state);
  if (actual !== file.meta.stateSha256) {
    throw new StateError('STATE_DIVERGED', '快照内容与 stateSha256 不符（就地损坏）', {
      expected: file.meta.stateSha256,
      actual,
    });
  }
  if (file.meta.seq !== file.state.revision) {
    throw new StateError('STATE_DIVERGED', `快照 meta.seq=${file.meta.seq} != state.revision=${file.state.revision}`);
  }
}

                                      
                                 
                  
                     
 

export async function writeSnapshot(
  fsPort        ,
  paths            ,
  file              ,
  expected                                                                            ,
)                               {
  const body = `${JSON.stringify(file, null, 2)}\n`;
  const outcome = await fsPort.writeCas(paths.snapshot, body, expected);
  return { operation: outcome.operation, version: outcome.version, meta: file.meta };
}

/** 便捷：读当前版本并 CAS 覆盖（读-改-写窗口内的竞争由版本校验兜底）。 */
export async function updateSnapshot(
  fsPort        ,
  paths            ,
  file              ,
)                               {
  const current = await fsPort.versionOf(paths.snapshot);
  return writeSnapshot(
    fsPort,
    paths,
    file,
    current === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: current },
  );
}

/** 快照与 journal 的锚点比较。 */
                              
                                                                      
                      
                     
                              
                                          
 

/**
 * 锚点比较规则：
 *   - journal 只追加 → 快照记录的 `journalBytes` 必然是当前 journal 的**前缀**，
 *     所以用「当前文本前 journalBytes 字节」的 sha256 与 `journalHash` 比，
 *     而不是比全文（比全文会在 journal 正常前进时误报）。
 *   - 前缀字节落在行边界（构建时按整行累计），UTF-8 多字节切分安全。
 */
export function checkAnchor(file              , records                 , rawJournalText        )              {
  const journalSeq = records.length ? records[records.length - 1].seq : 0;
  const buffer = Buffer.from(rawJournalText, 'utf8');
  const anchoredBytes = Math.min(file.meta.journalBytes, buffer.length);
  const prefixHash = sha256Hex(buffer.subarray(0, anchoredBytes).toString('utf8'));
  const journalHashMatches = prefixHash === file.meta.journalHash;
  const base = {
    snapshotSeq: file.meta.seq,
    journalSeq,
    journalHashMatches,
  };
  if (file.meta.seq > journalSeq) {
    return { status: 'snapshot-ahead', ...base, detail: { reason: '快照序号超过 journal：journal 丢失/被回滚' } };
  }
  if (!journalHashMatches) {
    // 锚点前缀字节被改写（哈希链可能仍自洽，例如整段重写/压缩）
    return {
      status: 'diverged',
      ...base,
      detail: { reason: 'journal 锚点前缀字节与快照不符', anchoredBytes, journalBytes: buffer.length },
    };
  }
  if (file.meta.seq < journalSeq) {
    return { status: 'journal-ahead', ...base, detail: { replay: journalSeq - file.meta.seq } };
  }
  return { status: 'in-sync', ...base, detail: {} };
}

export { journalFingerprint };


//# sourceURL=state\snapshot.js