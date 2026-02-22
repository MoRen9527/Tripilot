````markdown
```markdown
# 内置工具：vscodeAPI

> 查询 VS Code Extension API 的文档/示例，用于回答“某个 API 怎么用”“某个贡献点怎么配置”等问题。

## 结论：Tripilot 是否需要实现？

- **需要实现（如果你想对齐 Copilot 的该能力）**：扩展侧没有公开的“VS Code API 文档检索服务”可以直接调用。

## 可选替代方案（不实现工具也能满足部分需求）

- 打开官方文档：
  - 直接用 `openSimpleBrowser` / `vscode.env.openExternal()` 打开 https://code.visualstudio.com/api
- 本地 API 提示：
  - 通过 TypeScript 的 `vscode` 类型定义（`vscode.d.ts`）做静态查询（需要你自建索引）

## Tripilot 若要实现的方向（建议）

- 方案 A：内置索引
  - 把 `vscode.d.ts`、官方文档关键页做离线索引（全文检索/向量检索）
  - 优点：离线可用、速度快
  - 缺点：需要维护版本、内容更新

- 方案 B：联网检索
  - 拉取官方文档页面（HTML/Markdown）并做检索
  - 优点：更新快
  - 缺点：需要网络、解析成本、稳定性

## Tripilot 建议接口

- `vscode_api({ query, version? }) -> { answer, sources[] }`

> 注意：此工具在 Copilot 里属于产品内置检索能力；Tripilot 若实现，建议显式标注“数据源与版本”。

```
````
