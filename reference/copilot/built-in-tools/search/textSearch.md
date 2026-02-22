```markdown
# 内置工具：textSearch

> 在工作区文件中做文本搜索（可普通字符串或正则），用于精确定位某段代码/字面量/日志。

## 公开资料依据

- VS Code 官方内置工具列表（textSearch 简述）：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

## 语义与行为

- 输入：查询（字符串或正则）+ 是否正则 + 可选 includePattern（限制范围）。
- 输出：匹配结果（通常含文件路径与匹配行/上下文）。
- 副作用：无（只读）。

## 典型用法

- 查配置键：`"chat.tools"`
- 查函数调用：`\bcreateAndRunTask\b`

## Tripilot 建议接口

- `grep_search({ query, isRegexp, includePattern?, maxResults?, includeIgnoredFiles? })`

## 风险提示

- 可能命中密钥、令牌或个人信息；建议默认限制 includePattern 或增加敏感文件策略。

```