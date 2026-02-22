# VS Code 内置工具：#getTerminalOutput

## 一句话概述

获取之前用 `runInTerminal` 启动的终端命令的输出。

## 公开资料依据

- 内置工具列表中对 `#getTerminalOutput` 的描述：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

## 核心行为语义

- 读取指定终端的输出（stdout/stderr）
- 通常用于查看后台任务（`isBackground=true`）的输出
- 只读操作，不会影响终端状态

### 与 `runInTerminal` 的配合

典型流程：
1. `runInTerminal(..., isBackground=true)` 启动后台任务（例如 dev server）
2. 返回 terminal ID
3. 稍后用 `getTerminalOutput(terminalId)` 查看输出

## 风险与审批建议（低风险）

- 只读操作，风险很低
- 可自动批准（无需弹出审批）

## Tripilot 建议接口（实现对齐用）

- 工具名：`get_terminal_output`
- 入参：
  - `id`：终端 ID（由 `runInTerminal` 返回）

返回值：
- `stdout`/`stderr` 的文本内容
- 可选：截断规则（若输出过长）

## 典型用法（提示词写法）

- "查看 dev server 的启动日志。"
- "读取后台测试任务的输出，看是否有失败。"

## 不适用场景

- 实时流式输出：需要用 VS Code 原生终端 UI（本工具返回的是"快照"）
