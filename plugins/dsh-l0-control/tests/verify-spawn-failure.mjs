/**
 * spawn 失败的分类与处置：**宿主满了 ≠ 组装失败**。
 *
 * 两种失败对调度器的含义完全相反：
 *
 * | 失败 | 含义 | 正确处置 |
 * |---|---|---|
 * | 宿主并发/配额/容量上限 | 现在派不进去，过一会儿可以 | 节点保持 ready，下一轮重试 |
 * | 组装失败（preset 不存在 / prompt 超长 / role 非法 / provider 未注册） | 重试多少次都一样 | 停止派发，让人介入 |
 *
 * 旧实现把两者都塞进 `spawn-failed`，调度器只能选一种行为，而两种都是错的：
 *  - 一律重试 → 对一个永远失败的节点每轮白烧一次 spawn，还把 journal 刷满同样的错误；
 *  - 一律不重试 → 宿主短暂满载就把整张图的就绪节点全判死。
 *
 * 判据只能靠错误文本：宿主没给稳定的错误码清单，抛出来的可能是 `Error`、带 `code`
 * 的对象、或纯字符串。所以这里钉住的是「分类正确」+「默认安全方向」两件事。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const lib = (name) => pathToFileURL(path.join(root, 'lib', name)).href;
const { classifySpawnFailure, isPermanentSpawnFailure } = await import(lib('native/spawn-failure.js'));
const { NativeTeam } = await import(lib('native/team.js'));

// ── 1. 宿主满载：可重试 ────────────────────────────────────────────────────
const hostCapacity = [
  ['max concurrent activations reached (limit 8)', '结构化文本'],
  ['concurrency limit exceeded', '并发上限'],
  ['too many children in this session', '子会话过多'],
  ['capacity reached for provider spawn', '容量到顶'],
  ['rate limited, try again later', '限流'],
  ['quota exceeded for model', '配额'],
  ['slot pool is full', '槽位池满'],
  ['并发已满，请稍后重试', '中文提示'],
];
for (const [message, label] of hostCapacity) {
  const failure = classifySpawnFailure(new Error(message));
  assert.equal(failure.code, 'host-capacity', `${label}: "${message}" 应判为宿主满载，实际 ${failure.code}`);
  assert.equal(failure.retryable, true, `${label}: 宿主满载必须可重试`);
  assert.equal(isPermanentSpawnFailure(failure), false, `${label}: 宿主满载不是永久失败`);
}
console.log(`PASS 1. 宿主满载 8 种表述全部判为 host-capacity（可重试）`);

// ── 2. 宿主满载的结构化错误码优先于文本 ────────────────────────────────────
for (const code of ['EDSH_LIMIT', 'EDSH_CAPACITY', 'QUOTA_EXCEEDED', 'RATE_LIMITED', 'EBUSY']) {
  // 故意给一段看起来像组装失败的文本：结构化 code 必须胜出
  const failure = classifySpawnFailure(Object.assign(new Error('invalid agent name'), { code }));
  assert.equal(failure.code, 'host-capacity', `${code}: 结构化满载码应优先，实际 ${failure.code}`);
  assert.equal(failure.hostCode, code);
}
console.log('PASS 2. 结构化满载错误码优先于文本判据（5 个码）');

// ── 3. 组装失败：永久，不再派 ──────────────────────────────────────────────
const assembly = [
  ['agent preset "nope" not found', 'preset 不存在'],
  ['unknown preset: foo', '未知 preset'],
  ['preset is not registered', 'preset 未注册'],
  ['maxDepth exceeded: 9 > 4', '递归深度超限'],
  ['prompt exceeds 200000 tokens', '提示词超长（复数形态）'],
  ['prompt too long', '提示词超长'],
  ['context length exceeded', '上下文超限'],
  ['invalid role: NOPE', 'role 非法'],
  ['provider not registered', 'provider 未注册'],
  ['预设 foo 不存在', '中文预设'],
  ['提示词过长', '中文超长'],
];
for (const [message, label] of assembly) {
  const failure = classifySpawnFailure(new Error(message));
  assert.equal(failure.code, 'assembly-failed', `${label}: "${message}" 应判为组装失败，实际 ${failure.code}`);
  assert.equal(failure.retryable, false, `${label}: 组装失败不可重试`);
  assert.equal(isPermanentSpawnFailure(failure), true, `${label}: 组装失败应判为永久`);
}
console.log(`PASS 3. 组装失败 11 种表述全部判为 assembly-failed（永久）`);

// ── 4. 组装失败优先于宿主满载（两组关键字同时出现时）──────────────────────
// 组装失败是**确定性**的，一旦成立重试必然同样失败，所以优先级更高。
// 反过来会让一个永远失败的节点每轮重试一次。
{
  const failure = classifySpawnFailure(new Error('cannot spawn: preset not found (capacity check skipped)'));
  assert.equal(failure.code, 'assembly-failed', '组装失败应优先于同时出现的 capacity 字样');
  assert.equal(failure.retryable, false);
}
console.log('PASS 4. 两组关键字同时出现时，组装失败优先（确定性优先于临时性）');

// ── 5. 认不出来时朝安全方向倒：默认可重试 ──────────────────────────────────
// 把「可重试」误判成永久失败会让节点永久卡死；反过来的代价只是多派几次。
// 成本不对称，所以默认必须可重试。
for (const weird of [new Error('boom'), 'a bare string', null, undefined, {}, Object.assign(new Error(''), { code: 'EWEIRD' })]) {
  const failure = classifySpawnFailure(weird);
  assert.equal(failure.retryable, true, `无法归因时必须可重试（入参 ${JSON.stringify(weird)}）`);
  assert.equal(isPermanentSpawnFailure(failure), false);
}
console.log('PASS 5. 无法归因时默认可重试（两种误判成本不对称，朝安全方向倒）');

// ── 6. NativeTeam 把分类透传到结果上 ───────────────────────────────────────
{
  const mkCtx = (startActivation) => ({
    get: (name) => (name === 'subagents' ? { list: () => ['spawn'], startActivation } : undefined),
  });
  const cases = [
    ['宿主满载', Object.assign(new Error('max concurrent activations reached'), { code: 'EDSH_LIMIT' }), true, 'host-capacity'],
    ['preset 不存在', new Error('agent preset "nope" not found'), false, 'assembly-failed'],
    ['未知异常', new Error('boom'), true, 'spawn-failed'],
  ];
  for (const [label, thrown, expectRetry, expectCode] of cases) {
    const team = new NativeTeam(mkCtx(async () => { throw thrown; }), { provider: 'spawn', maxDepth: 2 });
    const result = await team.spawnAgent({ role: 'CODE', task: 'x' }, { id: 'lead' });
    assert.equal(result.ok, false, `${label}: 应失败`);
    assert.equal(result.retryable, expectRetry, `${label}: retryable 应为 ${expectRetry}`);
    assert.equal(result.failureCode, expectCode, `${label}: failureCode 应为 ${expectCode}`);
    assert.ok(String(result.hint ?? '').length > 0, `${label}: 必须带可读说明`);
  }
}
console.log('PASS 6. NativeTeam 把 retryable/failureCode 透传到 spawn 结果（3 类失败）');

// ── 7. 成功的 spawn 不带 retryable 标记 ────────────────────────────────────
{
  const mkCtx = (startActivation) => ({
    get: (name) => (name === 'subagents' ? { list: () => ['spawn'], startActivation } : undefined),
  });
  const team = new NativeTeam(
    mkCtx(async () => ({ childId: 'child-1', messageId: 'msg-1' })),
    { provider: 'spawn', maxDepth: 2 },
  );
  const result = await team.spawnAgent({ role: 'CODE', task: 'x' }, { id: 'lead' });
  assert.equal(result.ok, true);
  assert.equal(result.retryable, undefined, '成功结果不该带 retryable');
  assert.equal(result.failureCode, undefined, '成功结果不该带 failureCode');
}
console.log('PASS 7. 成功的 spawn 不带失败标记（不给下游制造歧义）');

console.log('\nPASS spawn failure: 宿主满载可重试 / 组装失败永久停止 / 无法归因朝安全方向倒');
