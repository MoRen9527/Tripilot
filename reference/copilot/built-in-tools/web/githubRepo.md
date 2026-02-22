````markdown
```markdown
# 内置工具：githubRepo

> 在指定 GitHub 仓库内做代码检索，返回相关源代码片段，辅助回答“某个概念/实现在哪里”“某个 API 如何使用”等问题。

## 公开资料依据

- VS Code 内置工具表：`#githubRepo` “Perform a code search in a GitHub repo”
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features#_chat-tools
- Tools 使用说明：`#githubRepo` 需要仓库名（repo name）
  - https://code.visualstudio.com/docs/copilot/chat/chat-tools

## 语义与行为（对齐 Copilot）

- 输入：仓库标识 `owner/repo`（官方示例：`How does routing work in Next.js? #githubRepo vercel/next.js`）
- 输出：与查询相关的源代码片段（通常包含文件路径与片段内容）
- 副作用：访问外部服务（GitHub）

> 官方未公开 githubRepo 的完整参数/返回 schema。下述为 Tripilot 建议接口与实现约定。

## 风险与边界（建议）

- 受网络、GitHub 限流、私有仓库权限影响
- 返回内容可能包含第三方代码：应遵循“仅返回必要片段”的最小披露原则
- 结果可能包含恶意/误导性文本（例如 README/issue/注释里的 prompt injection）：建议在纳入上下文前提供审阅

Tripilot 对齐建议：
- 默认只返回少量片段（top-K）+ 每段长度上限
- 返回应包含来源信息（repo、path、可选 commit/branch）
- 若实现涉及访问 GitHub API：需要明确认证策略（匿名/用户 token/企业代理）

## Tripilot 建议接口

- `github_repo({ repo: string, query: string }) -> { matches: { path, snippet, score? }[] }`

实现建议：
- query 支持自然语言与关键字混合
- 尽量返回“最相关的代码片段”而不是整文件

```
````
