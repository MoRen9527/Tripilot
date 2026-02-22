````markdown
```markdown
# 内置工具：runCommand

> 执行 VS Code 命令（command），用于触发工作台能力或其他扩展贡献的命令。

## 结论：Tripilot 是否需要实现？

- **不需要自研底层能力**：VS Code Extension API 原生支持 `vscode.commands.executeCommand()`。
- 但 **需要安全策略**：命令执行属于高权限操作（等同于“让 agent 控制 IDE”）。

## VS Code 可直接复用的能力

- `vscode.commands.executeCommand(commandId, ...args)`

兼容性：VS Code + VSCodium 均可用。

## 风险与边界（强烈建议）

- 默认 **必须用户确认**（至少首次/每次会话），避免被提示词诱导去执行破坏性命令。
- 使用 allowlist：只允许一组明确命令（例如打开视图、聚焦面板、打开文件、Simple Browser 等）。
- 参数校验：对 URI、路径、字符串长度做限制；禁止把任意文本直接拼到命令参数里。

## Tripilot 建议接口

- `run_command({ commandId, args? }) -> any`

返回建议：
- `ok: boolean`
- `result?: any`（可 JSON 序列化）
- `error?: { message, code? }`

```
````
