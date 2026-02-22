# VS Code 内置工具：#runInTerminal

## 一句话概述

在集成终端运行 shell 命令，用于执行构建/安装/启动等任务。

## 公开资料依据

- 内置工具列表中对 `#runInTerminal` 的描述：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features
- Agent 审批机制（实验性设置 `chat.tools.terminal.autoApprove`）：
  - 同上页面，"Use agents" 部分

## 核心行为语义

- 在集成终端（Integrated Terminal）中运行用户指定的命令
- 支持同步执行（阻塞等待结果）或后台执行（例如启动 dev server）
- 返回 stdout/stderr/exitCode（供 agent 用于下一步推理）

### 与 `getTerminalOutput` 的配合

- `runInTerminal` 启动命令
- 若是后台任务（`isBackground=true`），稍后可用 `getTerminalOutput` 查看输出

## 风险与审批建议（高风险）

**必须审批**：
- 可能执行破坏性命令（`rm -rf`、`sudo`、格式化磁盘等）
- 可能安装软件/修改系统配置（`npm install -g`、`apt-get install`）
- 可能长时间阻塞（未设置 `isBackground` 时）

官方实验性设置：
- `chat.tools.terminal.autoApprove`：允许 agent 自动批准终端命令
- 默认行为：每次执行前弹出审批请求

Tripilot 对齐建议：
- **默认强制审批**（不建议默认开启自动批准）
- 对常见低风险命令（例如 `npm run build`、`python script.py`）可提供"仅本会话信任"选项
- 对高风险命令（包含 `rm`、`sudo`、`format` 等关键词）必须二次确认

## Tripilot 建议接口（实现对齐用）

- 工具名：`run_in_terminal`
- 入参：
  - `command`：要执行的 shell 命令
  - `explanation`：命令用途（向用户解释）
  - `isBackground`：是否后台运行（默认 false）

返回值（供 agent 推理）：
- `stdout`/`stderr`
- `exitCode`
- 若 `isBackground=true`，返回 terminal ID（供后续 `getTerminalOutput` 使用）

## 典型用法（提示词写法）

- "运行 `npm install` 安装依赖。"
- "执行 `python train.py` 训练模型，并查看输出。"
- "启动 dev server：`npm run dev`（后台运行）。"

## 不适用场景

- 需要交互式输入（例如 `git commit` 弹编辑器）：改用 VS Code 内置 UI
- 需要持续监控输出的长时间任务：建议用 VS Code Tasks（`createAndRunTask`）
