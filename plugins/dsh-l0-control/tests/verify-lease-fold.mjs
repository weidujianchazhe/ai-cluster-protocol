// 重启一致性：租约的「内存态」必须完全由 journal 事件决定。
//
// 背景：Bug 8 —— `dropLease` 只删内存、不写事件，重启后 fold 重放旧的
// `lease_claimed` 把租约复活，节点停在 ready 却「已被持有」，永久卡死。
// 这个测试锁定因果：租约在不在，只看事件里有没有 release。
import { foldEvents } from "../lib/core/fold.js";

let seq = 0;
const ev = (kind, nodeId, payload = {}) => ({
  seq: ++seq,
  kind,
  node_id: nodeId,
  payload,
  at: new Date().toISOString(),
});

const node = {
  node_id: "N1",
  title: "t",
  spec: "s",
  status: "ready",
  deps: [],
  attempts: 0,
  assignee: null,
  evidence_required: [],
  verifier_ids: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const base = [ev("node_added", "N1", { node })];
const claimed = ev("lease_claimed", "N1", {
  owner: "role-code-01",
  fencing_token: 1,
  expires_at: 9999999999999,
  heartbeat_at: 1,
});

const cases = [];
const check = (name, cond, detail) => cases.push({ name, pass: Boolean(cond), detail });

// A. 只有 claim → 租约存在
{
  seq = 0;
  const s = foldEvents([ev("node_added", "N1", { node }), ev("lease_claimed", "N1", claimed.payload)]);
  check("只有 lease_claimed → 租约存在", s.leases.size === 1, `size=${s.leases.size}`);
}

// B. claim + release → 租约不存在（这是 Bug 8 的修复语义）
{
  seq = 0;
  const s = foldEvents([
    ev("node_added", "N1", { node }),
    ev("lease_claimed", "N1", claimed.payload),
    ev("lease_released", "N1", { reason: "rejected:credential_unavailable" }),
  ]);
  check("lease_claimed + lease_released → 租约消失", s.leases.size === 0, `size=${s.leases.size}`);
}

// C. release 之后再 claim → 租约回来，fencing token 单调递增
{
  seq = 0;
  const s = foldEvents([
    ev("node_added", "N1", { node }),
    ev("lease_claimed", "N1", claimed.payload),
    ev("lease_released", "N1", { reason: "rejected" }),
    ev("lease_claimed", "N1", { owner: "role-code-01", fencing_token: 2, expires_at: 9999999999999, heartbeat_at: 2 }),
  ]);
  const lease = s.leases.get("N1");
  check("release 后重新 claim → token=2", lease?.fencing_token === 2, `token=${lease?.fencing_token}`);
}

// D. 顺序敏感：release 在前、claim 在后 → 租约仍存在（证明按 seq 排序执行）
{
  seq = 0;
  const s = foldEvents([
    ev("node_added", "N1", { node }),
    ev("lease_released", "N1", { reason: "stale" }),
    ev("lease_claimed", "N1", claimed.payload),
  ]);
  check("release 在 claim 前 → 租约仍存在", s.leases.size === 1, `size=${s.leases.size}`);
}

const failed = cases.filter((c) => !c.pass);
for (const c of cases) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : "  (" + c.detail + ")"}`);
console.log(failed.length === 0 ? "\nALL PASS" : `\nFAILED: ${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);
