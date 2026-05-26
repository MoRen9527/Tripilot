# TriPilot Product State

## Module Overview

- `TriPilot` 是用户入口界面和工具级基础设施的一部分；当前物理仓库路径仍为 `Tripilot/`，在显式 repo rename 前继续作为兼容路径。
- 它基于 VS Code 扩展与 webview 提供三元宇宙服务的桌面聊天入口，并属于 PC 端软件层中的本地控制和显示入口模块。

## Current Product Scope

- 提供桌面侧聊天与工具交互入口。
- 作为 `TriPilot + Tride + vscodium + CLI` 组成的 PC 端软件层中的用户交互入口之一。
- 作为用户直接使用本地自动化、PC 软件自动化与 `vibe coding` 的前台入口之一。
- 与 `TriLC` 协同承接本地化任务在用户侧的触发、确认与交互展示。
- 目标上通过 `TriMC` 与 `TriStaciss` 接通所有可用模型，并控制和调配龙虾 / Hermes / 其他 agents；即使部分 agent 在本地运行，也应由服务端主控保持任务连续性，降低 IDE 关闭导致会话中断的影响。
- 产品定位上，TriPilot 只是与 `vscodium` 共同形成的本地工具和显示入口，不承担云端 agent 主控本身。
- 不承担正式宿主适配或切换语义；正式宿主配置由 `TriHost` 负责。

- 涉及具体项目代码仓库时，产品侧文档基线应按 `PROJECT.md`、`REQUIREMENTS.md`、产品版 `ROADMAP.md` 和产品版 `STATE.md` 维护；若缺失，应视为待补齐的产品真源缺口。

## Current Progress

- 已具备根级 `AGENTS.md`、模块 `README.md`、`src/`、`tests/` 和扩展工程结构。
- 已建立首版 registry 工作层。
- 当前已与中央边界对齐为 PC 端软件中的入口层，而不是运行面或宿主切换层。

## Bug And Gap State

- 当前产品状态尚未沉淀为稳定的 registry 快照，仍较依赖 README 和代码结构。
- “IDE 关闭不影响长期任务”的能力依赖 `TriMC` 服务端主控和 agent 任务续跑机制，不应写成当前扩展单体已完成能力。
- 与 `vscodium` 的宿主基础设施边界需要持续明确。
- 与 `Tride` 的交互入口 / orchestration 边界需要持续显式维护。

## Cross-Module Dependencies

- 与 `vscodium` 共同构成 PC 端软件中的 IDE 与入口基础设施能力域。
- 与 `Tride` 协同承接工具调用、agentic 执行链和本机 runtime 能力。
- 与 `TriLC` 协同承接本地域任务在桌面入口侧的触发与反馈。
- 与 `TriHost` 存在未来正式宿主适配边界关系，但不承担该层职责。
- 与 `TriMetaverse` 的总体商业模式和当前实验保持对齐。

## Architecture State

- 当前以 VS Code 扩展 + webview 为核心形态，并在中央边界中归于 PC 端软件层的本地控制和显示入口。

## Sources

- `../../AGENTS.md`
- `../../README.md`
- `../../package.json`
