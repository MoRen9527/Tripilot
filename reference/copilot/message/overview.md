# Overview: Copilot Chat message primitives (VS Code)

This document describes the **observable/officially documented** message primitives and states used by Copilot Chat in VS Code, so Tripilot can implement an equivalent UX.

## Primary message types

### 1) User prompt (request)

- A user sends a prompt in the Chat view.
- VS Code supports editing previous requests (see release notes and settings reference).

### 2) Assistant response (streamed)

- Responses are streamed into the conversation.
- During agent runs, intermediate progress (tool calls, terminal runs, confirmations) appears inline in the chat conversation.

### 3) Tool invocation “summary line”

VS Code chat can display tool invocations as a summary line in the conversation.

- Tool call details are **collapsed by default** and can be expanded.
- Default collapse behavior is configurable via `chat.agent.thinking.collapsedTools` (experimental).

Source:

- [Chat tools docs](https://code.visualstudio.com/docs/copilot/chat/chat-tools)
- [Settings reference](https://code.visualstudio.com/docs/copilot/reference/copilot-settings)

### 4) Tool output disclosure

Some tool results are shown with a lightweight inline UI (for example, terminal output).

- Terminal tool output can be shown inline ("Show Output") or in the integrated terminal.
- Output location is configurable (experimental) via `chat.tools.terminal.outputLocation`.

Source:

- [Chat tools docs](https://code.visualstudio.com/docs/copilot/chat/chat-tools)

### 5) Pending edits / review surface

When chat performs edits:

- Edits are applied to disk and tracked as “pending edits”.
- Chat view shows a list of edited files that are pending review.
- Opening a changed file shows an inline diff.
- The user can Keep/Undo per file and accept/reject all in chat.

Source:

- [Review AI-generated code edits](https://code.visualstudio.com/docs/copilot/chat/review-code-edits)

### 6) Confirmations (approvals)

VS Code requires approvals for sensitive operations:

- Tool approval dialog (tool-level approval, configurable scope)
- URL approval is two-step (pre-approval request + post-approval response review)
- Sensitive file edits can require approval before applying

Sources:

- [Chat tools docs (tool approval, URL approval, reset confirmations, edit tool params)](https://code.visualstudio.com/docs/copilot/chat/chat-tools)
- [Review edits docs (sensitive files approval)](https://code.visualstudio.com/docs/copilot/chat/review-code-edits)
- [Security model/background](https://code.visualstudio.com/docs/copilot/security)

### 7) Todos / task list

VS Code chat can track progress via a todo list.

- The agent can create a todo list and update it automatically as work completes.
- Users can ask to revise steps in natural language.

Sources:

- [Planning in VS Code chat](https://code.visualstudio.com/docs/copilot/chat/chat-planning)
- [Release notes for task lists feature flag (historical)](https://code.visualstudio.com/updates/v1_103)

## Tripilot alignment notes

- Where VS Code docs specify behavior/settings, treat as **hard requirements** for alignment.
- Where VS Code behavior is not documented (e.g., exact pixel widths, typography), treat as **implementation-defined** and align visually through UI heuristics + iterative UX review.
