````markdown
```markdown
# 内置工具：fetch

> 获取给定网页的内容，用于总结网页、提取要点、把网页信息作为后续推理/执行的上下文输入。

## 公开资料依据

- VS Code 内置工具表：`#fetch` “Fetch the content from a given web page”
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features#_chat-tools
- Tools 使用说明：`#fetch` 需要 URL；并描述 URL 双重审批（pre/post）
  - https://code.visualstudio.com/docs/copilot/chat/chat-tools

## 语义与行为（对齐 Copilot）

- 输入：URL（官方示例：`Summarize the content from #fetch https://code.visualstudio.com/updates`）
- 输出：网页内容的“可读正文”为主（而非原始 HTML 全量），并应包含来源 URL
- 副作用：联网访问外部 URL

> 官方未公开 fetch 的完整参数/返回 schema。下述为 Tripilot 建议接口与实现约定。

## 安全：URL 双重审批（建议必须实现）

官方文档说明：当工具尝试访问 URL（例如 `fetch`）时，采用两步审批：
- **请求审批（pre-approval）**：用户确认要访问的 URL/域名
- **内容审批（post-approval）**：用户确认将抓取到的内容纳入上下文，防止 prompt injection

Tripilot 对齐建议：
- 默认开启 pre + post 两步审批
- 支持“仅本次/本会话/全局”的自动批准模式，但默认保守
- 把“最终被纳入上下文的文本”明确展示给用户（支持截断提示）

## 失败模式与边界（建议）

- 网络错误/代理/证书
- 301/302 重定向（需显式展示最终 URL）
- 401/403 登录/防爬
- 内容过大（需要截断并告知）
- 非文本资源（图片/二进制）应拒绝或只返回元信息

## Tripilot 建议接口

- `fetch_webpage({ urls: string[], query: string }) -> { items: { url, title?, content }[] }`

设计说明：
- 允许多个 URL：提升 agent 批量总结能力
- `query` 用于“从页面里找什么”，避免全量注入（更安全、更省 token）

```
````
