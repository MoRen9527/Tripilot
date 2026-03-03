# Tripilot 测试框架与流程（R04）

## 1. 分层测试策略

- 单元测试（Unit）
  - 框架：Vitest
  - 目标：纯函数与协议解析逻辑（如 SSE 解析、排序、映射）
- 集成测试（Integration）
  - 框架：Vitest（Node 环境）
  - 目标：跨模块边界的数据流与状态变迁（如 chunk 边界、debug buffer）
- 系统/端到端（System/E2E）
  - 当前：Avatar-react 已使用 Playwright
  - Tripilot 计划：下一阶段接入 `@vscode/test-electron` 做扩展宿主级 E2E

## 2. 执行命令

- `npm run compile`：类型与工具契约检查
- `npm run test:unit`：运行单元测试（含 coverage）
- `npm run test:integration`：运行集成测试
- `npm run test:coverage`：全量测试与覆盖率
- `npm run test:data:generate`：生成可复现测试样本数据

## 3. 覆盖率与可视化

- 输出目录：`coverage/`
- 报告格式：`text`、`html`、`lcov`
- 本地查看：打开 `coverage/index.html`

## 4. CI/CD 回归

- 流水线：`.github/workflows/quality-gate.yml`
- 触发：`push`/`pull_request` 到 `dev`、`main`
- 步骤：`npm ci` -> `compile` -> `test:data:generate` -> `test:coverage`
- 产物：coverage 报告与生成的 fixture 数据

## 5. 人工审查门禁（必须）

以下变更需要人工评审签字后合并：

- 安全关键路径：认证、令牌管理、权限控制、敏感文件改写
- 业务关键逻辑：审批流、回放与实时态切换、子代理事件映射
- 性能敏感模块：高频事件渲染、日志缓冲、长会话内存管理

建议在 PR 模板中加入：

- [ ] Security path reviewed
- [ ] Critical business logic reviewed
- [ ] Performance sensitive path reviewed

## 6. 套件维护策略

- 每个缺陷修复必须至少新增一个回归测试
- 测试命名遵循 `feature.behavior.expected.test.ts`
- flaky 测试必须在 24h 内标记并处置（修复/隔离/删除）
- 每周检查覆盖率趋势，禁止无解释下降

## 7. 用例勾选模板

见：`tests/test-cases-checklist.md`
