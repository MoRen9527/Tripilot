````markdown
```markdown
# 内置工具：extensions

> 列出/查询当前已安装并可用的 VS Code 扩展（Extension），用于让 agent 了解“可以调用哪些扩展贡献的能力”。

## 结论：Tripilot 是否需要实现？

- **不需要自研底层能力**：VS Code Extension API 直接提供扩展枚举与查询。
- Tripilot 若要把它暴露给 LLM/agent：只需要做一个“只读工具包装”，返回必要字段即可。

## VS Code 可直接复用的能力

- `vscode.extensions.all`：列出所有已知扩展
- `vscode.extensions.getExtension(extensionId)`：按 `publisher.name` 查询扩展

兼容性：VS Code + VSCodium 均可用（属于公开稳定 API）。

## 语义与行为（建议对齐）

- 输入：可选过滤条件（例如 publisher/name 前缀、是否已激活、是否启用等）
- 输出：扩展摘要列表（id、displayName、isActive、extensionUri 等）
- 副作用：无（只读）

## Tripilot 建议接口

- `extensions({ query?, includeDisabled? }) -> ExtensionSummary[]`

建议最小返回字段：
- `id`（`publisher.name`）
- `displayName`
- `isActive`

> 备注：扩展对象暴露字段较多，建议做裁剪，避免泄露不必要的本机信息。

```
````
