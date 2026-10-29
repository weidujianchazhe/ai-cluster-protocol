/**
 * 幂等键注册表（进程内，TTL 淘汰）。
 *
 * 语义（A2A/HTTP 幂等的常见做法）：
 *  - 同键 + 同指纹 → **replay**：返回首次的响应（不再调用端口），并标 `Idempotent-Replay: true`；
 *  - 同键 + 异指纹 → **conflict**：409，绝不"用旧响应糊过去"；
 *  - 无键 → 调用方自己负责去重（传输层按配置可强制要求键）。
 *
 * 为什么进程内而不落盘：幂等窗口只需覆盖客户端重试（秒级~小时级）；
 * 落盘会与 N4 的 journal/快照写域重叠，且重放语义应由权威层（journal）承担，不由传输层承担。
 */
export interface IdempotentEntry {
  fingerprint: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  at: number;
}

export type BeginOutcome =
  | { kind: 'fresh' }
  | { kind: 'replay'; status: number; headers: Record<string, string>; body: unknown }
  | { kind: 'conflict'; originalFingerprint: string };

export interface IdempotencyOptions {
  ttlMs?: number;
  now?: () => number;
  /** 容量上限，超出按最旧淘汰（防内存被刷爆）。 */
  maxEntries?: number;
}

export class IdempotencyRegistry {
  ttlMs: number;
  maxEntries: number;
  now: () => number;
  entries: Map<string, IdempotentEntry>;

  constructor(options: IdempotencyOptions = {}) {
    this.ttlMs = Number(options.ttlMs ?? 24 * 60 * 60 * 1000);
    this.maxEntries = Number(options.maxEntries ?? 5000);
    this.now = options.now ?? Date.now;
    this.entries = new Map();
  }

  get size(): number {
    this.prune();
    return this.entries.size;
  }

  prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.at < cutoff) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  begin(key: string, fingerprint: string): BeginOutcome {
    this.prune();
    const existing = this.entries.get(key);
    if (!existing) return { kind: 'fresh' };
    if (existing.fingerprint !== fingerprint) {
      return { kind: 'conflict', originalFingerprint: existing.fingerprint };
    }
    return {
      kind: 'replay',
      status: existing.status,
      headers: { ...existing.headers },
      body: existing.body,
    };
  }

  settle(key: string, fingerprint: string, status: number, headers: Record<string, string>, body: unknown): void {
    this.entries.set(key, {
      fingerprint,
      status,
      headers: { ...headers },
      body,
      at: this.now(),
    });
    this.prune();
  }

  /** 失败时释放键，避免"失败的请求把键占死"。 */
  release(key: string): void {
    this.entries.delete(key);
  }
}
