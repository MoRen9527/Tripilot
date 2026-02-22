# VS Code 内置工具：#editFiles

## 一句话概述

对工作区的一个或多个文件应用修改，用于实现“跨文件编辑/重构/批量修复”等。

## 公开资料依据

- 内置工具列表中对 `#editFiles` 的描述：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features
- VS Code 对 AI 代码编辑的审查体验（pending/review/keep/undo、自动接受、敏感文件审批、与 Source Control 联动）：
  - https://code.visualstudio.com/docs/copilot/chat/review-code-edits

> 官方文档更多描述的是“产品审查体验”，不会把 `#editFiles` 的 patch schema 作为稳定 API 对外承诺。

## 核心行为语义

从用户体验层面，`#editFiles` 应满足：

- 支持多文件修改
- 产生可审查的差异（diff），并支持按文件或按 chunk 接受/撤销
- 与 Source Control 的 stage/discard 行为能合理联动（至少不冲突）

### Pending / Review

官方文档描述的关键点：
- AI 修改会写入磁盘，并被标记为 pending changes
- 编辑器显示 inline diff，并提供 Keep/Undo
- Chat 视图可“一次性接受/拒绝所有”

## 风险与审批建议

- 默认对敏感文件强制审批（对应 `chat.tools.edits.autoApprove` 的 deny 规则）
- 对普通源码文件可以允许自动批准，但仍建议保留“可撤销”的 UI

## Tripilot 落地实现建议

### 1) 用 patch 而不是整文件覆盖

- 优先生成最小改动（例如 unified diff / 结构化 patch），减少误伤
- 避免用“读出文件 -> 生成整文件 -> 覆盖写回”的方式（diff 太大、审查困难）

### 2) 形成工具调用 loop

常见可靠流程：
1. 读取相关文件（`read_file`）
2. 规划改动（LLM）
3. 生成 patch 并走审批（`apply_patch`/`editFiles`）
4. 如有错误再迭代（编译/测试/修复）

### 3) 与审批流对齐

Tripilot 已有 preview/apply/cancel 的审批体验时：
- `#editFiles` 对齐为“生成 patch + 预览 + 用户批准后应用”
- 记录 pending 状态（至少在当前会话可追踪）

## Tripilot 建议接口（实现对齐用）

- 低层工具：`apply_patch(input, explanation)`
- 高层封装（可选）：`edit_files(edits[])`，其中每条 edit 是 {filePath, patch} 或 {filePath, replacements}

## 典型用法（提示词写法）

- “把所有 `var` 改成 `const/let`，并修复 lint。”
- “对 `src/api` 下所有路由加上统一的错误处理。”

## 不适用场景

- notebook cell 级编辑：用 `#editNotebook`
- 仅创建文件：用 `#createFile`
