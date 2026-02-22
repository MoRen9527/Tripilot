# Tool call messages, approvals, and disclosures

This page documents how Copilot Chat in VS Code presents **tool usage** in the conversation.

## Tool invocation summary lines (collapsed details)

VS Code shows tool invocations inline in chat.
- By default, tool call details are **collapsed**.
- Users can expand tool call details by selecting the tool summary line.
- Default behavior is configurable via `chat.agent.thinking.collapsedTools` (experimental).

Source:
- https://code.visualstudio.com/docs/copilot/chat/chat-tools

## Tool approval (confirmation dialog)

Some tools require approval before they can run.
VS Code shows a confirmation dialog with tool details.
Approvals can be granted at different scopes:
- single use
- current session
- current workspace
- all future invocations

Source:
- https://code.visualstudio.com/docs/copilot/chat/chat-tools

## Edit tool parameters before running

VS Code allows reviewing and editing tool input parameters:
1) In the tool confirmation dialog, expand details via the chevron.
2) Edit inputs.
3) Allow to run with modified parameters.

Source:
- https://code.visualstudio.com/docs/copilot/chat/chat-tools

## URL approval (two-step)

When tools access a URL (e.g., `fetch`), VS Code uses two-step approval:
- Pre-approval: approve request to the URL/domain.
- Post-approval: review the fetched response content before it is added to chat or passed to other tools.

Notes from docs:
- Pre-approval respects VS Code “Trusted Domains”.
- Post-approval always requires review and is **not linked** to Trusted Domains.
- Auto-approval patterns stored in `chat.tools.urls.autoApprove`.

Source:
- https://code.visualstudio.com/docs/copilot/chat/chat-tools

Tripilot alignment:
- Implement URL approvals as two separate user decisions.
- Clearly label whether the user is approving a request vs approving response content.

## Reset confirmations

VS Code provides a command to clear saved tool approvals:
- “Chat: Reset Tool Confirmations”

Source:
- https://code.visualstudio.com/docs/copilot/chat/chat-tools

## Terminal tool output disclosure

When the agent runs terminal commands:
- The conversation shows the commands run.
- The user can show output inline in chat ("Show Output") or open the terminal ("Show Terminal").
- Output location is configurable (experimental) via `chat.tools.terminal.outputLocation`.

Source:
- https://code.visualstudio.com/docs/copilot/chat/chat-tools

## Security rationale (why approvals exist)

VS Code explicitly frames approvals and visibility as protections against:
- prompt injection via tool output
- destructive edits/commands
- data exfiltration

Source:
- Security considerations: https://code.visualstudio.com/docs/copilot/security
