# VS Code 内置工具：#createFile

## 一句话概述

在工作区内创建一个新文件，并写入初始内容；常用于脚手架生成或新增模块。

## 公开资料依据

- 内置工具列表中对 `#createFile` 的描述：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features
- 关于 AI edits 的审查/自动接受/敏感文件审批（适用于 createFile 这类写操作）：
  - https://code.visualstudio.com/docs/copilot/chat/review-code-edits

## 核心行为语义

- 创建新文件并写入内容
- 与 `#editFiles` 的区别：
  - `#createFile` 更偏“新增”，而 `#editFiles` 偏“在已有文件上做 patch/改动”

建议行为（便于对齐与可预期）：

- 若父目录不存在：先创建目录或返回可解释的错误
- 若目标文件已存在：
  - 默认不覆盖（让上层改用 `#editFiles`，或要求明确“允许覆盖”）
  - 或者走审批/确认流程后覆盖（避免静默破坏）

## 风险与审批建议

- 对敏感文件（例如 `.env`、`.vscode/*.json`）强制审批
- 对普通源码文件可按策略自动批准，但仍应提供“可回滚/可审查”体验

参考：
- `chat.tools.edits.autoApprove`（glob 策略）
- `chat.editing.autoAccept`（延迟自动接受）
  - https://code.visualstudio.com/docs/copilot/chat/review-code-edits

## Tripilot 建议接口（实现对齐用）

- 工具名：`create_file`
- 入参：
  - `filePath`：目标文件绝对路径
  - `content`：文件完整内容（UTF-8 文本）

可选扩展（若 Tripilot 需要更严谨的语义）：
- `overwrite?: boolean`（默认 false）
- `encoding?: 'utf-8'`（默认 utf-8）

## 典型用法（提示词写法）

- “新增 `src/auth/index.ts`，导出 login/logout，并补上单元测试文件。”
- “创建一个 `README.md`，包含安装、运行、测试命令。”

## 不适用场景

- 对已有文件的小改动：优先用 `#editFiles`（更可控、diff 更小）
- 对 notebook：优先用 `#newJupyterNotebook` / `#editNotebook`
