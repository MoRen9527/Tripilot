```markdown
# 内置工具：getNotebookSummary

> 获取 notebook（.ipynb）中所有 cell 的概要信息（含 cellId、类型、行范围、语言、执行信息等），用于后续选择要运行/编辑/读取输出的 cell。

## 公开资料依据

- VS Code 官方内置工具列表（getNotebookSummary 简述）：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

## 语义与行为

- 输入：notebook 文件路径（通常为绝对路径）。
- 输出：cell 列表，每个 cell 包含：
  - `id`（后续工具用的 cell 标识）
  - cell 类型（markdown/code）、语言
  - 行范围（便于用 readFile 精读某段）
  - 执行信息与输出 mime types（若可用）

- 副作用：无（只读）。

## 典型链路

- 读取输出：`getNotebookSummary` → 选 cellId → `readNotebookCellOutput`
- 运行 cell：`getNotebookSummary` → 选 cellId → execute 工具族的 `runNotebookCell`
- 编辑 cell：`getNotebookSummary` → 选 cellId/行范围 → edit 工具族的 `editNotebook`

## Tripilot 建议接口

- 对齐 VS Code 工具命名：`copilot_getNotebookSummary({ filePath })`

> 说明：Tripilot 的工具名可以与 VS Code 内置工具名不同，但建议在文档里保留一一映射。

```