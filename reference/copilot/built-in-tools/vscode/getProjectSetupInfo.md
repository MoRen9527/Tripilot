````markdown
```markdown
# 内置工具：getProjectSetupInfo

> 读取/推断当前项目的“如何安装依赖、如何构建、如何运行、如何测试”等设置信息。Copilot Chat 里通常用于自动生成可执行的 setup/run 指令与项目结构建议。

## 结论：Tripilot 是否需要实现？

- **需要实现**：VS Code Extension API 没有等价的“项目脚手架/设置建议”公共服务。
- 可做的“直接复用”仅限于：读取工作区文件、解析配置、运行搜索。

## 可复用的基础能力

- 读取文件：`vscode.workspace.fs.readFile()`
- 查找文件：`vscode.workspace.findFiles()`
- 读取工作区信息：`vscode.workspace.workspaceFolders`

这些在 VS Code + VSCodium 都可用。

## Tripilot 建议实现思路（最小可用）

- 探测入口文件（按优先级）：
  - Node：`package.json`（scripts）
  - Python：`pyproject.toml` / `requirements.txt`
  - .NET：`*.csproj` / `*.sln`
  - Java：`pom.xml` / `build.gradle`
  - Rust：`Cargo.toml`

- 推断常见命令：
  - install：`npm i` / `pnpm i` / `pip install -r ...` / `cargo build` ...
  - test：`npm test` / `pytest` / `dotnet test` / `cargo test` ...

- 输出结构：给 agent 一个“可执行计划”，并标注需要用户审批的步骤。

## Tripilot 建议接口

- `get_project_setup_info({ workspaceRoot }) -> { detected, install, build, test, run, notes }`

> 注意：这是 Tripilot 自研能力，不是官方公开 schema。

```
````
