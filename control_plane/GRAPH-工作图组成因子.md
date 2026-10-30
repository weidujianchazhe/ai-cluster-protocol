# 工作图组成因子（不做固定架构）

## 原则

工作图不提供“固定 6 节点”“固定流水线”“固定角色架构”。

只提供可组合的**组成因子**和**按需生成/校验指令**；具体节点、依赖、阶段、验收和并行边界，由 AI 面对具体需求时决定。

## 组成因子

### Node

- `nodeId`：稳定 ID
- `title`
- `spec`：要做什么、边界、约束
- `capability`：自由能力标签（不是固定角色枚举）
- `stage`：research / design / build / audit / deliver（阶段，不是岗位）
- `deps`：依赖的 nodeId
- `evidenceRequired`：需要什么证据（artifact / command / review / custom）
- `verifierIds` / `acceptance`：谁/什么条件可验收
- `budget`：maxTokens / maxParallel
- 可选：`writeScopes`、`contextRefs`、`risk`

### Edge / 依赖

- 只表达“完成先后”和“证据依赖”
- 不表达组织层级、角色从属
- 同一层可并行；强依赖必须串行

### GraphSpec

```json
{
  "version": 1,
  "wish": "原始需求",
  "nodes": [],
  "policies": {
    "maxParallel": 4,
    "maxDepth": 3,
    "budgetTokens": 0
  },
  "notes": []
}
```

## 指令

### graph_plan

输入 `wish + nodes + policies`，只做：

- 结构校验：ID 唯一、依赖存在、无环、stage 合法
- 验收校验：每个节点有 evidence/verifier/acceptance
- 预算校验
- ready 预览（哪些节点一开始可领）
- 返回 `errors` / `warnings` / `planId`，**零写入**

### graph_commit

输入同一 GraphSpec（或 planId），校验通过后落图：

- 幂等：同一 wish 已有图 → 返回 existing
- 写入节点/依赖
- 触发 ready 计算
- 返回 counts / ready

### wish_submit

只记录愿望并返回 GraphSpec 模板/指令，**不再自动生成固定 6 节点**。

## AI 的建图指令（摘要）

1. 先分析需求、约束、风险、可并行点。
2. 只使用 Node/GraphSpec 因子，不套固定模板。
3. 节点数量由工作决定，不由团队规模决定。
4. 每个节点必须可验收；没有验收条件的节点不许落图。
5. 能并行的才并行；强依赖必须显式 deps。
6. 先 `graph_plan` 预览；确认后再 `graph_commit`。
7. 需要多级管理时，用节点依赖和上下文因子表达，不新增固定角色层级。

## 验收

- 任意合法 DAG 可 plan/commit（3 节点、分支、汇合均可）
- 非法：环、未知依赖、无验收、重复 ID → 零写入
- 同一愿望重复 commit 幂等
- `wish_submit` 不再产生固定 6 节点
- 指令文档能让 AI 按需求生成不同结构
