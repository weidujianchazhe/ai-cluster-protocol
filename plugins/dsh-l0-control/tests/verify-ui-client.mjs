#!/usr/bin/env node
/**
 * UI 客户端契约自检（静态，不启动浏览器）：
 *   1. 不得再写死侧车地址（`http://127.0.0.1:<port>/ui/...`），必须走 resolveBase；
 *   2. 必须有 /ui/health 探测 + localStorage 缓存；
 *   3. 所有请求必须经 getJson/postJson（带超时），不得裸 fetch；
 *   4. 提示文案不得再声称 wish_submit 建图（愿望只记意图）。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..', '..');
const clientPath = path.join(root, 'dsh-l0-control-ui', 'client.js');
const src = fs.readFileSync(clientPath, 'utf8');

// 1) 无写死的侧车 URL
const hardcoded = src.match(/https?:\/\/127\.0\.0\.1:\d+\/ui\/[a-z-]+/g) ?? [];
assert.equal(hardcoded.length, 0, `client.js 仍有写死的侧车地址：${hardcoded.join(', ')}`);

// 2) 地址解析与探测
assert.ok(src.includes('resolveBase'), '缺少 resolveBase');
assert.ok(src.includes('/ui/health'), '缺少 /ui/health 探测');
assert.ok(src.includes('localStorage'), '缺少 localStorage 缓存');
assert.ok(src.includes('AbortController'), '缺少请求超时（AbortController）');

// 3) 请求统一入口
assert.ok(src.includes('const getJson'), '缺少 getJson 统一入口');
assert.ok(src.includes('const postJson'), '缺少 postJson 统一入口');
const bareFetch = (src.match(/\bawait fetch\(/g) ?? []).length;
// 允许 fetch 只出现在 request()/resolveBase() 内部（各 1 处）
assert.ok(bareFetch <= 2, `裸 fetch 过多（${bareFetch} 处），请求应统一走 request/getJson/postJson`);

// 4) 文案不再声称 wish_submit 建图
assert.ok(!/先 wish_submit 生成工作图/.test(src), '中文提示仍在说 wish_submit 建图');
assert.ok(!/run wish_submit first/.test(src), '英文提示仍在说 wish_submit 建图');

// 5) 离线提示可诊断（提到端口/探测）
assert.ok(/探测|probed/.test(src), '离线提示未说明"已探测端口"');

// 6) 同源通道优先：必须先试 /l0-control，而不是一上来就跨源
assert.ok(src.includes("'/l0-control'"), '缺少同源前缀常量');
assert.ok(/const list = \[''\]/.test(src), '同源必须是第一个候选（否则又回到跨源不稳定）');
assert.ok(src.includes('fetch(toUrl(base'), '请求必须经 toUrl 拼装，确保同源与回环两种 base 都正确');

console.log('PASS ui-client: 5/5（无写死端口 / 健康探测 / 统一请求 / 文案 / 可诊断）');
