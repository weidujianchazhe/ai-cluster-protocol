# DSH 原生插件 · 验收记录（2026-10-29）

> 计划：`designs/_research/DSH原生插件-60轮长任务.md`
> 目标：一个 **DSH 原生控制面插件**，直接使用 `agentTeams` / `subagents` / `sessionController` / `tools`；TeamTask 是投影，插件 journal 是权威；Python `control_plane/` 冻结为 oracle。

## 门禁（全部实测）

| 门禁 | 结果 |
|---|---|
| 插件自检 `scripts/selftest.mjs` | **16/16** |
| 工具契约 `scripts/contract.mjs` | **19 checks / 0 failed** |
| 原生团队 `tests/e2e/native-real/check.mjs` | **13/13 + identity 7/7**（6 节点全链 done，2 CODE + 2 AUDIT） |
| 统一身份链 `chain-unified.mjs` | **6/6**（全小写 `role-code-01` / `role-audit-code-01`，6 节点 done） |
| 持久化 `npm run persistence` | **8/8**（6 节点全链 + 两代次重载；counts {6,5,6,0}、coreCursor==core 事件数、replay==snapshot、fingerprint 稳定） |
| e2e conformance `tests/e2e/conformance.mjs` | **7/7 PASS，state=pass，exit 0** |
| Python oracle `unittest discover` | **308 tests OK** |
| schema fixture | **23/23** |

conformance 明细：adapter（14 工具 / grades 8-3-3）｜crud_wish 35/35｜failure_replan 23/23｜G5 真实 8/8｜native:branch 15/15｜native:chain 6/6 节点 done｜oracle:diff = 0。

## 原生能力（已验证）

| 能力 | 证据 |
|---|---|
| `agentTeams` 投影 | `board_task_create` → TeamTask（nodeId 映射）→ claim → complete；`team_status` 读 9 成员/15 任务 |
| `subagents` 真实执行 | `agent_spawn` 起 ROLE-CODE-01/02 + ROLE-AUDIT_CODE-01，sessionId 全不同 |
| 原生通信 | `agent_message{awaitOutput:true}` → inspect 轮询到 turn/end，回执 `CODE-01 R2` / `PRD-DRAFT-OK`，不串号 |
| 真实全链 | 6 节点 research→PRD→contract→build→audit→deliver 全 done；2 CODE + 2 AUDIT；五段闸门 passed |
| 证据/done | 真实 producer/auditor，`EVD-*` pass → submitted → verify_done → done，解锁下游 |
| 审计独立 | producer `ROLE-CODE-01/02` ≠ auditor `ROLE-AUDIT_CODE-01`；同实例被拒 |
| 阶段闸门 | `pass_gate(stage, evidence_refs)`；未过闸门 `credential-unavailable`，不伪造 |
| 职务编队 | 8 生产 / 3 审计 / 复合模板；`agent_card` roles；审计独立机检 |
| 持久化 | JSONL journal + 快照三元锚；node 模式重开恢复 nodes/edges/gates；SIGKILL 恢复 |
| 失败语义 | 无 acceptance 且无 verdict → `unknown`/`acceptance-required`；unknown 不 pass |

## 架构

```
DSH Host
├─ plugin dsh-l0-control (TS)
│  ├─ 14 工具：wish_submit / graph_status / task_next / task_claim
│  │          / evidence_submit / verify_done / pass_gate / decision_record
│  │          / team_status / agent_spawn / agent_message
│  │          / board_task_create / board_task_update / graph_export
│  ├─ core：graph/ready/evidence/done/decisions/leases/stages/fold
│  ├─ native：agentTeams（task 投影）+ subagents（真实实例）
│  ├─ state：JSONL journal + fs CAS + snapshot/recovery
│  └─ service：l0control
└─ Python control_plane（oracle，8 项差分 = 0）
```

## 关键限制（如实）

1. `agentTeams.spawnTeammate` 仅 **Lead** 可调；插件已在 Lead 入口走该路径（实测 `ROLE-SMOKE-01`，`via:'spawnTeammate'`），非 Lead 自动回退 `subagents.startActivation`。Host `agent-team.maxMembers` 已从 bundle 的 8 在 profile 覆盖为 **16**。
2. `board_task_update` 的 `reassign` 仅 Lead 可调；已实测 Lead `reassign(task-24, owner=role-code-01)` 成功（ownerName=role-code-01）。图 assignee 仍用 subagent 角色实例，**角色到 Team member 的映射**可按任务接入。
3. `awaitOutput` 默认 120s；长任务需传 `timeoutMs`。
4. 真实团队链已验证 **6 节点**（2 CODE + 2 AUDIT；审计节点由第二个审计实例交叉复核，未绕过门禁）。
5. 默认 persistence=`memory`；node 模式 6 节点 + 重载 8/8 已验证。
6. 工具名需避让宿主同名（`agent_*`/`board_task_*`/`graph_export`/`decision_record`）。

## 统一身份（A，2026-10-29）

用户选择 A：**角色实例与 Team member 使用同一名字**。

- `roleInstanceId` 改为小写 `role-<role>-<nn>`（`AUDIT_CODE → role-audit-code-01`），`memberName` 与 instanceId 相同；
- core `parseInstanceId` 接受小写与旧大写，归一 canonical；`role-code-01` ≡ `ROLE-CODE-01`；
- Lead 调 `agent_spawn` → `via:'spawnTeammate'`、`instanceId=role-code-21`、`memberName=role-code-21`、`ownerCapable:true`；
- `agent_message{awaitOutput:true}` → `via:'agentTeams.sendMessage'`，回执 `UNIFIED-ID-OK`；
- `chain-unified.mjs` 用统一 ID 跑 6 节点全链 6/6；board owner 可用同一 memberName。

## 收口记录（2026-10-29 补充）

- **宿主名额已提高**：`agent-team.maxMembers` 在 profile `cordis.patch.yml` 覆盖为 **16**（bundle 原 8），新 teammate 可正常 spawn。
- **`agentTeams.spawnTeammate` 已真实走通**：Lead 调 `agent_spawn(role=SMOKE)` → `via:'spawnTeammate'`、`instanceId ROLE-SMOKE-01`、`memberName role-smoke-01`；随后 `agent_message{awaitOutput:true}` → `via:'agentTeams.sendMessage'`，回执 `SPAWN-TEAM-OK`。
- **Lead 侧 owner reassign 已走通**：`board_task_create` → task-24 → `board_task_update(reassign, owner=role-code-01)` → ownerName=`role-code-01`，随后 complete（rev3）。
- **子 Agent 自主调用工具：已验证**。`ROLE-AUTO-01` 自主调用 `task_next(role=CODE)`，回执含 `{ok:true, action:'task_next'}`；说明子 Agent 能直接使用插件工具。
- **结论**：spawnTeammate / agentTeams.sendMessage / Lead reassign 三条原生路径均已实测；剩余是“图角色实例 ↔ Team member 名字”的映射接线，不是权限阻断。

## 生产化与全自主（2026-10-29，30 轮）

| 模块 | 落地 |
|---|---|
| 鉴权/多租户 | `src/security`（9 角色×20 动作矩阵、能力令牌、默认拒绝、审计带 actor/tenant）+ `src/tenancy`（tenant 路径/读写/导出过滤）；service `authorizeWithAudit` 前置 14 工具 |
| 观测 | `src/observability`（指标/健康/6 条告警/脱敏导出）；`graph_status.observability`；真实链 tokens 20500、cost 0.137、retries 2、4 条告警 |
| 全自主 | `src/native/worker.ts`（角色目录/白名单/prompt/退避/心跳）；6/6 节点由 worker 自驱，协调者 0 次 claim/evidence/verify；audit 实例 claim∪verify 参与 ≥2 |
| A2A | `src/a2a`（Agent Card、REST create/get/cancel、**JSON-RPC 2.0 POST /a2a**、幂等、鉴权、409/404/405）；`src/wiring/a2a-port.ts` 接 core；`tokenSecret` 非空才启动 |
| A2A JSON-RPC | **42/42**：`message/send` / `tasks/get` / `tasks/cancel`；`-32700/-32600/-32601/-32602`；同 `messageId` 重放不重复建 |
| 配置 | `tenant`(default)、`tokenSecret`、`lockWaitMs`(**15s**)、`lockTtlMs`(**30min**)、`a2aHost`/`a2aPort` |

**关键命令**：
```
node plugins/dsh-l0-control/tests/e2e/autonomy/check-autonomy.mjs \
  .l0-control-autonomy-2/journal.jsonl .l0-control-autonomy-2/core-state/journal.jsonl
npm run persistence --prefix plugins/dsh-l0-control
node plugins/dsh-l0-control/tests/e2e/a2a/run.mjs
```

## 剩余（生产化可选）

- A2A 的 streaming / push notification（当前 REST + JSON-RPC 非流式，Card 声明 streaming=false）。
- 企业 SSO / 多租户管理后台；真实 tokenSecret 的 live A2A 冒烟（单测已真起 HTTP，默认关闭服务）。
- 子 Agent 全 6 节点自主循环已在隔离 state 验证；`lockTtlMs=30min`、`lockWaitMs=15s` 按本仓实测数据取整留余量（见下）；`dispose→persistence.close()` 已接线。

## 锁参数取值依据（本仓实测）

| Journal | 记录数 | 跨度 | 最大空闲间隔 | >5min 间隔 |
|---|---:|---:|---:|---:|
| `.l0-control/journal.jsonl` | 197 | 81.3min | **522.4s（8.7min）** | 4 |
| `.l0-control-autonomy-2/journal.jsonl` | 59 | 16.6min | 340.0s（5.7min） | 1 |
| `.l0-control-autonomy-2/core-state/journal.jsonl` | 111 | 10.8min | 141.9s | 0 |

取值：
- `lockTtlMs = 1_800_000`（30min）= **3.4×** 最大实测空闲 8.7min；整数、留足 2 个长回合余量。
- `lockWaitMs = 15_000`（15s）= **3×** 旧 5s，覆盖 disable→enable 的 close/快照窗口。
- 若生产单 Agent 回合 >20min，按 `TTL ≥ 3× 最大回合` 上调到 45–60min，或加心跳；不要手工删 `journal.lock`。
- 观察 `writer_taken_over` / `STATE_LOCKED` / `lease_expired`；`dispose` 必须等 `plugin_dispose_result.closed===true` 再 enable。
