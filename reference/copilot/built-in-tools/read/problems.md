```markdown
# 内置工具：problems

> 将 Problems 面板中的问题（编译错误、lint 警告、类型检查错误等）作为结构化上下文提供给模型，常用于“修复报错/收敛改动范围”。

## 公开资料依据

- VS Code 官方内置工具列表（problems 简述）：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

## 语义与行为

- 输入：可选的文件列表（只看特定文件/目录），或默认查看整个工作区的 problems。
- 输出：问题列表，通常包含：
  - 文件路径、行列号范围
  - 严重级别（error/warning/info）
  - 诊断信息（message）与来源（tsserver/eslint 等）

- 副作用：无（只读）。

## 典型链路

1) `problems` → 收集错误
2) `readFile` → 读取出错附近代码
3) 进入 edit 工具族修复
4) 进入 execute 工具族跑 tests/build 验证（如需要）

## Tripilot 建议接口

- 对应实现通常是：`get_errors({ filePaths? })`

```