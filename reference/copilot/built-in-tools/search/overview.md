```markdown
# VS Code 内置工具：search（工具族）总览

> 目的：归纳 Copilot Chat 中与“在工作区查找上下文（文件、文本、符号引用、Git 变更）”相关的内置工具语义，用于 Tripilot 对齐实现。

## 公开资料依据

- Copilot in VS Code cheat sheet（内置工具列表与简述）：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features
- Chat tools 概念与类型说明：
  - https://code.visualstudio.com/docs/copilot/chat/chat-tools

## 工具族范围

从官方内置工具列表中，与“搜索/定位上下文”相关的条目包括：

- `#changes`：获取 Git 变更（staged/unstaged/merge-conflicts）
- `#codebase`：在代码库中语义查找相关文件/片段
- `#fileSearch`：用 glob 模式查找文件路径
- `#listDirectory`：列出目录内容
- `#textSearch`：按文本（可 regex）搜索文件内容
- `#usages`：查找符号的引用/定义/实现等
- `#searchResults`：读取 VS Code Search 视图中的搜索结果

## 关键体验语义（与 Copilot Chat 对齐）

### 1) “先搜再读”而不是“整仓读”

- `fileSearch/textSearch/codebase/usages` 用于缩小范围
- 再用 read 工具族（例如 `readFile`）读取精确片段

这能显著降低 token 消耗，并减少模型“看错文件”的概率。

### 2) 结果需要可复现与可定位

Tripilot 对齐建议：
- 搜索返回应尽量包含：文件路径 + 行范围（或至少能定位到片段）
- 对于 `codebase` 这类语义搜索，要清晰标注“这是建议相关上下文”，避免当作确定性结果

### 3) 风险普遍较低，但可能暴露敏感信息

- search 工具本身大多是只读。
- 但搜索/变更可能把 `.env`、密钥、私有路径、内部仓库信息带入上下文；建议加策略限制。

## 风险边界（建议）

### 低风险（可默认自动批准）
- `fileSearch` / `listDirectory`：只返回路径列表
- `searchResults`：只读取已有结果

### 中风险（建议按策略审批）
- `textSearch`：可能命中敏感内容
- `changes`：可能暴露未提交改动（含敏感信息）
- `codebase`：可能收集较多上下文片段
- `usages`：可能扫到大量引用（噪声与泄露风险）

## 与 Tripilot 现有工具映射（建议命名）

- `#changes` -> `get_changed_files(repositoryPath?, sourceControlState?)`
- `#codebase` -> `semantic_search(query)`
- `#fileSearch` -> `file_search(query)`
- `#listDirectory` -> `list_dir(path)`
- `#textSearch` -> `grep_search(query, isRegexp, includePattern?)`
- `#usages` -> `list_code_usages(symbolName, filePaths?)`
- `#searchResults` -> `get_search_view_results()`

> 上述为 Tripilot 内部工具接口建议，不是官方公开 schema。

```