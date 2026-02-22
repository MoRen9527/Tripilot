# VS Code 内置工具：#testFailure

## 一句话概述

获取上次单元测试失败的详细信息，用于诊断和修复测试问题。

## 公开资料依据

- 内置工具列表中对 `#testFailure` 的描述：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features

## 核心行为语义

- 读取最近一次测试运行的失败信息
- 包含失败测试的名称、错误消息、堆栈跟踪等
- 只读操作，不会影响测试状态

### 与 `runTests` 的配合

典型 agent 工作流：
1. `runTests()` 运行测试
2. 若有失败，agent 调用 `testFailure()` 获取详细信息
3. Agent 分析失败原因（例如断言错误、空指针等）
4. Agent 修复代码并重新运行测试

## 风险与审批建议（低风险）

- 只读操作，风险很低
- 可自动批准（无需弹出审批）

## Tripilot 建议接口（实现对齐用）

- 工具名：`test_failure`
- 入参：无（或可选 `maxResults` 限制返回条数）

返回值：
- 失败测试列表（每项包含）：
  - 测试名称
  - 失败原因（错误消息）
  - 堆栈跟踪
  - 文件路径和行号

## 典型用法（提示词写法）

- "查看测试失败原因，帮我修复。"
- "分析 `auth.test.ts` 的失败，看是否是配置问题。"

## 不适用场景

- 需要实时监控测试输出：改用 VS Code Testing UI
