/**
 * 证据 / 产物（Python `evidence.py` 的核心部分；提交与验证在 R3 补齐）。
 *
 * 不变量：
 *  - append-only：同 `evidence_id` / `artifact_id` 再写一次直接抛错（不覆盖、不先删后插）；
 *  - 证据必须引用存在的 artifact，且节点必须存在；
 *  - `verdict` 只能是 pass / fail / unknown；`unknown` 永不等价于 pass。
 */
import { DuplicateEvidence, EvidenceError } from "./errors.js";
import { ALIASES, pickAlias, pickNumber, pickString } from "./alias.js";
                                                                    
import { VERDICTS } from "./types.js";
                                        

                                   
                     
               
                 
                       
                         
                                
 

                                   
                     
                 
               
                     
                     
                   
                                                      
                            
                                                
                                  
                     
              
 

/**
 * 实例 ID 解析（统一身份 A：角色实例与 Team member 同名）。
 *
 * 接受两种写法：
 *   - 旧大写：`ROLE-CODE-01`、`ROLE-AUDIT-CODE-01`
 *   - 小写  ：`role-code-01`、`role-audit-code-01`
 *
 * 归一：`role` 为连字符转下划线后大写 → `CODE` / `AUDIT_CODE`；
 * `canonical` 保持连字符形态大写（`ROLE-AUDIT-CODE-01`），用于「同实例」比较。
 */
                                 
              
                          
                    
                                             
               
                               
                       
 

const INSTANCE_PATTERN = /^role-([a-z0-9]+(?:[-_][a-z0-9]+)*?)[-_](\d+)$/i;

export function parseInstanceId(instanceId                           )                        {
  const raw = String(instanceId ?? "").trim();
  if (!raw) return null;
  // 允许 `ROLE-CODE-01` 与 `role-audit-code-01`；职务段本身可含连字符/下划线
  const byHyphen = /^role-(.+)[-_](\d+)$/i.exec(raw);
  if (!byHyphen) return null;
  const rolePart = byHyphen[1].replace(/[_\s]+/g, "-");
  const indexText = byHyphen[2];
  const role = rolePart.replace(/-/g, "_").toUpperCase();
  const canonical = `ROLE-${rolePart.toUpperCase()}-${indexText}`;
  return {
    raw,
    canonical,
    role,
    index: Number.parseInt(indexText, 10),
  };
}

/**
 * 从实例 ID 取职务（`ROLE-CODE-01` / `role-code-01` → `CODE`；`role-audit-code-01` → `AUDIT_CODE`）。
 * 非实例 ID（如 `verifier-ci`）原样返回（不猜测、不改写）。
 */
export function roleOfInstance(instanceId        )         {
  return parseInstanceId(instanceId)?.role ?? String(instanceId ?? "");
}

/** 实例同一性比较（大小写/分隔符不敏感）：无法解析时退回字符串比较。 */
export function sameInstance(a        , b        )          {
  const pa = parseInstanceId(a);
  const pb = parseInstanceId(b);
  if (pa && pb) return pa.canonical === pb.canonical;
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

                                    
              
                                                              
                    
                   
                        
                       
 

/**
 * 判定一组证据的「审计独立」（提交者实例 × 审计方实例/职务）。
 * 统一身份：`role-code-01` 与 `ROLE-CODE-01` 视为同一实例；职务按
 * 连字符转下划线大写归一后比较（`role-audit-code-01` → `AUDIT_CODE`）。
 */
export function auditIndependence(
  rows                                                                                ,
)                    {
  for (const row of rows) {
    const producer = String(row.producer_instance ?? "").trim();
    const auditor = String(row.auditor_instance ?? "").trim();
    if (!producer) {
      return { ok: false, reason: "missing-producer", producer: "", auditor };
    }
    if (!auditor) continue; // 未声明审计方：不参与独立判定（由验证器白名单兜底）
    const producerRole = roleOfInstance(producer);
    const auditorRole = roleOfInstance(auditor);
    if (sameInstance(producer, auditor)) {
      return { ok: false, reason: "same-instance", producer, auditor, producerRole, auditorRole };
    }
    if (producerRole === auditorRole) {
      return { ok: false, reason: "same-role", producer, auditor, producerRole, auditorRole };
    }
  }
  return { ok: true };
}

export function getArtifact(store       , artifactId        )                       {
  return store.state.artifacts.get(artifactId);
}

export function addArtifact(store       , input                  )           {
  const { artifactId, path, sha256, producerNode } = input;
  if (!artifactId) throw new EvidenceError("artifact_id 不能为空");
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? "")) {
    throw new EvidenceError(`sha256 必须是 64 位小写十六进制：${artifactId}`);
  }
  if (!store.state.nodes.has(producerNode)) {
    throw new EvidenceError(`producer 节点不存在：${producerNode}`);
  }
  if (store.state.artifacts.has(artifactId)) {
    throw new EvidenceError(`产物已存在且不可覆盖：${artifactId}`, "duplicate_artifact");
  }
  const artifact           = {
    artifact_id: artifactId,
    path,
    sha256,
    producer_node: producerNode,
    verifier_ids: [...(input.verifierIds ?? [])],
    a2a_artifact_id: input.a2aArtifactId ?? null,
  };
  store.state.artifacts.set(artifactId, artifact);
  store.journal.append("artifact_added", producerNode, {
    artifact_id: artifactId,
    path,
    sha256,
    // 供 fold 重建：完整记录（老事件缺这些字段时 fold 走默认值）
    producer_node: producerNode,
    verifier_ids: [...artifact.verifier_ids],
    a2a_artifact_id: artifact.a2a_artifact_id,
  });
  return artifact;
}

export function addEvidence(store       , input                  )                 {
  const raw = input                                      ;
  // 别名兼容（N2 归一化会丢 camel）：两键同时存在且值不同 → AliasError，不静默择一
  const evidenceId = pickString(raw, ALIASES.evidenceId) ?? String(input.evidenceId ?? "");
  const nodeId = pickString(raw, ALIASES.nodeId) ?? String(input.nodeId ?? "");
  const artifactId = pickString(raw, ALIASES.artifactId) ?? String(input.artifactId ?? "");
  const kind = String(input.kind ?? "");
  const verifierId =
    pickString(raw, [...ALIASES.verifierId, "verifier"]) ?? String(input.verifierId ?? "");
  const verdict = input.verdict;
  if (!evidenceId) throw new EvidenceError("evidence_id 不能为空");
  if (!VERDICTS.includes(verdict)) throw new EvidenceError(`非法 verdict：${verdict}`);
  if (!store.state.nodes.has(nodeId)) throw new EvidenceError(`节点不存在：${nodeId}`);
  if (!store.state.artifacts.has(artifactId)) {
    throw new EvidenceError(`artifact 不存在：${artifactId}`);
  }
  // 审计独立的前置：提交者实例必须可辨识（缺 → fail-closed，不落账）
  const producerInstance = String(
    pickString(raw, ALIASES.producerInstance) ?? input.producerInstance ?? "",
  ).trim();
  if (!producerInstance) {
    throw new EvidenceError(
      `证据缺少提交者实例 producerInstance/producer_instance（不可审计，拒绝落账）：${evidenceId}`,
      "producer-instance-required",
    );
  }
  const auditorInstanceRaw = pickAlias(raw, ALIASES.auditorInstance) ?? input.auditorInstance;
  const auditorInstance =
    auditorInstanceRaw === undefined || auditorInstanceRaw === null
      ? null
      : String(auditorInstanceRaw).trim() || null;
  if (auditorInstance) {
    const independence = auditIndependence([
      { producer_instance: producerInstance, auditor_instance: auditorInstance },
    ]);
    if (!independence.ok) {
      throw new EvidenceError(
        `审计不独立（${independence.reason}）：producer=${producerInstance} auditor=${auditorInstance}`,
        "audit-not-independent",
      );
    }
  }
  if (store.state.evidence.has(evidenceId)) {
    throw new DuplicateEvidence(`证据已存在且不可覆盖：${evidenceId}`);
  }
  const record                 = {
    evidence_id: evidenceId,
    node_id: nodeId,
    kind,
    artifact_id: artifactId,
    verifier_id: verifierId,
    verdict,
    attempt_no: pickNumber(raw, ALIASES.attemptNo) ?? input.attemptNo ?? 1,
    at: input.at ?? store.nowIso(),
    producer_instance: producerInstance,
    auditor_instance: auditorInstance,
  };
  store.state.evidence.set(evidenceId, record);
  store.journal.append("evidence_added", nodeId, {
    evidence_id: evidenceId,
    kind,
    verdict,
    verifier_id: verifierId,
    producer_instance: producerInstance,
    auditor_instance: auditorInstance,
    // 供 fold 重建完整记录
    artifact_id: artifactId,
    attempt_no: record.attempt_no,
    at: record.at,
  });
  return record;
}

export function listEvidence(store       , nodeId        )                   {
  return [...store.state.evidence.values()]
    .filter((e) => e.node_id === nodeId)
    .sort((a, b) => (a.at === b.at ? a.evidence_id.localeCompare(b.evidence_id) : a.at.localeCompare(b.at)));
}

export function passEvidence(store       , nodeId        )                   {
  return listEvidence(store, nodeId).filter((e) => e.verdict === "pass");
}


//# sourceURL=core\evidence.js