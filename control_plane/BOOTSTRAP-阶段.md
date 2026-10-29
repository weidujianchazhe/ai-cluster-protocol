# Bootstrap 阶段（project_init）

> 目标：让愿望在进入 6 节点图前，能安全地创建工程区 + 管理区 + 可选 git init。
> 默认 dry-run；幂等；防覆盖；安全阀；不做 commit/push。

## 工具

`project_init(input)`

```ts
{
  projectName?: string;
  wish?: string;
  slug?: string;
  root?: string;              // 必须在 workspaceRoot 下，默认 workspaceRoot/projects/<slug>
  dryRun?: boolean;           // 默认 true；只有 false 才写
  gitInit?: boolean;          // 默认 true；只 init，不 commit/push
  management?: boolean;       // 默认 true
  allowEmptyExisting?: boolean; // 默认 false；空目录也要求显式允许
}
```

返回：

```ts
{
  ok: boolean;
  dryRun: boolean;
  project: { name; slug; root; managementDir; marker };
  actions: { kind; path; status: 'would-create'|'created'|'skipped'|'conflict'|'would-init'|'initialized' }[];
  conflicts: string[];
  git: { state: 'existing'|'initialized'|'skipped'|'missing'|'would-init'; detail?: string };
  next: string;
}
```

## 安全规则

1. **根目录白名单**：`workspaceRoot`（可选，别名 `selectedWorkspace`/`workspacePath`）必须是已存在目录，
   且等于插件实例 workspaceRoot 或位于其**父目录**下；越界 → `workspace-root-outside-allowed-parent`。
   `root` 必须落在该 `workspaceRoot` 下；`..` 逃逸拒绝（`root-outside-workspace`）。
2. **默认 dry-run**：`dryRun !== false` 时只读; 不 mkdir、不写文件、不 git。
3. **幂等**：marker `.l0-control/project.json` 存在且 slug 匹配 → 返回现有；不重写。
4. **防覆盖**：目标目录非空且无 marker → `conflict:not-empty`，零写入。
5. **git**：只有 `.git` 不存在才 `git init`；绝不 commit/push；git 缺失 → `git.missing`，不阻断文件创建。
6. **原子性**：先 preflight 全部通过再写；失败清理本次创建的目录（尽力）。
7. **可审计**：写 `project_init_planned` / `project_init_result` 到插件 journal。

## 创建内容

```text
<root>/
  README.md
  .gitignore
  src/                 （空目录）
  docs/
  .l0-control/project.json

<root>-管理区/           （**同级**，默认目录；不是 <root>/管理区）
  INDEX.md
  STATE.md
  tasks/BOOTSTRAP.md
  designs/BOOTSTRAP.md
  reports/
```

- 已存在文件一律 skip，不覆盖。
- 管理区骨架是“可继续被 closeout/new-card 接管”的初始态，不是完整协议实现。
- **管理区默认同级**（`<root>-管理区`，对齐 `AI集群工作协议-管理区` 的命名）；可用 `managementRoot` 覆盖。
  旧项目的 marker 里记录的是 `<root>/管理区` 时保持原样（不迁移、不重建）。

## 验收

- dry-run：目录不存在、零写入、返回 would-create。
- execute：创建上述结构、marker、git init；重复 execute 幂等。
- 非空目录冲突：零写入。
- 越界 root：拒绝。
- git 缺失：文件创建成功，git.missing。
- 单测 + 工具契约更新。
