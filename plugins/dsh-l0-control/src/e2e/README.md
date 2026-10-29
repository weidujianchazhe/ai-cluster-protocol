# N5 · e2e 与 UX · 设计草案（契约优先）

> Lane N5（预算 6 轮）· 计划：`designs/_research/DSH原生插件-60轮长任务.md` P4
> 写域：本目录 + `tests/e2e/` + `control_plane/lanes/n5-e2e-ux.md`
> **本文是草案**：N2（插件骨架）/N3（核心不变量）/N4（状态恢复）未落地前，先把**契约、场景、断言**写死，等依赖信号到了直接联调。

---

## 0. 为什么先写契约

N5 要验的是"整条链自己能跑完"，但链上每一环都归别人：

| 环 | 归属 | 我需要的稳定面 |
|---|---|---|
| `wish_submit` → 图 | N2（tools）+ N3（graph） | 工具名/入参/返回结构；图 JSON 形状（`graph_id/nodes/edges/stage_gates`） |
| 按职务 spawn 真实 Agent | N1（spike 已验证）+ N2 | 实例 ID 约定 `ROLE-<ROLE>-<NN>`；spawn 返回的 handle 字段 |
| TeamTask / 消息派发 | N2（agentTeams 投影） | TeamTask id ↔ node_id 映射；`sendMessage` 的 target 语义 |
| 证据 / 验证 / done | N3（evidence/done 事务） | `evidence_submit` 契约；done 拒绝码 |
| journal / 恢复 | N4 | 事件形状（`event_id/ts/actor/kind/refs`）；快照 revision |
| 导出 / prompt / 命令 | N2 + 本 lane | `export` 输出清单；prompt section 的注入点 |

**策略**：本目录只定义 **ControlPort（控制面端口）** 这一层接口 + 场景与断言。N2/N3 按此实现即插；实现未到位时用 `mock` 端口跑同一批断言（保证夹具本身是对的，而不是等人到了才第一次跑）。

---

## 1. ControlPort 契约（N2/N3 需要满足的最小面）

见 `port.ts`（纯类型，无 import，不依赖 core 实现）。九个动作对齐计划 §2 的工具清单：

| 动作 | 语义 | 关键约束 |
|---|---|---|
| `wishSubmit(wish)` | 许愿 → 建图 | 返回 `graph_id` + 首版 `graph_version`；**不得**直接产出 done 节点 |
| `graphStatus(graphId)` | 读图 + 阶段闸门 | 只读；含 nodes/edges/gates/version |
| `taskNext(graphId)` | 取 ready 集 | **只由 done 事件驱动**，不轮询（N3 负责） |
| `taskClaim(nodeId, instanceId)` | 认领 | 租约 + fencing；同节点双认领必须被拒 |
| `evidenceSubmit(ev)` | 提交证据 | append-only；同 id 覆盖被拒 |
| `verifyDone(nodeId, credential)` | done 事务 | 证据齐全才 done；否则返回拒绝码且节点回 ready |
| `decide(decision)` | L0–L3 决策 | L2 必须带默认值+超时；L3 必须显式确认 |
| `teamStatus(graphId)` | TeamTask 投影视图 | 投影只读；**不是第二事实源** |
| `export(graphId)` | 人读导出 | 从 journal 生成，不读 TeamTask |

**失败语义**：所有动作返回 `{ok:true, ...} | {ok:false, code, reason}`；`code` 为大写_下划线（沿用 Python oracle 风格，见 `WP10契约增量清单.md` §0 约束 1）。

**actor 约定**（A1 断言依赖它）：每个动作带 `actor: {kind: "agent"|"plugin"|"human", id}`。**e2e 断言要求 wish→done 全程 `kind != "human"`**，除 L3 闸门显式确认。

---

## 2. 场景与断言（验收映射）

夹具在 `tests/e2e/scenarios/`：

| 场景文件 | 覆盖验收条 | 说明 |
|---|---|---|
| `crud_wish.json` | 无人工中继 / 两实例不串 / 审计独立 | 完整 CRUD 闭环：wish → PRD → 契约 → DB → 后端+前端（**两个 CODE 实例**）→ 集成 → 测试 → 独立审计 → 交付 |
| `failure_replan.json` | 失败可 replan | 首轮审计 fail → 节点回 ready → replan 递增 `graph_version` → 只重做受影响子图 → 最终 done |

四条验收的**机检口径**（逐条可断言，不靠肉眼）：

- **A1 全链路无人工中继**：journal 里 `wish_submitted` 之后、`graph_closed`/交付之前，**不存在** `actor.kind == "human"` 的事件，除 `decision.level == "L3"` 的确认事件。命令（slash）本身记 `actor.kind="human"` 但只允许出现在 `wishSubmit` 与 L3 确认两处 → 这条同时防止"用命令手动推进节点"。
- **A2 两个同职务实例不串**：`ROLE-CODE-01` 与 `ROLE-CODE-02` 各自 (a) 持有不同节点的租约；(b) 产物 `producer_instance` 唯一；(c) 消息 `target` 与派发意图一致（无交叉投递）；(d) 一个实例被 kill 后其节点回 ready，另一实例的节点状态**不变**。
- **A3 审计独立**：同一节点 `producer_instance != auditor_instance`；复合实例（含 `AUDIT_*` 职务）不得同时是该节点生产者；缺 auditor → `verifyDone` 拒绝。
- **A4 失败可 replan**：拒绝后节点回 `ready`（attempts+1）；`replan` 事件使 `graph_version` 单调 +1；只有受影响子图重跑（未受影响节点的 `updated_at` 不变）；重跑后 done。

**UX 面**（本 lane 同时交付）：

- **U1 prompt 注入**：`systemPrompt` section 只放**指针与摘要**（node_id / role / evidence_required / 预算），不贴全文；断言 section 文本含这四项且长度 ≤ `PROMPT_SECTION_MAX`。
- **U2 导出**：`export` 产出人读文件（tasks / decisions / capabilities / STATE / INDEX），全部从 journal 生成；断言"删掉 TeamTask 后导出仍一致"。
- **U3 命令**：`/wish` `/status` `/next` `/export` 映射到工具；断言命令不提供"跳过证据直接 done"的路径（命令层做白名单）。
- **U4 conformance 摘要**：一段机器可读摘要，含 8 项 adapter 能力级别 + A7 四态 + 与 Python oracle 的差分条数；断言四态码 `0/1/2/3` 与差分 `== 0`（P2 门禁）。

---

## 3. 依赖门（什么时候能跑真链路）

| 门 | 需要什么 | 谁给 | 我这轮怎么处理 |
|---|---|---|---|
| G1 | `wish_submit` / `graphStatus` 可用 | N2 + N3 | mock 端口先跑（内存图） |
| G2 | 真实 spawn + 实例 ID | N1/N2 | mock 返回伪造实例，只验"不串"的断言逻辑 |
| G3 | TeamTask 投影 | N2 | 断言只读性质；无投影时跳过并标记 `SKIP(no-projection)` |
| G4 | done 事务 | N3 | mock 实现"无证据拒 done"，与 Python oracle 同语义 |
| G5 | journal/快照 | N4 | 断言事件形状；恢复用例标 `SKIP(no-journal)` |

**规则**：跳过必须在报告里显式记为 `SKIP`，**不得**当作 pass（沿用 `unknown ≠ pass` 原则）。

---

## 4. 与 Python oracle 的关系

`control_plane/` 仍是行为基准（计划 §0）。N5 的差分断言不重写业务逻辑，只比对**同一夹具下的可观测结果**：

| 比对项 | 来源 A（TS 插件） | 来源 B（Python oracle） |
|---|---|---|
| done 拒绝/接受 | `verifyDone` 返回 | `evidence.finalize` 行为 |
| ready 集合 | `taskNext` | `scheduler.recompute_ready` |
| 审计独立违规 | `verifyDone` 拒绝码 | `capabilities.audit_independence_violations` |
| 图版本递增 | `replan` 事件 | `stages.record_replan` |

差分 > 0 即阻塞 N5（计划 §6 停止条件），并在报告里给出**具体条目**而不是"有差异"。

---

## 5. 本轮（R1）产出与下一轮入口

**R1 产出**：`port.ts`（端口契约）+ `tests/e2e/` 两个场景夹具 + 断言矩阵（本文件 §2）+ lane note。

**下一轮（R2）入口**：写 `tests/e2e/run.mjs` 的 **mock 端口**跑通两个场景（不依赖 N2/N3），把 A1–A4 的断言第一次真正执行起来；若 N2/N3 已给 G1/G4 信号，则同轮切真端口做首次联调。

**不做**：不碰 `core/`、`state/`、入口（`index.ts`/`cordis.patch.yml`）；不替 N2/N3 定 API 实现细节，只给契约与断言。
