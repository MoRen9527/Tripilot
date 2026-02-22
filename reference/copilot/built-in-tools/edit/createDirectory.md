# VS Code 内置工具：#createDirectory

## 一句话概述

在工作区内创建目录，用于为后续创建文件/脚手架生成提供落点。

## 公开资料依据

- 内置工具列表中对 `#createDirectory` 的描述：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

> 官方公开信息通常只覆盖“工具存在且用于创建目录”，不一定公开参数 schema。

## 核心行为语义

- 在工作区内创建一个新目录（可用于多级路径）
- 若目录已存在：应当幂等（不报错或给出“已存在”的可理解反馈）
- 若父级不存在：多数实现会递归创建（相当于 `mkdir -p` 行为）

## 风险与审批建议

创建目录本身风险较低，但仍属于“对工作区的写操作”。建议：

- 若路径位于敏感区域（例如 `.vscode/`、隐藏目录、或被策略标记的路径），走审批流
- 否则可自动批准（取决于你的安全策略）

与官方体验对齐的设置点参考（整体 edits 审批机制）：
- https://code.visualstudio.com/docs/copilot/chat/review-code-edits

## Tripilot 建议接口（实现对齐用）

- 工具名：`create_directory`
- 入参：
  - `dirPath`：工作区内的绝对路径（Tripilot 侧建议统一转为绝对路径执行）

## 典型用法（提示词写法）

- “在 `src/features/auth` 下新增目录结构，把 handler 和 tests 分开。”
- “为新组件创建 `src/components/Button` 目录，然后生成文件。”

## 不适用场景

- 需要移动/重命名目录（应使用重命名/移动的专用逻辑，而不是创建+删除的组合，避免误删）
