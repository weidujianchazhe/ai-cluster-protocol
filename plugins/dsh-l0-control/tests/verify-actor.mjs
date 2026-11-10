#!/usr/bin/env node
/**
 * 调用者解析（resolveActor）单测：
 *   优先级顺序 / 非法实例被跳过 / 无活 Agent 兜底 plugin / 审计实例排在生产者之前。
 */
import assert from 'node:assert/strict';
import { resolveActor, pickInstanceFromArgs } from '../lib/security/actor.js';

const roleOf = (value) => {
  const m = /^role-([a-z][a-z0-9_]*(?:-[a-z0-9_]+)*)-(\d{2,})$/i.exec(String(value ?? ''));
  return m ? m[1].replace(/-/g, '_').toUpperCase() : null;
};

const base = { tenant: 'acme', roleOfInstance: roleOf };

// 1) instanceId 优先
assert.deepEqual(
  resolveActor({ ...base, args: { instanceId: 'ROLE-CODE-01' }, exec: { agent: { id: 's1' } } }),
  { id: 'ROLE-CODE-01', kind: 'agent', tenant: 'acme', roles: ['CODE'] },
);

// 2) 审计实例必须排在生产者之前（这是 verify_done 不 403 的关键）
assert.equal(
  resolveActor({ ...base, args: { producer_instance: 'ROLE-CODE-01', auditor_instance: 'ROLE-AUDIT_CODE-09' } }).id,
  'ROLE-AUDIT_CODE-09',
);

// 3) 生产者兜底
assert.equal(
  resolveActor({ ...base, args: { producer_instance: 'ROLE-CODE-02' } }).id,
  'ROLE-CODE-02',
);

// 4) camelCase 也认
assert.equal(
  resolveActor({ ...base, args: { producerInstance: 'ROLE-CODE-03' } }).roles[0],
  'CODE',
);

// 5) 非法实例被跳过 → 落到下一个合法项
assert.equal(
  resolveActor({ ...base, args: { instanceId: 'not-an-instance', auditorInstance: 'ROLE-AUDIT_CODE-01' } }).id,
  'ROLE-AUDIT_CODE-01',
);

// 6) 没有实例 → 活 Agent，角色是 ORCH+HUMAN
const byAgent = resolveActor({ ...base, args: {}, exec: { agent: { id: 'session-abc' } } });
assert.equal(byAgent.id, 'session-abc');
assert.deepEqual(byAgent.roles, ['ORCH', 'HUMAN']);

// 7) 既无实例又无活 Agent → plugin
const byPlugin = resolveActor({ ...base, args: {}, exec: null });
assert.equal(byPlugin.kind, 'plugin');
assert.deepEqual(byPlugin.roles, ['PLUGIN', 'HUMAN']);

// 8) pickInstanceFromArgs 顺序
assert.equal(
  pickInstanceFromArgs({ producer_instance: 'ROLE-CODE-01', instanceId: 'ROLE-DESIGN-02' }, roleOf),
  'ROLE-DESIGN-02',
);
assert.equal(pickInstanceFromArgs(null, roleOf), null);

// 9) 不因非法输入抛错（fail-safe，不 fail-closed 到异常）
assert.doesNotThrow(() => resolveActor({ ...base, args: { instanceId: 123, producerInstance: {} } }));

console.log('PASS actor: 9/9（优先级 / 审计前置 / 兜底 / 容错）');
