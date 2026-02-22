# VS Code 内置工具：#getTaskOutput

## 一句话概述

获取 Task 运行输出，用于查看构建/测试等任务的执行结果。

## 公开资料依据

- 内置工具列表中对 `#getTaskOutput` 的描述：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

## 核心行为语义

- 读取指定 Task 的输出（stdout/stderr）
- 通常用于查看后台 Task 的执行结果
- 只读操作，不会影响 Task 状态

### 与 `runTask` 的配合

典型流程：
1. `runTask(...)` 启动 Task（可能是后台 watch 任务）
2. 返回 Task ID
3. 稍后用 `getTaskOutput(taskId)` 查看输出

## 风险与审批建议（低风险）

- 只读操作，风险很低
- 可自动批准（无需弹出审批）

## Tripilot 建议接口（实现对齐用）

- 工具名：`get_task_output`
- 入参：
  - `id`：Task ID
  - `workspaceFolder`：工作区根路径

返回值：
- `stdout`/`stderr` 的文本内容
- 可选：截断规则（若输出过长）

## 典型用法（提示词写法）

- "查看构建 Task 的输出，看是否有编译错误。"
- "读取 watch 任务的日志，确认文件变更是否被检测到。"

## 不适用场景

- 实时监控 Task 输出：需要用 VS Code 原生 Task UI（本工具返回的是"快照"）
