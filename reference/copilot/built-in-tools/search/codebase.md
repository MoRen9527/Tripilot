```markdown
# 内置工具：codebase

> 在当前工作区中做“语义级”代码检索，返回可能相关的文件/片段/注释，用于自动补上下文。

## 公开资料依据

- VS Code 官方内置工具列表（codebase 简述）：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

## 语义与行为

- 输入：自然语言查询（例如“认证是怎么实现的？”、“哪里处理了 webhook 重试？”）。
- 输出：相关代码片段/文件摘要（实现可能返回 snippets，而不是整文件）。
- 副作用：无（只读）。

## 体验语义

- `codebase` 通常用于快速“找入口/找相关点”，但不保证完全正确或完整。
- 最佳实践：用它定位后，再用 `readFile` 精读确认。

## Tripilot 建议接口

- `semantic_search({ query })`

## 风险提示

- 语义检索可能一次性拉取较多上下文，容易把敏感信息带入对话；建议加大小限制与敏感文件策略。

```