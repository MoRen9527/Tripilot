```markdown
# 内置工具：todo（或 #todos）

> 用“结构化 todo 列表”管理和追踪一项复杂请求的进度，既能展示计划，也能持续更新状态。

## 公开资料依据

- VS Code 官方内置工具列表（cheat sheet 中为 `#todos`，用于任务规划与进度跟踪）：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

## 语义与行为

- 输入：完整 todo 数组（必须包含全部条目：已有 + 新增）。
- 输出：更新后的 todo 展示/状态。
- 副作用：会影响 chat UI 中的 todo 面板展示（对代码无直接副作用）。

## 关键约束（对齐建议）

- 必须“全量提交”：每次更新都传完整列表，而不是增量 patch。
- 每条 todo 需要：
  - `id`（建议从 1 开始递增）
  - `title`（短标题）
  - `description`（验收标准/实现说明）
  - `status`：`not-started` | `in-progress` | `completed`
- 同一时刻最多一个 `in-progress`（有助于 UI 与心智对齐）。

## Tripilot 建议接口

- `manage_todo_list({ todoList })`

## 典型用法

- 复杂任务开始前：创建 todo 列表
- 每完成一块：把对应条目标记为 `completed`，下一条置为 `in-progress`
- 计划变更：调整 title/description，并保持全量提交

```
