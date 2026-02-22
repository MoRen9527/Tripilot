```markdown
# 内置工具：listDirectory

> 列出某个目录下的子项（文件/子目录），用于探索工程结构。

## 公开资料依据

- VS Code 官方内置工具列表（listDirectory 简述）：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

## 语义与行为

- 输入：目录路径。
- 输出：子项列表；通常会用末尾 `/` 标识目录。
- 副作用：无（只读）。

## Tripilot 建议接口

- `list_dir({ path })`

## 注意事项

- 在工具实现里，尽量要求使用绝对路径或工作区相对路径，并避免越界访问工作区外。

```