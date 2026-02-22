````markdown
```markdown
# 内置工具：newWorkspace

> 创建一个新的工作区/项目，并在 VS Code 中打开。Copilot Chat 的体验通常包括：生成目录结构、写入初始文件、安装依赖、打开新窗口。

## 结论：Tripilot 是否需要实现？

- **需要实现（至少部分）**：VS Code 没有“一键生成完整新项目”的通用公共 API。
- 但其中“打开/切换工作区”部分可以复用 VS Code 命令。

## 可复用能力（打开/切换工作区）

- `vscode.commands.executeCommand('vscode.openFolder', folderUri, { forceNewWindow: true })`
- 或 `vscode.workspace.updateWorkspaceFolders(...)`（在当前窗口追加/替换文件夹）

兼容性：VS Code + VSCodium 均可用。

## Tripilot 需要补齐的部分（建议）

- 创建目录结构：使用 Node `fs`/`fs/promises` 或 VS Code `workspace.fs`
- 写入模板文件：README、package.json、src/ 等
- 安装依赖：通常需要结合执行工具（终端命令或 tasks）并做审批
- 错误处理：路径已存在、权限不足、用户取消等

## Tripilot 建议接口

- `new_workspace({ name, directory, template, openInNewWindow? })`

返回建议：
- `workspacePath`
- `opened: boolean`

```
````
