import type { CoordinationPartition, CoordinationSpec } from './graphspec.ts';
import type { Store } from './store.ts';

/**
 * 协调域索引缓存：`coordinationJson → { owners, byId }`。
 *
 * **为什么必须缓存**：`leaseCapacity` 每次都要把「节点 → 所属分区」建成两张表
 * （owners 按 nodeRefs 累加，byId 按 id 索引），成本是 O(所有分区的所有 nodeRefs)
 * —— 也就是 O(节点数)。而它被**每次 claim** 调用。5000 节点图上单次建表约 0.3ms，
 * claim p50 从 0.15ms 涨到 1.29ms，就是这么来的。
 *
 * 分区结构只在 `graph_commit` / `replan` 时变化，而那时 meta 里的
 * `graph_coordination` 字符串会整体换掉。用它当缓存键，天然失效，
 * 不需要显式的失效通知，也不会读到过期索引。
 *
 * 缓存值不可变（建成后只读），所以多个 store 共享同一份也安全。
 */
const coordinationIndexCache = new Map<
  string,
  { owners: Map<string, CoordinationPartition>; byId: Map<string, CoordinationPartition> }
>();

function coordinationIndex(coordination: CoordinationSpec | null) {
  const key = coordination ? JSON.stringify(coordination) : '';
  const hit = coordinationIndexCache.get(key);
  if (hit) return hit;
  const partitions = coordination?.partitions ?? [];
  const byId = new Map(partitions.map((partition) => [partition.id, partition]));
  const owners = new Map<string, CoordinationPartition>();
  for (const partition of partitions) {
    for (const nodeId of partition.nodeRefs) owners.set(nodeId, partition);
  }
  const built = { owners, byId };
  // 上限保护：正常项目分区结构不会频繁变，留少量条目即可避免无界增长
  if (coordinationIndexCache.size > 32) coordinationIndexCache.clear();
  coordinationIndexCache.set(key, built);
  return built;
}

/**
 * 容量快照：只读规划（dispatchPlan）与同步租约准入（task_claim）共用同一份。
 *
 * 关键点是「同一份」：如果两条路径各自算一遍 active 数，就可能出现
 * 「计划说还能派 3 个、实际 claim 说超限」这种互相打脸的现场。
 */
export function leaseCapacity(store: Store, now: number, hostLimit = Infinity) {
  const coordination = JSON.parse(store.state.meta.get('graph_coordination') ?? 'null') as CoordinationSpec | null;
  const enabled = coordination?.enabled ? coordination : null;
  const graphLimit = Number(store.state.meta.get('graph_max_parallel'));
  const maxActive = Math.min(hostLimit, graphLimit > 0 ? graphLimit : Infinity, enabled?.maxActive ?? Infinity);
  const partitions = enabled?.partitions ?? [];
  const { owners, byId } = coordinationIndex(enabled);
  const domainsFor = (nodeId: string) => {
    const domains: CoordinationPartition[] = [];
    for (let domain = owners.get(nodeId); domain; domain = byId.get(domain.parentId ?? '')) domains.push(domain);
    return domains;
  };
  let active = 0;
  const activeByPartition = new Map(partitions.map(({ id }) => [id, 0]));
  for (const lease of store.state.leases.values()) {
    if (lease.expires_at <= now) continue;
    active += 1;
    for (const { id } of domainsFor(lease.node_id)) activeByPartition.set(id, (activeByPartition.get(id) ?? 0) + 1);
  }
  return { active, maxActive, activeByPartition, domainsFor };
}
