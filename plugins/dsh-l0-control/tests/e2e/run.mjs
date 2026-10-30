#!/usr/bin/env node
/**
 * N5 · e2e runner（R3）
 *
 * 用法：
 *   node tests/e2e/run.mjs --scenario crud_wish --port mock [--json]
 *   node tests/e2e/run.mjs --scenario failure_replan --port mock [--json]
 *   node tests/e2e/run.mjs --scenario crud_wish --port native [--json]
 *
 * 退出码（与 A7 conformance 对齐）：0 pass / 1 drift(有 SKIP) / 2 failed / 3 unknown
 * 原则：SKIP 与 unknown **不得**折算成 pass。
 *
 * R3 变化：
 *  - journal / 折叠 / 快照按 N4 稳定形状（JournalRecord / StateDoc / SnapshotMeta 三元锚 / 恢复错误码），
 *    见 `control_plane/lanes/n4-state-recovery.md` §2；
 *  - A3 审计独立改为「证据提交者 producer_instance × verifier→role 推导的审计实例」，
 *    不再依赖 mock 注入的 auditor_instance；
 *  - 新增 G5 恢复断言组（重放==状态、记录形状、三元锚、锚前缀、四类篡改码、稳定点重建）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCEN_DIR = path.join(HERE, 'scenarios');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

// ── 参数 ───────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { scenario: 'crud_wish', port: 'mock', json: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--scenario') out.scenario = argv[++i];
    else if (a === '--port') out.port = argv[++i];
    else if (a === '--out') out.out = argv[++i];
  }
  return out;
}

const EXIT = { pass: 0, drift: 1, failed: 2, unknown: 3 };

// ── 逻辑时钟 + 规范化哈希（N4：canonicalJson + sha256）───────────────
function makeClock() {
  let n = 0;
  return () => `#${++n}`;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

// ── N4 形状 journal（seq 严格 +1、eventId、prevHash 链、hash）─────────
class N4Journal {
  constructor() {
    this.records = [];
  }
  append(kind, nodeId, payload) {
    const seq = this.records.length + 1;
    const ts = new Date(Date.UTC(2026, 9, 29, 4, 0, seq % 60)).toISOString();
    const prevHash = seq === 1 ? '' : this.records[this.records.length - 1].hash;
    const eventId = `EVT-${String(seq).padStart(6, '0')}`;
    const body = { seq, eventId, ts, kind, nodeId: nodeId ?? null, payload, prevHash };
    const rec = { ...body, hash: sha256(canonicalJson(body)) };
    this.records.push(rec);
    return rec;
  }
  read() {
    return this.records.map((r) => ({ ...r, payload: { ...r.payload } }));
  }
  textOf(records = this.records) {
    return records.map((r) => JSON.stringify(r) + '\n').join('');
  }
  anchor() {
    const text = this.textOf();
    return { bytes: Buffer.byteLength(text, 'utf8'), hash: sha256(text) };
  }
}

// ── 折叠 / 快照 / 恢复（N4 §2.2–§2.4）───────────────────────────────
function foldRecords(records) {
  const nodes = {};
  let graphRevision = 1;
  for (const rec of records) {
    if (rec.kind === 'node_added') {
      nodes[rec.payload.node.node_id] = { ...rec.payload.node };
    } else if (rec.kind === 'status_changed') {
      const n = nodes[rec.nodeId];
      if (n) {
        n.status = rec.payload.to;
        if (rec.payload.assignee !== undefined) n.assignee = rec.payload.assignee;
        if (rec.payload.attempts !== undefined) n.attempts = rec.payload.attempts;
        n.updated_at = rec.payload.at ?? n.updated_at;
      }
    } else if (rec.kind === 'lease_claimed') {
      const n = nodes[rec.nodeId];
      if (n) {
        n.assignee = rec.payload.owner;
        n.status = 'claimed';
      }
    } else if (rec.kind === 'graph_replanned') {
      graphRevision = rec.payload.graphVersion;
    }
  }
  return { schema: 1, revision: records.length, graphRevision, nodes };
}

function buildSnapshot(journal) {
  const state = foldRecords(journal.read());
  const anchor = journal.anchor();
  return {
    schema: 1,
    seq: state.revision,
    revision: state.revision,
    graphRevision: state.graphRevision,
    journalBytes: anchor.bytes,
    journalHash: anchor.hash,
    stateSha256: sha256(canonicalJson(state)),
    createdAt: '2026-10-29T12:00:00.000+08:00',
  };
}

/** 恢复错误码（N4 §2.4）；null = 无错 */
function detectRecoveryError(records, snapshot) {
  if (!Array.isArray(records) || records.length === 0) return 'STATE_CORRUPT';
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    if (!rec || typeof rec !== 'object' || typeof rec.kind !== 'string' || !rec.kind) return 'STATE_CORRUPT';
    if (rec.seq !== i + 1) return 'STATE_SEQ_GAP';
    const body = { seq: rec.seq, eventId: rec.eventId, ts: rec.ts, kind: rec.kind, nodeId: rec.nodeId, payload: rec.payload, prevHash: rec.prevHash };
    if (sha256(canonicalJson(body)) !== rec.hash) return 'STATE_HASH_BREAK';
    const expectedPrev = i === 0 ? '' : records[i - 1].hash;
    if (rec.prevHash !== expectedPrev) return 'STATE_HASH_BREAK';
  }
  if (snapshot) {
    if (snapshot.seq > records.length) return 'STATE_SNAPSHOT_AHEAD';
    const prefix = records.slice(0, snapshot.seq);
    if (sha256(prefix.map((r) => JSON.stringify(r) + '\n').join('')) !== snapshot.journalHash) return 'STATE_DIVERGED';
    if (snapshot.stateSha256 !== sha256(canonicalJson(foldRecords(prefix)))) return 'STATE_DIVERGED';
  }
  return null;
}

const ok = (value) => ({ ok: true, value });
const bad = (code, reason) => ({ ok: false, code, reason });

// ── MockPort ────────────────────────────────────────────────────
class MockPort {
  constructor({ scenario, journal, clock, outDir }) {
    this.scenario = scenario;
    this.journal = journal;
    this.tick = clock;
    this.outDir = outDir;
    this.version = 1;
    this.nodes = new Map();
    this.edges = [];
    this.gates = new Map();
    this.evidence = new Map();
    this.leases = new Map();
    this.fencing = 0;
    this.busy = new Map();
    this.killed = new Set();
    this.decisions = [];
    /** verifier 注册表：verifierId → { role, instanceId } —— A3 的推导来源 */
    this.verifiers = new Map();
  }

  registerVerifier(verifierId, role, instanceId) {
    this.verifiers.set(verifierId, { role, instanceId });
    return verifierId;
  }

  n(id) {
    return this.nodes.get(id);
  }
  touch(node) {
    node.updated_at = this.tick();
  }
  depsDone(node) {
    return node.deps.every((d) => this.n(d)?.status === 'done');
  }
  liveNodesOf(instanceId) {
    const set = this.busy.get(instanceId);
    return set ? [...set] : [];
  }
  release(node) {
    const lease = this.leases.get(node.node_id);
    if (lease) {
      this.busy.get(lease.instance_id)?.delete(node.node_id);
      this.leases.delete(node.node_id);
    }
    node.assignee = null;
  }

  async wishSubmit(wish) {
    for (const spec of this.scenario.expected_nodes) {
      const node = {
        node_id: spec.node_id,
        title: spec.node_id,
        status: 'planned',
        stage: spec.stage,
        capability: spec.capability,
        deps: [...spec.deps],
        evidence_required: [...spec.evidence_required],
        assignee: null,
        attempts: 0,
        updated_at: this.tick(),
      };
      this.nodes.set(spec.node_id, node);
      this.journal.append('node_added', spec.node_id, { node: { ...node } });
      for (const dep of spec.deps) this.edges.push({ from: dep, to: spec.node_id, kind: 'blocks' });
    }
    for (const stage of this.scenario.expected_stage_gates || []) this.gates.set(stage, 'pending');
    return ok({ graph_version: this.version });
  }

  async graphStatus() {
    return ok(this.snapshot());
  }

  snapshot() {
    return {
      graph_version: this.version,
      nodes: [...this.nodes.values()].map((x) => ({ ...x, deps: [...x.deps], evidence_required: [...x.evidence_required] })),
      edges: this.edges.map((e) => ({ ...e })),
      stage_gates: [...this.gates.entries()].map(([stage, status]) => ({ stage, status })),
    };
  }

  async taskNext(filter = {}) {
    const ready = [...this.nodes.values()].filter((x) => x.status === 'ready');
    const rows = filter.role ? ready.filter((x) => x.capability === filter.role) : ready;
    return ok(rows.map((x) => ({ ...x })));
  }

  async recomputeReady() {
    const promoted = [];
    for (const node of this.nodes.values()) {
      if (node.status === 'planned' && this.depsDone(node)) {
        node.status = 'ready';
        this.touch(node);
        this.journal.append('status_changed', node.node_id, { from: 'planned', to: 'ready', reason: 'dependency_done', at: node.updated_at });
        promoted.push(node.node_id);
      }
    }
    return ok(promoted);
  }

  async taskClaim(claim) {
    const node = this.n(claim.node_id);
    if (!node) return bad('NODE_NOT_FOUND', claim.node_id);
    if (this.killed.has(claim.instance_id)) return bad('INSTANCE_KILLED', claim.instance_id);
    if (this.leases.has(node.node_id)) return bad('LEASE_HELD', node.node_id);
    if (node.status !== 'ready') return bad('NODE_NOT_READY', `${node.node_id}=${node.status}`);
    if (this.liveNodesOf(claim.instance_id).length > 0) return bad('INSTANCE_BUSY', claim.instance_id);
    this.fencing += 1;
    this.leases.set(node.node_id, { instance_id: claim.instance_id, fencing: this.fencing });
    if (!this.busy.has(claim.instance_id)) this.busy.set(claim.instance_id, new Set());
    this.busy.get(claim.instance_id).add(node.node_id);
    node.assignee = claim.instance_id;
    node.status = 'claimed';
    this.touch(node);
    this.journal.append('lease_claimed', node.node_id, { owner: claim.instance_id, fencingToken: this.fencing });
    return ok({ fencing_token: this.fencing });
  }

  async evidenceSubmit(ev) {
    const node = this.n(ev.node_id);
    if (!node) return bad('NODE_NOT_FOUND', ev.node_id);
    if (this.evidence.has(ev.evidence_id)) return bad('DUPLICATE_EVIDENCE', ev.evidence_id);
    this.evidence.set(ev.evidence_id, { ...ev });
    this.journal.append('evidence_added', ev.node_id, {
      evidenceId: ev.evidence_id,
      kind: ev.kind,
      artifactId: ev.artifact_id,
      verifierId: ev.verifier_id,
      verdict: ev.verdict,
      producerInstance: ev.producer_instance,
    });
    return ok({ evidence_id: ev.evidence_id });
  }

  /** 审计实例：优先 verifier→role 推导（真实面路径）；无注册时可回退注入值（仅单测） */
  resolveAuditor(evidence, injected) {
    const reg = this.verifiers.get(evidence.verifier_id);
    if (reg) return { instanceId: reg.instanceId, role: reg.role, source: 'verifier-registry' };
    if (injected) return { instanceId: injected, role: null, source: 'injected' };
    return null;
  }

  async verifyDone(cred) {
    const node = this.n(cred.node_id);
    if (!node) return bad('NODE_NOT_FOUND', cred.node_id);
    const reject = (code, reason) => {
      this.release(node);
      const from = node.status;
      node.status = 'ready';
      node.attempts += 1;
      this.touch(node);
      this.journal.append('status_changed', node.node_id, { from, to: 'ready', reason: code, attempts: node.attempts, at: node.updated_at });
      return bad(code, reason);
    };
    if (node.status === 'done') return bad('ALREADY_DONE', node.node_id);
    if (!this.depsDone(node)) return reject('DEPS_NOT_DONE', node.deps.join(','));
    const gate = this.gates.get(node.stage);
    if (gate !== 'passed') return reject('GATE_NOT_PASSED', `${node.stage}=${gate}`);

    const rows = [...this.evidence.values()].filter((e) => e.node_id === node.node_id);
    const passed = rows.filter((e) => e.verdict === 'pass');
    const kinds = new Set(passed.map((e) => e.kind));
    const missing = node.evidence_required.filter((k) => !kinds.has(k));
    if (missing.length) {
      const failedKinds = new Set(rows.filter((e) => e.verdict !== 'pass').map((e) => e.kind));
      return missing.some((k) => failedKinds.has(k)) ? reject('EVIDENCE_FAILED', missing.join(',')) : reject('EVIDENCE_MISSING', missing.join(','));
    }
    if (rows.some((e) => e.verdict === 'unknown')) return reject('EVIDENCE_UNKNOWN', node.node_id);

    const producer = node.assignee ?? passed[0]?.producer_instance ?? null;
    // A3：在**全部通过证据**里找带审计角色的 verifier；找不到 → NOT_AN_AUDITOR_ROLE；一个都没有 → AUDITOR_REQUIRED
    const resolutions = passed.map((e) => this.resolveAuditor(e, cred.auditor_instance)).filter(Boolean);
    const auditor = resolutions.find((r) => r.role && String(r.role).startsWith('AUDIT'));
    if (resolutions.length === 0) return reject('AUDITOR_REQUIRED', '无 verifier→role 注册且未注入审计实例');
    if (!auditor) return reject('NOT_AN_AUDITOR_ROLE', resolutions.map((r) => String(r.role)).join(','));
    if (auditor.instanceId === producer) return reject('AUDIT_NOT_INDEPENDENT', `producer=${producer}`);

    node.status = 'done';
    this.release(node);
    this.touch(node);
    this.journal.append('status_changed', node.node_id, { from: 'verifying', to: 'done', reason: 'evidence_ok', assignee: null, at: node.updated_at });
    return ok({ status: 'done' });
  }

  async decide(d) {
    if (d.level === 'L2' && (!d.default_option || !d.timeout_sec)) return bad('L2_REQUIRES_DEFAULT_AND_TIMEOUT', d.decision_id);
    const status = d.level === 'L3' ? 'blocked' : d.level === 'L2' ? 'proposed' : 'auto';
    this.decisions.push({ ...d, status });
    this.journal.append('decision_recorded', d.node_id ?? null, { decisionId: d.decision_id, level: d.level, status });
    return ok({ decision_id: d.decision_id, status });
  }

  async teamStatus() {
    return ok(
      [...this.nodes.values()].map((x) => ({
        id: `TT-${x.node_id}`,
        revision: this.version,
        subject: x.node_id,
        status: x.status,
        ownerName: x.assignee ?? null,
        ready: x.status === 'ready',
        blockedBy: [...x.deps].filter((d) => this.n(d)?.status !== 'done'),
      })),
    );
  }

  async exportProjection(input = {}) {
    const dir = path.resolve(input.outDir || this.outDir || path.join(REPO_ROOT, 'out', 'e2e'));
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    const write = (name, body) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, body, 'utf8');
      files.push({ path: p, bytes: Buffer.byteLength(body) });
    };
    write('tasks.md', [...this.nodes.values()].map((x) => `| ${x.node_id} | ${x.status} | ${x.stage} | ${x.assignee ?? '-'} |`).join('\n') + '\n');
    write('journal.jsonl', this.journal.read().map((e) => JSON.stringify(e)).join('\n') + '\n');
    write('STATE.md', `graph_version: ${this.version}\nnodes: ${this.nodes.size}\n`);
    return ok({ files, source: 'journal' });
  }

  async export(input) {
    return this.exportProjection(input);
  }

  async setGate(stage, status) {
    this.gates.set(stage, status);
    this.journal.append('stage_gate_changed', null, { stage, status });
    return ok({ stage, status });
  }

  async replan(record) {
    this.version = record.graph_version;
    for (const id of record.replanned_nodes) {
      const node = this.n(id);
      if (!node) continue;
      const from = node.status;
      node.status = 'planned';
      this.release(node);
      this.touch(node);
      this.journal.append('status_changed', id, { from, to: 'planned', reason: record.reason, at: node.updated_at });
    }
    this.journal.append('graph_replanned', null, { graphVersion: this.version, reason: record.reason, nodes: record.replanned_nodes });
    return ok({ graph_version: this.version });
  }

  async killInstance(instanceId) {
    this.killed.add(instanceId);
    for (const nodeId of this.liveNodesOf(instanceId)) {
      const node = this.n(nodeId);
      if (!node) continue;
      const from = node.status;
      this.release(node);
      node.status = 'ready';
      node.attempts += 1;
      this.touch(node);
      this.journal.append('status_changed', nodeId, { from, to: 'ready', reason: 'lease_expired', attempts: node.attempts, at: node.updated_at });
    }
    return ok({ killed: true });
  }
}

// ── 断言收集 ─────────────────────────────────────────────────────
class Report {
  constructor(scenario, portName) {
    this.scenario = scenario;
    this.port = portName;
    this.checks = [];
  }
  add(id, title, okFlag, detail = '') {
    this.checks.push({ id, title, ok: !!okFlag, detail });
  }
  skip(id, title, reason) {
    this.checks.push({ id, title, ok: null, skip: true, detail: reason });
  }
  summary() {
    const failed = this.checks.filter((c) => c.ok === false).length;
    const skipped = this.checks.filter((c) => c.skip).length;
    const passed = this.checks.filter((c) => c.ok === true).length;
    const state = failed > 0 ? 'failed' : skipped > 0 ? 'drift' : 'pass';
    return { passed, failed, skipped, total: this.checks.length, state, exitCode: EXIT[state] };
  }
}

function topoOrder(nodes) {
  const byId = new Map(nodes.map((n) => [n.node_id, n]));
  const out = [];
  const seen = new Set();
  const visit = (id, stack = new Set()) => {
    if (seen.has(id)) return;
    if (stack.has(id)) throw new Error(`dependency cycle at ${id}`);
    stack.add(id);
    for (const dep of byId.get(id)?.deps ?? []) visit(dep, stack);
    stack.delete(id);
    seen.add(id);
    out.push(id);
  };
  for (const n of nodes) visit(n.node_id);
  return out;
}

// ── 负向探测（A2 / A3 被拒路径，独立最小图）──────────────────────────
async function runNegativeProbes(report) {
  const mk = (id) => ({ node_id: id, stage: 'build', capability: 'CODE', deps: [], evidence_required: ['t'] });
  const scenario = { expected_stage_gates: ['build'], expected_nodes: ['NODE-P1', 'NODE-P2', 'NODE-P3', 'NODE-P4', 'NODE-P5', 'NODE-P6'].map(mk) };
  const port = new MockPort({ scenario, journal: new N4Journal(), clock: makeClock(), outDir: null });
  port.registerVerifier('v-code-role', 'CODE', 'ROLE-CODE-09');            // 非审计角色
  port.registerVerifier('v-audit-self', 'AUDIT_CODE', 'ROLE-CODE-04');     // 审计角色但实例=该节点生产者
  port.registerVerifier('v-audit-ok', 'AUDIT_CODE', 'ROLE-AUDIT_CODE-01'); // 正常审计

  await port.wishSubmit({ text: 'probe', acceptance: ['probe'] });
  await port.setGate('build', 'passed');
  await port.recomputeReady();

  // A2-1：同节点双认领
  const c1 = await port.taskClaim({ node_id: 'NODE-P1', instance_id: 'ROLE-CODE-01' });
  const c2 = await port.taskClaim({ node_id: 'NODE-P1', instance_id: 'ROLE-CODE-02' });
  report.add('A2-1', '同节点双认领被拒', c1.ok === true && c2.ok === false, c2.ok ? 'accepted!' : `${c2.code}`);

  // A2-2：同一实例两个活跃节点
  const c3 = await port.taskClaim({ node_id: 'NODE-P2', instance_id: 'ROLE-CODE-01' });
  report.add('A2-2', '同一实例不得同时持有两个活跃节点', c3.ok === false, c3.ok ? 'accepted!' : `${c3.code}`);

  const claimAndEvidence = async (nodeId, instance, verifierId) => {
    await port.taskClaim({ node_id: nodeId, instance_id: instance });
    await port.evidenceSubmit({
      evidence_id: `EV-${nodeId}`,
      node_id: nodeId,
      kind: 't',
      artifact_id: `ART-${nodeId}`,
      verifier_id: verifierId,
      producer_instance: instance,
      verdict: 'pass',
    });
    return port.verifyDone({ node_id: nodeId }); // 不注入 auditor：全靠 verifier→role 推导
  };

  // A3-0：verifier 角色非审计
  const notAudit = await claimAndEvidence('NODE-P3', 'ROLE-CODE-03', 'v-code-role');
  report.add('A3-0', 'verifier 注册角色非审计 → NOT_AN_AUDITOR_ROLE',
    notAudit.ok === false && notAudit.code === 'NOT_AN_AUDITOR_ROLE', notAudit.ok ? 'accepted!' : `${notAudit.code}`);

  // A3-1：审计角色但实例 = 生产者
  const selfAudit = await claimAndEvidence('NODE-P4', 'ROLE-CODE-04', 'v-audit-self');
  report.add('A3-1', '证据提交者 = 审计实例（verifier→role 推导）被拒',
    selfAudit.ok === false && selfAudit.code === 'AUDIT_NOT_INDEPENDENT', selfAudit.ok ? 'accepted!' : `${selfAudit.code}`);

  // A3-2：无 verifier→role 注册且未注入
  const none = await claimAndEvidence('NODE-P5', 'ROLE-CODE-05', 'v-unknown');
  report.add('A3-2', '无 verifier→role 注册 → AUDITOR_REQUIRED（fail-closed）',
    none.ok === false && none.code === 'AUDITOR_REQUIRED', none.ok ? 'accepted!' : `${none.code}`);

  // A3-3：正确审计实例（AUDIT_CODE ≠ producer）
  const good = await claimAndEvidence('NODE-P6', 'ROLE-CODE-06', 'v-audit-ok');
  report.add('A3-3', '正确审计实例可通过（AUDIT_CODE ≠ producer）', good.ok === true, good.ok ? '' : `${good.code}`);

  // A2-4：kill 持有活跃节点的实例；另一实例名下（已 done）节点不变
  const c4 = await port.taskClaim({ node_id: 'NODE-P2', instance_id: 'ROLE-CODE-02' });
  const before = (await port.graphStatus()).value.nodes.find((x) => x.node_id === 'NODE-P6');
  await port.killInstance('ROLE-CODE-02');
  const afterNodes = (await port.graphStatus()).value.nodes;
  const doneAfter = afterNodes.find((x) => x.node_id === 'NODE-P6');
  const p2After = afterNodes.find((x) => x.node_id === 'NODE-P2');
  report.add('A2-4', 'kill 一个实例：其节点回 ready，另一实例节点不变',
    c4.ok === true && before.status === doneAfter.status && before.updated_at === doneAfter.updated_at && p2After.status === 'ready',
    `P6 ${before.status}@${before.updated_at}→${doneAfter.status}@${doneAfter.updated_at}; P2=${p2After.status}`);
}

// ── team_status 投影契约 ────────────────────────────────────────
const PROJECTION_SCALARS = ['id', 'revision', 'subject', 'status', 'ownerName', 'ready'];
const PROJECTION_FORBIDDEN = ['context', 'diagnostics'];
const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

async function assertTeamProjection(port, report) {
  const r1 = await port.teamStatus();
  if (!r1.ok) return report.add('T1', 'team_status 投影可读', false, r1.code);
  const rows = r1.value;
  const missing = [];
  const nonScalar = [];
  for (const row of rows) {
    for (const key of PROJECTION_SCALARS) {
      if (!(key in row)) missing.push(`${row.id ?? '?'}:${key}`);
      else if (!isScalar(row[key])) nonScalar.push(`${row.id ?? '?'}:${key}`);
    }
  }
  report.add('T1', `投影含 6 个稳定标量（${PROJECTION_SCALARS.join('/')}）`, missing.length === 0 && nonScalar.length === 0,
    missing.length ? `缺字段 ${missing.join(',')}` : nonScalar.length ? `非标量 ${nonScalar.join(',')}` : `${rows.length} 行全部合规`);
  const nested = rows.filter((row) => PROJECTION_FORBIDDEN.some((k) => row[k] && typeof row[k] === 'object' && !Array.isArray(row[k])));
  report.add('T2', '嵌套 context/diagnostics 未被当作契约字段', nested.length === 0, nested.map((r) => r.id).join(',') || 'none');

  const graphBefore = (await port.graphStatus()).value;
  const r2 = await port.teamStatus();
  const graphAfter = (await port.graphStatus()).value;
  const unchanged = JSON.stringify(graphBefore) === JSON.stringify(graphAfter);
  const sameCount = r2.ok && r2.value.length === graphAfter.nodes.length;
  const statuses = new Set(graphAfter.nodes.map((n) => n.status));
  const mapped = r2.ok && r2.value.every((row) => statuses.has(row.status));
  report.add('T3', '投影为只读派生视图（读投影不改图、行数=节点数、状态可取）', unchanged && sameCount && mapped,
    `unchanged=${unchanged} rows=${r2.value?.length}/${graphAfter.nodes.length} statusOk=${mapped}`);
  const tolerated = rows.filter((row) => row.blockedBy !== undefined && !Array.isArray(row.blockedBy));
  report.add('T4', 'blockedBy 若存在则必须是数组（容忍字段）', tolerated.length === 0, tolerated.map((r) => r.id).join(',') || 'ok');
}

// ── 工具面（来自 lib/capabilities.js，供 U3 校验）─────────────────────
async function toolNamesFromLib() {
  try {
    const mod = await import(`file://${path.join(REPO_ROOT, 'plugins', 'dsh-l0-control', 'lib', 'capabilities.js').replace(/\\/g, '/')}`);
    return Object.keys(mod.TOOL_SURFACE ?? {});
  } catch {
    return [];
  }
}

// ── U1 / U3：UX 契约（prompt 注入 / 命令白名单）─────────────────────
async function assertUxContract(report, { toolNames = [] } = {}) {
  const ux = await import(`file://${path.join(HERE, 'lib', 'ux-contract.mjs').replace(/\\/g, '/')}`);

  // U1：只放指针，不贴正文
  const node = { nodeId: 'NODE-DB', role: 'CODE', stage: 'build', evidenceRequired: ['migration'] };
  const section = ux.buildPromptSection({ ...node, budgetTokens: 20000 });
  const v1 = ux.validatePromptSection(section, node);
  report.add('U1', 'prompt 注入只放指针/摘要（node/role/stage/证据 + 长度上限）', v1.ok, v1.ok ? `${section.length} chars` : v1.issues.join('; '));

  // U1-：反例守卫（贴正文必须被判失败）
  const bad = `${section}\nPRD 正文 BEGIN ${'x'.repeat(120)}\n\`\`\`diff --git a b\`\`\``;
  const v1neg = ux.validatePromptSection(bad, node);
  report.add('U1-', '贴正文的注入被判失败（反例）', v1neg.ok === false, v1neg.issues.slice(0, 2).join('; '));

  // U3：命令白名单 + 工具面不得含直改状态工具
  const allow = ux.validateCommand('/status');
  const deny = ux.validateCommand('/force-done');
  const deny2 = ux.validateCommand('/set_status');
  const surface = ux.validateToolSurface(toolNames);
  report.add('U3', '命令白名单（/status 允许；/force-done、/set_status 拒绝）',
    allow.allowed === true && allow.mapsTo === 'graph_status' && deny.allowed === false && deny2.allowed === false,
    `allow=${allow.mapsTo} deny=${deny.reason}/${deny2.reason}`);
  report.add('U3-', '工具面不含"直改状态"工具（状态只能经证据事务）', surface.ok,
    surface.ok ? surface.allowlist.join(' , ') : surface.issues.join('; '));
}
// ── G5：journal / 快照 / 恢复（N4 形状）─────────────────────────────
function assertRecovery(port, report) {
  const records = port.journal.read();
  const folded = foldRecords(records);
  report.add('G5-1', '重放 == 图状态（revision 与节点数一致）',
    folded.revision === records.length && Object.keys(folded.nodes).length === port.nodes.size,
    `revision=${folded.revision} foldedNodes=${Object.keys(folded.nodes).length} graphNodes=${port.nodes.size}`);

  report.add('G5-2', 'JournalRecord 形状（seq 严格 +1 / EVT-%06d / prevHash 链 / hash 64 位）',
    records.every((r, i) => r.seq === i + 1 && /^EVT-\d{6}$/.test(r.eventId) && r.hash.length === 64
      && r.prevHash === (i === 0 ? '' : records[i - 1].hash)),
    `${records.length} records`);

  const snap = buildSnapshot(port.journal);
  report.add('G5-3', '快照三元锚自洽（seq == revision == graphRevision 折叠值）',
    snap.seq === snap.revision && snap.seq === folded.revision && snap.graphRevision === folded.graphRevision,
    `seq=${snap.seq} graphRevision=${snap.graphRevision}`);

  const oldSnap = buildSnapshot(port.journal);
  port.journal.append('snapshot_diverged', null, { note: 'journal 前进（模拟）' });
  const prefix = port.journal.read().slice(0, oldSnap.seq);
  const prefixOk = sha256(prefix.map((r) => JSON.stringify(r) + '\n').join('')) === oldSnap.journalHash
    && detectRecoveryError(prefix, oldSnap) === null
    && detectRecoveryError(port.journal.read(), oldSnap) === null;
  report.add('G5-4', '锚按前缀比较（journal 前进后旧快照仍有效）', prefixOk, `prefixSeq=${oldSnap.seq} journalSeq=${port.journal.read().length}`);

  const base = port.journal.read();
  const tampered = (mutate) => {
    const copy = base.map((r) => ({ ...r, payload: { ...r.payload } }));
    mutate(copy);
    return detectRecoveryError(copy, null);
  };
  const hashBreak = tampered((recs) => { recs[1].payload = { ...recs[1].payload, injected: true }; });
  const seqGap = tampered((recs) => { recs.splice(1, 1); });
  const corrupt = tampered((recs) => { recs[2].kind = ''; });
  const ahead = detectRecoveryError(base, { ...buildSnapshot(port.journal), seq: base.length + 5 });
  report.add('G5-5', '四类篡改码（HASH_BREAK / SEQ_GAP / CORRUPT / SNAPSHOT_AHEAD）',
    hashBreak === 'STATE_HASH_BREAK' && seqGap === 'STATE_SEQ_GAP' && corrupt === 'STATE_CORRUPT' && ahead === 'STATE_SNAPSHOT_AHEAD',
    `${hashBreak} / ${seqGap} / ${corrupt} / ${ahead}`);

  const stable = base.slice(0, Math.max(1, base.length - 1));
  const rebuilt = foldRecords(stable);
  report.add('G5-6', '从稳定点恢复可重建（截断到 seq-1 仍可折叠且 revision 正确）',
    rebuilt.revision === stable.length && Object.keys(rebuilt.nodes).length > 0,
    `revision=${rebuilt.revision} nodes=${Object.keys(rebuilt.nodes).length}`);
}

// ── 场景：crud_wish ─────────────────────────────────────────────
async function runCrudWish(port, scenario, report) {
  const assignment = new Map((scenario.dispatch?.assignments ?? []).map((a) => [a.node_id, a.instance]));
  port.registerVerifier('v-audit-evidence-01', 'AUDIT_EVIDENCE', 'ROLE-AUDIT_EVIDENCE-01');

  await port.wishSubmit({ text: scenario.wish.text, acceptance: scenario.wish.acceptance, constraints: scenario.wish.constraints ?? {} });
  const evidences = [];

  for (const nodeId of topoOrder(scenario.expected_nodes)) {
    const node = (await port.graphStatus()).value.nodes.find((x) => x.node_id === nodeId);
    if ((await port.graphStatus()).value.stage_gates.find((g) => g.stage === node.stage)?.status !== 'passed') {
      await port.setGate(node.stage, 'passed');
    }
    await port.recomputeReady();
    const instance = assignment.get(nodeId) ?? `ROLE-${node.capability}-01`;
    const claim = await port.taskClaim({ node_id: nodeId, instance_id: instance });
    if (!claim.ok) {
      report.add(`claim:${nodeId}`, `claim ${nodeId} by ${instance}`, false, `${claim.code}: ${claim.reason}`);
      continue;
    }
    const ev = {
      evidence_id: `EV-${nodeId}`,
      node_id: nodeId,
      kind: node.evidence_required[0],
      artifact_id: `ART-${nodeId}`,
      verifier_id: 'v-audit-evidence-01',
      producer_instance: instance,
      verdict: 'pass',
    };
    if ((await port.evidenceSubmit(ev)).ok) evidences.push(ev);
    const done = await port.verifyDone({ node_id: nodeId }); // 不再注入 auditor：由 verifier→role 推导
    report.add(`done:${nodeId}`, `${nodeId} → done（producer=${instance}）`, done.ok, done.ok ? '' : `${done.code}: ${done.reason}`);
  }

  report.add('A1', '无人工中继（journal 中无 human actor 事件）',
    port.journal.read().every((e) => (e.payload?.actor?.kind ?? 'plugin') !== 'human'), `${port.journal.read().length} events`);

  const producerMismatch = evidences.filter((e) => assignment.get(e.node_id) && e.producer_instance !== assignment.get(e.node_id));
  report.add('A2-3', '产物生产者与派发分配一致', producerMismatch.length === 0, producerMismatch.map((e) => e.node_id).join(',') || 'all match');

  await runNegativeProbes(report);

  const final = (await port.graphStatus()).value;
  const notDone = final.nodes.filter((x) => x.status !== 'done').map((x) => `${x.node_id}=${x.status}`);
  report.add('A1-final', '全部节点最终 done', notDone.length === 0, notDone.join(',') || 'all done');
  return final;
}

// ── 场景：failure_replan ────────────────────────────────────────
async function runFailureReplan(port, scenario, base, report) {
  const assignment = new Map((base.dispatch?.assignments ?? []).map((a) => [a.node_id, a.instance]));
  const failNode = 'NODE-TEST';
  port.registerVerifier('v-audit-evidence-01', 'AUDIT_EVIDENCE', 'ROLE-AUDIT_EVIDENCE-01');
  const idOf = (nodeId) => assignment.get(nodeId) ?? `ROLE-${(base.expected_nodes.find((n) => n.node_id === nodeId) ?? {}).capability ?? 'CODE'}-01`;

  const executeNode = async (nodeId, { verdict = 'pass', evidenceSuffix = '' } = {}) => {
    const node = (await port.graphStatus()).value.nodes.find((x) => x.node_id === nodeId);
    if (!node) return bad('NODE_NOT_FOUND', nodeId);
    if ((await port.graphStatus()).value.stage_gates.find((g) => g.stage === node.stage)?.status !== 'passed') {
      await port.setGate(node.stage, 'passed');
    }
    await port.recomputeReady();
    const instance = idOf(nodeId);
    const claim = await port.taskClaim({ node_id: nodeId, instance_id: instance });
    if (!claim.ok) return claim;
    await port.evidenceSubmit({
      evidence_id: `EV-${nodeId}${evidenceSuffix}`,
      node_id: nodeId,
      kind: node.evidence_required[0],
      artifact_id: `ART-${nodeId}`,
      verifier_id: 'v-audit-evidence-01',
      producer_instance: instance,
      verdict,
    });
    return port.verifyDone({ node_id: nodeId });
  };

  await port.wishSubmit({ text: base.wish.text, acceptance: base.wish.acceptance, constraints: base.wish.constraints ?? {} });

  let replanned = null;
  for (const nodeId of topoOrder(base.expected_nodes)) {
    if (nodeId === failNode && !replanned) {
      const rejected = await executeNode(nodeId, { verdict: 'fail', evidenceSuffix: '-fail' });
      const after = (await port.graphStatus()).value.nodes.find((x) => x.node_id === nodeId);
      report.add('R1', '证据 fail → 节点回 ready 且 attempts+1',
        rejected.ok === false && after.status === 'ready' && after.attempts > 0,
        `status=${after.status} attempts=${after.attempts} code=${rejected.code ?? 'ok'}`);

      const before = (await port.graphStatus()).value;
      const untouchedBefore = new Map((scenario.replan.expect.untouched_nodes || []).map((id) => {
        const n = before.nodes.find((x) => x.node_id === id);
        return [id, `${n?.status}@${n?.updated_at}`];
      }));
      const version = before.graph_version + 1;
      replanned = scenario.replan.expect.replanned_nodes;
      await port.replan({ reason: scenario.replan.reason, graph_version: version, replanned_nodes: replanned });
      const afterPlan = (await port.graphStatus()).value;
      report.add('R2', 'replan 使 graph_version 单调 +1', afterPlan.graph_version === version, `${before.graph_version} → ${afterPlan.graph_version}`);
      const changed = (scenario.replan.expect.untouched_nodes || []).filter((id) => {
        const n = afterPlan.nodes.find((x) => x.node_id === id);
        return untouchedBefore.get(id) !== `${n.status}@${n.updated_at}`;
      });
      report.add('R3', '未受影响节点未被重做（状态+逻辑时钟不变）', changed.length === 0, changed.join(',') || 'unchanged');

      for (const id of topoOrder(base.expected_nodes).filter((x) => replanned.includes(x))) {
        const r = await executeNode(id, { evidenceSuffix: '-r2' });
        report.add(`rerun:${id}`, `重跑 ${id} → done`, r.ok === true, r.ok ? '' : `${r.code}: ${r.reason}`);
      }
      continue;
    }
    const current = (await port.graphStatus()).value.nodes.find((x) => x.node_id === nodeId);
    if (current?.status === 'done') continue;
    const res = await executeNode(nodeId);
    if (!res.ok) report.add(`done:${nodeId}`, `${nodeId} → done`, false, `${res.code}: ${res.reason}`);
  }

  report.add('R2b', 'replan 事件已落 journal',
    port.journal.read().some((e) => e.kind === 'graph_replanned'),
    `${port.journal.read().filter((e) => e.kind === 'graph_replanned').length} event(s)`);
  const final = (await port.graphStatus()).value;
  const notDone = final.nodes.filter((x) => x.status !== 'done').map((x) => `${x.node_id}=${x.status}`);
  report.add('R5', '重跑后收敛到全 done', notDone.length === 0, notDone.join(',') || 'all done');
  return final;
}

// ── native 端口：真实插件 + 真实 lib/state（每次用隔离临时 workspace）──
async function runNative() {
  const checks = [];
  const add = (id, title, okFlag, detail = '') => checks.push({ id, title, ok: !!okFlag, detail });
  const unknown = (id, title, detail) => checks.push({ id, title, ok: null, skip: true, detail });

  const svcPath = path.join(REPO_ROOT, 'plugins', 'dsh-l0-control', 'lib', 'service.js');
  if (!fs.existsSync(svcPath)) return { state: 'unknown', exitCode: EXIT.unknown, reason: `service 未构建：${svcPath}`, checks };

  const os = await import('node:os');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'n5-native-'));
  let svc;
  try {
    const mod = await import(`file://${svcPath.replace(/\\/g, '/')}`);
    const Service = mod.L0ControlService;
    if (!Service) return { state: 'unknown', exitCode: EXIT.unknown, reason: 'lib/service.js 未导出 L0ControlService', checks };
    // 隔离 workspace：不污染插件真实状态目录（否则第二次跑就没有 ready 节点了）
    svc = new Service({ get: () => null }, { workspaceRoot: ws }, {});
  } catch (err) {
    fs.rmSync(ws, { recursive: true, force: true });
    return { state: 'unknown', exitCode: EXIT.unknown, reason: `service 构造失败：${err?.message ?? err}`, checks };
  }

  try {
    // ① graph_status
    const status = await svc.graphStatus();
    const inner = status?.graph;
    add('N1', 'graph_status 走 core（graph.result.ok === true）',
      inner?.ok === true && inner?.result?.ok === true,
      inner?.ok === true ? `version=${inner.result.version} nodes=${inner.result.counts?.nodes} journalSeq=${inner.result.journal?.lastSeq}` : `error=${inner?.error}`);

    // ② wish_submit（只记愿望）+ graph_commit（本测试显式给 spec；生产路径无固定模板）
    let wish = null;
    try { wish = await svc.wishSubmit({ text: 'N5 native: 记账 CRUD 端到端' }); } catch (err) { wish = { ok: false, error: 'threw' }; }
    const wr = wish?.result ?? {};
    let committed = null;
    try {
      committed = await svc.graphCommit({
        wish: 'N5 native: 记账 CRUD 端到端',
        nodes: [
          { nodeId: 'NODE-RESEARCH', title: '调研', stage: 'research', capability: 'RESEARCH', deps: [], acceptance: { kind: 'exists' } },
          { nodeId: 'NODE-PRD', title: 'PRD', stage: 'design', capability: 'DESIGN', deps: ['NODE-RESEARCH'], acceptance: { kind: 'exists' } },
          { nodeId: 'NODE-CONTRACT', title: '契约', stage: 'design', capability: 'DESIGN', deps: ['NODE-PRD'], acceptance: { kind: 'exists' } },
          { nodeId: 'NODE-BUILD', title: '实现', stage: 'build', capability: 'CODE', deps: ['NODE-CONTRACT'], acceptance: { kind: 'exists' } },
          { nodeId: 'NODE-AUDIT', title: '审计', stage: 'audit', capability: 'AUDIT', deps: ['NODE-BUILD'], acceptance: { kind: 'exists' } },
          { nodeId: 'NODE-DELIVER', title: '交付', stage: 'deliver', capability: 'OPS', deps: ['NODE-AUDIT'], acceptance: { kind: 'exists' } },
        ],
      });
    } catch (err) {
      committed = { ok: false, error: 'threw' };
    }
    const cr = committed?.result ?? {};
    const nodeIds = cr.order ?? [];
    const ready = cr.ready ?? [];
    if (wish?.ok === true && committed?.ok === true) {
      add('N2', 'wish_submit 只记愿望 + graph_commit 落 6 节点（ready=NODE-RESEARCH）',
        wr.graphPlanRequired === true && nodeIds.length === 6 && ready.includes('NODE-RESEARCH'),
        `planRequired=${wr.graphPlanRequired === true} nodes=${nodeIds.length} ready=${JSON.stringify(ready)}`);
    } else {
      unknown('N2', 'wish_submit + graph_commit 建图', `error=${committed?.error ?? wish?.error}`);
    }

    // ③ task_next
    let next = null;
    try { next = await svc.taskNext({}); } catch (err) { next = { ok: false, error: 'threw' }; }
    const readyList = next?.result?.ready ?? [];
    if (next?.ok === true) add('N3', 'task_next 可用（ready 集）', readyList.length > 0, `ready=${JSON.stringify(readyList)}`);
    else unknown('N3', 'task_next 可用', `error=${next?.error}`);

    // ④ claim（正向）+ 同一节点被他人认领（guard）
    const target = readyList[0] ?? 'NODE-RESEARCH';
    let claim1 = null;
    try { claim1 = await svc.taskClaim({ nodeId: target, instanceId: 'ROLE-RESEARCH-01' }); } catch (err) { claim1 = { ok: false, error: 'threw' }; }
    const lease = claim1?.result?.lease;
    add('N8', 'claim 成功（租约 + fencing token + 状态 claimed）',
      claim1?.ok === true && lease?.fencing_token >= 1 && claim1?.result?.node?.status === 'claimed',
      `fencing=${lease?.fencing_token} status=${claim1?.result?.node?.status}`);

    let claim2 = null;
    try { claim2 = await svc.taskClaim({ nodeId: target, instanceId: 'ROLE-RESEARCH-02' }); } catch (err) { claim2 = { ok: false, error: 'threw' }; }
    const claim2Code = claim2?.detail?.code ?? claim2?.error ?? null;
    add('N9', '同节点被他人再认领 → lease_held（guard-pass）',
      claim2?.ok === false && claim2Code === 'lease_held',
      `code=${claim2Code}`);

    // ⑤ 证据：verifier 必须取节点允许清单（wish 模板为 `verifier-ci`）；acceptance 必须显式
    const artDir = path.join(ws, 'artifacts');
    fs.mkdirSync(artDir, { recursive: true });
    const artifact = path.join(artDir, 'research.md');
    fs.writeFileSync(artifact, '# research\n', 'utf8');
    let ev = null;
    try {
      ev = await svc.evidenceSubmit({
        nodeId: target,
        artifactPath: artifact,
        verifier: 'verifier-ci',
        acceptance: { kind: 'exists' },
        producer_instance: 'ROLE-RESEARCH-01',
        producerInstance: 'ROLE-RESEARCH-01',
      });
    } catch (err) { ev = { ok: false, error: 'threw' }; }
    add('N10', 'evidence_submit 成功（节点 → submitted）',
      ev?.ok === true && ev?.result?.nodeStatus === 'submitted',
      ev?.ok === true ? `evidence=${ev.result.evidenceId} status=${ev.result.nodeStatus}` : `error=${ev?.error}`);
    const evId = ev?.result?.evidenceId ?? null;

    // ⑤b 无 acceptance 且无 verdict → 必须拒（unknown 不得 pass）
    let evNoAcc = null;
    try {
      evNoAcc = await svc.evidenceSubmit({
        nodeId: target,
        artifactPath: artifact,
        verifier: 'verifier-ci',
        producer_instance: 'ROLE-RESEARCH-01',
        producerInstance: 'ROLE-RESEARCH-01',
      });
    } catch (err) { evNoAcc = { ok: false, error: 'threw' }; }
    add('N15', '无 acceptance 且无 verdict → 拒绝（acceptance-required / unknown 不得 pass）',
      evNoAcc?.ok === false,
      `code=${evNoAcc?.error ?? 'accepted!'}`);

    // ⑥ 闸门 → verify_done
    const gate = await svc.passGate({ stage: 'research', evidence_refs: evId ? [evId] : [] });
    add('N16', 'pass_gate(research) 通过', gate?.ok === true, gate?.ok === true ? 'passed' : `code=${gate?.error}`);

    let done = null;
    try {
      done = await svc.verifyDone({
        nodeId: target,
        producer_instance: 'ROLE-RESEARCH-01',
        producerInstance: 'ROLE-RESEARCH-01',
        auditor_instance: 'ROLE-AUDIT_CODE-01',
        auditorInstance: 'ROLE-AUDIT_CODE-01',
      });
    } catch (err) { done = { ok: false, error: 'threw' }; }
    const doneCode = done?.error ?? done?.result?.error ?? null;
    add('N11', 'verify_done → done（含闸门）',
      done?.ok === true,
      done?.ok === true ? 'done' : `code=${doneCode}`);

    // ⑦ 别名归一化：单拼写 snake / camel 都应被接受（N2 已修）
    const evSnake = await svc.evidenceSubmit({
      nodeId: target, artifactPath: artifact, verifier: 'verifier-ci',
      acceptance: { kind: 'exists' }, producer_instance: 'ROLE-RESEARCH-01',
    }).catch((err) => ({ ok: false, error: 'threw' }));
    const evCamel = await svc.evidenceSubmit({
      nodeId: target, artifactPath: artifact, verifier: 'verifier-ci',
      acceptance: { kind: 'exists' }, producerInstance: 'ROLE-RESEARCH-01',
    }).catch((err) => ({ ok: false, error: 'threw' }));
    // 已 done 的节点会返回 evidence-after-done，属正常拒绝；只要不是 producer-instance-required 即说明归一化生效
    const aliasOk = (r) => r?.ok === true || !String(r?.error ?? '').includes('producer-instance-required');
    add('N12', 'producer 别名归一化（snake / camel 单写都被识别）',
      aliasOk(evSnake) && aliasOk(evCamel),
      `snake=${evSnake?.error ?? 'ok'} camel=${evCamel?.error ?? 'ok'}`);

    // ⑧ decide：**创建**决策（options 内部键必须是 snake_case：option_id）
    let dec = null;
    try {
      dec = await svc.decide({
        decisionId: 'DEC-N5-1',
        level: 'L0',
        question: 'N5 e2e：是否采用当前契约？',
        options: [{ option_id: 'a', label: '采用' }, { option_id: 'b', label: '改' }],
        optionId: 'a',
        note: 'n5 probe',
      });
    } catch (err) { dec = { ok: false, error: 'threw' }; }
    add('N7', 'decide 创建 L0 决策（question + options[option_id]≥2 + optionId）',
      dec?.ok === true,
      dec?.ok === true ? `status=${dec.result?.decision?.status ?? 'ok'}` : `code=${dec?.error}${dec?.result?.message ? '（' + dec.result.message + '）' : ''}`);

    // ⑧b L2 缺 defaultOptionId/timeoutSec → 必须拒绝（guard-pass）
    let decL2 = null;
    try {
      decL2 = await svc.decide({
        decisionId: 'DEC-N5-2',
        level: 'L2',
        question: 'N5：L2 缺参数应被拒',
        options: [{ option_id: 'a', label: 'A' }, { option_id: 'b', label: 'B' }],
        optionId: 'a',
      });
    } catch (err) { decL2 = { ok: false, error: 'threw' }; }
    add('N13', 'L2 缺 defaultOptionId/timeoutSec → 拒绝（guard-pass）',
      decL2?.ok === false && String(decL2?.error ?? '').includes('params-required'),
      `code=${decL2?.error}`);

    // ⑧c 契约瑕疵：options 用 optionId（camel）会被判"至少两项且唯一"
    let decCamel = null;
    try {
      decCamel = await svc.decide({
        decisionId: 'DEC-N5-3',
        level: 'L0',
        question: 'q',
        options: [{ optionId: 'a', label: 'A' }, { optionId: 'b', label: 'B' }],
        optionId: 'a',
      });
    } catch (err) { decCamel = { ok: false, error: 'threw' }; }
    add('N12b', 'decide 的 options 别名归一化（option_id / optionId 单写都被识别）',
      decCamel?.ok === true,
      `camel=${decCamel?.ok === true ? 'ok' : decCamel?.result?.message ?? decCamel?.error} / snake=ok`);

    // ⑨ export 投影
    let exp = null;
    try { exp = await svc.exportProjection({ outDir: path.join(ws, 'export') }); } catch (err) { exp = { ok: false, error: 'threw' }; }
    const expFiles = exp?.result?.files ?? exp?.files ?? [];
    add('N14', 'export 投影可导出（从 journal）',
      exp?.ok === true && (Array.isArray(expFiles) ? expFiles.length > 0 : true),
      exp?.ok === true ? `files=${Array.isArray(expFiles) ? expFiles.length : 'n/a'}` : `error=${exp?.error ?? exp?.result?.error}`);

    // ⑨ G5 真实实现
    const g5Script = path.join(HERE, 'state-g5.mjs');
    if (fs.existsSync(g5Script)) {
      const { execFileSync } = await import('node:child_process');
      let parsed = null;
      let errMsg = '';
      try {
        parsed = JSON.parse(execFileSync(process.execPath, [g5Script, '--json'], { encoding: 'utf8', cwd: REPO_ROOT }));
      } catch (err) {
        errMsg = String(err?.message ?? err);
        try { parsed = JSON.parse(String(err?.stdout ?? '')); } catch { /* ignore */ }
      }
      if (parsed) add('N6', 'G5 恢复断言跑真实 lib/state（recovery.js）', parsed.state === 'pass', `passed=${parsed.passed}/${parsed.total} state=${parsed.state}`);
      else add('N6', 'G5 恢复断言跑真实 lib/state', false, errMsg.slice(0, 120));
    } else unknown('N6', 'G5 真实实现', 'state-g5.mjs 缺失');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => c.ok === false).length;
  const skipped = checks.filter((c) => c.skip).length;
  const passed = checks.filter((c) => c.ok === true).length;
  const state = failed > 0 ? 'failed' : skipped > 0 ? 'drift' : 'pass';
  return { state, exitCode: EXIT[state], passed, failed, skipped, total: checks.length, checks };
}

// ── main ──────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenarioPath = path.join(SCEN_DIR, `${args.scenario}.json`);
  if (!fs.existsSync(scenarioPath)) {
    console.error(`scenario 不存在：${scenarioPath}`);
    process.exit(EXIT.failed);
  }
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  const base = scenario.base_scenario ? JSON.parse(fs.readFileSync(path.join(SCEN_DIR, scenario.base_scenario), 'utf8')) : scenario;

  if (args.port === 'native') {
    const res = await runNative();
    if (args.json) console.log(JSON.stringify({ scenario: args.scenario, port: 'native', ...res }, null, 2));
    else {
      console.log(`\n=== ${args.scenario} @native ===`);
      for (const c of res.checks ?? []) {
        const mark = c.skip ? 'SKIP' : c.ok ? 'PASS' : 'FAIL';
        console.log(`${mark}  ${c.id.padEnd(6)} ${c.title}${c.detail ? ' — ' + c.detail : ''}`);
      }
      console.log(`\nstate=${res.state} passed=${res.passed ?? 0} failed=${res.failed ?? 0} skipped=${res.skipped ?? 0} exit=${res.exitCode}${res.reason ? ' — ' + res.reason : ''}`);
    }
    process.exit(res.exitCode);
  }

  const outDir = args.out || path.join(REPO_ROOT, 'out', 'e2e', args.scenario);
  const port = new MockPort({ scenario: base, journal: new N4Journal(), clock: makeClock(), outDir });
  const report = new Report(args.scenario, 'mock');

  if (args.scenario === 'crud_wish') await runCrudWish(port, base, report);
  else if (args.scenario === 'failure_replan') await runFailureReplan(port, scenario, base, report);
  else report.add('scenario', '未知场景', false, args.scenario);

  const exported = await port.exportProjection({ outDir });
  report.add('U2', 'exportProjection 从 journal 生成且产出文件',
    exported.ok && exported.value.source === 'journal' && exported.value.files.length > 0,
    exported.ok ? exported.value.files.map((f) => path.basename(f.path)).join(',') : exported.code);

  await assertTeamProjection(port, report);
  assertRecovery(port, report);
  await assertUxContract(report, { toolNames: await toolNamesFromLib() });

  const s = report.summary();
  if (args.json) console.log(JSON.stringify({ scenario: args.scenario, port: 'mock', ...s, checks: report.checks }, null, 2));
  else {
    console.log(`\n=== ${args.scenario} @mock ===`);
    for (const c of report.checks) {
      const mark = c.skip ? 'SKIP' : c.ok ? 'PASS' : 'FAIL';
      console.log(`${mark}  ${c.id.padEnd(18)} ${c.title}${c.detail ? ' — ' + c.detail : ''}`);
    }
    console.log(`\nstate=${s.state} passed=${s.passed} failed=${s.failed} skipped=${s.skipped} total=${s.total} exit=${s.exitCode}`);
  }
  process.exit(s.exitCode);
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(EXIT.failed);
});
