````markdown
```markdown
# 内置工具：installExtension

> 安装 VS Code 扩展。Copilot Chat 里通常用于“为完成任务安装缺失的能力”。

## 结论：Tripilot 是否需要实现？

- **可以在 VS Code 里 best-effort 复用**：通过内置命令触发安装。
- **但不建议把它当作稳定能力**：安装行为受扩展库/画廊服务、产品发行版、远程模式影响。
- 对 VSCodium：强烈建议以“安装 VSIX + 引导用户确认/手动安装”为主。

## VS Code 可复用的能力（内置命令）

- `workbench.extensions.installExtension`
  - 参数通常是：extensionId（`publisher.name`）或 VSIX 的 `vscode.Uri`

相关命令（辅助）：
- `workbench.extensions.search`（打开扩展搜索 UI，不是编程安装 API）

## 兼容性与限制

- VS Code：
  - 若启用 VS Code Marketplace，按 extensionId 安装通常可用。
  - 在远程开发/容器/SSH 等模式下，安装目标（本地/远程）与可见性可能造成困惑，需要额外处理。

- VSCodium：
  - 通常使用 Open VSX 或自定义 gallery。
  - 如果 gallery 未配置、或目标扩展只在 MS Marketplace，按 extensionId 安装可能失败。

## Tripilot 建议策略

- 默认必须用户确认（安装扩展等同于执行第三方代码）。
- 优先路径：
  1) 如果用户提供 VSIX：直接安装 VSIX
  2) 如果用户提供 extensionId：尝试 `workbench.extensions.installExtension`
  3) 失败则降级：打开扩展搜索 UI / 提示用户手动安装

## Tripilot 建议接口

- `install_extension({ id?, vsixUri? })`

返回建议：
- `status: "installed" | "failed" | "needs-user-action"`
- `message?: string`

```
````
