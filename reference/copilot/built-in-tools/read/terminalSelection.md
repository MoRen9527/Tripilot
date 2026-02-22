```markdown
# 内置工具：terminalSelection

> 获取当前活动终端中被用户选中的文本（用于把某段日志/命令/错误精确作为上下文提供给模型）。

## 公开资料依据

- VS Code 官方内置工具列表（terminalSelection 简述）：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

## 语义与行为

- 输入：无（隐含使用当前活动终端）。
- 输出：选择区域的文本；若没有选择，可能为空。
- 副作用：无（只读）。

## 典型用法

- 让用户在终端选中一段报错 → `terminalSelection` → 直接分析并给出修复建议
- 相比 `terminalLastCommand` 更可控、更省 token

## Tripilot 建议接口

- `terminal_selection()`

```