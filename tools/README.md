# 会话返工分析

> 把「哪里最费劲」这个直觉判断，换成数据。

## 一、它解决什么问题

人（和模型）对「返工在哪里」的判断经常是错的。实测一次：

| 我的主观判断 | 真实数据 |
|---|---|
| 最大返工来源是「PowerShell 拼 `node -e` 的引号地狱」 | **pwsh 失败率 0.1%**（2965 次调用，失败 3 次） |
| 没提 edit | **edit 2147 次 / 失败 155 次 / 占全部失败 71%** |

主观判断错了 5 倍以上。这个工具就是用来把这种判断换成数据的。

## 二、怎么跑

```bash
# 给会话目录（自动找 session.v4.jsonl.zstd）
node tools/analyze-session.mjs "%USERPROFILE%\.dsh\sessions\<workspace-dir>"

# 给具体某个会话
node tools/analyze-session.mjs "%USERPROFILE%\.dsh\sessions\<workspace-dir>\<session-dir>"

# 给已解压的 jsonl
node tools/analyze-session.mjs path/to/session.jsonl

# 机器可读
node tools/analyze-session.mjs <target> --json

# 自定义深度
node tools/analyze-session.mjs <target> --top 20
```

**实测性能**：45 MB 压缩 / 141 MB 解压 / 5.7 万行 → **2.8 秒**。

## 三、它算什么

| 维度 | 输出 |
|---|---|
| **工具失败率** | 每个工具被调用几次、失败几次、失败率 |
| **错误类型聚类** | 错误文本归一化后（路径/数字/引号内容→占位符）聚类计数 |
| **重复操作的文件** | 同一路径被 read/edit/write 的次数 |
| **重复命令** | 同一命令指纹（去空白后前 90 字）被执行 ≥3 次 |

## 四、实测输出（一个 5.7 万行的真实会话）

```
行数 57074 / 工具调用 8587 / 有结果 8761 / 失败 219
总体失败率 2.5%

工具                    调用    失败   失败率
edit                     2149    155    7.2%
read                     1550     18    1.2%
write                     502     17    3.4%
working_directory           8      6   75.0%
grep                      376      4    1.1%
pwsh                     2965      3    0.1%

错误类型（Top 4，合计 157 次 = 全部失败的 72%）：
   46 × Error: old_string was not found in "<S>"
   45 × Error: cannot edit: file changed since it was read — re-read the file, then retry
   38 × Error: cannot modify: file has not been read — read the file, then retry
   28 × Error: old_string and new_string must differ
```

## 五、四类错误其实是同一件事

| 错误 | 根因 |
|---|---|
| `old_string was not found` | 凭记忆写 `old_string` |
| `file changed since it was read` | 读完之后又发生过修改 |
| `has not been read` | 跳过读直接改 |
| `must differ` | 想改的其实已经是那样了（记忆与现状不符） |

**全部指向：在「凭记忆改文件」，而不是「读当前内容后改」。**

一条规则能挡掉这 72%：

> 动手前先读，且**从刚读到的内容里复制** `old_string`，不凭记忆拼。

## 六、为什么需要外部 zstd

会话文件是**多帧 zstd**（一个文件里几千个独立帧拼接，每帧一小段）。前 200 KB 里就有 **94 个帧头**。

Node 24 的 `zlib.zstdDecompressSync` 和 `createZstdDecompress` **都只解第一帧**：

```
45 MB 文件 → 只解出 210 字节（就是会话头那一行）
```

实测确认，两种 API 都一样。所以工具调外部 `zstd` 可执行文件，解压到临时文件再流式读。

**找 zstd 的顺序**：`ZSTD_BIN` 环境变量 → PATH → 常见安装路径（msys64 / chocolatey）。

都找不到时**明确报错并给出两条替代路径**（装 zstd，或先手动解压成 `.jsonl`），不假装成功。

**为什么不走管道捕获 stdout**：某些沙箱里 `stdio: 'pipe'` 会 EPERM。走 `-o` 落盘 + 后续流式读取绕开这个问题。

## 七、它不算什么

| 不是 | 原因 |
|---|---|
| **不是因果** | 失败率高不代表工具差——可能它被用在最难的地方（`edit` 就比 `read` 危险得多，因为它要看懂当前内容） |
| **不是产出质量** | 这是**过程指标**（失败次数），不是产出好坏 |
| **不能与插件质量分混算** | 会话记录里没有 `deps` / `evidence` / `provenance`，数据源不同 |

插件侧的 `quality_report` 看的是**节点**（有证据、有审计、有返工分因）；这个工具看的是**会话**（有工具调用、有错误、没有节点结构）。**两者不能相加，也不能互相替代。**

## 八、能问出什么

| 问题 | 看哪个输出 |
|---|---|
| 哪个工具最容易出错 | 工具失败率排行 |
| 出错集中在什么原因 | 错误类型聚类 |
| 哪些文件最折腾人 | 重复操作的文件 |
| 哪些命令在空转 | 重复执行的同一命令 |

**不能回答**「这个会话做得好不好」——那需要独立的验收标准，会话记录里没有。

---

**相关**：[10 质量度量](../docs/10-质量度量.md)（节点侧的质量分）· [09 测试与验收链](../docs/09-测试与验收链.md)（项目自己的验收怎么跑）
