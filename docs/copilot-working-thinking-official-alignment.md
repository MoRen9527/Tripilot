# Copilot / VS Code “Working / Thinking” 对齐：官方信息 + 实现映射（Tripilot / Opentride）

目标：把你截图里“Working/Thinking/工具摘要/终端输出/折叠层级/状态词”等 UX，按 **VS Code 官网与 GitHub Copilot 官方文档**能确认的内容做“硬对齐”，并把**未被官方明确描述**但你要求对齐的部分单独标注为“观察/推断”，避免把猜测当事实。

> 说明：我们是 webview 自绘 UI，不会自动继承 VS Code Chat 原生渲染，所以需要把“官方语义/设置项 → 我们的消息协议/前端渲染”手动映射。

---

## 1. 官方文档里能直接确认的行为（可当硬约束）

### 1.1 工具调用（Tools）

VS Code 官方文档明确：Agent 模式会调用 tools（内置 / MCP / 扩展工具），并在聊天里展示运行过程、支持审批、以及在必要时展示终端输出。

可直接引用的官方入口（建议以此作为“权威来源集合”）：
- VS Code：Copilot settings reference：https://code.visualstudio.com/docs/copilot/reference/copilot-settings
- VS Code：Use tools with agents：https://code.visualstudio.com/docs/copilot/agents/agent-tools
- VS Code：Chat tools（含 tool approvals、terminal 展示）https://code.visualstudio.com/docs/copilot/chat/chat-tools
- VS Code 更新日志（示例：工具输出 UI、Thinking tokens UI）https://code.visualstudio.com/updates/

与 UI 强相关、且在官方文本/截图中出现的点：
- 工具/终端调用会在聊天里出现进度元素，并出现动作（例如终端的 “Show Terminal / Show Output”）
- 工具调用涉及审批（tool approval），并支持“记住审批范围 / 重置审批”

### 1.2 终端输出呈现（Terminal tool output）

VS Code 更新日志（示例 1.106）描述了终端工具调用的两个动作：
- “Show Terminal”：聚焦到对应终端会话，且在 shell integration 完整时能滚动定位到命令
- “Show Output”：把最终输出 inline 展示在 chat 中；非 0 退出码时自动展开

且设置项 `chat.tools.terminal.outputLocation`（实验）会影响输出呈现位置。

### 1.3 工具详情默认折叠（collapsed）

Tripilot 的参考文档已明确记录：
- 默认折叠行为可由 `chat.agent.thinking.collapsedTools`（实验）配置

这意味着：想“像 Copilot”，应默认 **collapsed**，并允许用户手动展开；同时尊重设置项。

### 1.4 Thinking tokens / Chain-of-thought 呈现（可折叠段落）

Copilot Chat 参考实现的 changelog（对应 VS Code 1.105）明确提到：
- **Setting**：`chat.agent.thinkingStyle`
- Thinking tokens 会在 chat response 里以“可展开 sections”的形式呈现

这至少能确认：Thinking 是一种“可配置的呈现层”，并非纯粹的正文内容。

---

## 2. 你截图里“Working / Thinking 三层结构”的官方性现状

目前我们已从 VS Code 官网明确确认：
- 有 Thinking 相关设置（例如 `chat.agent.thinkingStyle`、`chat.agent.thinking.collapsedTools`）
- 有 Tool/Terminal 相关 UI（Show Terminal / Show Output 等）

但对“Working 外层汇总 → Step 标题可折叠 → Step 内细节”的 **三层折叠结构**：
- VS Code 官网更偏“能力说明/设置说明”，并不总会把 UI 的层级结构逐像素写出来
- 因此这部分更像是：**产品行为（可观察）** + **实现细节（需从 VS Code core / Copilot 扩展产物溯源）**

结论：
- “是否存在这些折叠层级”可以通过截图与本机产品验证
- “每一层的触发信号/事件协议/状态词规则”需要继续从 VS Code core bundle / Copilot 扩展产物里定位实现锚点（而不是仅依赖官网文字）

---

## 3. 设置项 → Opentride webview 的当前映射（已实现）

后端读取并下发 chat UI 配置：
- 实现在 [Opentride/sdks/vscode/src/extension.ts](../../Opentride/sdks/vscode/src/extension.ts)
- 入口函数：`readChatUiConfig()`（`vscode.workspace.getConfiguration("chat")`）

前端接收并应用：
- 实现在 [Opentride/sdks/vscode/media/main.js](../../Opentride/sdks/vscode/media/main.js)
- 入口函数：`applyChatUiConfig(raw)`

已覆盖的关键设置（其中一部分可直接与官网对齐）：
- `chat.agent.thinkingStyle` → `chatUiConfig.thinkingStyle`（控制是否显示 thinking transcript）
- `chat.agent.thinking.collapsedTools` → `chatUiConfig.collapsedTools`（控制 tool details 默认折叠/展开）
- `chat.agent.thinking.terminalTools` → `chatUiConfig.terminalTools`（控制“终端工具调用”是否被折叠进 thinking box；这是从本机 VS Code core bundle 的实际使用点确认的行为）
- `chat.agent.thinking.generateTitles` → `chatUiConfig.generateTitles`（从本机 VS Code core bundle 可确认：它用于 **thinking box 标题生成**；Opentride 不再把它当作 tool group 标题开关）
- `chat.tools.terminal.outputLocation` → `chatUiConfig.terminalOutputLocation`（控制终端工具开始时是否自动 reveal terminal）

UI 行为落点（前端）：
- tool group 标题生成：`getToolGroupTitleFromCounts()`（当所有工具都是 terminal 时会显示 “Terminal Tools”）
- tool invocation 终端动作：`onToolInvocationBegin()` 会渲染 “Show Terminal”，且当 `outputLocation === 'terminal'` 时自动调用 `revealTerminal`

---

## 4. 仍需对齐/补齐的点（按你截图目标）

### 4.1 三层折叠结构：外层 Working/完成标题 + 中层 step + 内层 details

现状：Opentride 已实现“Copilot-like 固定高度 trace panel（上滚动细节 + 下固定状态词）”，并在 turn end 用 LLM 一句话 `chatTurnSummary` 覆盖完成标题。

仍需进一步“结构对齐”的核心差距通常是：
- 外层 summary 的文案与时机（什么时候从 Working → Thinking → 完成标题）
- step 的“可更新”语义（同一步骤 streaming 更新 vs 新增步骤）
- step 内终端/搜索/文件的细节折叠策略（默认折叠 + 可展开）

### 4.2 底部状态词（Considering/Analyzing/Evaluating/Processing/Loading/Reasoning）

官方文档通常不会对这些词给出精确规则；更可靠的是：
- 以“最后一个活跃 step / tool invocation 的类型 + 状态”来驱动状态词
- 保持映射可预测（同一种 toolName 总是映射到同一种状态词）

Opentride 当前实现位置：
- `inferFooterStatusFromStep({ text, toolName, status })`

### 4.3 “Generate Titles / Terminal Tools”等设置项的权威描述缺口

我们已经从本机 VS Code core bundle 中发现（字符串层面）存在：
- `chat.agent.thinking.generateTitles`
- `chat.agent.thinking.terminalTools`
- `chat.agent.thinking.collapsedTools`

但在当前抓取到的 VS Code 官网片段里：
- `generateTitles` 与 `collapsedTools` 有更直接的对齐路径（至少 `collapsedTools` 已在文档/参考里出现；`generateTitles` 在 Opentride 侧已实现为“标题生成开关”）
- `terminalTools` 的“设置解释/行为契约”尚未在官网文本中直接出现，需要继续溯源其真实语义（更可能是 VS Code 内部实验开关，或者仅出现在 Insiders）

建议：在对齐文档里把 `terminalTools` 标注为“已发现 key，但尚未从官网确认语义”，实现上先不要硬做行为承诺，除非我们能在 VS Code core / Copilot 扩展产物中找到使用点。

---

## 5. 下一步（最短路径）

- 继续从 VS Code core bundle 中定位 `chat.agent.thinking.*` 的具体使用位置（不是只确认 key 存在），提取“terminalTools/generateTitles”对 UI 的真实影响。
- 把你截图中的三层折叠结构拆成可验证的 UI contract（每层的展开/收起条件、默认状态、更新时机），再回写到 Opentride 的 webview 事件模型中。

