# VS Code 内置工具：#createAndRunTask

## 一句话概述

在工作区创建一个新的 VS Code Task 并立即运行，用于临时执行构建/测试/启动等命令。

## 公开资料依据

- 内置工具列表中对 `#createAndRunTask` 的描述：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

## 核心行为语义

- 创建一个 Task（可能写入 `.vscode/tasks.json`，或仅在内存中）
- 立即执行该 Task
- 返回执行输出（stdout/stderr/exitCode）

### 与 `runTask` 的区别

- `createAndRunTask`：临时创建 + 立即执行（适合一次性任务）
- `runTask`：执行已有 Task（适合重复使用的构建/测试配置）

## 风险与审批建议（高风险）

**必须审批**：
- 会创建 Task 并立即执行，等同于执行任意 shell 命令
- 风险类似于 `runInTerminal`

Tripilot 对齐建议：
- 弹出审批时显示完整 Task 配置（label、command、args）
- 对常见低风险命令可提供"仅本会话信任"选项

## Tripilot 建议接口（实现对齐用）

- 工具名：`create_and_run_task`
- 入参：
  - `task`：Task 配置对象（包含 label、type、command、args 等）
  - `workspaceFolder`：工作区根路径

返回值：
- `stdout`/`stderr`
- `exitCode`
- Task ID（若后续需要 `getTaskOutput`）

## 典型用法（提示词写法）

- "创建并运行一个 Task：编译 TypeScript（`tsc -p .`）。"
- "临时运行测试：`npm test`。"

## 不适用场景

- 需要长期保留的 Task 配置：建议手动写 `tasks.json` 或用 VS Code UI 创建
- 需要交互式输入：改用 VS Code 内置 Terminal
