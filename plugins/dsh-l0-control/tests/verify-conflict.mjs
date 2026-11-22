/**
 * 冲突检测与路由（`core/conflict.ts`）。
 *
 * 这块逻辑 7.7 KB、被 `state.ts` 真实调用、输出决定路由到 agent 还是人；
 * 之前没有专项测试，本文件现在覆盖检测、路由与统计的关键分支。
 *
 * 它检的是**视角（facet）之间**的冲突，不是节点产物之间的一致性：
 *
 *   FacetDigest[]（capability / evidence / org / risk / goal-drift 各自的主张）
 *     → detectConflicts  检出「两边各主张什么」说得清的冲突
 *     → routeConflicts   按「解决它需要什么能力」路由
 *
 * 设计原则（写进注释了）：**root 不裁决，root 只路由。人不是默认裁决者，而是能力来源之一。**
 * 人的位置只在两类冲突上不可替代：实用（需要真实体验）与价值（需要立场）。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const lib = (n) => pathToFileURL(path.join(root, 'lib', n)).href;
const core = await import(lib('core/index.js'));

// ── 1. HUMAN_ONLY_NEEDS：只有人能提供的两类能力 ────────────────────────
{
  assert.ok(core.HUMAN_ONLY_NEEDS.has('human-experience'), 'human-experience 必须是人类专属');
  assert.ok(core.HUMAN_ONLY_NEEDS.has('human-value'), 'human-value 必须是人类专属');
  assert.equal(core.HUMAN_ONLY_NEEDS.size, 2, '故意只有两类：实用与价值。别的都能由 agent 补');
}
console.log('PASS 1. HUMAN_ONLY_NEEDS 恰好两类（human-experience / human-value）');

// ── 2. 空输入不崩 ──────────────────────────────────────────────────────
{
  const conflicts = core.detectConflicts([], []);
  assert.deepEqual(conflicts, [], '无视角、无节点 → 无冲突');
  const routed = core.routeConflicts([], { availableCapabilities: new Map(), catalogCapabilities: [] });
  assert.deepEqual(routed, [], '空冲突列表 → 空路由结果');
  const summary = core.summarizeRouting([]);
  assert.equal(typeof summary, 'object', 'summarizeRouting 对空输入要返回对象');
}
console.log('PASS 2. 空输入：detect/route/summarize 都不崩');

// ── 2b. detectConflicts 的五类触发条件都能检出 ─────────────────────────
{
  const digest = (facetId, matched, counts) => ({ facetId, matched, counts, notes: [], nodes: [] });
  const digests = [
    digest('capability', 6, { '(无标签)': 1, DELIVER: 1 }),
    digest('org', 6, {}),
    digest('evidence', 6, { both: 1 }),
    digest('risk', 6, { retried: 2 }),
    digest('goal-drift', 6, { signals: 1 }),
    digest('usability', 6, { signals: 1 }),
  ];
  const nodes = [{
    nodeId: 'N-DANGLING', title: '悬空依赖', capability: 'CODE', stage: 'build', status: 'ready',
    org: { assignee: null, deps: ['GHOST'] }, requirements: [],
    evidence: { required: [], verifiers: [] }, cost: { maxTokens: 0 }, risk: { attempts: 0, updatedAt: '' },
  }];
  const found = core.detectConflicts(digests, nodes);
  const bySubject = new Map(found.map((c) => [c.subject, c]));

  assert.ok(bySubject.has('1 个无标签节点'), '组织 says doing but capability is unlabeled');
  assert.deepEqual(bySubject.get('1 个无标签节点').needs, ['requirements-analysis']);

  assert.ok(bySubject.has('证据要求与审计覆盖'), 'evidence requirement but no AUDIT capability');
  assert.deepEqual(bySubject.get('证据要求与审计覆盖').needs, ['audit-independence']);

  assert.ok(bySubject.has('反复失败与目标定义'), 'retried + goal drift');
  assert.deepEqual(bySubject.get('反复失败与目标定义').needs, ['requirements-analysis', 'human-value']);

  assert.ok(bySubject.has('交付前的实用验收'), 'deliver node + usability signals');
  assert.deepEqual(bySubject.get('交付前的实用验收').needs, ['human-experience']);

  assert.ok(bySubject.has('1 个节点有悬空依赖'), 'dangling dep');
  assert.deepEqual(bySubject.get('1 个节点有悬空依赖').needs, ['code-repair']);

  assert.ok(found.every((c, i) => c.id === `CF-${i + 1}`), 'ID 应稳定、连续');
  assert.ok(found.every((c) => c.route === 'unresolved'), 'detect 阶段只检测，不裁决/路由');
  console.log('PASS 2b. detectConflicts 五类触发：无标签 / 证据无审计 / 重试+目标偏移 / 交付实用性 / 悬空依赖');
}

// ── 3. 路由：有人类专属能力 → 升级给人，并写明理由 ─────────────────────
{
  const conflicts = [
    {
      id: 'C1',
      subject: '按钮颜色该用哪个',
      type: 'value',
      between: [
        { facet: 'a', text: '用红' },
        { facet: 'b', text: '用蓝' },
      ],
      needs: ['human-value'],
      route: 'unresolved',
      reason: '',
    },
  ];
  const routed = core.routeConflicts(conflicts, {
    availableCapabilities: new Map([['human-value', ['someone']]]),
    catalogCapabilities: [],
  });
  assert.equal(routed.length, 1);
  assert.equal(routed[0].route, 'human', 'human-value 必须路由给人');
  assert.ok(routed[0].reason.length > 0, '必须写明为什么只有人能判');
}
console.log('PASS 3. 人类专属能力 → route=human，且 reason 非空（不说清就不许静默升级）');

// ── 4. 路由：图里有 agent 声明了该 capability → 派给它 ─────────────────
{
  const conflicts = [
    {
      id: 'C2',
      subject: '接口字段名不一致',
      type: 'technical',
      between: [
        { facet: 'a', text: 'user_id' },
        { facet: 'b', text: 'userId' },
      ],
      needs: ['api-design'],
      route: 'unresolved',
      reason: '',
    },
  ];
  const routed = core.routeConflicts(conflicts, {
    availableCapabilities: new Map([['api-design', ['NODE-A']]]),
    catalogCapabilities: [],
  });
  assert.equal(routed[0].route, 'agent', '图里有该能力 → 路由给 agent');
  assert.equal(routed[0].routedTo, 'NODE-A', 'routedTo 必须指向承接者');
}
console.log('PASS 4. 图里有能力 → route=agent 且 routedTo 指向承接节点');

// ── 5. 路由：都没有 → 仍路由给 human，但理由是「集群缺口」─────────────
{
  const conflicts = [
    {
      id: 'C3',
      subject: '需要一个没人会的能力',
      type: 'technical',
      between: [
        { facet: 'a', text: 'x' },
        { facet: 'b', text: 'y' },
      ],
      needs: ['quantum-chemistry'],
      route: 'unresolved',
      reason: '',
    },
  ];
  const routed = core.routeConflicts(conflicts, {
    availableCapabilities: new Map(),
    catalogCapabilities: [],
  });
  // 注意：**不是 unresolved**。第 4 步「都没有」也路由给 human，理由写明「集群缺口」。
  // 设计取向是「宁可找人，也不留悬案」——见下面组 9 的显式验证。
  assert.equal(routed[0].route, 'human', '无人有能力 → 仍路由给 human（记作集群缺口）');
  assert.ok(/缺口/.test(routed[0].reason), `reason 必须点明是「能力缺口」而不是人的日常工作量：${routed[0].reason}`);
  assert.ok(/quantum-chemistry/.test(routed[0].reason), 'reason 要写明缺的是哪个能力');
}
console.log('PASS 5. 无人有能力 → route=human，reason 点明「集群缺口」并写出缺哪个能力');

// ── 补充：`unresolved` 只是入参默认值，routeConflicts 保证不遗留它 ─────
{
  // 类型声明是 `'agent' | 'human' | 'unresolved'`，但实现里第 4 步落到 human。
  // 换句话说：**路由之后不存在「悬而未决」的终态**，每个冲突都有人或节点接手。
  const inputs = [
    { id: 'a', subject: 's', type: 'value', between: [{ facet: 'x', text: '1' }, { facet: 'y', text: '2' }], needs: ['human-value'], route: 'unresolved', reason: '' },
    { id: 'b', subject: 's', type: 'technical', between: [{ facet: 'x', text: '1' }, { facet: 'y', text: '2' }], needs: ['api-design'], route: 'unresolved', reason: '' },
    { id: 'c', subject: 's', type: 'requirement', between: [{ facet: 'x', text: '1' }, { facet: 'y', text: '2' }], needs: ['no-one-has-this'], route: 'unresolved', reason: '' },
  ];
  const routed = core.routeConflicts(inputs, {
    availableCapabilities: new Map([['api-design', ['N1']]]),
    catalogCapabilities: [],
  });
  assert.equal(routed.filter((c) => c.route === 'unresolved').length, 0,
    '路由后不得遗留 unresolved —— 否则等于把冲突丢回给人还不说为什么');
  assert.deepEqual(routed.map((c) => c.route), ['human', 'agent', 'human']);
}
console.log('PASS 补充. routeConflicts 不遗留 unresolved：每个冲突都落到 human 或 agent');

// ── 6. 路由：catalog 里能拉 → 按目录拉取 ───────────────────────────────
{
  const conflicts = [
    {
      id: 'C4',
      subject: '需要图像处理',
      type: 'technical',
      between: [
        { facet: 'a', text: 'p' },
        { facet: 'b', text: 'q' },
      ],
      needs: ['image-processing'],
      route: 'unresolved',
      reason: '',
    },
  ];
  const routed = core.routeConflicts(conflicts, {
    availableCapabilities: new Map(),
    catalogCapabilities: ['image-processing'],
  });
  assert.equal(routed[0].route, 'agent', 'catalog 里能拉 → 走能力拉取，仍记作 agent');
}
console.log('PASS 6. catalog 里能拉 → route=agent（走能力拉取路径）');

// ── 7. 路由不改原对象（纯函数语义）────────────────────────────────────
{
  const original = {
    id: 'C5',
    subject: 's',
    type: 'technical',
    between: [{ facet: 'a', text: '1' }, { facet: 'b', text: '2' }],
    needs: ['api-design'],
    route: 'unresolved',
    reason: '原样',
  };
  const snapshot = JSON.stringify(original);
  core.routeConflicts([original], {
    availableCapabilities: new Map([['api-design', ['N']]]),
    catalogCapabilities: [],
  });
  assert.equal(JSON.stringify(original), snapshot, 'routeConflicts 不得原地改入参（便于回放与复用）');
}
console.log('PASS 7. routeConflicts 不改原对象（纯函数语义）');

// ── 8. summarizeRouting 统计口径 ──────────────────────────────────────
{
  const summary = core.summarizeRouting([
    { id: 'a', subject: 's', type: 'technical', between: [{ facet: 'x', text: '1' }, { facet: 'y', text: '2' }], needs: [], route: 'agent', reason: 'r' },
    { id: 'b', subject: 's', type: 'value', between: [{ facet: 'x', text: '1' }, { facet: 'y', text: '2' }], needs: [], route: 'human', reason: 'r' },
    { id: 'c', subject: 's', type: 'requirement', between: [{ facet: 'x', text: '1' }, { facet: 'y', text: '2' }], needs: [], route: 'unresolved', reason: 'r' },
  ]);
  const total = summary.byRoute.agent + summary.byRoute.human + summary.byRoute.unresolved;
  assert.equal(total, 3, 'byRoute 三类计数之和应等于冲突总数');
  assert.equal(summary.byRoute.agent, 1);
  assert.equal(summary.byRoute.human, 1);
  assert.equal(summary.byRoute.unresolved, 1);
}
console.log('PASS 8. summarizeRouting：byRoute 三类计数正确');

console.log('\n全部通过：conflict.ts 的检测/路由/统计都有覆盖了。');
