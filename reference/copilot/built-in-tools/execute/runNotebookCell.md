# VS Code 内置工具：#runNotebookCell

## 一句话概述

在 Jupyter Notebook 中触发单元格执行，用于验证代码逻辑或生成数据/图表。

## 公开资料依据

- 内置工具列表中对 `#runNotebookCell` 的描述：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features
- Notebook 场景下的 AI 编辑体验（提到 agent 会生成并运行 cell）：
  - https://code.visualstudio.com/docs/copilot/guides/notebooks-with-ai

## 核心行为语义

- 执行指定 notebook 的指定 cell
- 返回执行结果（输出、错误、图表等）
- 与 `editNotebook` 配合：先编辑 cell，再运行验证

### 与其它 notebook 工具的配合（对齐建议）

典型 agent 工作流：
1. `getNotebookSummary`：读取 notebook 结构
2. `editNotebook`：修改/新增 cell
3. `runNotebookCell`：运行 cell 验证
4. `readNotebookCellOutput`：读取输出用于下一步推理

## 风险与审批建议（中风险）

**可配置审批**：
- 运行 cell 会执行代码，风险中等
- 在 Workspace Trust 下可适当放宽
- 建议首次运行时弹出审批，用户批准后可记住"本会话内信任该 notebook"

官方体验（从文档推断）：
- Agent 生成 notebook 后会自动运行 cell（需用户批准 tool invocation）
- 用户可通过 overlay controls 审查/接受/撤销

Tripilot 对齐建议：
- 运行前弹出审批（显示 cell 内容）
- 对明确标记为"只读/可视化"的 cell（例如绘图）可自动批准

## Tripilot 建议接口（实现对齐用）

- 工具名：`run_notebook_cell`
- 入参：
  - `filePath`：notebook 绝对路径
  - `cellId`：cell ID（由 `getNotebookSummary` 返回）
  - `continueOnError`：是否继续运行后续 cell（默认 false）

返回值：
- 执行状态（success/error）
- 输出内容（text/image/html 等）
- 若出错，返回错误信息

## 典型用法（提示词写法）

- "运行数据清洗 cell，验证缺失值是否已处理。"
- "执行绘图 cell，生成价格分布直方图。"

## 不适用场景

- 需要交互式输入（例如 `input()`）：notebook cell 不支持交互
- 需要长时间运行的训练任务：建议在终端运行（`runInTerminal`）
