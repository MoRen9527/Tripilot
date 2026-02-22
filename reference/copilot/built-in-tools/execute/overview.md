# VS Code 内置工具：execute（工具族）总览

> 目的：归纳 Copilot Chat 中与"执行代码/命令/测试"相关的内置工具语义，用于 Tripilot 对齐实现。

## 公开资料依据

- Copilot in VS Code cheat sheet（包含 execute 相关工具的简要说明）：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features
- Agent 模式说明（提到 agent 会自动调用工具并监控编译/测试输出）：
  - https://code.visualstudio.com/docs/copilot/chat/copilot-chat
- Review AI-generated code edits（部分提到与 agent 的工具审批联动）：
  - https://code.visualstudio.com/docs/copilot/chat/review-code-edits

## 工具族范围

官方内置工具列表中与"执行"相关的条目包括：

- `#execute`（tool set）：在机器上执行代码和应用程序（概念上是"允许执行工具可用"）
- `#runInTerminal`：在集成终端运行 shell 命令
- `#getTerminalOutput`：获取终端命令的输出
- `#createAndRunTask`：在工作区创建并运行新任务
- `#runTask`：运行工作区中已有任务
- `#getTaskOutput`：获取任务运行输出
- `#runNotebookCell`：在 notebook 中触发单元格执行
- `#runTests`：运行单元测试（可选覆盖率）
- `#testFailure`：包含有关上次单元测试失败的信息

## 关键体验语义（与 Copilot Chat 对齐）

### 1) 执行前审批（Auto-approve 机制）

官方提供实验性设置：
- `chat.tools.autoApprove`：允许 agent 自动批准所有工具
- `chat.tools.terminal.autoApprove`：允许 agent 自动批准终端命令

默认行为（从产品体验推断）：
- Agent 调用工具时会弹出审批请求
- 用户可批准/拒绝单次执行
- 可配置自动批准（风险较高）

Tripilot 对齐建议：
- **默认必须审批**（特别是 `runInTerminal`/`runTests` 等可能影响系统或消耗时间的操作）
- 提供"仅本会话信任"或"全局信任"选项（但保守为上）

### 2) Agent 监控执行结果并迭代

官方文档描述 Agent 模式的特点：
- Agent 会自动处理编译/lint 错误
- 监控终端和测试输出
- 迭代直到任务完成

这意味着：
- `runInTerminal`/`runTask`/`runTests` 返回的结果会被 agent 用于下一步决策
- 若执行失败，agent 可能继续修复（进入 tool-calling loop）

### 3) 与测试框架的集成

- `#runTests`：应当能调用工作区的测试配置（例如 Jest、pytest、xUnit）
- `#testFailure`：包含失败信息（用于诊断和修复）

Tripilot 对齐建议：
- 优先支持主流测试框架
- 对于需要长时间执行的测试，支持后台运行（`isBackground` 标志）

## 风险边界（建议）

Execute 工具族风险较高，建议：

### 高风险（必须审批）
- `runInTerminal`：可能执行破坏性命令（`rm -rf`、格式化磁盘等）
- `createAndRunTask`：创建并立即执行
- `runTests`：可能消耗大量时间/资源

### 中风险（可配置审批）
- `runTask`：执行已有任务（用户已定义过，相对可信）
- `runNotebookCell`：执行 notebook cell（若在 Workspace Trust 下）

### 低风险（可自动批准）
- `getTerminalOutput`：只读取输出
- `getTaskOutput`：只读取输出
- `testFailure`：只读取失败信息

## Tripilot 实现边界（建议）

- 所有"执行类"操作必须经过审批（或在用户明确授权后放行）
- 返回结果应包含 stdout/stderr/exitCode，便于 agent 推理
- 对后台任务（例如 watch、dev server）应支持 `isBackground=true`，不阻塞会话

## 与 Tripilot 现有工具映射（建议命名）

- `#runInTerminal` -> `run_in_terminal(command, isBackground)`
- `#getTerminalOutput` -> `get_terminal_output(id)`
- `#createAndRunTask` -> `create_and_run_task(task, workspaceFolder)`
- `#runTask` -> `run_task(id, workspaceFolder)`
- `#getTaskOutput` -> `get_task_output(id, workspaceFolder)`
- `#runNotebookCell` -> `run_notebook_cell(filePath, cellId)`
- `#runTests` -> 对应 VS Code 测试 API（需根据项目测试配置推断）
- `#testFailure` -> `test_failure()`（获取最近失败信息）

> 上述为 Tripilot 内部工具接口建议，不是官方公开 schema。
