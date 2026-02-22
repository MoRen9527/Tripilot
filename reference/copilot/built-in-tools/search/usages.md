```markdown
# 内置工具：usages

> 查找某个符号（函数/类/方法/变量等）的引用、定义、实现等，用于理解调用链与影响面。

## 公开资料依据

- VS Code 官方内置工具列表（usages 简述）：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

## 语义与行为

- 输入：symbolName + 可选 filePaths（提示可能的定义位置，加速与提准）。
- 输出：引用/定义/实现等位置列表（通常含文件与范围）。
- 副作用：无（只读）。

## 典型用法

- 改动 API 前，先用 `usages` 评估影响面
- 重构/重命名时，配合 edit 工具族进行批量修改

## Tripilot 建议接口

- `list_code_usages({ symbolName, filePaths? })`

```