/**
 * 派发登记：从 journal 推导「这个节点还有活 worker 吗」。
 *
 * 旧实现是进程内 `Set`，有两个**方向相反**的错，都被本测试钉住：
 *
 *   1. 重启即失忆 → 同一节点被再派一个 worker（浪费 spawn，现场像幽灵 worker）
 *   2. 永不释放 → worker claim 被拒后按契约停手，节点重新 ready 却再没人看
 *      ⇒ **永久停滞**（不报错，只安静地卡住，比第 1 个严重得多）
 *
 * 所以判据不能是「派过没有」，必须是「能否证明它还活着」。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const lib = (name) => pathToFileURL(path.join(root, 'lib', name)).href;
const { deriveEnqueueState, applyEnqueueRows, emptyEnqueueState, sweepStale, trimReleased, explainRelease, isEnqueueReleaseReason } = await import(lib('dispatch/enqueue-state.js'));

const results = [];
const eq = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok, detail: ok ? '' : `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}` });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}\n`);
};
const ok = (name, cond, detail) => {
  results.push({ name, ok: Boolean(cond), detail: detail ?? '' });
  process.stdout.write(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` — ${detail ?? ''}`}\n`);
};

const T = (seconds) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
const row = (kind, nodeId, at, extra = {}) => ({ kind, nodeId, at: T(at), ...extra });

process.stdout.write('\n派发登记推导\n' + '─'.repeat(70) + '\n');

// ═══ 1. 基础：node_enqueued → 登记 ═════════════════════════════════════════
{
  const state = deriveEnqueueState([row('node_enqueued', 'N1', 1, { instanceId: 'role-code-01', sessionId: 's1' })]);
  eq('node_enqueued 登记一个节点', [...state.live.keys()], ['N1']);
  eq('登记带实例与会话', [state.live.get('N1').instanceId, state.live.get('N1').sessionId], ['role-code-01', 's1']);
  eq('未确认 claim 前 claimed=false', state.live.get('N1').claimed, false);
}

// ═══ 2. task_claimed / heartbeat_ok → 确认存活 ═══════════════════════════════
{
  const state = deriveEnqueueState([
    row('node_enqueued', 'N1', 1, { sessionId: 's1' }),
    row('task_claimed', 'N1', 2),
    row('task_heartbeat_ok', 'N1', 5),
  ]);
  eq('claim 后 claimed=true', state.live.get('N1').claimed, true);
  eq('心跳刷新时间', state.live.get('N1').at, T(5));
}

// ═══ 3. ★ 永不释放的反面：claim 被拒必须释放 ═══════════════════════════════
// 这是旧实现最严重的缺陷：worker 因容量被拒后停手，节点重新 ready，
// 但 Set 里还留着 → 再没人看它 → 永久停滞。
{
  const state = deriveEnqueueState([
    row('node_enqueued', 'N1', 1, { sessionId: 's1' }),
    row('task_claim_rejected', 'N1', 2, { error: 'graph_capacity' }),
  ]);
  eq('claim 被拒 → 释放（否则永久停滞）', [...state.live.keys()], []);
  eq('释放原因可解释', state.released.get('N1').reason, 'claim-rejected');
  ok('释放说明含中文解释', explainRelease(state.released.get('N1')).includes('准入拒绝'));
}

// ═══ 4. 续租失败必须释放 ═══════════════════════════════════════════════════
{
  const state = deriveEnqueueState([
    row('node_enqueued', 'N1', 1, { sessionId: 's1' }),
    row('task_claimed', 'N1', 2),
    row('task_heartbeat_failed', 'N1', 9),
  ]);
  eq('续租失败 → 释放', [...state.live.keys()], []);
  eq('原因 heartbeat-failed', state.released.get('N1').reason, 'heartbeat-failed');
}

// ═══ 5. 完成 / 回收 也要释放 ═══════════════════════════════════════════════
{
  const done = deriveEnqueueState([
    row('node_enqueued', 'N1', 1, { sessionId: 's1' }),
    row('verify_done_requested', 'N1', 3),
  ]);
  eq('done → 释放', [...done.live.keys()], []);
  eq('原因 completed', done.released.get('N1').reason, 'completed');

  const reaped = deriveEnqueueState([
    row('node_enqueued', 'N2', 1, { sessionId: 'sess-x' }),
    row('agent_reap_applied', null, 4, { applied: ['sess-x'], archived: [] }),
  ]);
  eq('会话被回收 → 释放对应节点', [...reaped.live.keys()], []);
  eq('原因 reaped', reaped.released.get('N2').reason, 'reaped');
}

// ═══ 6. 释放后重新登记 → 释放记录被清掉（能解释「又派了一次」）═══════════════
{
  const state = deriveEnqueueState([
    row('node_enqueued', 'N1', 1, { sessionId: 's1' }),
    row('task_claim_rejected', 'N1', 2),
    row('node_enqueued', 'N1', 10, { sessionId: 's2', instanceId: 'role-code-02' }),
  ]);
  eq('重新登记后 live 有新记录', state.live.get('N1').sessionId, 's2');
  eq('上一次释放记录被清掉', state.released.has('N1'), false);
}

// ═══ 7. node_enqueue_failed 不改状态 ═══════════════════════════════════════
{
  const state = deriveEnqueueState([
    row('node_enqueued', 'N1', 1, { sessionId: 's1' }),
    row('node_enqueue_failed', 'N1', 2, { error: 'instance-exists' }),
  ]);
  eq('派发失败不释放已有登记', [...state.live.keys()], ['N1']);
  eq('未标注 retryable 的失败不入册（按可重试处理）', state.failed.size, 0);
}

// ═══ 7b. ★ 确定性失败入册：重试无用的失败必须停止派发 ═══════════════════════
// 旧实现只有一行 `continue`：失败既不登记也不记住。于是「preset 不存在」这种
// 重试一万次也不会变好的失败，每轮都白烧一次 spawn，还把 journal 刷满同样的错误。
// 关键在于**只记 retryable === false**：宿主满载是临时的，记成永久失败会让节点
// 在宿主短暂繁忙时被永久判死。
{
  const state = deriveEnqueueState([
    row('node_enqueue_failed', 'A', 1, { error: 'spawn-failed', retryable: false, failureCode: 'assembly-failed' }),
    row('node_enqueue_failed', 'B', 2, { error: 'spawn-failed', retryable: true, failureCode: 'host-capacity' }),
    row('node_enqueue_failed', 'C', 3, { error: 'spawn-failed', retryable: null }),
  ]);
  eq('确定性失败入册', [...state.failed.keys()], ['A']);
  eq('失败码与说明保留', [state.failed.get('A').code, state.failed.get('A').message], ['assembly-failed', 'spawn-failed']);
  eq('宿主满载不入册', state.failed.has('B'), false);
  eq('缺 retryable 字段不入册', state.failed.has('C'), false);
  eq('失败不占 live（不冒充活 worker）', state.live.size, 0);
}

// ═══ 7c. ★ 成功派发清掉失败登记：这是唯一的解除路径 ═══════════════════════════
// 人改完配置后手动派一次，登记自动失效。没有这条，误判一次就永久卡死。
{
  const state = deriveEnqueueState([
    row('node_enqueue_failed', 'A', 1, { error: 'spawn-failed', retryable: false, failureCode: 'assembly-failed' }),
    row('node_enqueued', 'A', 5, { sessionId: 's9' }),
  ]);
  eq('成功派发后失败登记被清', state.failed.has('A'), false);
  eq('节点转为正常登记', [...state.live.keys()], ['A']);
}

// ═══ 7d. 失败登记同样有界（长跑不能线性膨胀）═══════════════════════════════
{
  const rows = [];
  for (let i = 0; i < 300; i += 1) {
    rows.push(row('node_enqueue_failed', `F${i}`, i + 1, { error: 'x', retryable: false, failureCode: 'assembly-failed' }));
  }
  const state = trimReleased(deriveEnqueueState(rows), 50);
  eq('失败登记裁剪到 50 条', state.failed.size, 50);
}

// ═══ 8. 乱序 journal：不把记录改旧 ═════════════════════════════════════════
// 跨进程/并发写时行序不一定严格按时间。若用「最后一行的时间」当活动时间，
// 乱序会把一个活跃 worker 判成失联。
{
  const state = deriveEnqueueState([
    row('node_enqueued', 'N1', 1, { sessionId: 's1' }),
    row('task_heartbeat_ok', 'N1', 20),
    row('task_heartbeat_ok', 'N1', 10), // 旧时间戳后到
  ]);
  eq('乱序不把活动时间改旧', state.live.get('N1').at, T(20));
}

// ═══ 9. ★ 沉默即失联：超时释放 ═════════════════════════════════════════════
// worker 崩掉不留任何事件。不能因为「没收到死亡通知」就永久占位。
{
  const rows = [row('node_enqueued', 'N1', 1, { sessionId: 's1' })];
  const fresh = deriveEnqueueState(rows, { now: Date.parse(T(100)), maxAgeMs: 600000 });
  eq('未超时 → 仍算活', [...fresh.live.keys()], ['N1']);

  const stale = deriveEnqueueState(rows, { now: Date.parse(T(10000)), maxAgeMs: 600000 });
  eq('超时 → 释放', [...stale.live.keys()], []);
  eq('原因 stale', stale.released.get('N1').reason, 'stale');
  ok('stale 解释承认「无法证明仍在运行」', explainRelease(stale.released.get('N1')).includes('无法证明'));
}

// ═══ 10. maxAgeMs=0 时不判定（默认配置关闭该兜底）═══════════════════════════
{
  const rows = [row('node_enqueued', 'N1', 1, { sessionId: 's1' })];
  const state = deriveEnqueueState(rows, { now: Date.parse(T(99999)), maxAgeMs: 0 });
  eq('maxAgeMs=0 → 不做过期判定', [...state.live.keys()], ['N1']);
}

// ═══ 11. ★ 重启后不失忆：同一个 journal 两遍推导结果一致 ════════════════════
{
  const rows = [
    row('node_enqueued', 'A', 1, { sessionId: 'sA' }),
    row('task_claimed', 'A', 2),
    row('node_enqueued', 'B', 3, { sessionId: 'sB' }),
    row('task_heartbeat_failed', 'B', 4),
    row('node_enqueued', 'C', 5, { sessionId: 'sC' }),
  ];
  const first = deriveEnqueueState(rows);
  const second = deriveEnqueueState(rows); // 模拟重启后重放
  eq('重启后 live 集合一致', [...second.live.keys()].sort(), [...first.live.keys()].sort());
  eq('重启后 A 仍在（有活 worker）', second.live.has('A'), true);
  eq('重启后 B 已释放（续租失败）', second.live.has('B'), false);
}

// ═══ 12. 缺 nodeId 的行被计数而不是静默丢弃 ═══════════════════════════════
{
  const state = deriveEnqueueState([
    row('node_enqueued', null, 1, { sessionId: 's1' }),
    row('node_enqueued', '', 2),
    row('node_enqueued', 'OK', 3),
  ]);
  eq('缺 nodeId 记 ignored=2', state.ignored, 2);
  eq('合法行仍被登记', [...state.live.keys()], ['OK']);
}

// ═══ 13. 同一节点多次派发：只留最后一条 ════════════════════════════════════
{
  const state = deriveEnqueueState([
    row('node_enqueued', 'N1', 1, { sessionId: 'old' }),
    row('node_enqueued', 'N1', 2, { sessionId: 'new' }),
  ]);
  eq('同节点只留最新登记', state.live.get('N1').sessionId, 'new');
  eq('登记数仍为 1', state.live.size, 1);
}

// ═══ 14. 释放原因枚举校验 ═══════════════════════════════════════════════════
{
  ok('合法原因被承认', isEnqueueReleaseReason('claim-rejected'));
  ok('非法原因被拒', !isEnqueueReleaseReason('whatever'));
  ok('无释放记录时 explainRelease 不崩', explainRelease(null).length > 0);
}

// ═══ 15. 不修改入参（纯函数）════════════════════════════════════════════════
{
  const rows = [row('node_enqueued', 'N1', 1, { sessionId: 's1' })];
  const snapshot = JSON.stringify(rows);
  deriveEnqueueState(rows, { now: Date.parse(T(9999)), maxAgeMs: 1 });
  eq('推导不修改入参', JSON.stringify(rows), snapshot);
}

// ═══ 16. ★ 增量折叠 == 全量折叠（这是增量的正确性根基）════════════════════
// `applyEnqueueRows` 是原地折叠。它一旦与全量推导不等价，派发就会漏派或重复派，
// 且因为「看起来跑得通」而极难发现。这里用随机 journal 做等价性比对。
{
  let seed = 20260101;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const kinds = [
    'node_enqueued',
    'task_claimed',
    'task_heartbeat_ok',
    'task_heartbeat_failed',
    'task_claim_rejected',
    'verify_done_requested',
    'node_enqueue_failed',
    'agent_reap_applied',
    'unrelated_event',
  ];
  const nodeIds = ['A', 'B', 'C', 'D', 'E'];
  const sessions = ['s1', 's2', 's3'];
  const at = (second) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
  let mismatches = 0;
  let trials = 0;
  for (let trial = 0; trial < 60; trial += 1) {
    const rows = [];
    const len = 10 + Math.floor(rand() * 60);
    for (let i = 0; i < len; i += 1) {
      const kind = kinds[Math.floor(rand() * kinds.length)];
      const nodeId = nodeIds[Math.floor(rand() * nodeIds.length)];
      const row = { kind, nodeId, at: at(i) };
      if (kind === 'node_enqueued') row.sessionId = sessions[Math.floor(rand() * sessions.length)];
      if (kind === 'agent_reap_applied') row.applied = [sessions[Math.floor(rand() * sessions.length)]];
      if (kind === 'node_enqueued' && rand() < 0.1) row.nodeId = '';
      rows.push(row);
    }
    // 全量：折叠 + 失联判定
    const sweep = { now: Date.parse(at(len + 5)), maxAgeMs: 120 };
    const full = sweepStale(deriveEnqueueState(rows), sweep);
    // 增量：随机切成三段分别折叠，折叠完成后统一做失联判定
    // （失联不是行语义，折叠中途判定会与全量不等价——这正是下面要钉住的）
    const state = emptyEnqueueState();
    const cuts = [0, Math.floor(rand() * len * 0.4), Math.floor(rand() * len * 0.8), len];
    for (let i = 1; i < cuts.length; i += 1) {
      applyEnqueueRows(state, rows.slice(cuts[i - 1], cuts[i]));
    }
    const swept = sweepStale(state, sweep);
    const liveSame =
      JSON.stringify([...full.live.entries()].sort((a, b) => a[0].localeCompare(b[0]))) ===
      JSON.stringify([...swept.live.entries()].sort((a, b) => a[0].localeCompare(b[0])));
    const releasedSame =
      JSON.stringify([...full.released.entries()].sort((a, b) => a[0].localeCompare(b[0]))) ===
      JSON.stringify([...swept.released.entries()].sort((a, b) => a[0].localeCompare(b[0])));
    trials += 1;
    if (!liveSame || !releasedSame || full.ignored !== swept.ignored) {
      mismatches += 1;
      if (mismatches === 1) {
        process.stdout.write(`      首个不等价用例 len=${len} cuts=${JSON.stringify(cuts)} live=${liveSame} released=${releasedSame} ignored=${full.ignored}/${state.ignored}\n`);
      }
    }
  }
  eq('增量折叠与全量折叠等价（60 组随机 journal）', mismatches, 0);
  eq('等价性检查确实跑了 60 组', trials, 60);
}

// ═══ 17. released 裁剪不影响判定 ═══════════════════════════════════════════
{
  const rows = [];
  for (let i = 0; i < 500; i += 1) {
    rows.push(row('node_enqueued', `N${i}`, i, { sessionId: `s${i}` }));
    rows.push(row('task_claim_rejected', `N${i}`, i));
  }
  rows.push(row('node_enqueued', 'KEEP', 600, { sessionId: 'sK' }));
  const state = deriveEnqueueState(rows);
  eq('裁剪前 released 有 500 条', state.released.size, 500);
  trimReleased(state, 50);
  eq('裁剪后 released 只留 50 条', state.released.size, 50);
  eq('裁剪不影响 live 判定', [...state.live.keys()], ['KEEP']);
}

const failed = results.filter((r) => !r.ok);
process.stdout.write('─'.repeat(70) + '\n');
process.stdout.write(
  `${failed.length === 0 ? 'PASS' : 'FAIL'} enqueue-state: ${results.length - failed.length}/${results.length} 项通过\n`,
);
if (failed.length) {
  for (const f of failed) process.stdout.write(`  FAILED: ${f.name} — ${f.detail}\n`);
  process.exit(1);
}
