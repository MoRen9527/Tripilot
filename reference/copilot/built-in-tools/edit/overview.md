# VS Code 内置工具：edit（工具族）总览

> 目的：把 Copilot Chat/VS Code Chat 中与“修改工作区内容”相关的内置工具做成一份可对齐规格，供 Tripilot 实现与验收使用。

## 公开资料依据（优先 VS Code 官方）

- Copilot in VS Code cheat sheet（包含内置 tools 列表与简述）：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features
- Review AI-generated code edits（描述编辑的“待审查/接受/撤销/自动接受/敏感文件审批”体验与设置项）：
  - https://code.visualstudio.com/docs/copilot/chat/review-code-edits
- Notebooks with AI（描述 notebook 场景下的“生成/编辑/跨多 cell 编辑”的产品行为线索）：
  - https://code.visualstudio.com/docs/copilot/guides/notebooks-with-ai

> 说明：官方文档通常只公开“工具名称 + 用途描述”，未必公开每个工具的精确 JSON schema。本文档因此把“行为语义”与“Tripilot 建议接口”分开写，避免把推测当成事实。

## 工具族范围

官方内置工具列表中与编辑相关的条目包括（名称以文档为准）：

- `#edit`（tool set）：启用对工作区的修改能力（概念上是“允许编辑工具可用/可执行”）
- `#createDirectory`：创建目录
- `#createFile`：创建文件
- `#editFiles`：对工作区文件应用编辑
- `#editNotebook`：编辑 notebook
- `#newJupyterNotebook`：基于描述生成一个新 notebook（与 `/newNotebook` slash command 同属“scaffold notebook”能力）

## 关键体验语义（与 Copilot Chat 对齐）

### 1) 编辑结果的“待审查（Pending changes）”

VS Code 会跟踪由 AI 产生的编辑，并在 Chat 视图和编辑器里以“可审查”的方式呈现：

- 修改会被写入磁盘（由 VS Code 记录哪些文件有待审查的 AI edits）
- 你可以按文件或按变更块（chunk）接受/撤销
- 与 Source Control 有联动：暂存/丢弃会影响 pending edits

这决定了 Tripilot 的“edit 工具”需要具备：
- 将改动以 diff/patch 形式呈现
- 支持用户审批：Keep/Undo（或 Apply/Cancel）
- 能记住 pending 状态（至少在会话生命周期内）

### 2) 自动接受（Auto-accept）

官方提供设置 `chat.editing.autoAccept`，可在一段延迟后自动接受 AI edits；并允许取消倒计时。

Tripilot 对齐建议：
- 先实现显式审批流（preview/apply/cancel）
- 可选增加“延迟自动应用”开关，但默认关闭

### 3) 敏感文件审批（Edit sensitive files）

官方提供设置 `chat.tools.edits.autoApprove`：通过 glob 规则决定哪些路径的 edits 可自动批准、哪些必须弹出审批。

Tripilot 对齐建议：
- 提供类似的 allow/deny glob 规则
- 默认对典型敏感文件强制审批（例如 `.env`、`.vscode/*.json`、CI/CD 配置等）

## Tripilot 实现边界（建议）

- 不要“静默写盘”：所有涉及写入工作区的操作都要可追踪、可回滚
- 对 notebook 采用 cell 级别编辑，不把 ipynb 当普通 JSON 文本直接 patch（除非明确选择“文本模式”）
- 对多文件 edits：尽量用“最小 patch”而非整文件覆盖

## 与 Tripilot 现有工具映射（建议命名）

- `#createDirectory` -> `create_directory(dirPath)`
- `#createFile` -> `create_file(filePath, content)`
- `#newJupyterNotebook` -> `create_new_jupyter_notebook(query)`
- `#editFiles` -> `apply_patch(...)`（或更高层的“多文件 patch list”封装）
- `#editNotebook` -> `edit_notebook_file(filePath, cellId, editType, newCode, language)`

> 上述为 Tripilot 内部工具接口建议/现状（以仓库工具实现为准），不是官方公开 schema。
