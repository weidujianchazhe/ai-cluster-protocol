# 多工作区独立 journal（registry + per-workspace store）

## 目标

每个工作区一份自己的状态：

```text
<workspace>/.l0-control/
  journal.jsonl
  core-state/
```

互不混 journal、互不抢锁、统计独立。

## 设计

1. **workspaceRoot 解析**
   - 工具入口用 DSH `workingDirectory.ensure(exec.agent)` 取当前会话工作目录；
   - 取不到时回退实例配置 workspaceRoot。

2. **ServicePool**
   - `get(workspaceRoot)` 懒建 `L0ControlService`；
   - 当前工作区沿用旧 stateDir（`.l0-control-autonomy-2`，兼容已有数据）；
   - 其他工作区默认 `<workspaceRoot>/.l0-control`；
   - 每实例独立 persistence/lock/journal/snapshot。
   - registry 文件记录 `workspaceRoot → stateDir`，便于重启恢复。

3. **工具路由**
   - 工具执行前解析 workspaceRoot → `pool.get` → 取该实例同名 tool 执行；
   - 权限/access/观测按实例；
   - 同名工具不重复注册，只是路由。

4. **UI / 侧车**
   - `/ui/snapshot?workspaceRoot=...&sessionId=...` 选对应实例；
   - `/ui/workspaces` 返回 registry 列表 + counts；
   - 面板工作区选择传 path；无实例显示未接入。

5. **锁**
   - 每实例独立 stateDir/lock；两个工作区可并行，不共享锁。

## 边界

- 旧单一 journal 不自动拆分；当前工作区映射到旧 stateDir。
- 不做跨工作区聚合图；只做各自独立。
- registry 只记录本机路径，不写个人身份。

## 验收

- 在工作区 A/B 分别 `wish_submit`，生成两个不同 journal 路径；
- A 的 ready/task 不出现在 B；
- 两工作区同时 claim 不抢锁；
- reload 后 registry 恢复两实例；
- UI 按 workspaceRoot 查询返回各自 counts。
