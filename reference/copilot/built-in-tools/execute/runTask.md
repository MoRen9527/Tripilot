# VS Code 内置工具：#runTask

## 一句话概述

运行工作区中已有的 VS Code Task（通常定义在 `.vscode/tasks.json` 中）。

## 公开资料依据

- 内置工具列表中对 `#runTask` 的描述：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

## 核心行为语义

- 读取工作区的 Task 配置（`.vscode/tasks.json`）
- 运行指定 Task（通过 label 或 ID）
- 返回执行输出（stdout/stderr/exitCode）

### 与 `createAndRunTask` 的区别

- `runTask`：执行已有 Task（用户已配置，相对可信）
- `createAndRunTask`：临时创建 + 立即执行（更灵活但风险更高）

## 风险与审批建议（中风险）

**可配置审批**：
- 因为 Task 已由用户预先定义，风险相对较低
- 但仍可能执行长时间任务（例如完整构建）或影响系统（例如 `npm publish`）

Tripilot 对齐建议：
- 首次运行某 Task 时弹出审批
- 用户批准后可记住"本会话内信任该 Task"
- 对明确标记为 `isBackground` 的 Task（例如 watch）可自动批准

## Tripilot 建议接口（实现对齐用）

- 工具名：`run_task`
- 入参：
  - `id`：Task 标识（label 或内部 ID）
  - `workspaceFolder`：工作区根路径

返回值：
- `stdout`/`stderr`
- `exitCode`
- Task ID（若后续需要 `getTaskOutput`）

## 典型用法（提示词写法）

- "运行构建 Task。"
- "执行测试 Task 并查看结果。"

## 不适用场景

- 工作区没有 Task 配置：改用 `createAndRunTask` 或 `runInTerminal`
