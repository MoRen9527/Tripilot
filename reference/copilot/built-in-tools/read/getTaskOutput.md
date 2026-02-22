```markdown
# 内置工具：getTaskOutput

> 读取某个 VS Code Task 的运行输出（只读）。常与 `runTask` / `createAndRunTask` 配合。

## 公开资料依据

- VS Code 官方内置工具列表（getTaskOutput 简述）：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

## 语义与行为

- 输入：任务 id + 工作区目录（workspaceFolder）。
- 输出：该任务的输出（可能是最近一次运行的输出，或当前缓存的输出）。
- 副作用：无（只读，不会启动任务）。

## 分类说明

- 在产品 UI 中它可能出现在 read 分类（因为它是读取输出）。
- 在 Tripilot 文档中它也出现在 execute 目录（因为它通常跟任务执行链路一起使用）。

参见：
- `execute/getTaskOutput.md`

## Tripilot 建议接口

- `get_task_output({ id, workspaceFolder })`

```