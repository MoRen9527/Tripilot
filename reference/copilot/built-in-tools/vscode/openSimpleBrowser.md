````markdown
```markdown
# 内置工具：openSimpleBrowser

> 在 VS Code 内部打开一个网页（Simple Browser），用于在编辑器内展示文档/登录页/回调页等。

## 结论：Tripilot 是否需要实现？

- **多数情况下不需要自研**：可以直接调用内置命令打开 Simple Browser。
- 但要准备 **兼容性降级**：如果 Simple Browser 不可用，改用系统浏览器打开。

## VS Code 可直接复用的能力

- 内置命令：`simpleBrowser.show`
  - 常见用法：`vscode.commands.executeCommand('simpleBrowser.show', 'https://example.com')`

降级方案：
- `vscode.env.openExternal(vscode.Uri.parse(url))`

兼容性：
- VS Code：通常可用。
- VSCodium：多半可用，但取决于发行版是否包含/启用 Simple Browser 组件。

## 语义与行为（建议对齐）

- 输入：URL
- 输出：通常无结构化返回（只负责打开）
- 副作用：打开一个编辑器标签页（Simple Browser）或唤起系统浏览器

## Tripilot 建议接口

- `open_simple_browser({ url })`

建议：
- 对 URL 做 allowlist（例如只允许 HTTPS、只允许特定域名/本地回环）
- 对 `http://localhost` 场景提示用户确认（避免 SSRF/本地服务探测）

```
````
