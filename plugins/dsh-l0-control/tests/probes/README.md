# 性能探针

> 这些不是验收测试，是**一次性调查工具**：先测，再决定改不改。
> 它们**不在 `npm run verify` 里**，跑一遍要几十秒到一分钟。

## 为什么单独放一个目录

它们原先散落在 `tests/` 根目录、带 `_` 前缀、零引用——看起来像临时垃圾，但**记录了改之前的真实数据**（比如「10 万节点冷启动 15.5 秒」）。删掉就再也测不出「改之前是什么样」了。

所以移到 `probes/`、去掉 `_` 前缀、加这份说明：**它们是有据可查的调查记录，不是残留**。

## 怎么跑

```bash
node tests/probes/probe-status-cost.mjs        # 单个跑
```

都依赖内部 API（`lib/core/*`、`lib/state/*`），**API 变了它们会坏**——而且因为不在验收链里，坏了不会有人发现。

> **实测过一次**：`probe-recovery-redundancy.mjs` 因为 `journal.rawText()` 从同步变成 `async` 而崩了（把 Promise 传给了 `Buffer.byteLength`）。没人发现，直到这次整理才修。
> 所以改动内部 API 时，**要么顺手修这些探针，要么把它们标注为过时**。

## 九个探针

| 探针 | 测什么 | 耗时 | 状态 |
|---|---|---|---|
| `probe-spread-forms.mjs` | 「数组字面量展开」与「函数实参展开」的栈行为差异 | 0.2 s | ✅ |
| `probe-spread-limit.mjs` | `push(...arr)` 在多大批量上炸栈 | 0.2 s | ✅ |
| `probe-lease-reap.mjs` | worker 崩溃后节点会怎样（**修之前**的行为记录，保留作对照） | 0.5 s | ✅ |
| `probe-status-cost.mjs` | `Journal.status()` 的 `bytes` 字段有多贵 | 12.5 s | ✅ |
| `probe-snapshot-format.mjs` | 快照用 `JSON.stringify(file, null, 2)` 存，值不值 | 18.1 s | ✅ |
| `probe-open-breakdown.mjs` | 10 万节点冷启动 15.5 秒花在哪一段 | 19.0 s | ✅ |
| `probe-cp-open.mjs` | `CorePersistence.open()` 里 N4 之外那部分花了多少 | 21.8 s | ✅ |
| `probe-journal-scale.mjs` | journal 在 10 万节点量级的真实代价 | 53.0 s | ✅ |
| `probe-recovery-redundancy.mjs` | `recoverWithJournal()` 内部的重复计算有多少 | 13.2 s | ✅（修过 await） |

## 一条已经确定的结论（`probe-recovery-redundancy`）

在 10 万节点 / 100 MB journal 上实测：

```
合计 13107 ms
其中快照相关（第 4–14 步）  10056 ms

纯重复计算：
  #7  foldUntil 到末条 = fold         183 ms
  #12 fold #3 与 #1 同输入            178 ms
  #14 fold #4 + 两次 canonicalJson   1213 ms（恒为 true）
可共享：
  #8/#11 的四次 canonicalJson        2079 ms 只为一个比较
```

**结论原文**：

> 快照作为「加速手段」在 10 万节点规模上是**负收益**——journal 的哈希链校验与全量折叠无论如何都要跑，快照只能省下增量重放，而增量重放本身只要 2.329 ms。

这条结论**没有落地成改动**（快照机制仍在）。要动它属于架构变更，需要单独决策。

## 与验收链的分工

| | 验收链（`npm run verify`） | 探针（`probes/`） |
|---|---|---|
| 判据 | 断言（对/错） | 打印数据（快/慢） |
| 稳定性 | 必须每次都过 | 允许随环境波动 |
| 谁跑 | CI / 每次改动 | 只在要优化某处时手动跑 |
| 坏了怎么办 | 必须修 | 可以标注过时 |

## 另外五个（原在 `tests/e2e/scale/`，也并入这里）

| 探针 | 测什么 | 耗时 |
|---|---|---|
| `probe-e2e-action-cost.mjs` | 2000 节点为什么比 1000 节点贵（7.90 → 10.66 ms/节点） | 1.3 s |
| `probe-e2e-op-cost.mjs` | 为什么 1000 节点时每步 ~25 ms 而 60 节点时 ~4 ms | 1.3 s |
| `probe-e2e-file-limit.mjs` | 单文件 journal 的**硬上限**在哪 | 6.5 s |
| `probe-e2e-graphstatus.mjs` | `graphStatus(limit=1)` 在 1000 节点上那 24 ms 花在哪 | 6.5 s |
| `probe-e2e-withcore.mjs` | 服务层每步 ~1.7–1.8 ms 里，`withCore` 外壳占多少 | 8.7 s |

它们原本和 `tests/e2e/scale/run.mjs` 放在一起，但**零引用、git 未跟踪**——和 `run.mjs` 不是一回事。移到 `probes/` 后 `e2e/scale/` 只剩 `run.mjs`。

## 一个已经踩过的坑：tmp 清理

有 7 个探针用 `os.tmpdir()` 造数据。原先它们自己写 `try { fs.rmdirSync(t) } catch {}` —— 目录小时碰巧能删，**一旦像 `probe-recovery-redundancy` 那样写 156 MB 就删不掉**，而且它自己还打印「临时目录已清理」。

实测：跑 3 次留了 **469 MB** 残留（`.l0-probe-recov-*` × 3），只有泄漏闸门能发现。

**现在全部改用 `removeTempDir`（`_temp-state.mjs`）**，失败会打印「临时目录未删净，需手动清」。
