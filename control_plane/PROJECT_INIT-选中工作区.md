# project_init：按选中工作区 + 同级管理区

## 目标

1. `project_init` 接受 `workspaceRoot`（别名 `selectedWorkspace` / `workspacePath`）；工程区、管理区都必须落在该工作区下。
2. 默认管理区改为**同级** `<projectRoot>-管理区`，对齐现有管理区技能包命名（如 `AI集群工作协议-管理区`）。
3. UI「项目管理」增加“新建项目”入口，把当前选中工作区的 path 传给侧车。

## 安全规则

- `workspaceRoot` 必须是已存在的目录；允许等于插件实例 workspaceRoot，或位于 `path.dirname(插件 workspaceRoot)` 下（同父工作区）；越界拒绝 `workspace-root-outside-allowed-parent`。
- `root` 默认 `<workspaceRoot>/projects/<slug>`；必须落在 `workspaceRoot` 下。
- `managementRoot` 默认 `<root>-管理区`；必须落在 `workspaceRoot` 下（同级允许，因为仍在 workspace 内）。
- 其余 dry-run / marker 幂等 / 非空冲突 / git 规则不变。
- 旧项目 marker 里 `managementDir` 不变；新项目才用同级默认。

## API

```ts
project_init({
  projectName, wish, slug?,
  workspaceRoot?,        // 新；别名 selectedWorkspace / workspacePath
  root?, managementRoot?,
  dryRun?, gitInit?, management?
})
```

返回 `project.workspaceRoot`，`project.root`，`project.managementDir`。

## UI

项目管理页顶部增加：

```text
[新建项目]  → 小表单：项目名 / 愿望 / 预览 / 创建
```

- 使用 `activeSidebar.path` 作为 `workspaceRoot`；
- `managementMode` 必须 `auto` 或 `on`，off 时按钮禁用并提示；
- `preview` 调 `dryRun:true`；`create` 调 `dryRun:false`；
- 创建后刷新 snapshot，显示 actions/conflicts/git。

## 验收

- 选中工作区 A → 建在 A 下，不在插件实例默认目录。
- 默认管理区为 `<root>-管理区`，不是 `<root>/管理区`。
- 越界 workspaceRoot / root / managementRoot 零写入。
- 旧项目 marker 兼容。
- UI 预览零写入；创建后结构齐全；management off 拒绝。
