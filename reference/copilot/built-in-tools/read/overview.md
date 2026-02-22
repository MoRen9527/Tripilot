```markdown
# VS Code 内置工具：read（工具族）总览

> 目的：归纳 Copilot Chat 中与“读取上下文/输出/问题面板信息”相关的内置工具语义，用于 Tripilot 对齐实现。

## 公开资料依据

- Copilot in VS Code cheat sheet（内置工具列表与简述）：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features
- Chat tools 概念与类型说明：
  - https://code.visualstudio.com/docs/copilot/chat/chat-tools

## 工具族范围

从官方内置工具列表中，与“读取信息（read-only）”直接相关的条目包括：

- `#readFile`：读取工作区文件内容（通常按行范围）
- `#getNotebookSummary`：获取 notebook 单元格列表与元信息（用于后续选择 cellId）
- `#readNotebookCellOutput`：读取 notebook cell 之前执行过的输出
- `#problems`：将 Problems 面板中的问题/错误作为上下文（用于修复/调试）
- `#terminalLastCommand`：获取当前活动终端上一次命令及其输出
- `#terminalSelection`：获取当前活动终端选择的文本
- `#getTaskOutput`：获取任务运行输出（属于只读；常用于配合 `runTask`/`createAndRunTask`）

> 说明：产品 UI 里这些工具会按“read / execute / edit …”分类展示，但同一工具也可能在不同语境里被认为属于“执行链路的读取输出”。本目录按你截图中的 read 分类写说明；`getTaskOutput` 在 execute 目录也有对应页面。

## 关键体验语义（与 Copilot Chat 对齐）

### 1) Read 工具通常“低风险”，但仍可能泄露敏感信息

- Read 类工具不直接修改文件、不直接执行命令，风险普遍低。
- 但读取到的内容可能包含密钥/令牌/隐私数据；因此依然需要：
  - 限制读取范围（优先行范围/选区，而不是全文件）
  - 对敏感文件（例如 `.env`、密钥文件）进行额外确认或默认拒绝

### 2) 大多数 read 工具用于“补上下文”，而不是“产生副作用”

典型链路：
- `problems` → 收集错误/告警 → 推断修复点
- `readFile` → 精确读取相关代码片段（而非整仓库）
- `terminalLastCommand` / `getTaskOutput` → 读取输出 → 进入下一轮推理

### 3) 输出可能很大，需要截断与分页策略

Tripilot 对齐建议：
- 在工具返回中提供“截断标记”（例如 `truncated: true`）以及建议下一次读取的范围
- 对文本读取强制要求行范围或最大字符数（避免一次把整个仓库/大文件塞进上下文）

## 风险边界（建议）

### 低风险（可默认自动批准）
- `readNotebookCellOutput` / `terminalSelection`：只读、范围相对可控
- `problems`：只读（但可能暴露路径与代码片段）

### 中风险（建议按策略审批）
- `readFile`：可能读到敏感文件
- `terminalLastCommand`：可能包含凭据、内部地址、访问令牌等
- `getTaskOutput`：可能包含日志中的敏感信息

## 与 Tripilot 现有工具映射（建议命名）

- `#readFile` -> `read_file(filePath, startLine, endLine)`
- `#getNotebookSummary` -> `copilot_getNotebookSummary(filePath)`
- `#readNotebookCellOutput` -> `read_notebook_cell_output(filePath, cellId)`
- `#problems` -> `get_errors(filePaths?)`
- `#terminalLastCommand` -> `terminal_last_command()`
- `#terminalSelection` -> `terminal_selection()`
- `#getTaskOutput` -> `get_task_output(id, workspaceFolder)`

> 上述为 Tripilot 内部工具接口建议，不是官方公开 schema。

```