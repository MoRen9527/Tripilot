# Edits review, pending changes, and sensitive files

This page documents the **review flow** for AI-generated edits in VS Code chat.

## Pending edits model (what users see)

VS Code behavior:
- AI edits are applied and saved to disk.
- VS Code tracks files with “pending edits” and lets you review them.
- Chat view shows the list of edited files pending review.
- Explorer and editor tabs show an indicator for files with pending edits.
- Opening a changed file shows an inline diff.
- Pending status is restored after restarting VS Code.

Source:
- https://code.visualstudio.com/docs/copilot/chat/review-code-edits

Tripilot alignment:
- Maintain an explicit “pending changes” list in chat (or a side panel) after any edit tool runs.
- Offer a single place to accept/reject all pending changes.

## Per-file and per-hunk review controls

VS Code behavior:
- Editor overlay controls allow navigating between edits (Up/Down).
- Keep/Undo applies per file.
- Hovering over an inline change allows accepting/rejecting individual changes.
- Chat view can accept or reject all changes across all files at once.

Source:
- https://code.visualstudio.com/docs/copilot/chat/review-code-edits

## Source control integration

VS Code behavior:
- Staging changes in Source Control auto-accepts pending edits.
- Discarding changes discards pending edits.

Source:
- https://code.visualstudio.com/docs/copilot/chat/review-code-edits

## Auto-accept edits

Docs mention an auto-accept capability:
- Review docs: `chat.editing.autoAccept` (naming in that page)
- Settings reference currently lists `chat.editing.autoAcceptDelay`

Sources:
- Review docs: https://code.visualstudio.com/docs/copilot/chat/review-code-edits
- Settings ref: https://code.visualstudio.com/docs/copilot/reference/copilot-settings

Tripilot alignment:
- If you implement auto-accept, ensure there is a visible countdown and a cancel affordance.

## Sensitive files: approval before applying edits

VS Code behavior:
- To prevent inadvertent edits to sensitive files, VS Code prompts for approval before applying edits.
- In chat, a diff view of proposed changes is shown; user can approve or reject.
- `chat.tools.edits.autoApprove` configures which files require approval (glob patterns).

Source:
- https://code.visualstudio.com/docs/copilot/chat/review-code-edits

Tripilot alignment:
- Maintain a deny-by-pattern capability for “high-risk” paths (e.g., `.env`, `.vscode/*.json`, CI configs).
- Show a diff in the approval UI, not only a filename list.
