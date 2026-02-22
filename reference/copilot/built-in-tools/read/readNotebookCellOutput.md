```markdown
# 内置工具：readNotebookCellOutput

> 读取 notebook 某个 cell 的“最近一次执行输出”（或从磁盘恢复的输出）。不触发重新执行。

## 公开资料依据

- VS Code 官方内置工具列表（readNotebookCellOutput 简述）：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

## 语义与行为

- 输入：notebook 路径 + `cellId`
- 输出：该 cell 的输出（可能包含多种 mime 类型；工具实现通常会挑选或汇总为文本）
- 副作用：无（只读，不会运行 cell）

## 典型链路

- `getNotebookSummary` 先拿到 cellId
- `readNotebookCellOutput` 获取输出，作为分析/调试/继续生成图表的上下文

## 注意事项

- 如果 cell 从未执行过，输出可能为空。
- 输出可能很大（图像、表格、长日志）；建议：
  - 默认只返回文本/摘要
  - 需要时再按 mime 类型做更细读取（若 Tripilot 支持）

## Tripilot 建议接口

- `read_notebook_cell_output({ filePath, cellId })`

```