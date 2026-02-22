# Todo list / task tracking messages

This page documents how VS Code chat describes and presents **task/todo tracking**.

## Agent-created todo list

VS Code documentation describes that:
- When working on complex tasks, the agent can create a todo list to track progress.
- The list is updated automatically as tasks complete.
- The todo list helps keep the agent focused and gives the user visibility.

Source:
- https://code.visualstudio.com/docs/copilot/chat/chat-planning

## User edits to the todo list

VS Code documentation notes:
- You can update the todo list using natural language (e.g., "revise step 1" / "add another task").
- If todos are not as expected, you can clear the list; otherwise the agent manages updates.

Source:
- https://code.visualstudio.com/docs/copilot/chat/chat-planning

## Feature flag history (experimental)

Task/todo list support was introduced as an experimental feature in VS Code releases.
- Example: release notes mention enabling via a setting (`chat.todoListTool.enabled`).

Source:
- https://code.visualstudio.com/updates/v1_103

Tripilot alignment:
- Provide a top-of-chat (or persistent) todo list region.
- Use deterministic status values (e.g., `not-started`, `in-progress`, `completed`) to mirror VS Code’s concept.
- Support user-driven edits in plain language.
