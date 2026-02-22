```markdown
# 内置工具：terminalLastCommand

> 获取“当前活动终端”最近一次运行的命令及其输出（用于让模型理解你刚刚跑了什么、结果是什么）。

## 公开资料依据

- VS Code 官方内置工具列表（terminalLastCommand 简述）：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

## 语义与行为

- 输入：无（隐含使用当前活动终端）。
- 输出：最近命令（字符串）+ 对应输出（stdout/stderr 的合并或摘要）。
- 副作用：无（只读，不会重跑命令）。

## 风险提示

- 终端输出可能包含：访问令牌、内部域名、文件路径、用户数据等。
- 即使它属于“read-only”，也建议在默认策略中当作“可能敏感”处理（可配置 auto-approve）。

## Tripilot 建议接口

- `terminal_last_command()`

```