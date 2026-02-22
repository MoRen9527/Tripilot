````markdown
```markdown
# VS Code 内置工具：web（工具族）总览

> 目的：归纳 Copilot Chat 中与“联网获取网页内容 / 从 GitHub 仓库检索代码片段”相关的内置工具语义，用于 Tripilot 对齐实现。

## 公开资料依据

- GitHub Copilot in VS Code cheat sheet（内置工具表，包含 `#fetch` 与 `#githubRepo`）：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features#_chat-tools
- Use tools in chat（说明 `#fetch` 需要 URL、`#githubRepo` 需要仓库名；并描述 URL 访问审批与防 prompt injection 的机制）：
  - https://code.visualstudio.com/docs/copilot/chat/chat-tools
- Get started with chat in VS Code（提到可通过 `#fetch`/`#githubRepo` 引用工具）：
  - https://code.visualstudio.com/docs/copilot/chat/copilot-chat

## 工具族范围（web 分组）

- `#fetch`：获取指定网页的内容
- `#githubRepo`：在指定 GitHub 仓库内做代码检索

## 关键体验语义（与 Copilot Chat 对齐）

### 1) 显式参数

官方文档明确：
- `#fetch` 需要 URL
- `#githubRepo` 需要仓库名（例如 `owner/repo`）

### 2) URL 访问的双重审批（安全关键点）

官方文档描述：当工具尝试访问 URL（例如 `fetch`），会使用两步审批：
- **Pre-approval**：批准对该 URL 发起请求（侧重域名信任）
- **Post-approval**：批准将响应内容纳入上下文（侧重防 prompt injection）

Tripilot 对齐建议：
- `fetch` 必须实现“请求前确认 + 结果内容确认”的流程（默认开启）
- 允许用户保存“URL/域名级别”的自动批准规则（但建议默认保守）

### 3) 成本/配额/限流与可用性

- `fetch` 和 `githubRepo` 都属于“外部服务访问”，可能受网络、代理、公司策略限制。
- 需要考虑：请求超时、重定向、认证页面、限流、内容过大等。

Tripilot 对齐建议：
- 统一外部访问超时（例如 10-30s）
- 响应做大小上限与截断（同时保留来源 URL）
- 对失败返回可诊断的错误结构（HTTP 状态/超时/解析失败等）

## 文件导航

- [fetch.md](fetch.md)
- [githubRepo.md](githubRepo.md)

```
````
