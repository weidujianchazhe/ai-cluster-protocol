# Lane N4 · 状态日志 / CAS / 恢复（task-13）

> 代码：`plugins/dsh-l0-control/src/state/`（本 lane 独占写域）
> 计划依据：管理区 `designs/_research/DSH原生插件-60轮长任务.md` §2 权威边界、§4 P3
> 自测：`node plugins/dsh-l0-control/src/state/self-test.ts`（Node ≥ 22.6 类型擦除，无需构建）

## 1. 定位与权威边界

```
插件 journal（append-only + 哈希链 + revision）  ← 权威
   ├─ snapshot.json（fs CAS 发布，可重建缓存）
   ├─ checkpoints/*.json（检查点，含 sessionId/lastSeq 锚）
   └─ projection.json（TeamTask 投影，不是第二事实源）
```

- journal 只追加；快照可丢、可重建；TeamTask 投影可随时从状态重建。
- 与 N3（core）的关系：core 决定**业务规则**（done 凭证、ready 门控、租约、决策），
  state 层决定**怎么记、怎么恢复**。core 通过 `Store.append(...)` 落事件，通过
  `Store.state` 读折叠结果；state 层不解释业务语义（默认 reducer 只是"够用且可与
  Python 差分"的参考实现，N3 可用 `StoreOptions.fold` 覆盖）。

## 2. 稳定形状（N3 / N5 按此编码）

### 2.1 `JournalRecord`（`types.ts`）

```ts
interface JournalRecord {
  seq: number;          // 1 起、严格 +1（= StateDoc.revision）
  eventId: string;      // `EVT-%06d`，与 Python `_next_event_id` 同格式
  ts: string;           // 本地时区 ISO 秒精度，与 `db.now_iso()` 同形
  kind: string;         // 事件种类，词汇见 §3
  nodeId: string | null;
  payload: JsonObject;
  prevHash: string;     // seq=1 时为 ""
  hash: string;         // sha256(canonicalJson({seq,eventId,ts,kind,nodeId,payload,prevHash}))
}
```

哈希输入**不含** `hash` 自身，含 `eventId`；`canonicalJson` = 键排序 + 紧凑分隔符。

### 2.2 `StateDoc`（折叠结果，`revision === seq`）

```ts
interface StateDoc {
  schema: number;              // STATE_SCHEMA = 1
  revision: number;            // === 最后一条记录的 seq
  graphRevision: number;       // 对应 Python `meta.graph_version`（replan 递增，初值 1）
  updatedAt: string;
  nodes: Record<string, GraphNode>;   // 字段与 Python `tasks` 表一一对应（camelCase）
  edges: GraphEdge[];                 // {fromId,toId,kind}，按 (from,to,kind) 排序
  evidence: Record<string, EvidenceRecord>;
  artifacts: Record<string, ArtifactRecord>;
  decisions: Record<string, DecisionRecord>;
  gates: Record<string, GateRecord>;
  leases: Record<string, LeaseRecord>;
}
```

`GraphNode` 关键字段：`nodeId/title/spec/capability/stage/status/deps/evidenceRequired/
decisionId/assignee/attempts/verifierIds/budget/createdAt/updatedAt`；
`status` 取值与 Python `graph.STATUSES` 完全一致（10 态）。

### 2.3 快照三元锚 `SnapshotMeta`

```ts
interface SnapshotMeta {
  schema: number;
  seq: number;            // = state.revision
  revision: number;
  graphRevision: number;
  journalBytes: number;   // 快照对应 journal 的字节长度（= 当时全文长度）
  journalHash: string;    // 该前缀字节的 sha256（**比前缀，不比全文**）
  stateSha256: string;    // canonicalJson(state) 的 sha256
  createdAt: string;
}
```

比较规则（`snapshot.checkAnchor`）：`journalBytes` 是当前 journal 的前缀 → 取
`Buffer.subarray(0, journalBytes)` 求哈希再比；比全文会在 journal 正常前进时误报。

### 2.4 错误码（全部 fail-closed，`StateError.code`）

| 码 | 触发 | 恢复动作 |
|---|---|---|
| `STATE_LOCKED` | 已有活写者；锁未过期；抢占竞争失败 | 等锁过期 → `Store.takeover()` |
| `STATE_FENCED_OUT` | fencing token 过期/不匹配；锁易主 | 重新 takeover 取新 token |
| `STATE_STALE_VERSION` | 快照/文件 CAS 版本不匹配 | 重读版本后重试（禁止盲覆盖） |
| `STATE_SNAPSHOT_AHEAD` | 快照 `seq >` journal `seq` | 停：journal 丢失/回滚，人工介入 |
| `STATE_DIVERGED` | 快照内容/哈希不符；锚前缀不符 | journal 胜 → 重写快照 + `snapshot_diverged` |
| `STATE_SEQ_GAP` | seq 不连续 / 首条不是 1 | 停：journal 被拼接 |
| `STATE_HASH_BREAK` | 单条哈希不自洽 / prevHash 断链 | 停：journal 被篡改 |
| `STATE_CORRUPT` | 中间行不可解析 / 快照非 JSON / kind 为空 | 停：不做自动修复 |
| `STATE_READONLY` / `STATE_NOT_OPEN` | 只读模式 / 未持锁写入 | 编程错误 |

## 3. 事件词汇（默认 reducer 消费；N3 可扩展）

| kind | payload 关键字段 | 折叠效果 |
|---|---|---|
| `node_added` | `node`（完整节点） | 写入 `nodes[nodeId]`（Python 同义） |
| `node_removed` | `node` / `removed_edges` | 删节点 + 删相连边 + 删租约 |
| `edge_added` | `from,to,kind` | 去重插入边（Python 同义） |
| `status_changed` | `from,to,reason,at,**assignee?,attempts?** | 改状态；**assignee/attempts 随事件过来** |
| `lease_claimed` | `owner,fencingToken,expiresAt` | 建租约 + `assignee/status=claimed` |
| `lease_renewed` / `lease_released` / `lease_expired` / `lease_taken_over` | 见 `reducer.ts` | 维护 `leases` + 计数 |
| `evidence_added` | `evidenceId,kind,artifactId,verifierId,verdict,at` | 写 `evidence`（append-only 由 core 保证） |
| `artifact_added` | `artifactId,path,sha256` | 写 `artifacts` |
| `decision_*` | `decisionId,level,status,chosen` | 写 `decisions` |
| `stage_gate_changed` | `stage,status,evidenceRefs` | 写 `gates` |
| `graph_replanned` | `graphVersion` | `graphRevision = graphVersion` |
| `snapshot_diverged` / `writer_taken_over` | 诊断字段 | 不改业务状态（仅留痕） |

## 4. 与 Python `control_plane` 的语义对齐（有意差异已标注）

| 语义 | Python | N4 state | 结论 |
|---|---|---|---|
| 事件号 | `EVT-%06d`（`events.py`） | `eventIdOf(seq)` | **一致** |
| 时间戳 | `db.now_iso()` 本地 ISO 秒 | `nowIso()` 同形 | **一致** |
| 事件只追加 | `events` 表只 INSERT | JSONL 只追加 + fsync | **一致**（更严：哈希链） |
| 重放 | `graph.replay_snapshot()` 全量扫事件 | `reducer.fold()` 折叠 | **一致**（同夹具差分 = 0） |
| `snapshot == replay` | **原缺口已修复**：`control_plane/graph.py` 于 2026-10-29T21:20 起以 `set_status()` 为唯一入口，写 `status_changed` 后像 + `assignee_changed`；`snapshotEqualsReplay` 现为 `true`（夹具实测） | `status_changed`/`lease_*`/`assignee_changed`/`attempts_changed` 均落事件 | **口径一致**（N4 R1 时 Python 确有该缺口，已由上游 WP-02 修好） |
| 损坏处理 | 中间行不可解析=SQLite 层报错；无尾部修复 | 尾部半行截断修复；中间损坏 fail-closed | 更严 |
| 篡改检测 | 无 | `hash` 链 + `journalHash` 前缀锚 | 新增 |
| `graph_version` | `meta.graph_version` | `StateDoc.graphRevision` | 一致（命名差异） |
| 租约 | `leases` 表 + `lease_counters` 单调 token | `leases` 折叠 + `journal.lock.epoch` + `FenceToken` | 同构（单调、旧 token 被拒） |
| 诊断事件 | 无（`snapshot_diverged` 等仅日志） | `writer_taken_over` / `snapshot_diverged` **占用 seq**（单一序列空间）；业务记录数 = `revision − 诊断条数` | N4 私有约定，见 §5.3 |

## 5. 文件与 API 现状

| 文件 | 状态 | 对外符号 |
|---|---|---|
| `types.ts` | 完成 | 全部类型 + `StateError` |
| `canonical.ts` | 完成 | `canonicalJson/pythonJson/sha256Hex/eventIdOf/nowIso/sealRecord/recordHashOk/parseRecordLine/fingerprint/deepEqual/cloneJson` |
| `fs-port.ts` | 完成 | `NodeFsPort/MemoryFsPort/DshFsPort/HostFsService` |
| `journal.ts` | 完成 | `Journal.open/append/appendBatch/records/last/status/verifyChain/heartbeat/release/stealStaleLock`、`statePaths`、`journalFingerprint` |
| `reducer.ts` | 完成（可被 N3 覆盖） | `emptyState/fold/foldUntil/applyRecord/graphProjection`、`NODE_STATUSES/EDGE_KINDS` |
| `snapshot.ts` | 完成 | `buildSnapshot/readSnapshot/verifySnapshot/writeSnapshot/updateSnapshot/checkAnchor/stateSha256/journalBytesOf` |
| `recovery.ts` | 完成 | `recoverWithJournal/openAndRecover`、`RecoveryReport` |
| `store.ts` | 完成 | `Store.open({takeover})/append/appendBatch/heartbeat/snapshot/checkpoint/takeover/assertFence/verify/close` |
| `projection.ts` | 完成 | `projectTeamTasks/projectionStatus/rebuildProjection/diffProjection/readProjection` |
| `bridge.ts` | 完成 | `persistCoreEvents/restoreCoreJournal/toCoreGraph/pythonEventView/toAppendInputs/toEventRecords` |
| `python-diff.ts` | 完成 | `parseOracleFixture/runOracleScript/diffOracle/checkEventIdFormat` |
| `fixtures/python-replay.json` | 完成 | Python oracle 夹具（内存 SQLite 生成，含 script + python 视图） |
| `crash-child.ts` | 完成 | 真实强杀用例的子进程（追加 N 条 → 写 `committed.txt` → 空转等 SIGKILL） |
| `self-test.ts` | 完成（29/29） | 可执行验收 |

### 5.3 诊断事件与 seq

`writer_taken_over`（接管）与 `snapshot_diverged`（快照分歧）**也写进 journal、占用 seq**，
理由：单一序列空间，`revision === seq` 这条不变量不必开口子；代价是"业务条数"不等于 `revision`。

对账口径：
- 业务记录数 = `records.filter(kind 非诊断).length`；
- 强杀恢复后：`revision = 已提交业务条数 + 诊断条数`（用例 [J] 显式断言）；
- TeamTask 投影用 `state.revision`（含诊断），它只要求"投影 seq 与状态 seq 相等"。

### 5.4 序列空间对齐（`appendFromSeq` / `persistCoreEvents`）

**缺陷（P1 6 节点链暴露）**：旧 `persistCoreEvents` 要求 `event.seq === store.revision + 1 + i`，
把「core 的本地序号」和「journal revision（含诊断事件）」当成同一空间。恢复后 core=27、N4=39，
于是永远写不进去（工具侧表现为 `persistence:null`、records 停在 39）。

**契约**：

```ts
Store.appendFromSeq(baseSeq: number, inputs: AppendInput[], opts?: { cursorName?: string; ts?: string })
  : Promise<AppendFromSeqResult>
// { baseSeq, baseRevision, cursorBefore, appended, revisionAfter, cursorAfter, wroteCursor, cursor? }

Store.cursorOf(name?: string): CursorRecord | null          // { name, coreSeq, revision, at }
Store.adoptCursor(coreSeq: number, name?: string): Promise<{ changed, cursor }>

persistCoreEvents(store, events, opts?: { baseSeq?, cursorName?, at? })
  : Promise<{ baseSeq, baseRevision, appended, revisionAfter, cursorAfter }>

restoreCoreJournal(store, coreJournal, opts?: { includeDiagnostics?, adoptCursor?, cursorName? })
  : Promise<{ restored, coreSeq, revisionBefore, revision, cursor, adopted }>
```

| 规则 | 行为 |
|---|---|
| 历史保留 | 只追加；不重写既有记录，不出现 revision 回退 |
| 新记录位置 | journal `seq` 从 `max(revision, baseSeq) + 1` 起（`baseSeq > revision` 直接拒绝） |
| 幂等 | `baseSeq === 游标` 且无新事件 → 不写盘，直接返回映射 |
| 重复/回退 | `baseSeq < 游标` → `STATE_SEQ_GAP` |
| 中间缺口 | `baseSeq > 游标` → `STATE_SEQ_GAP`（提示先补区间） |
| core 领先 | `baseSeq > revision` → `STATE_SEQ_GAP`（N4 缺历史，必须对账） |
| 映射持久化 | 每次成功追加写一条 `cursor_aligned{name, baseSeq, coreSeq}`，重开即恢复 |
| 回灌口径 | `restoreCoreJournal` 默认只灌**业务事件**（诊断事件不进 core），并认领游标 |

对应验收用例 [K]（4 项）：恢复 27 / revision 39 / 追加 12 不拒绝且 revision 单调；重开继续追加；
重复/回退/缺口/core 领先被拒；**6 节点链 node 模式重载 counts=6、done=6、replay==snapshot、fingerprint 稳定**。

### 5.1 与 N3 core 的字段映射（`bridge.ts`）

N3 `core/types.ts` 全 snake_case（Python 同名），N4 磁盘格式 camelCase；两边都不改命名，
由 `bridge.ts` 双向转换：

| N4 | N3 / Python | 说明 |
|---|---|---|
| `JournalRecord.eventId` | `EventRecord.event_id` | 都是 `EVT-%06d` |
| `JournalRecord.nodeId` | `EventRecord.node_id` | |
| `GraphNode.evidenceRequired` | `NodeRecord.evidence_required` | `reducer` 同时接受两种拼写 |
| `GraphNode.decisionId` | `NodeRecord.decision_id` | 同上 |
| `GraphNode.verifierIds` | `NodeRecord.verifier_ids` | 同上 |
| `GraphNode.createdAt/updatedAt` | `created_at/updated_at` | 同上 |
| `GraphEdge.fromId/toId` | `Edge.from/to` | `toCoreEdge()` |
| `SnapshotMeta.journalBytes` | —（N4 私有） | 三元锚 |
| `LeaseRecord.fencingToken` | `Lease.fencing_token` | 语义相同（单调） |

写入协议（fail-closed）：
1. core 产生事件 → `persistCoreEvents(store, events)`；
2. 校验 `event.seq === store.revision + 1 + i`，不连续 → `STATE_SEQ_GAP`（提示先 `restoreCoreJournal()`）；
3. 通过则 `Store.appendBatch()` 一次 write + 一次 fsync，成功后增量折叠进 `Store.state`；
4. 重启时 `restoreCoreJournal(store, core.journal)` 把 journal 回灌 core 内存日志，之后 core 的 seq 继续对齐。

### 5.2 Store 语义（N2 `l0control` 可直接调）

| 动作 | 语义 | 失败模式 |
|---|---|---|
| `Store.open({dir, fs, owner, ttlMs})` | 取锁 + 恢复 + 折叠；**遇活锁默认等待 5s**（指数退避 25→500ms，等待期间只读锁、不抢） | 预算耗尽 → `STATE_LOCKED`（detail 含 `holder/heartbeatAt/ttlMs/waitedMs/attempts`）；`waitMs:0` 立即失败 |
| `Store.waitForUnlock({dir,fs,timeoutMs})` | 只等锁、不开 Store → `{released,waitedMs,attempts,stale,holder}` | 超时 `released:false` |
| `Store.readLock({dir,fs,now})` | 只读锁文件（诊断） | — |
| `Store.open({... , takeover:true})` | 锁**过期**才抢占（epoch+1，写 `writer_taken_over`） | 未过期 → `STATE_LOCKED`（TTL 内不抢活写者，可能正在 close） |
| `append/appendBatch` | 单写者、一次 fsync、增量折叠 | 锁易主 → `STATE_FENCED_OUT`（写前读盘校验 epoch） |
| `checkpoint({sessionId,lastSeq})` | 不可变检查点文件，含 `stateSha256` | 同 seq 幂等返回 |
| `takeover(owner)` | 显式签发新 fence token | 竞争失败 → `STATE_LOCKED` |
| `snapshot()` | CAS 落快照，已同步则零写入 | `STATE_STALE_VERSION` |
| `verify()` | `fold(records) == 内存状态` | 返回 `{ok,replayedSha,memorySha}` |

## 6. 恢复流程（已实现，`recovery.ts`）

```
Journal.open(dir)                  # 取锁（createIfAbsent + 心跳 + TTL）、读全量、尾部半行截断、校验哈希链
  → fold(records)                  # 权威状态 = 全量折叠
  → readSnapshot
      缺失            → 建快照（source=journal+bootstrap）
      seq 超前        → STATE_SNAPSHOT_AHEAD（停）
      内容/锚不符      → journal 胜：追加 snapshot_diverged + 重写快照（diverged=true）
      一致且落后       → 快照基线 + 增量重放（source=snapshot+replay），全量复核相等后推进快照
      一致且同步       → 不写快照（幂等）
```

不变量：
1. `revision` 单调且 `=== seq`；事件号由 seq 派生，修复后不复用。
2. `fold(records) == state`（同一 seq）；快照落盘后 `stateSha256` 自校验。
3. 任何"历史被改写/截断/超前"都 fail-closed，不静默拿快照反推 journal。

## 7. 验收对应（task-13）

| 验收项 | 证据 |
|---|---|
| 双写被拒 | `self-test.ts` [A] 第 2 项、[F] 第 2 项（`STATE_LOCKED`）；锁文件 CAS + 心跳 + TTL；`guardWriter()` 写前读盘校验 epoch → 旧 writer `STATE_FENCED_OUT` |
| revision 单调 | [A] 第 1 项；`seq` 由 `last().seq + 1` 派生，批量追加一次 fsync；[J] 强杀后 `revision = 业务条数 + 诊断条数` |
| 强杀后 journal 重放 == 快照 | **[J] 真实 SIGKILL**：子进程提交 5 条后被杀 → 锁残留 → 等 TTL → `takeover`（epoch=2）→ 业务记录恰 5 条、无丢失无重复、`verify().ok`；再注入半行 → `droppedLines=1`、`revision` 回到已提交边界。另有 [C] 半写截断、[E] `snapshot+replay` 一致 |
| 投影可重建 | [G] 三项：纯函数哈希稳定、`seq-advanced` 后重建（含 upsert/remove 增量）、`diffProjection` 发现缺失/多余/改值 |
| 与 Python 差分 | **[I] 同夹具差分 = 0**（statuses/assignee/attempts/edges/eventId 格式）；oracle 自洽(`snapshotEqualsReplay=true`)；差分口径见 §4 |

## 8. 接入约定（给 N2 / N3 / N5）

- 状态目录默认 `<workspaceRoot>/.l0-control/state`，由 Config 注入（N2）。
- `Store` 只暴露 `append(kind, payload, opts)`；**不要**直接写 `journal.jsonl`。
- 需要"done 事务原子性"时：先 `append` 全部事件（单次 `appendBatch`）再更新 TeamTask 投影；
  投影失败不回滚 journal，靠 `projection.rebuild()` 重放补齐。
- 后台循环请调用 `Store.snapshot()` / `Store.checkpoint()` 而非自己拼文件。

## 9. 交付清单 / 复现 / 限制

### 9.1 文件

| 路径 | 说明 |
|---|---|
| `src/state/types.ts` | 契约、错误码 |
| `src/state/canonical.ts` | 规范序列化、哈希链、`EVT-%06d`、ISO 时钟 |
| `src/state/fs-port.ts` | Node / Memory / DSH `fs` 三实现 |
| `src/state/journal.ts` | 单写者 JSONL、锁、心跳、尾部修复、栈内抢占 |
| `src/state/reducer.ts` | 默认折叠器（可被 N3 覆盖），双拼写兼容 |
| `src/state/snapshot.ts` | CAS 快照 + 三元锚 + 锚比较 |
| `src/state/recovery.ts` | 恢复判定（bootstrap / ahead / diverged / replay） |
| `src/state/store.ts` | 门面、fencing、检查点、`verify()` |
| `src/state/projection.ts` | TeamTask 投影（纯函数 + 重建 + 差异） |
| `src/state/bridge.ts` | core/Python 互操作（seq 连续性校验） |
| `src/state/python-diff.ts` | 与 oracle 的差分器 |
| `src/state/fixtures/python-replay.json` | oracle 夹具（内存 SQLite 生成） |
| `src/state/crash-child.ts` | 真实强杀用例子进程 |
| `src/state/self-test.ts` | 29 项可执行验收 |
| `src/state/README.md` | 目录内速查 + 接入片段 |

### 9.2 复现

```bash
node plugins/dsh-l0-control/src/state/self-test.ts        # 29 passed, 0 failed（连跑两次一致）
node plugins/dsh-l0-control/scripts/build.mjs --check     # 类型剥离兼容性（只读）
```

### 9.3 已知限制（诚实清单）

1. **无类型检查**：本机无 `tsc`，`build.mjs` 只做类型剥离；`strict` 只是 tsconfig 声明，未实际执行。
2. **NodeFsPort 的 CAS 是"内容哈希 + 预写复查 + 原子 rename"**，不是内核级 CAS；
   跨进程互斥由锁文件承担，CAS 只负责"拒绝明显陈旧覆盖"。宿主 `DshFsPort` 才是真 `FsVersion` CAS。
3. **宿主 `fs` 无 append**：`DshFsPort.append()` 是读写重试（O(n)），journal 很大时应改用 Node 端口。
4. **无日志压缩**：journal 只增，`replay` 全量折叠；后续可加"快照 + 尾部截断"的 compaction（需 CAS + 版本护栏）。
5. **诊断事件占 seq**：业务条数 ≠ revision（§5.3）。
6. **`lib/state/*` 需重新 build**：本 lane 只写 `src/state/`；`python-diff.ts`/`self-test.ts` 改动后
   `build.mjs --check` 会报 `stale`，由 N2 跑一次 `node scripts/build.mjs` 同步。
7. **未接 agentTeams**：投影只产出 `{upsert,remove}` 计划，真正的 `createTask/updateTask` 由 N1/N5 调用。

## 10. 与上游变化的关系（2026-10-29 21:20 后）

R1 报的两个缺口已在 oracle 侧修复（`control_plane/graph.py` 引入 `set_status()` 唯一入口、
`status_changed` 后像、`assignee_changed`，并新增 `engine/runtime/ledger/cli`）。
N4 的 reducer/`bridge` 与之对齐，差分 = 0；本 lane 不再把"Python 丢 assignee"当作现役差异，
但**保留了哈希链、前缀锚、尾部修复、epoch fencing 这些 oracle 没有的加固**（它们不在差分口径内）。
