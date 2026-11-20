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

/**
 * 构建快照。
 *
 * `known` 让调用方把**已经算过的**摘要/字节数带进来，避免重复计算。
 * 这不是微优化：`stateSha256` 要 `canonicalJson` 整个 state（10 万节点 34 MB ≈ 0.55 s），
 * `journalHash` 要 sha256 整个 journal（100 MB ≈ 0.5 s），而恢复流程往往刚刚算过其中之一。
 * 不传就照旧现算，语义完全不变。
 */
export function buildSnapshot(
  state          ,
  records                 ,
  rawJournalText        ,
  at        ,
  known                                                                        = {},
)               {
  const meta               = {
    schema: STATE_SCHEMA,
    seq: state.revision,
    revision: state.revision,
    graphRevision: state.graphRevision,
    journalBytes: known.journalBytes ?? Buffer.byteLength(rawJournalText, 'utf8'),
    journalHash: known.journalHash ?? sha256Hex(rawJournalText),
    stateSha256: known.stateSha256 ?? stateSha256(state),
    createdAt: at,
  };
  void records; // 保留参数位（早期实现用它算 journalBytes；现在按原文算，口径更准）
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

/**
 * 快照自校验：`stateSha256` 与内容一致，且 meta.seq 与 state.revision 一致。
 *
 * **返回**实际算出的 `stateSha256`：调用方（恢复流程）几乎总要用这个摘要去做下一步比对，
 * 而算它要 `canonicalJson` 整个 state（10 万节点 34 MB，约 0.6 s）。让它返回而不是
 * `void`，是为了让同一份 state 的摘要**每个进程内只算一次**，而不是各调用点各算一遍。
 */
export function verifySnapshot(file              )         {
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
  return actual;
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

/**
 * 快照与 journal 的锚点比较。
 */
                              
                                                                      
                      
                     
                              
                                                                    
                     
                                            
                        
                                          
 

/**
 * 锚点比较规则：
 *   - journal 只追加 → 快照记录的 `journalBytes` 必然是当前 journal 的**前缀**，
 *     所以用「当前文本前 journalBytes 字节」的 sha256 与 `journalHash` 比，
 *     而不是比全文（比全文会在 journal 正常前进时误报）。
 *   - 前缀字节落在行边界（构建时按整行累计），UTF-8 多字节切分安全。
 *   - 返回值带上 `prefixHash` / `anchoredBytes`：恢复流程拿它判断"快照是否正好等于当前
 *     journal 全文"，从而跳过第二次全量哈希——100 MB 的 sha256 约 0.78 s。
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
    prefixHash,
    anchoredBytes,
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