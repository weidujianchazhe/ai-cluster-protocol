/**
 * 宿主 Team 成员上限（`TEAM_MEMBER_LIMIT`）必须**不能挡住 L0 的派发**。
 *
 * 背景：第 37 轮真派一个 Agent 时撞到 `Team member limit 16 reached`。实机自省
 * （`cordis_inspect_query` → host/Service/agentTeams）确认：该服务的 11 个方法是
 *
 *   membership / listMembers / spawnTeammate / sendMessage / createTask /
 *   getTask / listTasks / updateTask / waitForChange / interrupt / tryMembership
 *
 * —— **没有任何设置上限的接口**。所以「把 16 调大」在宿主侧做不到。
 *
 * 正确做法不是去改宿主，而是**不让插件依赖它**：
 *   - Team 满 → 自动走 activation（B 路径）；
 *   - 这是**预期路径**，标 `teamLimitFallback: true` 并落 journal；
 *   - **不需要额外开关**：启用插件（coordination）即生效。
 *
 * 唯一真实损失：activation 实例没有 memberName → 不能当原生 TeamTask owner。
 * 而 Team board 只是 L0 的投影（`teamTaskRole: 'projection'`），权威在 graph，
 * 所以 L0 全链（claim / evidence / gate / verify）不受影响。
 *
 * 断言：
 *   1. 撞上限 → 仍 `ok:true`，且 `via` 落在 activation 路径；
 *   2. 结果带 `teamLimitFallback: true`；
 *   3. journal `agent_spawned` 带上该标记（可观测）；
 *   4. **非**上限类错误**不得**被标成上限降级（否则排障会被引到错的参数上）。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { tempStateDir, cleanupTempStateDirs } from './_temp-state.mjs';

const root = process.cwd();
const lib = (n) => pathToFileURL(path.join(root, 'lib', n)).href;
const { L0ControlService } = await import(lib('service.js'));

const LEAD = { id: 's-lead' };
let activationSpawns = 0;

/**
 * 假宿主：Team 永远失败（按 `limitMode` 决定抛哪种错），activation 永远可用。
 * 这正是真实情形——Team 满了不影响 activation。
 */
function makeCtx(limitMode) {
  return {
    get: (name) => {
      if (name === 'workingDirectory') return { defaultDirectory: root };
      if (name === 'agentTeams') {
        return {
          membership: () => ({ role: 'lead', name: 'lead', id: 'team-1', root: LEAD }),
          listMembers: () => [],
          spawnTeammate: async () => {
            const error = new Error(
              limitMode === 'member-limit'
                ? 'Team member limit 16 reached'
                : 'agent preset 不存在：nope',
            );
            error.name = 'TeamError';
            error.code = limitMode === 'member-limit' ? 'TEAM_MEMBER_LIMIT' : 'PRESET_NOT_FOUND';
            throw error;
          },
        };
      }
      if (name === 'subagents') {
        return {
          list: () => ['spawn'],
          startActivation: async () => {
            activationSpawns += 1;
            return { childId: `child-${activationSpawns}`, messageId: `msg-${activationSpawns}` };
          },
        };
      }
      return undefined;
    },
  };
}

async function spawn({ limitMode, tag }) {
  const stateDir = path.resolve(tempStateDir(`tl-${tag}`));
  const svc = new L0ControlService(makeCtx(limitMode), { workspaceRoot: root, stateDir, persistence: 'node', maxParallel: 8 }, {});
  try {
    const result = await svc.spawnAgent(
      { role: 'CODE', task: '标定用', capability: 'CODE', via: 'auto', contextPack: ['t'] },
      LEAD,
    );
    const journal = svc.readJournal();
    const row = [...journal].reverse().find((r) => r.kind === 'agent_spawned' || r.kind === 'agent_spawn_failed');
    return { result, row };
  } finally {
    try { svc.stopDispatch(); } catch { /* 未启动 */ }
    try { await svc.dispose(); } catch { /* 已关闭 */ }
    cleanupTempStateDirs();
  }
}

// ── 1 + 2 + 3：撞宿主上限 → 降级 activation，且可观测 ──────────────────
const limited = await spawn({ limitMode: 'member-limit', tag: 'limited' });
assert.equal(limited.result?.ok, true, `撞上限后应仍能派发，实际 ${JSON.stringify(limited.result).slice(0, 260)}`);
assert.equal(limited.result?.teamLimitFallback, true, '结果必须标记 teamLimitFallback=true');
assert.match(String(limited.result?.via ?? ''), /activation/i, `应走 activation，实际 via=${limited.result?.via}`);
assert.equal(limited.row?.teamLimitFallback, true, 'journal agent_spawned 必须带 teamLimitFallback');
console.log(`PASS 撞 TEAM_MEMBER_LIMIT → ok:true、via=${limited.result.via}、teamLimitFallback=true、journal 已标记`);

// ── 4：非上限错误不得被误标 ────────────────────────────────────────────
const other = await spawn({ limitMode: 'other', tag: 'other' });
assert.equal(other.result?.teamLimitFallback ?? false, false, '非上限错误不得标成上限降级');
console.log(`PASS 非上限错误（${other.result?.teammateError?.code}）→ teamLimitFallback 未标记`);

// ── 5：语义说明（不是断言，是让读的人知道代价）────────────────────────
console.log('\n代价（写进 README，不藏）：activation 实例没有 memberName，因此不能当原生 TeamTask owner；');
console.log('但 Team board 只是 L0 的投影（teamTaskRole=projection），权威在 graph，L0 全链不受影响。');
console.log(`本次共发生 ${activationSpawns} 次 activation 派发——若这个数等于派发次数，说明宿主 Team 上限一次都没挡住。`);
