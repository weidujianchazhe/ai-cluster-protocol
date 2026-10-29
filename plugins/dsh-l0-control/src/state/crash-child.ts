/**
 * N4 · 真实强杀用例的**子进程**（不是测试夹具，是被 SIGKILL 的对象）
 *
 * 用法：`node crash-child.ts <stateDir> <appendCount>`
 * 行为：
 *   1. 以单写者身份打开 stateDir；
 *   2. 追加 N 条 `node_added`；
 *   3. 把已提交的 revision 写进 `<stateDir>/committed.txt`（供父进程读取，避免依赖管道）；
 *   4. 不 close、不 release，空转等待父进程 SIGKILL —— 留下"活锁 + 完整 journal"的现场。
 */

import path from 'node:path';
import fs from 'node:fs';
import { NodeFsPort } from './fs-port.ts';
import { Store } from './store.ts';

const dir = process.argv[2];
const count = Number(process.argv[3] ?? 5);
if (!dir) {
  console.error('usage: node crash-child.ts <stateDir> [appendCount]');
  process.exit(2);
}

const store = await Store.open({ dir, fs: new NodeFsPort(), owner: 'crash-child', ttlMs: 1000 });
for (let index = 1; index <= count; index += 1) {
  await store.append({
    kind: 'node_added',
    nodeId: `N${index}`,
    payload: { node: { nodeId: `N${index}`, title: `节点 ${index}`, status: 'planned' } },
  });
}
fs.writeFileSync(path.join(dir, 'committed.txt'), String(store.revision), 'utf8');

// 故意不 close/release：模拟进程被杀在"已提交、未清理"的窗口
setInterval(() => {}, 1000);
