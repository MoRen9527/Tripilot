# VS Code 内置工具：#runTests

## 一句话概述

运行工作区的单元测试（可选生成覆盖率报告），用于验证代码正确性。

## 公开资料依据

- 内置工具列表中对 `#runTests` 的描述：
  - https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features
- Agent 模式说明（提到 agent 会自动修复测试失败）：
  - https://code.visualstudio.com/docs/copilot/chat/copilot-chat

## 核心行为语义

- 调用工作区的测试配置（例如 Jest、pytest、xUnit）
- 运行全部或部分测试
- 返回测试结果（通过/失败/跳过）
- 可选生成覆盖率报告

### 与 `testFailure` 的配合

典型 agent 工作流：
1. 用户要求"添加新功能并验证"
2. Agent 生成代码
3. Agent 调用 `runTests` 运行测试
4. 若失败，agent 调用 `testFailure` 获取失败信息
5. Agent 修复代码并重新运行测试

## 风险与审批建议（高风险）

**必须审批**：
- 运行测试可能消耗大量时间（特别是集成测试/端到端测试）
- 可能触发数据库/网络请求（若测试未正确 mock）

官方实验性设置：
- `chat.tools.autoApprove`：允许 agent 自动批准所有工具
- 默认行为：每次运行前弹出审批请求

Tripilot 对齐建议：
- **默认强制审批**（显示测试范围：全部/单个文件/单个测试）
- 对单元测试可提供"仅本会话信任"选项
- 对集成测试/端到端测试必须每次审批

## Tripilot 建议接口（实现对齐用）

- 工具名：`run_tests`（或通过 VS Code Testing API 实现）
- 入参（建议）：
  - `scope`：测试范围（`all` | 文件路径 | 测试名称）
  - `coverage`：是否生成覆盖率（默认 false）

返回值：
- 测试结果摘要（通过数、失败数、跳过数）
- 失败测试的详细信息（供 `testFailure` 使用）
- 可选：覆盖率报告

## 典型用法（提示词写法）

- "运行所有单元测试，验证重构是否破坏功能。"
- "执行 `auth.test.ts` 的测试，并生成覆盖率。"

## 不适用场景

- 需要手动调试测试：改用 VS Code Testing UI（断点/单步调试）
- 非 VS Code 支持的测试框架：改用 `runInTerminal` 直接执行测试命令
