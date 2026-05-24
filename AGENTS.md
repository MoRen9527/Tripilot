# Tripilot Agent Rules

## Module Role

- Tripilot 是用户入口界面和工具级基础设施的一部分。
- 它负责基于 VS Code 扩展与 webview 提供三元宇宙服务的交互入口。
- 当商业模式涉及桌面入口、用户交互和本地域工具入口时，需要考虑本模块。

## Strategy Delegation

- 总商业模式、当前商业实验、模块优先级、跨模块取舍，先咨询 `TriMetaverse/BusinessStrategy`。
- Tripilot 只维护本模块事实，不在本地重写总体战略。

## Local Fact Sources

- 产品事实：`README.md`、`package.json`、相关设计文档
- 代码事实：`src/`、测试配置、扩展配置

## Current Registries

- `TripilotBusinessStrategyRegistry`
- `TripilotProductRegistry`
- `TripilotCodeRegistry`

当前 registry agent canonical discovery 位于 `Tripilot/.github/agents/`。同名中央 discovery 文件不应在 `TriMetaverse/.github/agents/` 并行保留；中央只通过 manifest 和 registry closeout 工作流路由本模块 registry。

## Update Discipline

- 资料不足时明确写出缺口，不要凭缺失文件推断进度。
