# VS Code 内置工具：#editNotebook

## 一句话概述

对 Jupyter Notebook（`.ipynb`）执行结构化编辑（以 cell 为单位插入/删除/修改），避免把 notebook 当作普通文本文件硬改。

## 公开资料依据

- 内置工具列表中对 `#editNotebook` 的描述：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features
- notebook 场景下的 AI 编辑体验（inline edits、跨多 cell 编辑、overlay controls）：
  - https://code.visualstudio.com/docs/copilot/guides/notebooks-with-ai
- AI edits 的审查与接受机制（同样适用于 notebook 编辑结果的 review）：
  - https://code.visualstudio.com/docs/copilot/chat/review-code-edits

## 核心行为语义

- 定位目标：按 cell（而不是按 JSON 文本行）对 notebook 进行变更
- 支持的动作通常包括：
  - 插入 cell
  - 删除 cell
  - 编辑 cell 内容
  - 修改 cell 类型（code/markdown）

官方文档在 notebook 场景强调：
- inline chat 可以在单个 cell 中产出改动
- agent 可以做跨多个 cell 的较大编辑
- 编辑结果会进入“可审查/可接受/可撤销”的流程

## 与其它 notebook 工具的配合（对齐建议）

在 Tripilot 实现里，建议把 notebook 的工作流拆成：

1) 读取结构：`getNotebookSummary`（列出 cell id、类型、范围等）
2) 编辑：`editNotebook`
3) 若需要验证：`runCell`
4) 读取执行输出（用于下一轮推理）：`readNotebookCellOutput`

## 风险与审批建议

- notebook 编辑属于写操作：需要审批/可回滚
- notebook 运行属于“执行代码”：必须单独审批（不要因为编辑被批准就默认允许执行）

## Tripilot 建议接口（实现对齐用）

- 工具名：`edit_notebook_file`
- 关键入参：
  - `filePath`：notebook 绝对路径
  - `cellId`：目标 cell id（或插入位置锚点）
  - `editType`：`insert` | `delete` | `edit`
  - `newCode`：新 cell 内容（`edit/insert` 时）
  - `language`：`python`/`markdown` 等（可选）

## 典型用法（提示词写法）

- “在数据清洗 cell 后新增一个可视化 cell：画缺失值热力图。”
- “把所有绘图 cell 统一为 seaborn 风格，并添加解释性 Markdown。”

## 不适用场景

- 只想对 `.ipynb` 做小的 JSON 文本替换：不推荐（diff 难审查，容易破坏格式）
- 需要批量读取/执行：用 notebook 运行/读取输出相关工具组合
