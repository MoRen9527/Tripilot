# Copilot Chat（VS Code）vs Claude Code：终端/工具上下文注入机制与能力对齐（官方文档对照）

> 目标：回答两个问题：
>
> 1) **Copilot Chat 在 VS Code 里是怎么把“终端信息 / 工具信息”加入上下文并影响 agent 决策的？**
>
> 2) **这套机制与 Claude Code 的工作方式（工具/权限/MCP/命令体系）有哪些对齐点、差距与优势？**
>
> 约定：本文只把“官方文档明确写到”的内容当作事实；对推断/观察会显式标注为“推测/观察”。

---

## 1. 总览：两者的“上下文 + 工具”心智模型

### 1.1 Copilot Chat in VS Code：以“上下文管理 + 工具调用 + 审批”构成 agent 流程

Copilot Chat 在 VS Code 里把交互分成两层：

- **上下文（Context）**：为模型输入提供材料（文件、选区、终端输出、搜索结果、网页内容等）。
- **工具（Tools）**：让 agent 能“做事”（搜索、读写文件、跑命令、访问网页、调用 MCP 等）。

官方文档把关键入口分成三种“标记/选择器”：

- `#`：添加上下文/引用工具（例如 `#codebase`、`#terminalSelection`、`#fetch`）。
- `@`：选择**chat participant**（例如 `@terminal`、`@vscode`），更像“专用问答角色”。
- `/`：slash commands（快捷操作、可复用提示词、或 MCP prompts 的调用）。

参考：
- Manage context for AI：https://code.visualstudio.com/docs/copilot/chat/copilot-chat-context
- Use tools in chat：https://code.visualstudio.com/docs/copilot/chat/chat-tools
- Copilot in VS Code cheat sheet（含 `#terminalSelection` 等）：https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

### 1.2 Claude Code：以“工具权限系统 + 配置分层 + MCP + 命令/技能体系”构成 agent 流程

Claude Code 的官方文档强调：

- 工具是第一等公民：Bash / Read / Edit / WebFetch / Skill 等。
- **权限（permissions）**以 allow/ask/deny 规则显式控制工具能力；还能通过 managed settings 在组织层面强约束。
- **配置分层（managed/user/project/local）+ 优先级**决定团队共享与个人覆盖。
- **MCP** 作为扩展工具生态（.mcp.json、managed-mcp.json、OAuth、动态更新等）。
- **Slash commands / Skills** 让工作流模板化，可被模型（Skill tool）程序化调用。

参考：
- Claude Code settings：https://code.claude.com/docs/en/settings
- Claude Code MCP：https://code.claude.com/docs/en/mcp
- Claude Code slash commands：https://code.claude.com/docs/en/slash-commands

---

## 2. Copilot Chat：终端信息/工具信息如何进入上下文（机制拆解）

这一节按“从用户输入 → 到上下文 → 到工具执行 → 到结果回流”的链路解释。

### 2.1 上下文来源 1：Implicit context（隐式上下文）

VS Code 会根据你当前活动，自动把一些内容加入 prompt（不同模式有差异）：

- 当前编辑器选区、当前文件名。
- Ask/Edit 模式下，**active file**会被自动作为上下文。
- Agent 模式下，agent 会根据你的请求决定是否需要把 active file 加入上下文。

这意味着：即使你没显式 `#` 某个文件，模型也可能已经“看到了”当前文件或选区。

参考：
- Implicit context：https://code.visualstudio.com/docs/copilot/chat/copilot-chat-context#_implicit-context

### 2.2 上下文来源 2：`#`-mentions（显式上下文与工具引用）

VS Code 把可加入上下文的东西统一成“context items”，并用 `#` 触发。

#### 2.2.1 文件/文件夹/符号

- `#<file|folder|symbol>` 或者在 Chat 里 Add Context/拖拽。
- 文档说明：如果文件过大，会降级为 outline；再过大可能无法加入。

参考：
- Add files as context：https://code.visualstudio.com/docs/copilot/chat/copilot-chat-context#_add-files-as-context

#### 2.2.2 代码库搜索（`#codebase`）

- `#codebase` 代表“让 VS Code 用索引对工作区做语义/代码搜索”，把相关片段作为上下文注入。
- Agent 模式也可能自动触发 codebase search（当它判断需要更多上下文）。

参考：
- Perform a codebase search：https://code.visualstudio.com/docs/copilot/chat/copilot-chat-context#_perform-a-codebase-search

#### 2.2.3 终端上下文（`#terminalSelection` 等）

在 cheat sheet 的内置工具列表里，`#terminalSelection`（terminal selection）被定义为一个 context tool：

- `#terminalSelection`：获取“当前终端选中内容”。

这解释了你 UI 里看到的“附加到聊天/Attach to Chat”类操作：本质是把终端里你选的那段内容变成 prompt 的一部分。

参考：
- 内置工具列表（含 `#terminalSelection`）：https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features#_chat-tools

> 推测/观察：
> - 终端右键菜单里的“附加到聊天/运行最近命令”等，更多是 **VS Code Terminal 功能 + Copilot Chat 的上下文入口**组合出来的 UI，而不一定是 Copilot 单独“拦截了方向键”。方向键异常更可能来自终端自身输入链路、可访问性模式、建议列表焦点、或某扩展的 UI 注入。

#### 2.2.4 Web 内容（`#fetch`）与 GitHub Repo 搜索（`#githubRepo`）

这两类工具常用于把外部资料作为上下文注入：

- `#fetch <URL>`：抓取网页内容，**需要审批**；有缓存。
- `#githubRepo <owner/repo>`：在指定 GitHub 仓库里做代码搜索。

参考：
- Reference content from the web：https://code.visualstudio.com/docs/copilot/chat/copilot-chat-context#_reference-content-from-the-web

### 2.3 工具来源：Built-in tools / MCP tools / Extension tools

VS Code 官方把 tools 分为三类：

- Built-in tools：例如 `#readFile`、`#editFiles`、`#runInTerminal` 等。
- MCP tools：来自配置/安装的 MCP server。
- Extension tools：扩展通过 Language Model Tools API 提供的工具。

参考：
- Types of tools：https://code.visualstudio.com/docs/copilot/chat/chat-tools#_types-of-tools

### 2.4 Agent 如何“把终端信息带进来”：terminal tool + 终端输出呈现

#### 2.4.1 Agent 运行命令的方式

官方文档明确：当 agent 决定跑命令时，会使用内置 terminal tool 在集成终端执行。

- Chat 里会显示执行过的命令；可以 Show Output（把输出嵌入 chat）或 Show Terminal。
- 可以用 `chat.tools.terminal.outputLocation` 配置输出显示位置（inline 或 terminal）。

参考：
- Terminal commands：https://code.visualstudio.com/docs/copilot/chat/chat-tools#_terminal-commands

#### 2.4.2 命令审批与 auto-approve

VS Code 提供了“对 terminal 命令进行自动批准”的设置：

- `chat.tools.terminal.autoApprove`：按命令/正则规则允许或阻止自动批准。
- 文档强调：检测是 best-effort，存在语法解析/写文件检测不完整等局限。

参考：
- Automatically approve terminal commands：https://code.visualstudio.com/docs/copilot/chat/chat-tools#_automatically-approve-terminal-commands
- Security - Automated approval：https://code.visualstudio.com/docs/copilot/security#_automated-approval

#### 2.4.3 为什么“shell integration”与 agent 的终端能力强相关

VS Code 文档在 chat-tools FAQ 里直接写：agent 默认不会用 cmd，因为 cmd 不支持 shell integration，导致 agent 对终端内部状态“能见度”很弱（需要靠超时/idle 检测）。

这意味着：**shell integration 是让 agent 能更可靠判断“命令何时开始/结束、输出属于哪个命令”等能力的关键基础设施。**

参考：
- chat-tools FAQ（cmd 与 shell integration）：https://code.visualstudio.com/docs/copilot/chat/chat-tools#_why-isnt-the-agent-using-command-prompt-as-the-terminal-shell
- Terminal Shell Integration：https://code.visualstudio.com/docs/terminal/shell-integration

### 2.5 Terminal Shell Integration：让 VS Code “理解终端里发生了什么”

Shell integration 文档给出一些非常关键的信息：

- VS Code 会注入脚本/环境变量来启用 shell integration（可通过 `terminal.integrated.shellIntegration.enabled` 关闭）。
- Shell integration 通过自定义转义序列（例如 `OSC 633`）标记 prompt/命令执行边界、exit code、cwd 等。
- 这使得 VS Code 能实现：
  - command decorations、command navigation
  - Run Recent Command（Quick Pick 历史）
  - enhanced accessibility（包括“底层 textbox 同步，使箭头/退格更正确”）
  - PowerShell 扩展快捷键（例如 Shift+Enter 等）

参考：
- Terminal Shell Integration：https://code.visualstudio.com/docs/terminal/shell-integration

> 与你遇到的“方向键历史”问题的关联（推测/观察）：
> - shell integration 本身会改变 VS Code 如何同步/处理终端输入（文档明确提到 enhanced accessibility 与底层文本框同步）。
> - terminal IntelliSense 也可能影响 UpArrow 行为（文档里有 `terminal.integrated.suggest.upArrowNavigatesHistory`）。
> - 但这些属于 VS Code Terminal 的机制，不等同于“Copilot Chat 一定拦截了 UpArrow”。更稳妥的说法是：你看到的现象与 **终端输入/可访问性/建议系统/扩展注入**都有可能相关，需要逐项隔离。

---

## 3. Copilot Chat：MCP 如何把外部工具/资源/提示词接入上下文

### 3.1 MCP server 的配置与信任

VS Code 的 MCP 文档强调：

- MCP server 可通过 Extensions（GitHub MCP server registry）安装，也可通过 workspace/user 配置等方式添加。
- **本地 MCP server 可以执行任意代码**，需要信任；并且可以重置 trust。
- 配置文件是 `mcp.json`，包含 `servers` 与可选 `inputs`（敏感信息占位符）。
- `inputs` 的值会在首次启动时提示输入，随后“安全存储”。

参考：
- Use MCP servers in VS Code：https://code.visualstudio.com/docs/copilot/customization/mcp-servers
- Security - MCP server trust & secrets store：https://code.visualstudio.com/docs/copilot/security

### 3.2 MCP tools / resources / prompts 进入 chat 的方式

VS Code 文档将 MCP 能力分成三类：

- **Tools**：在 agent 流程里被自动调用，或用 `#` 显式引用；需要审批。
- **Resources**：可以通过 Add Context > MCP Resources 作为上下文加入，或从工具响应里保存到 workspace。
- **Prompts**：MCP server 可以提供预设 prompt，用户通过 slash 命令调用，格式为 `mcp.servername.promptname`。

参考：
- MCP tools/resources/prompts：https://code.visualstudio.com/docs/copilot/customization/mcp-servers

---

## 4. Copilot Chat 的安全/治理：为什么“终端/工具输出注入”必须有审批与边界

VS Code 的 Security 文档把风险与防护说得很直白：

- agent 做的事（编辑文件/跑命令）都以**用户权限**执行。
- 自动批准（edits/terminal/tools）会降低可见性与控制力。
- prompt injection 是真实风险：tool output / web fetch / 外部内容可能夹带恶意指令。
- VS Code 的防护强调：
  - trust boundaries（workspace、extension publisher、MCP server、domain）
  - controlled scope（内置 agent 工具只读写 workspace 内文件）
  - permission management（审批/会话隔离）
  - transparency（可审查 edits、显示自动批准提示）

参考：
- Security：https://code.visualstudio.com/docs/copilot/security
- Tool approval + URL approval：https://code.visualstudio.com/docs/copilot/chat/chat-tools

### 4.1 “敏感文件”的自动批准规则（与终端写文件不同步的风险）

Review code edits 文档提到：

- AI 的文件修改会直接写盘，但会被标记为 pending changes 供你 review。
- `chat.tools.edits.autoApprove` 可按 glob 配置哪些文件需要额外审批（例如 `.vscode/*.json`、`.env`）。

参考：
- Edit sensitive files：https://code.visualstudio.com/docs/copilot/chat/review-code-edits#_edit-sensitive-files

> 重要差异点（官方提示的“能力盲区”）：
> - VS Code 文档在 terminal auto-approve 部分提醒：终端命令的“写文件检测”目前较弱，可能绕过你对编辑工具的限制。
> - 所以要把“工具编辑文件的审批”与“终端命令的审批/规则”一起看。

---

## 5. Claude Code：相同问题域的实现方式（对齐理解）

### 5.1 配置分层与团队共享

Claude Code 明确给出 scopes 与优先级：

- Managed（最高，不可覆盖）
- CLI arguments
- Local（.claude/settings.local.json）
- Project（.claude/settings.json）
- User（~/.claude/settings.json）

参考：
- Configuration scopes & precedence：https://code.claude.com/docs/en/settings

对齐到 Copilot/VS Code：

- VS Code 侧更多依赖 Settings（user/workspace/profile）+ enterprise policies；
- Claude Code 明确把“组织强制策略（managed）”作为产品能力写进配置体系。

### 5.2 权限模型：allow/ask/deny（工具为中心）

Claude Code permissions 的结构里，直接把工具控制做成规则：

- allow/ask/deny：可按工具类型与命令模式控制（例如 `Bash(git diff:*)`）。
- deny 还可用于隐藏敏感文件（`Read(./.env)` 等）。
- 还有 `disableBypassPermissionsMode`、sandbox（macOS/Linux）等。

参考：
- Permission settings：https://code.claude.com/docs/en/settings#permission-settings

对齐到 Copilot：

- Copilot 侧也有审批与 auto-approve，但表现为“每次调用弹窗审批 + 可保存范围 + 若开启 auto-approve 则按规则跳过”。
- Claude Code 更像“默认就有一个 policy engine”，并且支持强制部署。

### 5.3 MCP：配置、作用域、prompt 注入

Claude Code MCP 文档关键点：

- 支持 http / stdio 等传输；提供 `claude mcp add/list/get/remove`。
- MCP 安装作用域：local（默认，写到 ~/.claude.json 的 per-project 节点）、project（写到 .mcp.json）、user（~/.claude.json）。
- 支持 OAuth（通过 `/mcp`）。
- MCP prompts 会作为 slash commands 暴露：`/mcp__servername__promptname`，其结果会注入对话。
- 支持 list_changed（动态刷新 tools/prompts/resources）。
- 企业可用 `managed-mcp.json` 进行独占控制，或用 allow/deny list 做策略控制。

参考：
- Claude Code MCP：https://code.claude.com/docs/en/mcp
- Claude Code slash commands（MCP commands）：https://code.claude.com/docs/en/slash-commands

对齐到 VS Code：

- VS Code 也支持 MCP tools/resources/prompts，并强调 server trust 与 inputs 的安全存储。
- Claude Code 把“prompt 作为 slash command”与“Skill 工具可程序化调用命令/技能”写得更系统。

### 5.4 Slash commands / Skill：把 workflow 变成可复用、可调用的能力包

Claude Code slash commands 文档指出：

- 内置命令（/config、/context、/permissions、/mcp 等）
- 自定义命令：.claude/commands/（project）或 ~/.claude/commands/（user），支持 frontmatter（allowed-tools、hooks、model 等）。
- `Skill` tool 允许模型程序化调用命令/技能（有字符预算与禁用机制）。

参考：
- Slash commands：https://code.claude.com/docs/en/slash-commands

对齐到 VS Code：

- VS Code 侧也有 slash commands，但更偏“固定能力入口（/fix /tests /new 等）”与“prompt files/agents 的复用”。
- Claude Code 更强调“命令/技能作为可组合组件”，并与权限/工具系统深度耦合。

---

## 6. 能力对齐矩阵（重点围绕：终端/工具信息进入上下文）

> 说明：这里用“是否有官方文档明确说明”为准；不同版本/预览特性可能变化。

| 维度 | Copilot Chat（VS Code） | Claude Code |
|---|---|---|
| 终端信息作为上下文 | `#terminalSelection`（选中内容）作为 context item；agent 还能运行终端命令并回显输出 | 通过 Bash 工具执行命令，输出进入对话；也可用自定义 slash commands 预先收集 git diff/status 等上下文 |
| 终端命令执行与可见性 | agent 使用内置 terminal tool；可配置输出位置；依赖 shell integration 提升命令边界识别 | Bash 工具执行；支持后台任务（bashes）；可配 sandbox（macOS/Linux） |
| 工具输出的安全处理 | tool approval、URL approval（pre + post）、trusted domains、MCP server trust、透明化提示 | permissions allow/ask/deny；可禁用 Skill；可用 managed settings 强制策略；MCP allow/deny/managed-mcp |
| MCP 工具接入 | VS Code 通过 mcp.json/Extensions 安装；inputs 存在安全存储；tools/resources/prompts | claude mcp add；.mcp.json/managed-mcp.json；OAuth；prompts 映射为 `/mcp__...` |
| “可复用工作流” | prompt files、custom agents、tool sets（#edit/#search 等） | slash commands、Skills（目录结构）、hooks、plugins |
| 组织级治理 | VS Code 有 enterprise policies（文档提及）；工具/URL/MCP/审批有设置项 | managed-settings.json / managed-mcp.json 明确写入体系；可锁定插件市场、MCP 服务器白黑名单 |

参考：
- VS Code tools & approvals：https://code.visualstudio.com/docs/copilot/chat/chat-tools
- VS Code context items：https://code.visualstudio.com/docs/copilot/chat/copilot-chat-context
- VS Code MCP：https://code.visualstudio.com/docs/copilot/customization/mcp-servers
- VS Code terminal shell integration：https://code.visualstudio.com/docs/terminal/shell-integration
- Claude Code settings/MCP/slash commands：见第 5 节链接

---

## 7. 结论：对齐点、差距与各自优势（面向落地）

### 7.1 Copilot Chat（VS Code）的优势

- **IDE 一体化上下文**：文件、符号、Problems、SCM、终端选区/输出等能被统一管理并用 `#` 入口加入 prompt。
- **工具审批与透明化**：工具/URL/终端命令在产品 UI 层可见、可编辑参数、可按范围记忆批准。
- **shell integration + terminal UX**：把“命令边界/历史/可访问性/装饰器”做成终端基础设施，agent 终端工具可受益。

### 7.2 Claude Code 的优势

- **权限/策略系统更“显式、可审计、可强制”**：allow/ask/deny + managed settings + sandbox（平台限定）让企业/团队治理更工程化。
- **工作流模板化更强**：slash commands/Skills/hooks 让“收集上下文 + 执行动作 + 校验”能以可版本化的方式沉淀。
- **MCP 生态的命令化体验**：MCP prompts 映射为 slash commands，且支持动态更新与更细的组织策略。

### 7.3 主要差距（同一件事两套解法）

- **Copilot 更像 IDE 的“上下文编排器 + 工具执行器”**：你可以非常细粒度地挑选上下文（例如只选终端一段输出），但治理更多散落在 VS Code settings / policies / 审批记录里。
- **Claude Code 更像“带策略引擎的 agent CLI/REPL”**：上下文更多通过命令/文件约定（CLAUDE.md、commands、skills）组织，优势在可控与可复用。

---

## 8. 与你这次终端现象相关的“可验证点”（把推测变成证据）

> 本节是为了把“终端上下键历史异常”与“你观察到的终端菜单项（附加到聊天/运行最近命令）”放在同一张图里理解。

1) **Run Recent Command 属于 VS Code Terminal（shell integration）特性**
- 文档明确：Terminal: Run Recent Command 会聚合历史来源，并且在 accessibility mode 下快捷键会调整。
- 这解释了你看到的“运行最近使用的命令”等 UI。

参考：
- Run recent command：https://code.visualstudio.com/docs/terminal/shell-integration#_run-recent-command

2) **终端选区附加到聊天属于 Copilot Chat 的 context 能力**
- `#terminalSelection` 是官方列出的内置上下文工具。

参考：
- 内置工具列表：https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features#_chat-tools

3) **方向键不工作不等同于 Copilot 拦截**（推测）
- VS Code terminal 文档中出现与可访问性、底层 textbox 同步、terminal suggest（UpArrow 行为）相关描述。
- 更可靠的排查方式是：逐一禁用/回退 shell integration、terminal suggest、accessibility 相关设置，以及可能注入终端 UI 的扩展，观察 UpArrow 是否恢复。

参考：
- Enhanced accessibility：https://code.visualstudio.com/docs/terminal/shell-integration#_enhanced-accessibility
- terminal.suggest.upArrowNavigatesHistory（同页）：https://code.visualstudio.com/docs/terminal/shell-integration

---

## 9. 参考链接（官方）

### VS Code / Copilot

- Manage context for AI：https://code.visualstudio.com/docs/copilot/chat/copilot-chat-context
- Use tools in chat：https://code.visualstudio.com/docs/copilot/chat/chat-tools
- Use MCP servers in VS Code：https://code.visualstudio.com/docs/copilot/customization/mcp-servers
- Terminal Shell Integration：https://code.visualstudio.com/docs/terminal/shell-integration
- Security：https://code.visualstudio.com/docs/copilot/security
- Review AI-generated code edits：https://code.visualstudio.com/docs/copilot/chat/review-code-edits
- Copilot in VS Code cheat sheet：https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

### GitHub Docs（Copilot Chat in IDE）

- Asking GitHub Copilot questions in your IDE：https://docs.github.com/en/copilot/using-github-copilot/asking-github-copilot-questions-in-your-ide

### Claude Code

- Settings：https://code.claude.com/docs/en/settings
- MCP：https://code.claude.com/docs/en/mcp
- Slash commands：https://code.claude.com/docs/en/slash-commands
