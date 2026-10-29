/**
 * N4 · journal → 状态折叠（默认 reducer）
 *
 * 语义基线 = Python `control_plane/graph.py::replay_snapshot()`，但**补上 Python 丢掉的字段**：
 *   Python 的 `_set_status()`（leases.py:64-68）直写 `assignee/attempts` 而不写事件，
 *   导致 `snapshot != replay_snapshot`（用内存库实测复现：claim 后 assignee 丢失）。
 *   本 reducer 要求：凡是改变 `assignee/attempts/status` 的事件，**必须在 payload 里带新值**，
 *   于是 `replay(records).nodes[nid]` 与物化视图天然一致（这是与 oracle 的"有意差异"）。
 *
 * N3（core）可以替换 reducer：`StoreOptions.reducer`；本文件只是默认实现 + 事件词汇表。
 */

import { cloneJson } from './canonical.js';
                                                                                                        
import { STATE_SCHEMA } from './types.js';

export const NODE_STATUSES                        = [
  'planned',
  'ready',
  'claimed',
  'running',
  'submitted',
  'verifying',
  'accepted',
  'rejected',
  'blocked',
  'done',
];

export const EDGE_KINDS = ['blocks', 'artifact', 'review']         ;

/** 与 Python `graph.STATUSES` / `EDGE_KINDS` 同名同值。 */
export function emptyState(at = new Date(0).toISOString())           {
  return {
    schema: STATE_SCHEMA,
    revision: 0,
    graphRevision: 1,
    updatedAt: at,
    nodes: {},
    edges: [],
    evidence: {},
    artifacts: {},
    decisions: {},
    gates: {},
    leases: {},
    cursors: {},
  };
}

/** N4 自身产生的诊断事件：占用 seq，但不是业务事实（`businessRecords()` 用于对账）。 */
export const DIAGNOSTIC_KINDS                    = [
  'writer_taken_over',
  'snapshot_diverged',
  'cursor_aligned',
];

function asObject(value         )             {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value              ) : {};
}

/** 双拼写取值：兼容本层 camelCase 与 N3 core / Python 的 snake_case。 */
function pick(obj            , ...keys          )                   {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

function pickString(obj            , ...keys          )                {
  const value = pick(obj, ...keys);
  return typeof value === 'string' ? value : null;
}

function pickStringArray(obj            , ...keys          )           {
  const value = pick(obj, ...keys);
  return Array.isArray(value) ? value.filter((item)                 => typeof item === 'string') : [];
}

function normalizeNode(raw            )                   {
  const nodeId = pickString(raw, 'nodeId', 'node_id');
  if (!nodeId) return null;
  return {
    nodeId,
    title: pickString(raw, 'title') ?? nodeId,
    spec: pickString(raw, 'spec') ?? '',
    capability: pickString(raw, 'capability'),
    stage: pickString(raw, 'stage'),
    status: (NODE_STATUSES                     ).includes(String(pick(raw, 'status') ?? 'planned'))
      ? (pick(raw, 'status')              )
      : 'planned',
    deps: pickStringArray(raw, 'deps'),
    evidenceRequired: pickStringArray(raw, 'evidenceRequired', 'evidence_required'),
    decisionId: pickString(raw, 'decisionId', 'decision_id'),
    assignee: pickString(raw, 'assignee'),
    attempts: Number.isInteger(pick(raw, 'attempts')) ? Number(pick(raw, 'attempts')) : 0,
    verifierIds: pickStringArray(raw, 'verifierIds', 'verifier_ids'),
    budget: asObject(pick(raw, 'budget') ?? {}),
    createdAt: pickString(raw, 'createdAt', 'created_at') ?? '',
    updatedAt: pickString(raw, 'updatedAt', 'updated_at') ?? '',
  };
}

function touches(edge           , nodeId        )          {
  return edge.fromId === nodeId || edge.toId === nodeId;
}

/**
 * 应用一条记录。返回是否改变了状态（用于判断是否需要落新快照）。
 * 未知 kind 一律忽略（前向兼容：N3 可能新增事件）。
 */
export function applyRecord(state          , record               )          {
  const payload = asObject(record.payload);
  const at = typeof payload.at === 'string' ? payload.at : record.ts;
  let changed = false;

  switch (record.kind) {
    case 'node_added': {
      const node = normalizeNode(asObject(payload.node ?? payload));
      if (!node) return false;
      state.nodes[node.nodeId] = node;
      changed = true;
      break;
    }
    case 'node_removed': {
      const nodeId =
        pickString(asObject(payload.node), 'nodeId', 'node_id') ??
        pickString(payload, 'nodeId', 'node_id') ??
        record.nodeId;
      if (!nodeId || !state.nodes[nodeId]) return false;
      delete state.nodes[nodeId];
      state.edges = state.edges.filter((edge) => !touches(edge, nodeId));
      delete state.leases[nodeId];
      changed = true;
      break;
    }
    case 'edge_added': {
      const fromId = pickString(payload, 'from', 'fromId', 'from_id');
      const toId = pickString(payload, 'to', 'toId', 'to_id');
      const kind = payload.kind;
      if (typeof fromId !== 'string' || typeof toId !== 'string') return false;
      if (!(EDGE_KINDS                     ).includes(String(kind))) return false;
      const exists = state.edges.some((edge) => edge.fromId === fromId && edge.toId === toId && edge.kind === kind);
      if (exists) return false;
      state.edges.push({ fromId, toId, kind: kind                      });
      state.edges.sort((a, b) =>
        `${a.fromId}\u0000${a.toId}\u0000${a.kind}`.localeCompare(`${b.fromId}\u0000${b.toId}\u0000${b.kind}`),
      );
      changed = true;
      break;
    }
    case 'edge_removed': {
      const fromId = pickString(payload, 'from', 'fromId', 'from_id');
      const toId = pickString(payload, 'to', 'toId', 'to_id');
      const kind = pickString(payload, 'kind');
      if (!fromId || !toId) return false;
      const before = state.edges.length;
      state.edges = state.edges.filter(
        (edge) => !(edge.fromId === fromId && edge.toId === toId && (!kind || edge.kind === kind)),
      );
      changed = state.edges.length !== before;
      break;
    }
    case 'status_changed': {
      const nodeId = record.nodeId;
      if (!nodeId || !state.nodes[nodeId]) return false;
      const to = payload.to;
      if (typeof to !== 'string' || !(NODE_STATUSES                     ).includes(to)) return false;
      const node = state.nodes[nodeId];
      node.status = to              ;
      node.updatedAt = at;
      // 关键差异：assignee / attempts 必须随事件过来（Python 在此丢字段）
      if (payload.assignee === null || typeof payload.assignee === 'string') node.assignee = payload.assignee                 ;
      if (Number.isInteger(payload.attempts)) node.attempts = Number(payload.attempts);
      changed = true;
      break;
    }
    case 'assignee_changed': {
      const nodeId = record.nodeId;
      if (!nodeId || !state.nodes[nodeId]) return false;
      const to = pick(payload, 'to', 'assignee');
      if (to !== null && typeof to !== 'string') return false;
      state.nodes[nodeId].assignee = to                 ;
      state.nodes[nodeId].updatedAt = at;
      changed = true;
      break;
    }
    case 'attempts_changed': {
      const nodeId = record.nodeId;
      if (!nodeId || !state.nodes[nodeId]) return false;
      const to = pick(payload, 'to', 'attempts');
      if (!Number.isInteger(to)) return false;
      state.nodes[nodeId].attempts = Number(to);
      state.nodes[nodeId].updatedAt = at;
      changed = true;
      break;
    }
    case 'lease_claimed': {
      const nodeId = record.nodeId;
      const owner = payload.owner;
      if (!nodeId || typeof owner !== 'string') return false;
      state.leases[nodeId] = {
        nodeId,
        owner,
        fencingToken: Number(payload.fencingToken ?? 0),
        expiresAt: Number(payload.expiresAt ?? 0),
        heartbeatAt: Number(payload.expiresAt ?? 0),
      };
      const node = state.nodes[nodeId];
      if (node) {
        node.assignee = owner;
        node.status = 'claimed';
        node.updatedAt = at;
      }
      changed = true;
      break;
    }
    case 'lease_renewed': {
      const nodeId = record.nodeId;
      if (!nodeId || !state.leases[nodeId]) return false;
      state.leases[nodeId].expiresAt = Number(payload.expiresAt ?? state.leases[nodeId].expiresAt);
      state.leases[nodeId].heartbeatAt = Number(payload.at ?? state.leases[nodeId].heartbeatAt);
      changed = true;
      break;
    }
    case 'lease_released':
    case 'lease_expired':
    case 'lease_taken_over': {
      const nodeId = record.nodeId;
      if (!nodeId || !state.leases[nodeId]) return false;
      if (record.kind === 'lease_taken_over') {
        state.leases[nodeId].owner = String(payload.toOwner ?? state.leases[nodeId].owner);
        state.leases[nodeId].fencingToken = Number(payload.fencingToken ?? state.leases[nodeId].fencingToken);
        state.leases[nodeId].expiresAt = Number(payload.expiresAt ?? state.leases[nodeId].expiresAt);
      } else {
        delete state.leases[nodeId];
      }
      const node = state.nodes[nodeId];
      if (node) {
        node.assignee = record.kind === 'lease_taken_over' ? String(payload.toOwner ?? node.assignee) : null;
        if (typeof payload.attempts === 'number') node.attempts = payload.attempts          ;
        if (record.kind === 'lease_expired') node.attempts = node.attempts + 1;
        node.updatedAt = at;
      }
      changed = true;
      break;
    }
    case 'evidence_added': {
      const nested = asObject(payload.evidence);
      const evidenceId =
        pickString(payload, 'evidenceId', 'evidence_id') ?? pickString(nested, 'evidence_id', 'evidenceId');
      if (!evidenceId) return false;
      state.evidence[evidenceId] = {
        evidenceId,
        nodeId: record.nodeId ?? pickString(payload, 'nodeId', 'node_id') ?? '',
        kind: pickString(payload, 'kind') ?? pickString(nested, 'kind') ?? '',
        artifactId: pickString(payload, 'artifactId', 'artifact_id') ?? pickString(nested, 'artifact_id') ?? '',
        verifierId: pickString(payload, 'verifierId', 'verifier_id') ?? pickString(nested, 'verifier_id') ?? '',
        verdict: ((pick(payload, 'verdict') ?? pick(nested, 'verdict') ?? 'unknown')                               ),
        at,
      };
      changed = true;
      break;
    }
    case 'artifact_added': {
      const nested = asObject(payload.artifact);
      const artifactId =
        pickString(payload, 'artifactId', 'artifact_id') ?? pickString(nested, 'artifact_id', 'artifactId');
      if (!artifactId) return false;
      state.artifacts[artifactId] = {
        artifactId,
        path: pickString(payload, 'path') ?? pickString(nested, 'path') ?? '',
        sha256: pickString(payload, 'sha256') ?? pickString(nested, 'sha256') ?? '',
        producerNode: record.nodeId ?? pickString(nested, 'producer_node') ?? null,
        verifierIds: pickStringArray(nested, 'verifier_ids', 'verifierIds'),
      };
      changed = true;
      break;
    }
    case 'decision_created':
    case 'decision_decided':
    case 'decision_blocked':
    case 'decision_timed_out':
    case 'decision_confirmed':
    case 'decision_overridden': {
      const nested = asObject(payload.decision);
      const decisionId =
        pickString(payload, 'decisionId', 'decision_id') ?? pickString(nested, 'decision_id', 'decisionId');
      if (!decisionId) return false;
      const existing = state.decisions[decisionId];
      const status =
        record.kind === 'decision_created'
          ? String(pick(payload, 'status') ?? 'proposed')
          : record.kind === 'decision_timed_out'
            ? 'timed_out'
            : record.kind.replace('decision_', '');
      state.decisions[decisionId] = {
        decisionId,
        nodeId: record.nodeId ?? existing?.nodeId ?? null,
        level: (String(pick(payload, 'level') ?? existing?.level ?? 'L0')                             ),
        status,
        chosenOptionId:
          (pick(payload, 'chosen', 'chosenOptionId', 'chosen_option_id')                 ) ??
          existing?.chosenOptionId ??
          null,
        defaultOptionId: existing?.defaultOptionId ?? null,
        deadlineAt: existing?.deadlineAt ?? null,
        decidedAt: status === 'proposed' || status === 'blocked' ? null : at,
      };
      changed = true;
      break;
    }
    case 'stage_gate_changed': {
      const stage = payload.stage;
      if (typeof stage !== 'string') return false;
      state.gates[stage] = {
        stage,
        status: (String(payload.status ?? 'pending')                                   ),
        evidenceRefs: Array.isArray(payload.evidenceRefs)
          ? (payload.evidenceRefs             ).filter((ref)                => typeof ref === 'string')
          : [],
      };
      changed = true;
      break;
    }
    case 'cursor_aligned': {
      const name = pickString(payload, 'name') ?? 'core';
      const coreSeq = pick(payload, 'coreSeq', 'core_seq');
      if (!Number.isInteger(coreSeq)) return false;
      state.cursors[name] = {
        name,
        coreSeq: Number(coreSeq),
        revision: record.seq,
        at,
      };
      changed = true;
      break;
    }
    case 'graph_replanned': {
      state.graphRevision = Number(payload.graphVersion ?? state.graphRevision + 1);
      changed = true;
      break;
    }
    default:
      return false;
  }

  if (changed) state.updatedAt = at;
  return changed;
}

/** 折叠：`records` 必须已按 seq 升序且链自洽（由 Journal.verifyChain 保证）。 */
export function fold(records                 , base           = emptyState())           {
  const state = cloneJson(base);
  for (const record of records) applyRecord(state, record);
  state.revision = records.length ? records[records.length - 1].seq : 0;
  return state;
}

/** 折叠到指定 seq（含）。返回 `{state, consumed}`。 */
export function foldUntil(
  records                 ,
  seq        ,
  base           = emptyState(),
)                                        {
  const slice = records.filter((record) => record.seq <= seq);
  return { state: fold(slice, base), consumed: slice.length };
}

/** 物化视图等价物：只含节点与边（与 Python `graph.snapshot()` 可比的子集）。 */
export function graphProjection(state          )                                                           {
  return { nodes: cloneJson(state.nodes), edges: cloneJson(state.edges) };
}


//# sourceURL=state\reducer.js