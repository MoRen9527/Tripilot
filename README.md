# Tripilot Chat

A Copilot Chat-like sidebar webview with a minimal tool-calling loop implemented using VS Code extension APIs.

## Run (dev)

1. In VS Code: open this folder.
2. Run `npm install`
3. Press `F5` (Run Extension) to launch the Extension Development Host.
4. In the new window, open the Activity Bar "Tripilot" icon → "Chat".

## Configure AI (VS Code Language Models)

Tripilot uses VS Code's Language Model API (`vscode.lm`).

- Use the Model menu → “管理模型...” to open VS Code's Language Models UI.
- Add/enable providers there (e.g. Copilot, OpenAI/OpenRouter via compatible provider extensions).
- Tripilot stores the last selected model id in extension global state.

Optional setting:

- `tripilot.maxToolIterations` (default `6`)

## Copilot Direct backend (experimental)

Tripilot can optionally talk to Copilot Proxy directly (without `vscode.lm`).

1) Sign in to GitHub in VS Code (Accounts menu).
2) Set:

- `tripilot.chatProvider`: `copilot-direct`
- `tripilot.copilotDirect.authMode`: `minimal` (or `permissive` if permissions errors occur)

Notes:

- This requires that your GitHub account has Copilot access.
- Model list is fetched from Copilot Proxy (`/models`) and shown in the model picker.

## Tools

Current built-in tools:

- `workspace_listFiles`
- `workspace_readFile`
- `workspace_writeFile`
- `vscode_executeCommand`
- `terminal_run` (best-effort: sends to terminal; output capture is limited by VS Code API)
