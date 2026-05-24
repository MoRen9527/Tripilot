# Tripilot Code State

## Repository Map

- `src/`：扩展与 webview 代码
- `tests/`：测试代码
- `scripts/`、`deploy/`、`docker/`：辅助脚本和环境资产
- `artifacts/`、`media/`、`resources/`：静态资产与构建相关内容

## Current Code Health

- 当前仓库具备较标准的扩展工程结构。
- 当前代码健康应按“PC 端软件交互入口层”理解，而不是按运行面或宿主切换层理解。
- 尚未建立 registry 级代码健康评分或 git 健康摘要。

## Change Tracking Baseline

- 首版只记录结构级事实，后续在明确要求时补充变更热区、主要改动链和健康指标。
- 与 `Tride`、`vscodium` 或 `TriHost` 边界相关的入口层变化，应同步回写中央 strategy 边界。

- 涉及具体项目代码仓库时，技术侧文档基线应按 `docs/engineering/DESIGN.md`、技术版 `ROADMAP.md`、技术版 `STATE.md` 以及 `docs/execution/<workstream>/<phase>/PLAN.md`、`SUMMARY.md`、`VERIFICATION.md` 维护；若缺失，应视为待补齐的技术或执行层缺口。

## Git Health

- 目前未在 registry 中建立分支或变更统计基线。

## Local CodeGraph Index

- 2026-05-24 已建立本地 CodeGraph 源码索引，由 `TripilotCodeRegistry` 接管摘要与后续维护纪律。
- 当前索引拆为 `src/` 与 `tests/` 两个干净索引：`src/` 为 10 files，488 nodes，1,917 edges，语言覆盖 `typescript`；`tests/` 为 6 files，27 nodes，32 edges，语言覆盖 `javascript`、`typescript`；backend 均为 `node-sqlite`。
- 2026-05-24 已由 CTO 小狄技术线执行仓库瘦身：`node_modules/` 与 `out/` 已从 Git 索引移出，本地依赖与编译输出保留；`.vscode-test/` 作为本地扩展测试运行产物忽略。
- Tripilot 仓库历史上存在已跟踪的 `node_modules/`，因此本轮仍不使用旧仓根 CodeGraph 索引作为 registry 事实，避免把依赖包误登记为模块代码事实；后续可在瘦身提交后按需重建仓根索引。
- `.codegraph/` 仅作为本地缓存与辅助索引，不作为仓库真源提交；后续只在本文件记录扫描摘要、版本锚点、排除规则、入口与调用链发现、待确认缺口。
- 首轮版本锚点：以本次本地扫描时工作区状态为准；后续正式收口时应补充对应 git commit / branch。

## Quality Risks

- 用户入口逻辑容易与 `vscodium` 的宿主边界混淆。
- 若把 Tripilot 误写成正式宿主适配层或统一 runtime，会直接破坏 PC 端软件层与 TriMC/TriHost 的分层。
- 若缺少与 `Tride` 的接口梳理，后续 Role Agents 难以准确估计集成成本。

## Sources

- `../../src/`
- `../../tests/`
- `../../README.md`
- `../../package.json`
