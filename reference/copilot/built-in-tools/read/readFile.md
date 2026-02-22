```markdown
# 内置工具：readFile

> 读取工作区某个文件的内容（通常要求指定行范围），用于为模型补充精确上下文。

## 公开资料依据

- VS Code 官方内置工具列表（readFile 简述）：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

## 语义与行为

- 输入：目标文件路径 + 行范围（start/end）。
- 输出：该范围内的纯文本内容（原样返回，保留换行/缩进）。
- 副作用：无（只读）。

Copilot Chat/Agent 常见用法：
- 修 bug：先用 `problems` 获取错误，再用 `readFile` 精读相关片段
- 生成补丁前：读取要改的文件片段以减少“幻觉修改”

## 重要边界与建议

- 行范围优先：避免“整文件”造成上下文浪费或泄露。
- 处理大文件：建议实现截断策略，并引导 agent 继续按范围读取。
- 敏感文件：对 `.env`、密钥/证书等路径可引入额外确认或 denylist。

## Tripilot 建议接口

- `read_file({ filePath, startLine, endLine })`
- 行号通常按 1-based（与 VS Code editor 行号一致）

## 典型用法（示意）

1) `problems` → 定位报错文件与行号
2) `readFile` 读取 `Lx-Ly`
3) 模型提出修复 → 进入 edit 工具族（若需要修改）

```