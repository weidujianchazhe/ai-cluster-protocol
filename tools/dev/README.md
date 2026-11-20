# tools/dev —— 开发期文档审计脚本（不进验收链）

这四个脚本是我维护文档时用的**一次性工具**，不是产品功能，也不在 `npm run verify` 里。

| 脚本 | 查什么 | 为什么不在验收链 |
|---|---|---|
| `audit-language.mjs` | 中文文档里混入的纯英文长句（≥8 个英文词） | 文档风格问题，不是语义正确性 |
| `audit-crosslinks.mjs` | 相对链接断链 | 同上；但**值得定期跑**，断了读者就找不到 |
| `audit-md-ratio.mjs` | 各文档的代码块/散文比例 | 仅供参考的指标 |
| `audit-contamination.mjs` | 控制字符（`\t` / `\v` / `\r`）、乱码、BOM 残留 | 同上；这类问题肉眼看不见，但会让 diff 变脏 |

## 怎么用

```bash
node tools/dev/audit-contamination.mjs ../..        # 参数：要扫的根目录
node tools/dev/audit-crosslinks.mjs ../..
node tools/dev/audit-language.mjs ../..
node tools/dev/audit-md-ratio.mjs ../..
```

## 为什么不放进 verify

`verify` 只断言语义（契约、状态机、租约、证据、闸门），**不断言风格**。把风格检查放进 CI，要么被误报打红，要么被人调宽松到失去意义——两条路都会让这条链的公信力下降。

但有一条例外值得考虑单独跑：**控制字符与乱码**（`audit-contamination.mjs`）。它是客观的、不会误报的。
