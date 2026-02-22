# VS Code 内置工具：#newJupyterNotebook

## 一句话概述

基于自然语言描述生成一个新的 Jupyter Notebook（`.ipynb`），属于“脚手架/生成”能力。

## 公开资料依据

- 内置工具列表中对 `#newJupyterNotebook` 的描述：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features
- Notebook 场景下的 AI 创建/编辑体验（包含 `/newNotebook` 与 Agent 生成 notebook 的描述）：
  - https://code.visualstudio.com/docs/copilot/guides/notebooks-with-ai

## 与 `/newNotebook` 的关系

从官方文档可见：

- `/newNotebook` 是 Chat 的 slash command，用于“按需求生成新 notebook”
- `#newJupyterNotebook` 是 tool（更像是 Agent/工具调用层面的“执行生成 notebook 的动作”）

Tripilot 对齐建议：
- 在 UI 层可提供 `/newNotebook` 风格入口
- 在执行层用 `newJupyterNotebook`（或内部 `create_new_jupyter_notebook`）落地生成文件

## 核心行为语义（建议）

- 输入：一段描述（目标、数据源、库、输出图表/表格等）
- 输出：创建一个 `.ipynb` 文件，至少包含：
  - Markdown 标题/说明
  - 若干代码 cell（例如读取数据、展示头部、绘图等）

注意：官方文档强调 notebook 编辑会伴随“可审查/可接受/可撤销”的体验（overlay controls）。

## 风险与审批建议

- 生成 notebook 会产生新文件，通常风险中等（内容可能包含执行代码）
- 建议：
  - 创建文件可自动批准
  - “运行 cell”必须单独审批（与 `runCell` 工具分离）

并结合 Workspace Trust（不在此文档展开）避免在不受信任工作区自动执行。

## Tripilot 建议接口（实现对齐用）

- 工具名：`create_new_jupyter_notebook`
- 入参：
  - `query`：生成 notebook 的自然语言需求

命名对齐：
- 官方 tool：`#newJupyterNotebook`
- Tripilot 内部实现：`create_new_jupyter_notebook(query)`

## 典型用法（提示词写法）

- “生成一个 notebook：读取 `housing.csv`，做缺失值分析，并画价格分布直方图（seaborn）。”
- “创建一个 notebook：演示 pandas groupby 和透视表，并包含示例数据。”

## 不适用场景

- 只需要在现有 notebook 里改一两个 cell：用 `#editNotebook`
- 需要执行 notebook：用 `runCell`/`runNotebooks` 相关工具（并单独审批）
