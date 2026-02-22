```markdown
# 内置工具：changes

> 获取当前 Git 工作区的改动概览（可区分 staged/unstaged/merge-conflicts），用于让模型理解你改了什么、下一步该怎么修/补。

## 公开资料依据

- VS Code 官方内置工具列表（changes 简述）：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

## 语义与行为

- 输入：可选仓库路径 + 过滤状态（staged/unstaged/merge-conflicts）。
- 输出：改动文件列表（通常含文件路径，可能还含简要状态）。
- 副作用：无（只读）。

## 典型用法

- 生成 commit message / PR 描述之前：先用 `changes` 获取范围
- 修复 merge conflicts：先用 `changes` 找到冲突文件，再用 `readFile` 精读

## 风险提示

- 改动文件名与路径本身可能敏感；如果后续还要读取 diff 内容，风险更高。

## Tripilot 建议接口

- `get_changed_files({ repositoryPath?, sourceControlState?: ['staged'|'unstaged'|'merge-conflicts'] })`

```