# Tripilot Business State

## Registry Role

- 本文件是 `Tripilot` 的 business registry 工作层。
- `Tripilot` 的 `product-state.md` 与 `code-state.md` 默认应以本文件作为业务上游约束。

## Module Business Role

- `Tripilot` 是用户入口界面和本地域工具交互入口的一部分。
- 它负责 VS Code 扩展与 webview 形态的用户入口，承接桌面交互、本地自动化和 `vibe coding` 体验。

## Current Default Business Position

- 当前默认定位是 PC 端软件层中的用户交互入口，而不是中央战略层或模型 API 平台层。

## Current Business Scope

- 承接用户进入三元宇宙服务的桌面入口体验。
- 承接本地域工具级交互和面向用户自用自动化的前台入口。

## Boundary Notes

- 不在本模块内重写总体商业模式。
- 涉及总体商业实验、模块优先级与跨模块取舍时，应先回到中央 `BusinessStrategy`。

## Sources

- `../../AGENTS.md`
- `../../README.md`
- `../../package.json`