# Lane N1 · DSH 原生 agentTeams / subagents Spike

> 日期：2026-10-29（本地 21:36–21:38 / UTC 13:36–13:38）· 执行者：integration-analyst（teammate）
> 预算：6 轮（task-10）· 写域：仅本文件
> 依据：`plugins/dsh-l0-adapter/`（只读参考）+ 本会话真实工具调用
> 标注：**[实测]** = 本会话真实调用返回；**[源码]** = 读 `plugins/dsh-l0-adapter` 代码所得；**[推断]** = 机制等价但未跑

---

## 0. 一句话结论

`subagents` 与 `sessionController` **在插件工具内可用，且 `exec.agent` 是合法 caller/parent**（已跑通 spawn + send + 收口 + 计量 + close）。
`agentTeams` 已有**唯一**调用点（`dsh-l0-control` 的 `team_status`，caller=`exec.agent`）：**实测已发起**，但**返回值投影不成 lossless JSON，被宿主拒收**——"能不能调"已不是问题，"输出契约"才是硬缺口（§2.7）。
`waitForChange` **看不见 subagent 生命周期**；`activation` 路径的 `awaitOutput` **被忽略**，call 语义两条路径不一致。

---

## 1. 可调用性（只读探针 `adapter_spike`）**[实测]**

```json
sessionController: { present:true, prompt:true, create:true, follow:true, cancel:true, inspect:true, directCallable:true }
subagents: { present:true, startActivation:true, sendMessage:true, listChildren:true, interrupt:true,
             providers:["spawn","fork","codex","claude-code"], configuredProvider:"spawn",
             providerReady:true, providerCapabilities:{ agentOptions:true, agentPreset:true, outputSchema:true, depthLimit:true } }
store: { file:".l0-adapter/adapter-state.json", readable:true, version:26 }
config: { source:"schemastery" }
verdict: { spawnPathA_session:true, spawnPathB_activation:true, call:true, usageCollection:true }
```

**含义**：`@Remote` 门面（`sessionController.prompt`）在插件进程内**直调可行**——这一条把上一轮（task-4）报告里的"最高优先未验证项"消掉了。

---

## 2. 真实调用记录（全部为跑通的原始返回）

### 2.1 spawn · activation 路径（`parent = exec.agent`）**[实测]**
```
adapter_spawn{role:SPIKE,index:1,mode:activation,label:n1-spike-child}
→ ok:true, instanceId:ROLE-SPIKE-01,
  sessionId:c84883b6-bd22-4fca-8324-f36ba4ad22d8,
  messageId:d10f345e-b5ae-4f35-9ce9-50f7a107aedb
close 后 finalState.parentSessionId = 9386815f-c90e-4f0d-98bd-e7db87d0d2e9（= 我的会话）
```
- 底层调用：`subagents.startActivation({provider:'spawn', label, request:{prompt:[blocks], parent:exec.agent, signal, agentPreset?, cwd?}, signal, delivery:'caller'})` **[源码 index.js:106 + service.js:376]**
- **深度闸未触发**：我的 delegation depth 已是 `remaining:0`，插件路径仍 spawn 成功 → 插件不经由 Agent 侧深度策略；`depthLimit:true` 只是 provider 能力位，**只有显式传 `maxDepth` 才生效，adapter 没传**。→ 递归无界风险（见 §5 R1）。

### 2.2 call · activation 路径（`subagents.sendMessage`）**[实测]**
```
adapter_call{ROLE-SPIKE-01, "再确认一次：只回复 N1-ACTIVATION-OK-2"}
→ ok:true, messageId:333f1e94-6429-4344-bbae-3bd33eb31284
  usageDelta.calls = 0，但 total.calls = 2（in 14412 / out 15 / cacheRead 8192 / finish stop×2）
子实例实际回话："N1-ACTIVATION-OK-2"（作为独立 system 通知到达主会话）
```
- 底层：`subagents.sendMessage(live.parent, instance.sessionId, blocks, {signal})` **[源码 service.js:474]**
- **两个缺陷**：
  1. `awaitOutput` 在 activation 分支被**忽略**（service.js:464–480 提前 return，不收口）；
  2. `usageDelta` 窗口错位：调用增量读作 0，而子实例的两个 LLM 调用已计入 total——**activation 的"本次调用用量"不可信**，只能读实例累计。

### 2.3 spawn · session 路径（无 parent）**[实测]**
```
adapter_spawn{index:2,mode:session,label:n1-spike-session}
→ ok:true, instanceId:ROLE-SPIKE-02,
  sessionId:session-00000000-0000-4000-8000-000000000003,
  requestId:88d8c93c-baab-42b9-8c46-949906659b74
```
- 底层：`sessionController.create({cwd,agentPreset?})` → `sessionController.prompt({requestId:randomUUID(), sessionId, mode:'queue', content})` **[源码 service.js:420–429]**
- 注意 **id 空间不同**：session 路径 `session-<uuid>`，activation 路径裸 `uuid` → 字典键必须带 `mode`。

### 2.4 call · session 路径 + 收口（`awaitOutput`）**[实测]**
```
adapter_call{ROLE-SPIKE-02, "请只回复一行：N1-SESSION-OK-2", awaitOutput:true}
→ ok:true, accepted:true, baselineSeq:24,
  output:{ settled:true, turnEnd:{seq:36,reason:"completed"}, lastSeq:36,
           text:"N1-SESSION-OK-2", segments:1, timedOut:false },
  usageDelta:{ calls:2, inputTokens:453, outputTokens:15, cacheReadTokens:23424 }
```
- 印证 task-4 结论：`prompt` 只回 `{accepted:true}`，**output 靠 `sessionController.inspect` 轮询到 `turn/end`**（不是 `follow`，避免插件长期持有 AsyncIterable）。
- 计量按实例归集有效（cacheRead 23424 被单独记到该 instanceId）。

### 2.5 close **[实测]**
```
ROLE-SPIKE-01 → status:closed, usage{calls:3,in:14646,out:26,cacheRead:30464}
ROLE-SPIKE-02 → status:closed, usage{calls:4,in:1764,out:28,cacheRead:45824}, requestIds:[2 个]
```

### 2.6 agentTeams 面（Agent 工具投影 / 板往返）**[实测]**
```
team_task_create → task-15, revision 1
claim(expected_revision=1) → revision 2, ownerName=integration-analyst
complete(expected_revision=2) → revision 3, status=completed
wait_agent(25000ms) → { timedOut:true }   ← 期间两个 subagent 实例正在跑
send_message(lead) → 正常受理
```
- 任务板 CAS 语义工作正常（revision 递增、ownerName 落定、陈旧 revision 会被拒）。
- **`waitForChange` 对 subagent 无感**：插件起的实例不是 teammate，团队板等待收不到它们的状态变化 → 收口只能走 `sessionController.inspect`。

### 2.7 `agentTeams` 插件内调用（`team_status`）**[实测：调用发生，输出被拒]**

```
team_status
→ Error: tool "team_status" returned invalid output: value is not lossless JSON
graph_status（对照，同插件、不同数据源）
→ ok:true, journal{events:3,lastKind:"plugin_applied"}, capabilities{toolCount:9, grades{native:1,projection:1,self-built:7},
   callerRequired:"live-agent", teamTaskRole:"projection"}, graph{ok:false,error:"core-unavailable"}（core 归 N3）
```

**判定链条（关键推理）**
1. 它不是 `{ok:false,error:'caller-required'}` → **`exec.agent` 被接受，caller 合法**；
2. 不是 `{ok:false,error:'agentTeams-absent'}` → **`ctx.get('agentTeams')` 拿到了服务**；
3. 不是 `{ok:false,error:'agentTeams-failed', detail}` → **`membership/listMembers/listTasks` 没有抛异常**，happy path 跑完；
4. 剩下的只有一种解释：**返回值无法通过宿主的 lossless-JSON 校验**（`plugins/dsh-l0-control/lib/service.js:42` 的 `toPlain` 投影不彻底，注释自己也写着"宿主会拒收含类实例/代理的值（`Agent` 句柄、branded 对象都会踩）"）。
5. 对照组 `graph_status` 同插件、同 `output` 定义，返回正常 → **不是插件整体坏，是 `team_status` 的 payload 投影坏**。

**N2 必修（成本很低）**：`team_status` 不要再映射 raw `member`/`task` 对象，只取标量白名单（`id/name/role/status/revision/ownerName/ready`），`context`、`diagnostics` 一律转字符串或丢弃；出口统一 `JSON.parse(JSON.stringify(v))` 兜底，并对失败分支返回 `error:'projection-failed'` 而不是把原值抛给宿主。

**副产品**：`graph_status` 还证明 `capabilities` 面已经落地——`grades{native:1,projection:1,self-built:7}`、`supports_whitebox:false`、`stateAuthority:'plugin-journal'`、`teamTaskRole:'projection'`、`callerRequired:'live-agent'`，与 task-4 给 N2/N3 的能力声明草案一致。

---

## 3. caller / 权限 / 失败模式矩阵

| 动作 | caller 要求 | 插件内可行？ | 已知失败模式（错误码） | 证据 |
|---|---|---|---|---|
| `subagents.startActivation` | `request.parent` = **活 Agent** | ✅ `exec.agent` | `parent-required`（无 parent）、`spawn-failed`；provider 未注册则 `UNSUPPORTED_CAPABILITY` | 实测 + 源码 |
| `subagents.sendMessage` | `sender` = **exact live** Agent | ✅ 存活的 parent | `activation-parent-missing`（父句柄丢）、`UNAUTHORIZED`（非直属）、`subagent/delivery-unavailable`（冷启容量） | 实测 + 契约 |
| `subagents.interrupt` | `authority` = user 地址或**祖先 Agent** | ⚠️ 未跑 | `UNAUTHORIZED`；缺席目标为 no-op | 契约 |
| `sessionController.create` | 无 Agent 要求 | ✅ | — | 实测 |
| `sessionController.prompt` | 无 Agent 要求（Remote 门面可直接调） | ✅ | `session/writer-held`、`session/agent-busy`、`subagent 会话不可 prompt` | 实测 + 源码注释 |
| `sessionController.inspect` | 只读，冷可读 | ✅ | — | 实测 |
| `agentTeams.createTask/listTasks/updateTask` | 首参 `caller: Agent` | ❓ **代码中未调用** | 陈旧 `expectedRevision` 被拒 | Agent 面实测；插件内未跑 |
| `agentTeams.spawnTeammate` | `caller` 须为团队 Lead | ❓ | 非 Lead 应被拒（预期 fail-closed） | **未跑（我是 teammate，不能自证）** |
| `agentTeams.sendMessage` | `caller` = 发件 Agent | ✅（Agent 面） | 目标不存在 | 实测（Agent 面） |
| `agentTeams.waitForChange` | `caller` + timeout + signal | ✅（Agent 面） | 超时返回 `timedOut`（非异常）；**不覆盖 subagent** | 实测 |

**统一信封已是事实标准**：插件内部所有动作返回 `{ok:false, error:'<kebab-code>', ...}`，建议 N3 直接把它当契约（见 §4.2）。

---

## 4. 给 N2 / N3 的接口草案

### 4.1 N2（插件壳）：把"推断"变"实测"的三件事

```js
// ① 新增团队工具：exec.agent 作 caller，fail-closed
ctx.tools.register({
  name: 'team_create',
  parameters: { type:'object', properties:{ subject:{type:'string'}, description:{type:'string'} }, required:['subject','description'], additionalProperties:false },
  output,
  async execute(args, exec) {
    const caller = exec?.agent;
    if (!caller) return { ok:false, error:'caller-required' };          // 无 caller 不猜、不降级
    const teams = ctx.get('agentTeams');
    if (!teams) return { ok:false, error:'agentTeams-absent' };
    const task = await teams.createTask(caller, { subject: args.subject, description: args.description });
    return { ok:true, caller: caller.id, task };
  },
});
```

② **修 call 语义**：activation 分支也支持 `awaitOutput`——复用 session 路径的 `awaitOutput(childId, baselineSeq)`（`sessionController.inspect` 轮询），使两条路径对上层同形。
③ **补深度闸**：`startActivation` 传 `maxDepth`（或插件侧硬限 `role×index`），否则插件路径没有递归上限。

### 4.2 N3（core-port）：两个后端、一个信封

```ts
interface NativeResult<T> { ok: true; value: T } | { ok: false; error: string; detail?: unknown }

interface NativeAdapter {
  // 团队后端（投影，非权威）
  createTask(caller: Agent, req: {subject: string; description: string}): Promise<NativeResult<TeamTask>>;
  listTasks(caller: Agent, q?: {status?: string; owner?: string}): Promise<NativeResult<TeamTask[]>>;
  updateTask(caller: Agent, req: {taskId: string; expectedRevision: number; action: TaskAction}): Promise<NativeResult<TeamTask>>;
  spawnTeammate(caller: Agent, req: TeammateSpec): Promise<NativeResult<Member>>;   // 仅 Lead 有效
  sendTeamMessage(caller: Agent, req: {target: string; message: string}): Promise<NativeResult<{messageId: string}>>;
  waitChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<NativeResult<'changed'|'timeout'>>;

  // 执行后端（真实 Agent）
  spawn(spec: SpawnSpec): Promise<NativeResult<{instanceId: string; sessionId: string; mode: 'activation'|'session'}>>;
  call(instanceId: string, input: string, opts: {delivery:'queue'|'steer'; awaitOutput:boolean; timeoutMs?: number}): Promise<NativeResult<CallReceipt>>;
  inspect(instanceId: string): Promise<NativeResult<{lastSeq: number; settled: boolean; text?: string}>>;
  close(instanceId: string): Promise<NativeResult<FinalState>>;
}
```

**N3 必须继承的三条纪律**
1. **权威在 journal，板是投影**：`done` 先写 journal（单写者 + revision CAS），再 `updateTask`；`updateTask` 失败**不回滚 journal**，进 `repair` 重放队列（板无事务，见 task-4 §缺口）。
2. **收口只用 `inspect` 轮询**，不用 `waitForChange`（它看不见 subagent）、也不长期持有 `follow` 的 AsyncIterable。
3. **计量读实例累计差**，不要相信 activation 的 `usageDelta`（窗口错位）；并且**只按 `instanceId`/`sessionId` 归集**，禁止全局累加。

---

## 5. 风险与未验证

| # | 风险 | 影响 | 缓解 / 下一步 |
|---|---|---|---|
| R1 | 插件 spawn 绕过 Agent 侧深度策略（我 depth 已 0 仍成功） | 递归/实例爆炸 | N2 传 `maxDepth` + `maxInstances`（现有默认 8）+ 单写者登记 |
| R2 | `agentTeams` 插件内**输出契约**坏（调用本身已通） | 团队面读不出数据，N2 验收卡住 | 按 §2.7 修 `toPlain` 白名单 + 兜底 JSON 往返；`graph_status` 作健康对照 |
| R3 | `spawnTeammate` 的 Lead 权限未验证 | 谁有权建 teammate 不明 | 用 Lead 会话跑一次；非 Lead 场景记录拒绝码 |
| R4 | activation 的 `awaitOutput` 缺失 + usageDelta 错位 | 上层 call 语义分叉 | 按 §4.1② 修；此前 activation 只作"派发+异步回收" |
| R5 | `waitForChange` 不覆盖 subagent | 收口漏事件 | 只用 `inspect`；团队板等待仅用于 teammate |
| R6 | 两种 sessionId 形态并存 | 字典键冲突 | 键 = `instanceId`，值为 `{mode, sessionId}`；已按此存 |
| R7 | 未测 `subagents.interrupt` / `takeover` 与 parent 失效组合 | 接管语义空白 | 留 N4（state-recovery） |
| R8 | `agentTeams`/`subagents` 契约无版本号 | DSH 升级即断 | 能力快照 + conformance 门禁（task-4 WP-A7） |

**未验证清单（诚实）**：`agentTeams.createTask/updateTask` **在插件内**的写路径（只验证到 `team_status` 的读路径发起）；`spawnTeammate` 的权限边界；`subagents.interrupt` 与 fencing 组合；`sessionController.follow` 流式收口（本次用 inspect）；跨进程/重启后的 parent 句柄恢复；`adapter_state` 写路径与 fencingToken 拒绝行为（本轮只读）。

---

## 6. 复用片段（插件内 exec.agent 模式）

```js
export const inject = ['tools'];                       // 其余服务用 ctx.get 判空，避免硬依赖
export function apply(ctx) {
  ctx.tools.register({
    name: 'n1_native_probe',
    parameters: { type:'object', properties:{}, additionalProperties:false },
    output: { schema:{type:'object',additionalProperties:true},
              render: (_a,v)=>[{type:'text',text:JSON.stringify(v,null,2)}] },
    async execute(_args, exec) {
      const caller = exec?.agent;                       // ← 唯一的 caller 来源
      if (!caller) return { ok:false, error:'caller-required' };
      const teams = ctx.get('agentTeams'), subs = ctx.get('subagents');
      const out = { caller: caller.id, teams: Boolean(teams), subagents: Boolean(subs) };
      if (teams) out.task = await teams.createTask(caller, { subject:'probe', description:'n1 spike' });
      if (subs)  out.provider = subs.list?.() ?? null;
      return { ok:true, ...out };
    },
  });
}
```

---

## 7. 对 task-4 结论的更新

| task-4 判定 | N1 后 |
|---|---|
| `@Remote` 门面进程内可调用性"未验证，最高优先" | **已验证可行**（`sessionController.prompt` 直调成功，`directCallable:true`） |
| spawn "需包装：`subagents` 需 parent Agent" | 确认；且 `exec.agent` 即合法 parent，包装成本低 |
| call "需包装：prompt 无 output/usage" | 确认，并新增 **activation 路径 awaitOutput 缺失** |
| 计量"按 sessionId 归集" | 确认可行（实例级 cacheRead 正确记账） |
| 团队面 `agentTeams` | **调用已实测**（`team_status` 打到原生板），但输出非 lossless JSON 被宿主拒收 → N2 修投影即可闭环 |
