# Copilot Chat UI 复刻设计指导（Tripilot / Opentride）

目标：在 Tripilot/Opentride 的自定义聊天 UI 中**尽可能像 VS Code GitHub Copilot Chat**，复刻以下“可感知体验”：引用（Used X references）、Working→Thinking、Thinking 过程框、工具调用完成摘要、以及“Files changed + 保留/撤消 + 展开查看 diff”。

> 重要前提：Copilot Chat 的 UI 大量由 VS Code Chat View 的原生渲染负责。若使用 VS Code 的 Chat Participant API（不是 webview 自绘），许多 UI（references、file tree、部分 edits UI）会自动获得原生外观。
> 目前我们是 webview 自绘，因此需要将“API 语义 → UI 结构 → 交互细节”全部自行实现。

---

## 1. UI 分块与顺序（你截图 1~6 的“精准描述”）

### 1.1 每次 assistant 回复的顶部：`Used N references`（可折叠）

**表现**
- 每个 assistant response 顶部先出现一行可折叠条目：`> Used N references`。
- 点击三角符号展开，显示引用项列表（URL、文件、图片/附件）。
- 每条引用前有图标：
  - 外部 URL：地球（globe）。
  - 工作区文件：文件图标。
  - 粘贴图片/附件：图片图标。

**对应 API/语义（官方可确认）**
- VS Code Chat API 的 `ChatResponseStream.reference(...)` / `reference2(...)`：
  - 语义是“引用”，**不会 inline 插入正文**，而是单独区域展示。
  - `reference2` 支持带状态（例如检索中/成功/失败）的扩展形式（见 Copilot 参考实现）。

**我们复刻的实现约束**
- 复刻时应把 references 作为“response container 的第一个区块”，永远在正文之前。
- references 的计数应只统计“本次 response 的引用”。


### 1.2 `Working...` → `Thinking...`（状态头）

**表现**
- `Used N references` 之后，出现 `Working...`。
- 很快转为 `Thinking...`。
- `Thinking...` 这一行只有**一个 spinner（转圈）**。

**对应 API/语义（官方 + 参考 repo 可确认）**
- `Working...` 不是一个单独的 VS Code ChatResponsePart 类型，更像 Chat UI 的“session busy 状态”呈现。
- `Thinking...` 的“步骤流”对应扩展/内部 API 的 `ChatResponseThinkingProgressPart`（在 Copilot 参考 repo 的 proposed d.ts 中存在）。
- 另外，常规进度也可以用 `ChatResponseStream.progress(...)` 输出“运行中提示”。

**我们复刻的实现约束**
- `Working` 和 `Thinking` 是 UI 状态机，不要把它当成正文内容。


### 1.3 Thinking 的内部过程框（截图2）

**表现**
- `Thinking...` 下方有一个“内部框”（boxed panel）展示过程。
- 内部框的每条任务**同一列纵向对齐**，通过不同 SVG 图标体现不同任务类型。
- 内部框的行**有时序感**：上方更早、下方更晚。
- 注意：**内部框每条任务不转圈**（只有 `Thinking...` header 在转）。

**对应 API/语义（参考 repo 可确认）**
- `ChatResponseThinkingProgressPart` 可携带 `id/metadata`，用于更新同一个步骤（streaming delta）。
- 工具调用流（tool invocation）可通过 `beginToolInvocation/updateToolInvocation` 把“运行中细节”挂到某个 toolCallId 上。

**我们复刻的实现约束**
- Thinking 框内的每一行应是“步骤（step）”而非“工具详情（details）”。
- 工具详情建议默认折叠（与 Copilot 行为一致），只显示步骤摘要。


### 1.4 正文消息 + 工具完成摘要（截图3）

**表现**
- 正文是 assistant 的 Markdown 输出（结合工具结果写出的最终说明）。
- 工具调用的“结果摘要”以**对号开头**，每行一个摘要。
- 这些摘要行可以和正文穿插出现（先有一些文本，再出现更多 thinking/工具摘要）。

**对应 API/语义（参考 repo 可确认）**
- 扩展/内部 API 中有 `ChatToolInvocationPart`（proposed）：
  - `invocationMessage/originMessage/pastTenseMessage` 用于生成 “正在做/做了什么/做完了什么” 的文案。
  - `isComplete/isError/isConfirmed` 驱动 UI 状态（对号/叉号/等待确认）。
  - `presentation` 可控制是否隐藏或完成后隐藏。

**我们复刻的实现约束**
- “步骤（thinking box）”与“摘要（完成行）”必须分离：
  - 运行中：只在 thinking box 增量展示。
  - 完成后：在正文区域上方/中间插入“对号摘要行”（并可点击展开关联详情）。


### 1.5 `Files changed`（截图4/5）

**表现**
- 当 assistant 修改了文件，聊天输入框（composer）上方出现一条 bar：
  - `X files changed` + `保留` / `撤消`（Keep / Undo）按钮。
- 展开三角号后显示修改的具体文件列表（截图5）。

**对应 API/语义（参考 repo 的 proposed d.ts 可确认）**
- VS Code 提供多种“编辑/差异”相关 response part（部分为 proposed/扩展）：
  - `ChatResponseTextEditPart`：文本编辑（可流式、可 done）。
  - `ChatResponseWorkspaceEditPart`：文件级别变更（新建/删除/重命名）。
  - `ChatResponseMultiDiffPart`：多文件 diff 列表（带 added/removed）。
  - `ChatResponseCodeblockUriPart`：与编辑/undo stop 相关（含 `undoStopId`）。
  - `ChatResponseExternalEditPart`：提供 callback，在 UI 里“应用”时回调。

**我们复刻的实现约束（webview 自绘）**
- “Files changed bar”是**会话级别的悬浮/固定 UI**，不属于某一条 message bubble 的正文。
- `保留`：保留当前 workspace 改动（不触发额外动作）。
- `撤消`：撤回本轮修改（需要我们能回滚：基于 patch/undo stop/备份实现）。


### 1.6 展开后看到具体 diff 与定位（截图6）

**表现**
- 展开文件条目可以看到 diff/修改位置。
- 提供 `保留/撤消` 仍可用。
- 点击文件/位置可以跳转到编辑器相应文件和范围。

**对应 API/语义**
- 原生 Copilot Chat 使用 VS Code 的多 diff/编辑器联动能力完成（`ChatResponseMultiDiffPart` / `ChatResponseCodeblockUriPart` 等可提供足够数据）。

**我们复刻的实现约束（webview 自绘）**
- 至少要做到：文件列表 + added/removed 计数 + 点击打开文件；
- 高保真：在 webview 内渲染 unified diff，并支持定位到具体行。

---

## 2. 与 VS Code 官方文档对齐的“可用输出类型”（实现基座）

VS Code 官方 Chat Participant API 文档明确：chat response 可以组合输出多种类型，包括：
- Markdown（正文）
- References（引用，独立区块）
- Progress（进度）
- Buttons（命令按钮）
- File trees（文件树控件）

对应方法在 `ChatResponseStream`：
- `markdown(...)`
- `reference(...)`
- `progress(...)`
- `button(...)`
- `filetree(...)`
- `push(...)`（推入更底层/扩展 part）

相关官方入口（用于产品/工程对齐）：
- Chat Participant API Guide：https://code.visualstudio.com/api/extension-guides/ai/chat
- Chat tools 文档：https://code.visualstudio.com/docs/copilot/chat/chat-tools
- Copilot settings reference：https://code.visualstudio.com/docs/copilot/reference/copilot-settings

---

## 3. 本地参考实现（Tripilot/reference/vscode-copilot-chat）里可直接借鉴的点

### 3.1 “流式输出”如何在内部被标准化

参考实现将 `ChatResponseStream` 的各种调用转为统一的 part 流（见 [src/util/common/chatResponseStreamImpl.ts](../reference/vscode-copilot-chat/src/util/common/chatResponseStreamImpl.ts)）：
- `reference(...)` → `ChatResponseReferencePart` / `ChatResponseReferencePart2`
- `progress(...)` → `ChatResponseProgressPart` / `ChatResponseProgressPart2`
- `thinkingProgress(...)` → `ChatResponseThinkingProgressPart`
- `workspaceEdit(...)` → `ChatResponseWorkspaceEditPart`
- `externalEdit(...)` → `ChatResponseExternalEditPart`
- 工具调用：`beginToolInvocation/updateToolInvocation(...)`

这对我们复刻的意义：
- 复刻 UI 最稳的方式是定义一份“中间事件模型”，其字段尽量贴近这些 part：
  - references[]、progress[]、thinkingSteps[]、toolInvocations[]、edits[]


### 3.2 “edits / files changed”需要依赖哪些数据结构

在 [src/extension/vscode.proposed.chatParticipantAdditions.d.ts](../reference/vscode-copilot-chat/src/extension/vscode.proposed.chatParticipantAdditions.d.ts) 能看到 Copilot 使用的扩展 part：
- `ChatResponseWorkspaceEditPart`（文件级变更）
- `ChatResponseMultiDiffPart`（多文件 diff）
- `ChatToolInvocationPart`（工具调用的 UI 语义字段）
- `ChatResponseThinkingProgressPart`（thinking steps）

这对我们复刻的意义：
- “Files changed + 保留/撤消 + 多文件 diff”不是单一事件；它是一个 edits 模型：
  - 文件级变化（create/delete/rename）
  - 文本级变化（patch/hunks）
  - 以及一套可撤回（undo）的能力

---

## 4. 复刻落地的产品/工程合同（最重要）

### 4.1 状态机（必须一致，否则体验会差）

建议最小状态：
- `idle`
- `working`：请求已发出、还没展示 thinking steps
- `thinking`：展示 Thinking header + thinking box
- `responding`：正文在流式输出（但允许中途插入新的 thinking box）
- `error`

关键规则：
- `Working...` 只出现在“尚未有 thinking step”之前。
- `Thinking...` header 只显示一个 spinner。
- thinking box 内的行永不显示 spinner。


### 4.2 插入规则（决定“像不像”）

每次 response 的推荐结构：
1) references 组（如果有）
2) Working...（短暂）
3) Thinking... + thinking box（步骤增长）
4) 工具完成后：将步骤转为“对号摘要行”并固定在 response 内（可点击展开 tool details）
5) 正文 Markdown 输出（可与 3/4 交错；需要支持 inline thinking 再出现）
6) response 结束，状态回到 idle


### 4.3 图标与文案（需要“确定性映射”，不能全靠 heuristic）

建议为以下类别建立固定映射（icon + 现在时/过去时文案模板）：
- workspace search / text search
- read file / open file / list dir
- web fetch / browser
- edit file / apply patch
- run terminal / run tests
- create file / create directory
- generic tool

并保证：
- thinking step 用“类别图标 + 现在时短语”
- 完成摘要用“对号 + 过去时短语 + 关键参数摘要”


### 4.4 Edits（files changed）的合同

最小可用（MVP）：
- 能统计本轮改动涉及哪些文件
- 能展示 `X files changed` bar
- 能按文件列出改动，并可点击打开文件
- `撤消` 至少能把这些文件回滚到改动前

高保真：
- 多文件 diff 展示 + added/removed 计数
- 每个 diff 可定位到行范围
- “保留/撤消”与 chat checkpoint/undo stop 概念一致

---

## 5. 我们当前代码对应关系（方便马上对照迭代）

当前 webview 复刻代码主要在：
- Opentride：[sdks/vscode/media/main.js](../../Opentride/sdks/vscode/media/main.js)
- Opentride：[sdks/vscode/media/main.css](../../Opentride/sdks/vscode/media/main.css)
- Opentride：[sdks/vscode/src/extension.ts](../../Opentride/sdks/vscode/src/extension.ts)

下一步为“精准复刻”最缺的一块：
- 实现 `Files changed` bar + 文件列表 + 撤回机制（undo/patch）。
- 将工具/步骤 icon 与文案从 heuristic 收敛为“确定性映射表”。
