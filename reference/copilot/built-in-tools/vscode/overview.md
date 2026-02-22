````markdown
```markdown
# VS Code 内置工具：vscode（工具族）总览

> 目的：归纳 Copilot Chat 中与“VS Code 工作台能力/扩展管理/打开内置页面/执行命令/查阅 API 文档”相关的内置工具语义，并评估 Tripilot 在 **VS Code + VSCodium** 中是否能直接复用现成能力。

## 工具族范围（截图中的 vscode 组）

- `#extensions`
- `#getProjectSetupInfo`
- `#installExtension`
- `#newWorkspace`
- `#openSimpleBrowser`
- `#runCommand`
- `#vscodeAPI`

> 注：上述名称来自 Copilot Chat 的内置工具分组展示；并非所有条目都对应公开、稳定的 VS Code Extension API。

## “能否直接使用”的结论速览（Tripilot 视角）

### 可直接复用（建议只做薄封装，不自研底层能力）

- `extensions`
  - VS Code Extension API 已提供：`vscode.extensions.all` / `vscode.extensions.getExtension()`
  - VS Code + VSCodium 都可用。

- `runCommand`
  - VS Code Extension API 已提供：`vscode.commands.executeCommand(commandId, ...args)`
  - VS Code + VSCodium 都可用（但命令 ID 是否存在取决于内置/已安装扩展）。

- `openSimpleBrowser`
  - 可通过内置命令 `simpleBrowser.show` 打开 Simple Browser
  - 兼容性：通常 VS Code 可用；VSCodium 也多半可用，但取决于发行版是否包含/启用 Simple Browser 组件。
  - 推荐降级：若 Simple Browser 不可用，则用 `vscode.env.openExternal(url)`。

### 部分可复用（可调用内置命令，但受环境/发行版限制）

- `installExtension`
  - VS Code 存在内置命令：`workbench.extensions.installExtension`（可安装扩展 ID 或 VSIX Uri）
  - 限制：该命令的行为依赖“扩展库/画廊服务（Marketplace/Open VSX）”与当前运行模式（本地/远程）。
  - VSCodium：常见场景是使用 Open VSX 或自定义 gallery；若未配置或与目标扩展不匹配，则按 ID 安装可能失败。
  - 建议策略：优先支持 **安装 VSIX**；按 extensionId 安装作为 best-effort，并要求用户确认。

### 不可直接复用（若要对齐 Copilot 体验，需 Tripilot 自研/自建数据源）

- `getProjectSetupInfo`
  - VS Code Extension API 没有“按项目类型返回完整脚手架/依赖/命令”的统一公共服务。
  - 若要对齐：需要 Tripilot 自己做项目探测（读取 `package.json`/`pyproject.toml`/`README` 等）并产出建议。

- `newWorkspace`
  - VS Code 提供打开/切换工作区的能力（例如 `vscode.openFolder`），但没有“一键生成完整项目结构并安装依赖”的通用公共 API。
  - 若要对齐：需要 Tripilot 自己实现 workspace 创建、模板落盘、依赖安装（通常还要结合 `runInTerminal`/tasks）。

- `vscodeAPI`
  - Copilot 环境里的“查 VS Code API 文档”是一个产品内置检索能力；扩展侧没有等价公开 API。
  - 若要对齐：需要 Tripilot 自己实现（例如：内置 `vscode.d.ts` 索引、本地文档镜像、或联网抓取官方文档再检索）。

## Tripilot 对齐建议（实现边界）

- 把“可直接复用”的能力做成 **安全封装工具**：参数校验、白名单/allowlist、必要时用户确认。
- 对 `installExtension/newWorkspace/getProjectSetupInfo/vscodeAPI`：先明确产品范围。
  - 如果目标是“最小可用”：只做提示与跳转（打开扩展页/打开 docs/提示用户手动安装）。
  - 如果目标是“对齐 Copilot agent 能力”：需要做工程化实现（脚手架、下载、索引检索等）。

## 文件导航

- [extensions.md](extensions.md)
- [getProjectSetupInfo.md](getProjectSetupInfo.md)
- [installExtension.md](installExtension.md)
- [newWorkspace.md](newWorkspace.md)
- [openSimpleBrowser.md](openSimpleBrowser.md)
- [runCommand.md](runCommand.md)
- [vscodeAPI.md](vscodeAPI.md)

```
````
