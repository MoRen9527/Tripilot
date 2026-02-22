# Layout, streaming, thinking, and checkpoints

This page captures **chat layout and “in-progress” UX** elements that affect perceived message format.

## Chat view placement and width

### Secondary Side Bar & maximized chat

VS Code’s Chat view lives in the Secondary Side Bar by default.
VS Code also supports opening Chat as maximized via the Secondary Side Bar visibility setting.

Source:

- [Release notes (Open chat as maximized)](https://code.visualstudio.com/updates/v1_103)

Tripilot alignment:

- Provide a “maximize chat” affordance or a setting that matches VS Code’s intent (chat can occupy a wider column).

## Streaming response UX

What’s documented:

- Chat responses are streamed (user experience; not a formal schema).
- Agent workflows interleave tool calls, confirmations, and final responses.

Tripilot alignment:

- Render assistant responses incrementally.
- Provide distinct UI for "in progress" vs "complete" vs "waiting for approval".

## Tool call details collapse

VS Code collapses tool call details by default; user can expand in the conversation.

- Setting: `chat.agent.thinking.collapsedTools` (experimental)

Source:

- [Chat tools docs](https://code.visualstudio.com/docs/copilot/chat/chat-tools)
- [Settings reference](https://code.visualstudio.com/docs/copilot/reference/copilot-settings)

Tripilot alignment:

- Default to collapsed tool detail blocks.
- Offer per-tool expand/collapse.
- Optional setting to change default behavior.

## Thinking presentation

VS Code exposes settings related to how “thinking tokens” are presented:

- `chat.agent.thinkingStyle` (experimental)
- `github.copilot.chat.agent.thinkingTool` (experimental)

Source:

- [Settings reference](https://code.visualstudio.com/docs/copilot/reference/copilot-settings)

Tripilot alignment (recommended contract):

- Treat “thinking” as **presentation state**, not user-visible raw tokens by default.
- If you display thinking, make it clearly distinct from the assistant’s final answer.
- Keep tool details + thinking separable (collapse independently).

## Checkpoints (restore state)

VS Code supports chat checkpoints:

- `chat.checkpoints.enabled`
- When selecting a checkpoint, VS Code reverts workspace changes and chat history to that point; can redo.

Sources:

- [Release notes (Chat checkpoints)](https://code.visualstudio.com/updates/v1_103)
- [Settings reference](https://code.visualstudio.com/docs/copilot/reference/copilot-settings)

Tripilot alignment:

- If Tripilot supports applying edits to disk, consider adding “checkpoint-like” restore points.
- At minimum, support undo flows that are visible in the chat UX (especially after multi-file edits).
