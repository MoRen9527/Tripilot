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

## PC 端 MVP 产品规格（CPO 裁决 #9-#11, 2026-07-16）

> 来源：CPO 路由包裁决 #9-#11

### MVP 验收标准（裁决 #9）

一条端到端任务链 = MVP Done：

```
用户故事：
  "作为一名新用户，我安装 Electron 应用后，
   可以看到聊天界面，输入一个任务，
   任务被总助理解并分派给员工执行，
   最终我收到执行结果。"
```

**验收门禁（按顺序全部通过 = MVP Done）：**

| Gate | 内容 | 
|------|------|
| G1 | Electron 安装包可正常安装启动（Win/Mac/Linux） |
| G2 | 启动后自动拉起 TriLC 本地服务（后台静默） |
| G3 | 聊天界面连接成功（优先连 TriMC，断线自动切 TriLC） |
| G4 | 输入"帮我整理本周工作" → 消息发送成功，返回 agent 思考过程 |
| G5 | 任务被 ChiefOfStaff 解析 → 路由到对应员工 agent |
| G6 | 员工 agent 完成执行 → 结果展示在聊天窗口 |
| G7 | 任务历史可回溯（会话列表） |
| G8 | 基础设置页可配置 TriMC 连接地址 |

**Phase 1 不做：** 离线模式全功能（TriLC 仅保障基础可用）、多会话并行、任务模板市场

### 简化模式默认预设（裁决 #10）

首次启动默认简化模式，一键恢复全功能。模式偏好保存到本地（不跨设备同步）。

**简化模式保留：**
- ✅ 聊天输入框
- ✅ 任务历史列表
- ✅ 基础设置（主题/语言）
- ✅ "切换到全功能模式"按钮（醒目位置）

**简化模式隐藏：**
- ❌ TriMC 高级配置（端点/超时/重试策略）
- ❌ Agent 选择器 / 员工编排面板
- ❌ 调试日志控制台
- ❌ 插件管理入口
- ❌ TriLC 本地服务管理面板
- ❌ 开发工具链菜单

### 插件市场形态（裁决 #11）

```
Phase 1 L0-L1: 无插件市场
  - AI 应用通过 IPD 流程 → TriDev 构建 → 发布到"我的应用"列表
  - 不引入应用审核、评价评分、支付结算、版本管理界面

Phase 1 L2（重新评估条件）:
  - OPC 商户数 ≥ 5 且发布应用 ≥ 10 时，评估启动插件市场 MVP
  - MVP 市场：应用列表 + 一键安装 + 基础评分

Phase 2+：完整市场（付费、审核、版本管理、排行榜）
```

### TriCode 多工具策略（裁决 #14-#15）

接入顺序：Tier 1 opencode → Tier 2 Claude Code → Tier 3 Codex/zcode/Copilot。工具账户完全独立，可选关联 TriMem 以解锁跨工具统计。

> TriCode 已独立为 `../TriCode/` 模块（CPO 2026-07-16 裁决），详见 `TriCode/docs/registry/product-state.md`。TriPilot 作为 TriCode 的消费者之一，通过 TriCode 统一接口调用代码工具，不直接耦合具体工具实现。

## Sources

- `../../AGENTS.md`
- `../../README.md`
- `../../package.json`
- `CPO 路由包裁决 #9-#11, #14-#15` — `TriMetaverse/docs/workflow/operating-records/2026-W29/cpo-product-routing-package.md`
