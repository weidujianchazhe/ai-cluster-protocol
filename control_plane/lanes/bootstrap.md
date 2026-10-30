# Lane B · Bootstrap 阶段（project_init）

> 任务板：task-31（预算 6）· 规格：`control_plane/BOOTSTRAP-阶段.md`
> 写域：`src/bootstrap/`、`src/tools.ts`、`src/service.ts`、`src/index.ts`、`scripts/`、`tests/`、本文件

---

## R1 · 实现 + 8 类验收（一次过）· 2026-10-29/30

### 交付

| 文件 | 内容 |
|---|---|
| `src/bootstrap/init.ts`（新） | `runProjectInit(input, deps)`：安全阀（root 白名单 / marker 幂等 / 非空冲突）→ preflight → 执行（mkdir/write/git）→ 失败清理；`slugify`、`isInside` 导出 |
| `src/bootstrap/index.ts`（新） | 对外导出 |
| `src/tools.ts` | 注册 `project_init`（第八…第十五个工具）：`dryRun`/`gitInit`/`management`/`allowEmptyExisting` 全在 schema 里，默认值由实现兜住 |
| `src/service.ts` | `projectInit()`：先 `project_init_planned` 再执行、最后 `project_init_result`（含 created/skipped/conflicts/git 摘要） |
| `src/index.ts` | `ACTION_BY_TOOL.project_init = 'project.init'`（授权 + audit 行） |
| `src/security/roles.ts` | 新增动作 `project.init` → `["ORCH","HUMAN","PLUGIN"]`（一行，S lane 表内注册；未登记动作会 fail-closed） |
| `src/capabilities.ts` | `TOOL_SURFACE.project_init`（`self-built`，`fs+git`） |
| `scripts/bootstrap-check.mjs`（新） | 8 条验收（见下） |
| `scripts/contract.mjs` | 新增 `project_init` 形状规格 + call（20 checks） |
| `scripts/selftest.mjs` | 工具数 14→15、`project_init` 分级、新增「默认 dry-run 零写入 + journal 两行」 |

### 安全规则落地（逐条对应规格）

| 规则 | 实现 |
|---|---|
| root 白名单 | `isInside(workspaceRoot, root)`（`path.resolve` 后逐段比较，`..` 逃逸 → `root-outside-workspace`） |
| 默认 dry-run | `dryRun !== false` → 只读；actions 全 `would-create`，git `would-init`/`missing`/`skipped` |
| 幂等 | marker `.l0-control/project.json` 存在且 slug 一致 → `ok:true`、actions 全 `skipped`、marker 不重写 |
| 防覆盖 | 目录非空且无 marker → `conflict:not-empty`，**零写入**（保留原文件） |
| git 最小化 | 只 `.git` 不存在才 `git init`；**不 commit/push**；`git --version` 探不到 → `git.missing`，文件照建 |
| 原子性 | preflight 全通过才写；写失败尽力 `rmSync` 本次创建的目录 |
| 可审计 | service 层写 `project_init_planned` + `project_init_result` |

### 验收数字

| 门禁 | 结果 |
|---|---|
| `scripts/bootstrap-check.mjs`（8 条） | **8 / 8** |
| `scripts/selftest.mjs` | **17 / 17** |
| `scripts/contract.mjs` | **20 / 0** |
| `scripts/persistence-check.mjs` | 10 / 10（未受影响） |
| `tests/e2e/conformance.mjs` | 7 / 7（未受影响） |

`bootstrap-check` 的 8 条：dry-run 零写入 / execute 结构+marker / README 内容 / 幂等不重写 /
非空冲突零写入 / root 越界拒绝（含 `../` 形式）/ git 缺失 fail-soft / git init 成功且无 commit。

### 期间修的一个真 bug

`git` 状态在 execute 分支被预置成 `initialized`，导致后面对 `git.state === 'would-init'` 的判断永不成立 →
**git init 实际没被调用**。改成独立布尔 `needGitInit` 后，`calls.length === 1` 断言通过（测试第 8 条抓到的）。

### 已知边界

- 管理区骨架是"可被 closeout/new-card 接管的初始态"，不是完整协议实现（规格原话）。
- `allowEmptyExisting` 只放行**空目录**；非空目录无论开关都要求 marker（防止误灌）。
- A2A / 观测 / 授权均已接入，`project.init` 走 `PLUGIN` 角色（宿主/插件内部调用），执行角色（CODE 等）无此权限。

**预算**：R1（1/6）。task-31 完成后可进 M5（全量验收）。

---

## R2（task-32）· UI 统计缓存 + managementRoot · 2026-10-30

### ① UI 统计 0 的真因与修法

**真因**：`uiSnapshot()` 的 `team` 完全依赖 `lastCaller`（只有 `team_status` 被调过才有值）。插件 reload 后
`lastCaller=null` → 面板显示团队成员/任务 0，但黑板事件（读 journal，全局）仍是 104 → **只有团队/任务区归零**。

**修法（三层）**
1. `teamStatus(caller, {capture})` 成功投影后把**纯标量快照**写 journal `team_snapshot`（`capturedAt` + 投影结果，
   `capture:false` 可关 —— UI 轮询不刷盘）；
2. `constructor` 里 `restoreTeamSnapshot()`：从 journal 反向找最后一条 `team_snapshot` 恢复内存缓存；
3. `uiSnapshot()` 优先实时（有 caller）→ 否则用恢复的快照 → 都没有才 `source='none'`，
   并在返回里带 `team.source = 'live' | 'snapshot' | 'none'` + `team.capturedAt`（面板可标"实时/快照 + 时间"）。

**验证**
- 单测（selftest 两条）：fake agentTeams + live caller → journal 出现 `team_snapshot`；再 `new L0ControlService` 模拟 reload
  （同 stateDir、无 caller）→ `uiSnapshot().team.source='snapshot'`、members=2、tasks=2；
  空 stateDir → `source='none'`（**不伪造**团队数据）。
- 真数据：reload 后 `team_status` 落 `team_snapshot`（members 12 / tasks 32，`capturedAt=2026-10-29T16:52:12Z`）；
  另起只读实例（无 caller）读同 stateDir → `source='snapshot'`、members 12 / tasks 32、capturedAt 一致。

### ② `managementRoot` 参数

- 可选；默认 `<root>/管理区`；相对路径按 **workspaceRoot** 解析；绝对路径原样解析；
- **必须落在 workspaceRoot 下** → 越界返回 `management-root-outside-workspace`（零写入）；
- 防覆盖/幂等/安全阀不变；marker 里额外记 `root` 与 `managementDir`（便于接管方定位）；
- 布局函数从"相对 root 的 rel"改成"绝对 target"，管理区文件写进 `managementDir`（可与工程区分离）。

**测试（bootstrap-check 8 → 11）**：自定义 managementRoot 落位（且工程区不再自带 `管理区/`）、
自定义后重复 execute 幂等（INDEX.md 内容不变）、managementRoot 越界（含 `../` 形式）零写入。

### 数字

| 门禁 | 结果 |
|---|---|
| `selftest` | **19 / 19**（+2 UI 快照） |
| `bootstrap-check` | **11 / 11**（+3 managementRoot） |
| `contract` | **20 / 0** |
| `conformance` | 7 / 7 |
| `persistence-check` | 10 / 10 |

**已知边界**：`team_snapshot` 只在 `team_status` 成功时更新；若团队板长期没被调，面板会显示较旧的快照
（有 `capturedAt` 可判断新鲜度）。要"永远新鲜"需要宿主定时推送，不在本 lane。

**预算**：R1–R2（2/6）。

---

## R3（task-33）· 按对话窗口（Session）细分统计 · 2026-10-30

### 为什么必须按 session 隔离

上一轮的 `team_snapshot` 是**全局单份**：任一对话窗口调过 `team_status`，别的窗口/工作区读 UI 快照就会看到
**当前 Lead session 的团队板**。用户要求改为按"对话窗口"统计，不许跨 session 复用。

### ① Service：按 session 缓存 + 严格隔离

| 点 | 实现 |
|---|---|
| 写快照 | `teamStatus(caller,{capture})` 成功后写 `team_snapshot { sessionId: caller.id, capturedAt, team }` |
| 恢复 | 构造时 `restoreTeamSnapshots()` 逐行扫描 journal，**按 sessionId 归 Map**（后写覆盖先写）；**无 sessionId 的旧行直接忽略**（正是要修掉的串数据来源） |
| 读取 | `uiSnapshot({sessionId})`：只有 `lastCaller.id === sessionId` 才走 live；否则查该 session 的快照；未知 session → `source='none'` + `no-snapshot-for-session`；**没给 sessionId → `source='none'` + `session-required`**（不再拿 lastCaller 兜底） |
| 附带 | 返回 `sessionId`、`sessions[]`（已快照的会话列表，供 UI 下拉）、`suggestedSessionId`（提示但不自动使用） |

### ② UI：工作区 → 对话窗口两级选择

- `Panel` 增接 `useSessions`（`snapshot.items` 或 `snapshot.byId` 归一），按 `session.cwd === data.workspaceRoot` **过滤出当前工作区的对话**；
- 工作区 chip 下面新增「对话窗口」chip 行（无则显示"当前工作区没有对话窗口"）；
- 选中会话后 `fetch('/ui/snapshot?sessionId=…')`；未选时用本窗口自己的 session id；
- **未接入**（`team.source` 不是 live/snapshot）：统计卡全部 `—`，团队/任务/黑板三个 tab 显示"该对话未接入/未快照（未调用过 team_status）"，**不显示任何别的会话数据**；
- 非当前工作区：统计 `—` + 团队/任务/黑板 tab 未接入（沿用上一轮的门控，加了 session 维度）；
- locale 新增 `sessions` / `noSessions` / `noSessionSnapshot`（zh/en 各 27 → 30 键）。

### ③ 侧车透传

`ui-server` 解析 `?sessionId=` → `getSnapshot(sessionId)` → `service.uiSnapshot({sessionId})`；
`index.ts` 接线同步；无参数时 `undefined`（service 侧按 `session-required` 处理）。

### 测试（selftest 17 → 20）

| 用例 | 断言 |
|---|---|
| 两 session 隔离 + reload | sess-a 快照（2 成员/1 任务）与 sess-b（3/4）各自恢复，`sessionId` 各自正确、`sessions[]` 长度 2、**互不借用** |
| 未知 session / 未指定 | `sess-zzz` → `no-snapshot-for-session`；无参 → `session-required`；两者 `source='none'`，且会话列表里没有 `sess-zzz` |
| 侧车透传 | 真起 `startUiServer(port:0)`，`?sessionId=sess-a` → `seen[0]==='sess-a'`，无参 → `null` |

### 真宿主验证（47831 侧车）

```
?sessionId=<本会话>   → source=live   members=12 tasks=33 sessions=1
?sessionId=unknown-xyz → source=none   error=no-snapshot-for-session members=0
（无参数）             → source=none   error=session-required suggestedSessionId=<本会话，仅提示>
```
journal 里 `team_snapshot` 已带 `sessionId`（新行 3 条 + 1 条旧格式无 sessionId —— 旧行被恢复逻辑忽略，符合预期）。

### 数字

| 门禁 | 结果 |
|---|---|
| `selftest` | **20 / 20** |
| `contract` | **20 / 0** |
| `bootstrap-check` | 11 / 11 |
| `conformance` | 7 / 7 |
| `persistence-check` | 10 / 10 |

**边界**：`sessions[]` 只列"有过快照"的会话；从没调过 `team_status` 的会话需要在面板里显示为"未接入"，
要它自动出现得靠宿主定时调用（不在本 lane）。UI 需刷新页面加载新 client bundle。

**预算**：R1–R3（3/6）。

---

## R4（task-34）· 按对话启用/停用 + 事实源半行 + 首次入口 · 2026-10-30

规格：`control_plane/ACCESS-按对话启用.md`。**默认 disabled**：没有 `access_changed` 记录的 session 视为未启用。

### ① Service（access）

| 方法 | 行为 |
|---|---|
| `isSessionEnabled(id)` | 无记录 = `false`（fail-closed） |
| `setSessionEnabled(id, enabled, by)` | 写内存 Map + journal `access_changed {sessionId, enabled, at, by}` |
| `accessSnapshot()` | `{ default:'disabled', sessions:[{sessionId,enabled,at,by}] }` |
| `accessFor(id)` | `{ok, sessionId, enabled, default:'disabled'}`（侧车 GET 用） |
| 恢复 | 构造 `restoreAccess()` 逐行扫 journal，后写覆盖先写 |

### ② 工具入口 guard（`index.ts`）

`authorize` **之前**先看 `exec.agent?.id`：未启用 → 写 `access_denied` 审计行并返回
`{ok:false, error:'not-enabled', sessionId, tool, hint}`，**不执行工具、不写业务 journal**。

### ③ 侧车（`ui-server`）

- `GET /ui/access?sessionId=` → `accessFor`
- `POST /ui/access {sessionId, enabled, by?}` → `setSessionEnabled`（唯一写路径，body ≤64KB，缺字段 400）
- CORS 放开 `POST`；`uiSnapshot` 增加 `access: {default:'disabled', enabled, sessionId}`

### ④ UI

- **事实源卡片缩成半行**（`padding: 8px 12px`）：左「事实源 + 插件 journal（TeamTask 是投影）」，右侧「启用/停用本对话」按钮 + 紧凑计数；
- 未启用：统计卡成员显示「未启用」、其它 `—`，团队/任务/黑板 tab 显示启用提示 + **立即启用**按钮，**不显示任何团队/任务/黑板数据**；
- 启用但无快照：显示"该对话未接入/未快照"；
- **首次对话入口**：注册 `conversation.input.left` 槽（try/catch，槽不存在则跳过），仅当前 session 未启用时显示「🎛 启用 AI集群工作协议」，点击 POST 启用；
- locale 新增 `enableThis/disableThis/notEnabled/notEnabledHint/needSession`（zh/en 各 35 键）。

### ⑤ 测试（selftest 20 → 23）

| 用例 | 断言 |
|---|---|
| 默认/启用/停用/reload/隔离 | 默认 false；启用后 true；`sess-2` 仍 false；reload 后仍是 true（`sess-2` false）；停用立即 false 且再 reload 仍 false |
| `uiSnapshot.access` | `sess-on` → `enabled:true`；`sess-off` → `enabled:false` 且 `team.source='none'` |
| 侧车往返 | `GET` 前 false → `POST` true → `GET` true；缺 `sessionId` 的 POST → **400** |

### 真宿主验证（本会话）

```
GET  /ui/access?sessionId=<me>   → enabled=false（默认停用）
POST /ui/access {enabled:true}   → ok
graph_status (tool)              → ok:true（guard 放行）
POST /ui/access {enabled:false}  → ok
graph_status (tool)              → {ok:false, error:'not-enabled', sessionId, hint}  ← **业务未执行**
POST /ui/access {enabled:true}   → 恢复可用
```
journal 实测：`access_changed × 3`（true/false/true，`by='cli'`）+ `access_denied × 1`（graph_status）。

### 数字

| 门禁 | 结果 |
|---|---|
| `selftest` | **23 / 23** |
| `contract` | **20 / 0** |
| `bootstrap-check` | 11 / 11 |
| `conformance` | 7 / 7 |
| `persistence-check` | 10 / 10 |

**注意（部署语义）**：现在默认所有对话都**未启用**——新会话必须先 POST 启用（或点面板/输入框按钮），
否则所有插件工具都会返回 `not-enabled`。本会话已通过 POST 启用，状态落在 journal 里，reload 不丢。

**预算**：R1–R4（4/6）。

---

## R5（task-35）· 协作 / 工作区管理双轴拆分 · 2026-10-30

规格：`control_plane/ACCESS-协作与管理区.md`。核心命题：**启用插件 ≠ 启用工作区管理**。

### ① 数据与语义

`access_changed { sessionId, coordination, management, at, by }`

| 轴 | 含义 | 默认 |
|---|---|---|
| `coordination` | 智能体协调（所有插件工具 + 集群统计） | `false` |
| `management` | 工作区管理（`project_init` / 管理区内容） | `'off'` |

- `isSessionEnabled()` **只看 coordination**（工具 guard 用它）；
- `managementFor()` → `'off' | 'auto' | 'on'`；`normalizeManagement()` 兜底成 `off`；
- **旧记录迁移**：`access_changed` 里没有 `coordination` 字段（只有 `enabled`）→ 迁移为
  `{coordination: enabled, management: 'off'}`；
- `setSessionAccess(sessionId, {coordination?, management?}, by)` 两轴独立更新，只传一个轴不动另一个；
  `setSessionEnabled()` 保留为"只改协作"的兼容入口。

### ② project_init 的第二道闸

`project_init(input, sessionId?)` 先看 management：

- `off` → `{ok:false, error:'management-disabled', management:'off', hint}` + journal `project_init_blocked`（**零写入**）；
- `auto` / `on` → 通过（`auto` 只是"AI 自己决定要不要建"，插件**不自动创建**）。

工具入口仍先过 coordination guard（未启用 → `not-enabled`）。

### ③ 侧车与 UI

- `GET /ui/access` 返回 `{coordination, enabled, management, default:'disabled', managementDefault:'off'}`；
- `POST /ui/access` 接受 `coordination` / `enabled`（兼容） / `management` 任意组合，缺轴 → **400 `sessionId-and-axis-required`**；
- `uiSnapshot.access` 同时带 `coordination` 与 `management`；
- **UI 事实源半行右侧两个独立控件**：`协作: 开/关`、`工作区管理: 关/自动/开`（点击循环切换）；
- 协作未启用：统计 `—` + 启用按钮；协作开、管理 off：统计正常，管理区 tab 显示"工作区管理未启用（off）"+ 快速切到自动；
- 管理 `auto`：tab 显示"自动（由 AI 决定）"；管理 `on`：正常展示；
- 首次对话入口（`conversation.input.left`）**只开 coordination**，不碰 management；
- locale +11 键（zh/en 各 46）。

### ④ 测试（selftest 23 → 24）

新增一条覆盖全轴的用例：**旧记录迁移**（只有 `enabled:true` → coordination=true / management=off）、
**默认**（coordination=false / management=off）、**只协作**（project_init → `management-disabled`）、
**auto 放行**（dry-run ok）、**关回 off 立刻拒绝**、**reload 双轴恢复**、**只改管理不动协作**。

### 真宿主验证

```
GET /ui/access?<me>  → coordination=true management=off   ← 旧 enabled 行迁移生效
project_init(...)    → {ok:false, error:'management-disabled', management:'off'}
POST {management:'auto'} → GET → coord=true mgmt=auto
project_init(dryRun) → ok:true（auto 放行，零写入）
POST {management:'off'}  → project_init → management-disabled
journal：access_changed×9（新旧格式混合，迁移正常）+ project_init_blocked×1
```
另外 journal 里能看到**别的 session**（`session-eae6… by ui`、`session-4578… by composer`）各自的旧格式记录，
说明按对话隔离与兼容迁移都在生效。

### 数字

| 门禁 | 结果 |
|---|---|
| `selftest` | **24 / 24** |
| `contract` | **20 / 0** |
| `bootstrap-check` | 11 / 11 |
| `conformance` | 7 / 7 |
| `persistence-check` | 10 / 10 |

**部署语义**：两道闸串联——协作关 → 所有工具 `not-enabled`；协作开但管理 off → 只有 `project_init` 被
`management-disabled` 挡住，其余工具正常。本会话：coordination=true / management=off。

**预算**：R1–R5（5/6）。

---

## R6（task-36）· 检查更新接仓库（只检查，不自动更新）· 2026-10-30

### ① 配置

`updateRepo`（默认 `weidujianchazhe/ai-cluster-protocol`，**空 = 关闭检查**）、`updateRef`（默认 `main`）。

### ② `service.checkUpdate({fetchImpl?})`

- 本地版本：读本插件 `package.json`（`lib/../package.json` → `0.1.0`）；
- 远端：`https://raw.githubusercontent.com/<repo>/<ref>/plugins/dsh-l0-control/package.json`；
- 比较：轻量 semver（按数字段，缺段补 0，`v` 前缀与前缀版本号都处理）；
- 返回 `{ok, available, currentVersion, latestVersion, repo, ref, url, message?, error?}`；
- **fail-soft**（不抛、不 500）：`repo` 空 → `update-repo-not-configured`；网络异常 → `network-failed`；
  404 → `remote-not-found`（"仓库里还没有发布版本"）；远端缺 version → `remote-version-missing`；
- `fetchImpl` 可注入 → 测试用 fake fetch，不打网。

### ③ 侧车

`/ui/update-check` 改调 `getUpdateInfo()`（index 接线 → `service.checkUpdate()`）；任何异常都回 200 +
`{ok:false,error:'update-check-failed'}`，**不 500**。

### ④ UI

按钮已有；响应 `available` 时 modal 显示「发现新版本 current → latest」+ `repo@ref` + 说明
「本版本暂不自动更新；仓库发布后再接入一键更新」，按钮 **关闭 / 稍后更新**；
非 available（404 / 未配置 / 网络失败）显示对应 message；locale +6 键（zh/en 各 52）。

### ⑤ 测试（selftest 24 → 26）

| 用例 | 断言 |
|---|---|
| fake fetch 四情形 | `9.9.9` → `available:true` 且 url 含 `raw.githubusercontent.com`；同版本 → `available:false`；404 → `remote-not-found`；抛错 → `network-failed`；`updateRepo:''` → `update-repo-not-configured` |
| `/ui/update-check` | 正常 → 200 + `available:true/latestVersion`；`getUpdateInfo` 抛错 → **200 + `update-check-failed`**（fail-soft） |

### 真宿主

`GET /ui/update-check`（本机无外网）→
`{ok:false, available:false, currentVersion:'0.1.0', latestVersion:'', error:'network-failed', repo:'weidujianchazhe/ai-cluster-protocol', ref:'main'}` —— 正好验证 fail-soft 路径：HTTP 200、不抛、UI 能显示"检查失败"。

### 数字

| 门禁 | 结果 |
|---|---|
| `selftest` | **26 / 26** |
| `contract` | **20 / 0** |
| `bootstrap-check` | 11 / 11 |
| `conformance` | 7 / 7 |
| `persistence-check` | 10 / 10 |

**边界**：只做"检查"，`apply/更新` 未实现（等仓库上传后再接）；无外网时永远显示"检查失败/未发布版本"，
不会误报"已是最新"。

**预算**：R1–R6（6/6，本 lane 预算用尽）。

---

## R7（task-37）· 子 Agent 快照持久化 · 2026-10-30

### 真因

`team_snapshot` 只存团队板（members/tasks），**没存 descendants**；`uiSnapshot` 的 descendants 只在
`lastCaller` 存在时才实时算 → **reload 后 lastCaller 为空 → 子 Agent 显示 0/—**（团队/任务因为有快照所以正常）。

### 修法

1. `descendantSnapshots: Map<sessionId,{count,active,at,items}>`；
2. `teamStatus` 成功（`capture !== false`）后 **异步** `captureDescendants(sessionId, caller)`：
   `subagents.listDescendants(caller.id)` → 取 `kind==='child'` → 写 journal `descendants_snapshot {sessionId,count,active,at,items}`（不阻塞团队板返回）；
3. 构造 `restoreDescendantSnapshots()` 逐行恢复每 session 最后一条；
4. `uiSnapshot({sessionId})` 的 descendants 三态：
   - live（`lastCaller.id === sessionId` 且有 `listDescendants`）→ 实时 + 顺手更新快照；
   - 否则该 session 有快照 → `source:'snapshot'` + `capturedAt`（reload 后不再 0/—）；
   - 都没有 → `source:'none'`、`count:0`（**不伪造数字**）；
5. UI：`descendantsSource !== 'none'` 时显示 `count/active`（如 `23/0`），`none` 时显示 `—`。

### 测试（selftest 26 → 27）

单条覆盖：fake `subagents.listDescendants` 返回 36 个 child（1 个 running）→ `teamStatus` 后 journal 出现
`descendants_snapshot`；live → `source:'live'` / count 36；**reload 无 caller → `source:'snapshot'` / count 36 / active 1 / 有 capturedAt**；
未知 session → `source:'none'` / count 0。

### 真宿主验证

```
team_status 后：journal descendants_snapshot {sessionId:1210cf86…, count:23, active:0}
GET /ui/snapshot?sessionId=<me>（live）        → descendants.source=live     count=23 active=0
reload 后再取（无 live caller）                 → descendants.source=snapshot count=23 active=0 capturedAt=2026-10-29T17:48:53Z
GET /ui/snapshot?sessionId=unknown-xyz         → descendants.source=none     count=0
```
即：reload 后**不再出现 0/—**，而是上次快照的真实 23/0。

### 数字

| 门禁 | 结果 |
|---|---|
| `selftest` | **27 / 27** |
| `contract` | **20 / 0** |
| `bootstrap-check` | 11 / 11 |
| `conformance` | 7 / 7 |
| `persistence-check` | 10 / 10 |

**边界**：快照只在 `team_status` 成功时刷新（异步，一拍后落盘）；如果长时间不调 `team_status`，
子 Agent 数是"上次调用时"的真值（有 `capturedAt` 可判断新鲜度）。

**预算**：R7（超出原 lane 预算 1 轮，task-37 单列预算 2）。

---

## R8（task-38）· 选中工作区 + 同级管理区 + UI 新建项目 · 2026-10-30

规格：`control_plane/PROJECT_INIT-选中工作区.md`（已同步更新 `BOOTSTRAP-阶段.md`：安全规则 1 与「创建内容」结构）。

### ① 选中工作区（`workspaceRoot` + 别名）

- 入参：`workspaceRoot` / `selectedWorkspace` / `workspacePath`（三者等价）；
- **必须存在**，且 `=== 实例 workspaceRoot` 或 `位于 dirname(实例 workspaceRoot)` 下：
  - 不存在 → `workspace-root-not-found`
  - 越界 → `workspace-root-outside-allowed-parent`
  - 两者都**零写入**；
- `root` 默认 `<选中工作区>/projects/<slug>`，必须落在选中工作区内（`root-outside-workspace`）；
- 返回新增 `project.workspaceRoot`。

### ② 默认管理区改为**同级**

`managementDir` 默认从 `<root>/管理区` 改为 **`<root>-管理区`**（对齐 `AI集群工作协议-管理区`）；
`managementRoot` 仍可覆盖（相对路径按选中工作区解析），仍必须落在工作区内。
**旧 marker 兼容**：marker 里已有 `managementDir` 时沿用（不迁移、不重建）。

### ③ service / tool / 侧车 / UI

- `service.projectInit(input, sessionId)` 透传三个别名；journal `project_init_planned/result` 记录 `workspaceRoot`；
- tool schema 增加 `workspaceRoot`（含别名说明），`managementRoot` 描述改为"同级默认"；
- **`POST /ui/project-init`** `{sessionId, workspaceRoot, projectName, wish?, dryRun?}`：
  缺字段 400；**management=off → 409 `management-disabled`（零写入）**；异常 500；
- UI「项目管理」页新增**新建项目**表单：项目名 / 愿望 / 预览(dryRun) / 创建，目标工作区取 `activeSidebar.path`，
  结果显示 actions/conflicts/git + 实际 root/managementDir；**management=off 时按钮禁用并提示**；locale +10（zh/en 各 62）。

### ④ 测试

| 套件 | 新增 |
|---|---|
| `bootstrap-check` 11 → **15** | 选中工作区落位（不落到实例默认目录）/ 别名等价 / 越界与不存在零写入 / 旧 marker 沿用 `<root>/管理区` |
| `selftest` 27 → **28** | `/ui/project-init`：preview 零写入、create 落位（含同级管理区）、management=off → **409** |

### 真宿主验证

```
POST /ui/project-init （management=off）        → HTTP 409
POST /ui/project-init （management=auto, dryRun）→ 200 ok，workspaceRoot=F:\output\AI集群工作协议
   project.root=…\projects\ui-probe
   project.managementDir=…\projects\ui-probe-管理区   ← 同级
   conflicts=[]，两个目录均未创建（预览零写入）
journal：project_init_planned / project_init_result 均带 workspaceRoot
```

### 数字

| 门禁 | 结果 |
|---|---|
| `selftest` | **28 / 28** |
| `bootstrap-check` | **15 / 15** |
| `contract` | **20 / 0** |
| `conformance` | 7 / 7 |
| `persistence-check` | 10 / 10 |

**边界**：UI 表单只覆盖 `projectName` / `wish` / `dryRun`（`root` 用默认 `<ws>/projects/<slug>`）；
`managementRoot` 的 UI 编辑留待后续。

**预算**：R8（task-38 单列预算 6，本文件累计记录）。

---

## R9（task-39）· 多工作区独立 journal（ServicePool + registry）· 2026-10-30

规格：`control_plane/MULTI-WORKSPACE独立journal.md`。

### ① 结构

```
src/workspaces/pool.ts   ServicePool（新）
<workspace>/.l0-control/ journal.jsonl + core-state/     ← 每个工作区一份
<primaryStateDir>/workspaces.json                        ← registry（workspaceRoot → stateDir）
```

- 主工作区（插件实例 workspaceRoot）**沿用旧 stateDir**（如 `.l0-control-autonomy-2`，旧数据不迁）；
- 其他工作区默认 `<workspaceRoot>/.l0-control`；
- 每实例独立 `L0ControlService` → 独立 persistence / **独立 lock** / 独立 journal / snapshot；
- registry 记录 `workspaceRoot → stateDir`，重启据此恢复列表。

### ② 解析与路由

- `pool.resolveWorkspaceRoot(agent)`：DSH `workingDirectory.ensure(agent)`（兼容返回 string / `{path}`）→
  失败回退主工作区；
- 工具入口：解析 cwd → `pool.get(root)` → **该实例**上做 access guard + authorize + 观测 →
  执行**该实例同名 tool**（每实例工具懒建并缓存；同名工具只注册一次，仅路由）；
- `auth` / `access_denied` 审计行带 `workspaceRoot`。

### ③ 侧车

- `GET /ui/snapshot?workspaceRoot=&sessionId=` → 选实例；
- `GET /ui/workspaces` → registry 列表 + 每项 `stateDir/journalPath/journalEvents/counts/instantiated`；
- `GET/POST /ui/access` 支持 `workspaceRoot`；UI 的 snapshot / access / project-init 请求都带当前工作区 path。

### ④ 测试（selftest 28 → 29）

单条覆盖：`pool.get(A)` 与 `pool.get(B)` →
- `stateDir` 分别 = `<A>/<配置 stateDir>` 与 `<B>/.l0-control>`，`journalPath` 不同；
- A/B 各自 `wish_submit` 后**各自 journal 只含自己的愿望**（隔离断言）；两边 counts 都是 6 nodes；
- **并发 claim** 同节点 → 两边都 `ok:true`（不共享锁）；
- `resolveWorkspaceRoot` 按 cwd 返回 A / B；
- 新池读同一 registry → `list()` 同时含 A、B（reload 恢复）。

### ⑤ 真宿主验证

```
GET /ui/workspaces
  - F:\output\AI集群工作协议                      stateDir=…\.l0-control-autonomy-2   events=253  instantiated=true
  - F:\output\AI集群工作协议\projects\multi-ws-demo stateDir=…\multi-ws-demo\.l0-control events=0   instantiated=true
GET /ui/snapshot?workspaceRoot=…\projects\multi-ws-demo&sessionId=<me>
  → workspaceRoot=B、stateDir=B\.l0-control、counts {0,0,0,0}、access 按实例默认 disabled
```
即：第二工作区懒建、独立目录、各自 access/统计，主工作区旧数据不受影响。

### 数字

| 门禁 | 结果 |
|---|---|
| `selftest` | **29 / 29** |
| `contract` | **20 / 0** |
| `bootstrap-check` | 15 / 15 |
| `conformance` | 7 / 7 |
| `persistence-check` | 10 / 10 |

**边界**：不做跨工作区聚合图（规格明示）；非主工作区默认 `.l0-control`，如需改名要显式迁移；
registry 里可能留下已删除目录的条目（列表会显示 events=0，不报错）。

**预算**：R9（task-39 单列预算 10，本文件累计记录）。

---

## R10（task-40）· 黑板增量 + 能力包上下文 + 容量/摘要 · 2026-10-30

### ① 黑板增量（cursor）

`uiSnapshot({sessionId, sinceSeq?})`：

| 情形 | 行为 |
|---|---|
| 无 `sinceSeq` | `blackboardMode='initial'`，最近 **40** 条（倒序），`blackboardTruncated = total>40` |
| `sinceSeq ≤ total` | `'incremental'`，只回 `sinceSeq` 之后的新行（最多 40，超出标 truncated），`blackboardCursor = 当前 journal 行数` |
| `sinceSeq > total`（超界/回退） | `'fallback'`，回退最近 40 条 + `truncated` |

- 新增返回：`blackboardCursor` / `blackboardTruncated` / `blackboardMode` / `sinceSeq` / `blackboardSummary`；
- `ui-server` 解析 `?sinceSeq=`（非数字忽略）并透传；
- UI：`cursorRef` 保存 cursor，10s 轮询带 `sinceSeq`；`mode === 'incremental'` 时把新行**合并**到已有黑板
  （按 `at|kind|nodeId|text` 去重、最多 40），其余模式直接替换。

### ② 能力包上下文（worker prompt）

- `WorkerPromptInput` 新增 `capability?: string` 与 `contextPack?: string[]`；
- prompt 结构改为：**身份** → `role` 只作"实例寻址/工具白名单/审计独立性"说明（明确**不是固定专家分工**）
  → `## 能力包` → `## 任务上下文` → 工具白名单 → 循环契约；
- 只有**没给能力包**时才用 role profile 的 `mission` 兜底（文本带"兜底"字样）；
- `agent_spawn` 工具/schema 新增 `capability`、`contextPack`（也接受 `cwd`）；`service.spawnAgent` 顶层或 `worker`
  子对象都可传；`workerSummary` 增加 `capability` / `contextPackSize`。

### ④ 容量 + 摘要

黑板**最多 40 条**；新增 `blackboardSummary`：
`{ total, shown, older, byKind, failedDecisions(最近 5), cursor }`，UI 黑板 tab 顶层显示
「总事件 / 已显示 / 更早 / 模式 / 最近失败数」，不再拉全量历史。

### 测试（selftest 29 → 32）

| 用例 | 断言 |
|---|---|
| blackboard | 60 条事件 → initial 40 条、`older=20`、`byKind.task_claimed>0`；`sinceSeq=cursor` → incremental 0 条；追加 3 条后 → incremental 3 条且 cursor+3；`sinceSeq=cursor+100000` → **fallback** 40 条 |
| capability | prompt 含 `## 能力包`/`## 任务上下文`/能力文本/上下文行；**不含 `职责：`**；缺省时含"兜底"与工具白名单 |
| UI（静态） | client.js 含 `cursorRef`、`sinceSeq` 参数、`blackboardMode`、`blackboardSummary`、`mode !== 'incremental'` 合并分支 |

### 真宿主 /ui/snapshot

```
initial        → mode=initial     rows=40 cursor=257 truncated=true  summary{total:257,shown:40,older:217,failed:1}
sinceSeq=257   → mode=incremental rows=0  cursor=257 truncated=false
sinceSeq=+99999→ mode=fallback    rows=40
```

### 数字

| 门禁 | 结果 |
|---|---|
| `selftest` | **32 / 32** |
| `contract` | **20 / 0** |
| `bootstrap-check` | 15 / 15 |
| `conformance` | 7 / 7 |
| `persistence-check` | 10 / 10 |

**边界**：cursor 是"journal 行数"，换 stateDir / journal 被截断时会走 fallback（安全但会重取 40 条）；
摘要只统计 `kind` 与最近 5 条失败，不做全量聚合。

**预算**：R10（task-40 单列预算 6，本文件累计记录）。

---

## R11（task-41）· 工作图组成因子（不做固定架构）· 2026-10-30

规格：`control_plane/GRAPH-工作图组成因子.md`。

### ① 组成因子（`src/core/graphspec.ts` 新）

- **NodeSpec**：`nodeId / title / spec? / capability?（自由标签）/ stage?（阶段不是岗位）/
  deps? / evidenceRequired? / verifierIds? / acceptance? / budget? / writeScopes? / contextRefs? / risk?`
- **GraphSpec**：`{version, wish, nodes[], policies{maxParallel,maxDepth,budgetTokens}, notes[]}`
- `planGraph(spec)`：**纯校验、零写入** → `{ok, planId, errors[], warnings[], ready[], order[], counts, spec}`
  校验项：ID 唯一、deps 存在、无环（DFS）、stage 合法、每节点可验收（acceptance 或 evidence+verifier）、预算合法；
  `order` 是拓扑序（commit 按它 addNode）；`ready` 是无依赖节点。
- `commitGraph(store, spec)`：校验不过 → **零写入**；通过 → 单事务 addNode（拓扑序）+ `wish_submitted`/`graph_created`；
  **幂等**：spec 里全部 nodeId 已存在 → `idempotent:true` 不重复写；部分存在 → `partial-existing` 拒绝半途落图。

### ② 工具与大模型指令

- 新工具 `graph_plan`（`graph.read`）、`graph_commit`（`graph.write`）；工具面 15 → **17**；
- `wish_submit` **不再自动建图**：只写 journal + 返回 `graphPlanRequired:true`、`template`（单节点样例）、
  `instructions`（5 条建图步骤）与现有 graph 现状；
- `WISH_PLAN` 从生产路径移除（`submitWishImpl` 不再使用），仍从 core 导出供 demo/兼容测试；
- README 工具面更新为 17，新增「建图：只有组成因子，没有固定流水线」一节。

### ③ 测试（selftest 32 → 33 + 3 个 e2e 改造）

| 用例 | 断言 |
|---|---|
| `graphspec`（新） | plan 前 nodes=0；菱形 DAG（A→B/C→D）plan `ok/ready=[A]/counts{4,4}` 且**plan 后 nodes 仍 0**；commit 后 nodes=4；再次 commit `idempotent:true` 且 nodes 不变；环/未知 dep/无验收/重复 ID 四类 → `errors` 命中对应 code 且**零写入**；`wish_submit` 返回 `graphPlanRequired` 且 nodes 数不变 |
| `tests/e2e/native-chain.mjs` | C1 改为"wish_submit 只记愿望 + graph_commit 落 6 节点"，全链仍 6/6 |
| `tests/e2e/oracle-diff.mjs` | 显式 2 节点 spec，diff=0 保持 |
| `tests/e2e/run.mjs` | N2 改为 wish_submit(graph-plan-required) + graph_commit 6 节点 |
| `scripts/persistence-check.mjs` | 6 节点链改用 `graphCommit(CHAIN_SPEC)`，10/10 保持 |

### 真宿主

```
wish_submit → {ok:true, graphPlanRequired:true, nodes:[], template, instructions[5]}
graph_plan（4 节点分支+汇合）→ {ok:true, planId:'PLAN-…', ready:['P-SCAN'], order:[P-SCAN,P-FIX-A,P-FIX-B,P-MERGE],
                              counts:{nodes:4,edges:4}, dryRun:true}   ← 落盘 appended=0
graph_status → counts 仍是原来的 6/5/6/0（plan 零写入）；capabilities.toolCount=17
```

### 数字

| 门禁 | 结果 |
|---|---|
| `selftest` | **33 / 33** |
| `contract` | **20 / 0** |
| `bootstrap-check` | 15 / 15 |
| `conformance` | **7 / 7**（native:branch / native:chain / oracle:diff / e2e×2 / g5:real 全 PASS） |
| `persistence-check` | 10 / 10 |
| autonomy（历史 6 节点记录） | 7 / 7 |

**边界**：`graph_plan` 也写一行 `graph_plan_preview` 审计（不是图写入，属 journal 审计）；`commit` 目前不允许"增量追加节点"
（要么整图新提交、要么同图幂等）；UI 尚未做 plan 预览面板（规格标注为可选）。

**预算**：R11（task-41 单列预算 8，本文件累计记录）。