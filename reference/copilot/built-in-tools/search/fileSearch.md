```markdown
# 内置工具：fileSearch

> 通过 glob 模式在工作区内查找文件路径（只返回路径），用于快速定位候选文件集合。

## 公开资料依据

- VS Code 官方内置工具列表（fileSearch 简述）：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

## 语义与行为

- 输入：glob（例如 `**/*.{ts,tsx}`、`src/**`）。
- 输出：匹配文件路径列表。
- 副作用：无（只读）。

## 典型用法

- 找配置文件：`**/{tsconfig,eslint}*.json`
- 找路由/控制器：`src/**/routes*.ts`

## Tripilot 建议接口

- `file_search({ query, maxResults? })`

```