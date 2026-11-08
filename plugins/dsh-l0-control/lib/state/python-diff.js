/**
 * N4 · 与 Python oracle 的同夹具差分
 *
 * 夹具由 `fixtures/python-replay.json` 提供（生成方式见该文件 `generator` 字段：
 * 用 Python `control_plane` + 内存 SQLite 跑同一脚本，不写工程区文件）。
 *
 * 差分口径（只比"可观察状态"，不比事件条数——core/N4 的事件词汇允许不同）：
 *   statuses / assignee / attempts / edges / 重放自洽 / eventId 格式。
 *
 * 另一条硬要求：**TS 侧必须能重放回 assignee/attempts**（N4 的加固点）；
 * 若 oracle 的 `snapshotEqualsReplay` 为 false，则把差异显式列出而不是掩盖。
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MemoryFsPort } from './fs-port.js';
import { Journal, statePaths } from './journal.js';
import { canonicalJson } from './canonical.js';
import { fold } from './reducer.js';
import { Store } from './store.js';
import { StateError,                                   } from './types.js';

/**
 * 定位 oracle 夹具。
 * `build.mjs` 只搬 `.ts` → `lib/*.js`，不搬 `fixtures/`，所以从 `lib/state/` 运行时
 * 要回退到 `src/state/fixtures/`；两处都不存在时返回首选路径（由调用方报错）。
 */
export function resolveFixturePath(metaUrl        )         {
  const fromSrc = fileURLToPath(new URL('./fixtures/python-replay.json', metaUrl));
  if (fs.existsSync(fromSrc)) return fromSrc;
  const fromLib = fileURLToPath(new URL('../../src/state/fixtures/python-replay.json', metaUrl));
  return fs.existsSync(fromLib) ? fromLib : fromSrc;
}

                                   
                                                  
                   
                 
                      
                 
                  
                 
                         
 

                                
                 
                    
               
                             
           
                       
                         
                       
                                     
                                           
                                            
                                                  
                                     
                                           
                                           
                                                 
                                  
    
 

export function parseOracleFixture(text        )                {
  const parsed = JSON.parse(text)                 ;
  if (!parsed?.python || !Array.isArray(parsed.script)) {
    throw new StateError('STATE_CORRUPT', 'oracle 夹具缺少 python/script 段');
  }
  return parsed;
}

                            
                  
                           
                             
                   
 

const AT = '2026-10-29T20:00:00+08:00';

/** 在 TS 侧执行同一脚本，产出 journal + 折叠状态。 */
export async function runOracleScript(script                    )                     {
  const fsPort = new MemoryFsPort();
  const store = await Store.open({ dir: '/mem/oracle', fs: fsPort, owner: 'oracle-ts', now: () => Date.parse(AT) });

  for (const step of script) {
    if (step.op === 'add_node') {
      const nodeId = step.node_id          ;
      await store.append({
        kind: 'node_added',
        nodeId,
        payload: {
          node: {
            nodeId,
            title: step.title ?? nodeId,
            spec: 's',
            capability: step.capability ?? null,
            stage: step.stage ?? null,
            status: 'planned',
            deps: step.deps ?? [],
            evidenceRequired: [],
            verifierIds: [],
            attempts: 0,
            assignee: null,
          },
        },
        ts: AT,
      });
      for (const dep of step.deps ?? []) {
        await store.append({ kind: 'edge_added', nodeId, payload: { from: dep, to: nodeId, kind: 'blocks' }, ts: AT });
      }
      continue;
    }
    if (step.op === 'bootstrap') {
      for (const node of Object.values(store.state.nodes)) {
        if (node.status === 'planned' && node.deps.length === 0) {
          await store.append({
            kind: 'status_changed',
            nodeId: node.nodeId,
            payload: { from: 'planned', to: 'ready', reason: 'bootstrap', at: AT },
            ts: AT,
          });
        }
      }
      continue;
    }
    if (step.op === 'claim') {
      const nodeId = step.node_id          ;
      await store.append({
        kind: 'lease_claimed',
        nodeId,
        payload: {
          owner: step.owner ?? 'agent-A',
          fencingToken: step.fencing_token ?? 1,
          expiresAt: 1600,
          at: AT,
        },
        ts: AT,
      });
      await store.append({
        kind: 'status_changed',
        nodeId,
        payload: { from: 'ready', to: 'claimed', reason: 'lease_claimed', assignee: step.owner ?? 'agent-A', at: AT },
        ts: AT,
      });
      continue;
    }
    throw new StateError('STATE_CORRUPT', `未支持的脚本 op：${step.op}`);
  }

  const records = store.journal.records();
  const replayed = fold(records);
  const replayEqualsState = canonicalJson(replayed           ) === canonicalJson(store.state           );
  await store.close();
  const reopened = await Journal.open({ dir: '/mem/oracle', fs: fsPort, owner: 'oracle-ts', now: () => Date.parse(AT) });
  const journal = reopened.journal;
  return { state: replayed, records, replayEqualsState, journal };
}

                              
               
              
                   
                 
 

                             
              
                        
                        
 

function sortedEdges(state          )                                  {
  return state.edges
    .map((edge) => [edge.fromId, edge.toId, edge.kind]                            )
    .sort((a, b) => `${a[0]}|${a[1]}|${a[2]}`.localeCompare(`${b[0]}|${b[1]}|${b[2]}`));
}

export function diffOracle(state          , fixture               )             {
  const expected = fixture.python;
  const statuses                         = {};
  const assignee                                = {};
  const attempts                         = {};
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    statuses[nodeId] = node.status;
    assignee[nodeId] = node.assignee;
    attempts[nodeId] = node.attempts;
  }
  const checks                = [
    {
      name: 'statuses',
      ok: canonicalJson(statuses) === canonicalJson(expected.statuses),
      expected: canonicalJson(expected.statuses),
      actual: canonicalJson(statuses),
    },
    {
      name: 'assignee',
      ok: canonicalJson(assignee) === canonicalJson(expected.assignee),
      expected: canonicalJson(expected.assignee),
      actual: canonicalJson(assignee),
    },
    {
      name: 'attempts',
      ok: canonicalJson(attempts) === canonicalJson(expected.attempts),
      expected: canonicalJson(expected.attempts),
      actual: canonicalJson(attempts),
    },
    {
      name: 'edges',
      ok: canonicalJson(sortedEdges(state)) === canonicalJson(expected.edges),
      expected: canonicalJson(expected.edges),
      actual: canonicalJson(sortedEdges(state)),
    },
    {
      name: 'oracle-snapshot-equals-replay',
      ok: expected.snapshotEqualsReplay === true,
      expected: 'true',
      actual: String(expected.snapshotEqualsReplay),
    },
  ];
  const differences = checks.filter((check) => !check.ok).map((check) => check.name);
  return { ok: differences.length === 0, checks, differences };
}

/** eventId 必须是 `EVT-%06d`（与 Python `_next_event_id` 同格式）。 */
export function checkEventIdFormat(records                 )              {
  const bad = records.filter((record) => !/^EVT-\d{6}$/.test(record.eventId));
  return {
    name: 'event-id-format',
    ok: bad.length === 0,
    expected: 'EVT-000001 …',
    actual: bad.length ? bad.map((record) => record.eventId).join(',') : `${records.length} 条全部合规`,
  };
}

export { statePaths };


//# sourceURL=state\python-diff.js