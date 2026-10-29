# `state/` · 控制面状态层（Lane N4）

权威状态 = **单写者 JSONL journal（哈希链 + revision）**；快照/检查点/TeamTask 投影都是可重建缓存。
无第三方依赖、无构建步骤（Node ≥ 22.6 直接跑 `.ts`）。

```
journal.jsonl   只追加，每行一条记录，hash 链
journal.lock    单写者锁：{pid, host, owner, epoch, heartbeatAt, ttlMs}
snapshot.json   fs CAS 发布的物化状态（三元锚：journalBytes / journalHash / stateSha256）
checkpoints/    不可变检查点 CKPT-<seq>-<sha8>.json（含 sessionId / lastSeq 锚）
projection.json TeamTask 投影（seq + projectionHash，不是第二事实源）
```

## 跑测试

```bash
node plugins/dsh-l0-control/src/state/self-test.ts      # 29 passed
```

覆盖：单写者/双写拒绝、哈希链篡改、torn tail 修复、快照 CAS、恢复判定（快照超前/落后/分歧）、
Store 门面、takeover + fencing、检查点、投影重建、core 互操作、Python oracle 差分、**真实 SIGKILL**。

## 用法（N2 `l0control` / N5 e2e 直接抄）

```ts
import { NodeFsPort } from './state/fs-port.ts';
import { Store } from './state/store.ts';
import { NodeFsPort, Store, persistCoreEvents, restoreCoreJournal, rebuildProjection } from './state/index.ts';

const store = await Store.open({ dir: '<workspace>/.l0-control/state', fs: new NodeFsPort(), owner: 'lead' });

// 1) 恢复：journal 的**业务事件**回灌 core（诊断事件不进 core），并认领 core 游标
const restored = await restoreCoreJournal(store, coreJournal);
// restored.coreSeq 可能 ≠ store.revision（revision 还含诊断事件）——这是正常的

// 2) 落盘：以 core 的 seq 为基准追加，不看 revision
const cursor = store.cursorOf('core')?.coreSeq ?? 0;
const pending = coreJournal.raw().filter((event) => event.seq > cursor);
await persistCoreEvents(store, pending);        // 内部 = store.appendFromSeq(cursor, …)

// 3) 投影（TeamTask）按需重建
await rebuildProjection(new NodeFsPort(), store.paths, store.state, {
  at: new Date().toISOString(),
  writer: async ({ upsert, remove }) => { /* agentTeams.createTask/updateTask */ },
});

// 4) 检查点 + 正常关闭
await store.checkpoint({ sessionId, lastSeq });
await store.close();
```

### 两个序列空间（最容易踩的坑）

| 空间 | 含义 | 谁维护 |
|---|---|---|
| `JournalRecord.seq` / `store.revision` | 磁盘位置，含诊断事件（`writer_taken_over`/`snapshot_diverged`/`cursor_aligned`） | N4 |
| `CoreEventRecord.seq` | core 内存日志的业务计数 | N3 core |

二者**不要求相等**。`persistCoreEvents(store, events, {baseSeq})` 与 `Store.appendFromSeq(baseSeq, inputs)`
以 `baseSeq` 为基准：新记录在 journal 里落在 `max(revision, baseSeq) + 1`，并写 `cursor_aligned` 持久化映射；
重复/回退/缺口/core 领先一律 `STATE_SEQ_GAP`。

## 不变量

1. `revision === seq` 单调；`eventId = EVT-%06d` 由 seq 派生，尾部修复后不复用。
2. journal 只追加；`hash` 链断 / seq 跳号 / 中间行损坏 → fail-closed，绝不静默修复中间段。
3. journal 是权威：快照只在"与重放一致"时被采用；快照超前 → 拒绝启动；内容分歧 → journal 胜并留痕。
4. 单写者：活锁 `STATE_LOCKED`；过期锁只能经 `Store.open({takeover:true})` 或 `Journal.stealStaleLock(token)`；
   抢到的 writer 之后所有 `append` 都读盘校验 epoch，旧 writer 一律 `STATE_FENCED_OUT`。
5. `fold(records) == Store.state`（`store.verify()` 可随时机检）。
6. 投影可从状态纯函数重建，`proj 失败`不回滚 journal。

## 与 core / Python 的边界

- core 定义业务词汇与规则；本层不解释业务语义（默认 reducer 可被 `StoreOptions.fold` 覆盖）。
- 字段拼写：磁盘 camelCase，core/Python snake_case，`bridge.ts` 双向转换（映射表见
  `control_plane/lanes/n4-state-recovery.md` §5.1）。
- 诊断事件（`writer_taken_over` / `snapshot_diverged`）也占 seq → 业务条数 = `revision − 诊断条数`。
