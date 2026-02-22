```markdown
# 内置工具：searchResults

> 读取 VS Code Search 视图里的结果（用户已经在 UI 里跑过搜索），把结果作为上下文提供给模型。

## 公开资料依据

- VS Code 官方内置工具列表（searchResults 简述）：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

## 语义与行为

- 输入：无。
- 输出：Search 视图的结果集合（通常包含文件与匹配片段）。
- 副作用：无（只读）。

## 典型用法

- 用户先在 UI 里搜一遍（更可控）
- 模型再用 `searchResults` 读取结果并做分析/批量替换建议

## Tripilot 建议接口

- `get_search_view_results()`

```