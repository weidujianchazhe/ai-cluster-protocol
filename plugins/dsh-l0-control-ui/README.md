# AI集群工作协议 · DSH UI 插件

给 `@local/dsh-l0-control` 提供 **侧边栏入口** 和 **按工作区/对话组织的总览面板**。

> **成本提醒**：这是许愿式集群工作面板，会派发多个子 Agent，子 Agent 可继续递归派发；工作量大，token 消耗也显著更高。请设置预算、限制并发/深度后再启用。

## 内容

- 侧边栏 `sidebar.panellist`：id `l0-control`，order 40，显示名 **AI集群工作协议**。
- 主面板 `main` key `l0-control`，按工作区分栏：
  - **团队**：agentTeams 成员数、角色、状态；原生实例。
  - **共同任务**：TeamTask 投影的任务、状态、owner。
  - **黑板**：最近 40 条 journal 事件（只读）。
  - **工作区**：工程目录、管理区、插件目录、状态目录；路径可复制、目录内容可查看。
- 数据来自只读 UI 侧车 `http://127.0.0.1:47831/ui/snapshot`，每 10 秒刷新。
- 实时图状态仍以 Agent 调 `graph_status` 为准；面板不复制事实源。

## 安装

由 dsh 的 `plugin_manager install_bundle` 安装本目录。

## 设计约束

- 只注册 `sidebar.panellist` 与 `main` 两个 slot；不替换 root、不写 DOM。
- 颜色全部用 `--dsw-alias-*` token；只 require React。
- UI 侧车只读、绑定 127.0.0.1；端口冲突/失败只记 journal，不影响控制面主功能。

