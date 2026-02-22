# Copilot Chat 内置工具（对齐规格）

本目录用于沉淀“基于公开资料可确认的 Copilot Chat/VS Code Chat 内置工具语义”，并补充 Tripilot 的落地接口建议与对齐清单。

## 文档列表

- agent
  - [agent/runSubagent.md](agent/runSubagent.md)
- edit
  - [edit/overview.md](edit/overview.md)
  - [edit/createDirectory.md](edit/createDirectory.md)
  - [edit/createFile.md](edit/createFile.md)
  - [edit/editFiles.md](edit/editFiles.md)
  - [edit/editNotebook.md](edit/editNotebook.md)
  - [edit/newJupyterNotebook.md](edit/newJupyterNotebook.md)
- execute
  - [execute/overview.md](execute/overview.md)
  - [execute/runInTerminal.md](execute/runInTerminal.md)
  - [execute/getTerminalOutput.md](execute/getTerminalOutput.md)
  - [execute/createAndRunTask.md](execute/createAndRunTask.md)
  - [execute/runTask.md](execute/runTask.md)
  - [execute/getTaskOutput.md](execute/getTaskOutput.md)
  - [execute/runNotebookCell.md](execute/runNotebookCell.md)
  - [execute/runTests.md](execute/runTests.md)
  - [execute/testFailure.md](execute/testFailure.md)
- read
  - [read/overview.md](read/overview.md)
  - [read/readFile.md](read/readFile.md)
  - [read/getNotebookSummary.md](read/getNotebookSummary.md)
  - [read/readNotebookCellOutput.md](read/readNotebookCellOutput.md)
  - [read/problems.md](read/problems.md)
  - [read/terminalLastCommand.md](read/terminalLastCommand.md)
  - [read/terminalSelection.md](read/terminalSelection.md)
  - [read/getTaskOutput.md](read/getTaskOutput.md)
- search
  - [search/overview.md](search/overview.md)
  - [search/changes.md](search/changes.md)
  - [search/codebase.md](search/codebase.md)
  - [search/fileSearch.md](search/fileSearch.md)
  - [search/listDirectory.md](search/listDirectory.md)
  - [search/searchResults.md](search/searchResults.md)
  - [search/textSearch.md](search/textSearch.md)
  - [search/usages.md](search/usages.md)
- web
  - [web/overview.md](web/overview.md)
  - [web/fetch.md](web/fetch.md)
  - [web/githubRepo.md](web/githubRepo.md)
- vscode
  - [vscode/overview.md](vscode/overview.md)
  - [vscode/extensions.md](vscode/extensions.md)
  - [vscode/getProjectSetupInfo.md](vscode/getProjectSetupInfo.md)
  - [vscode/installExtension.md](vscode/installExtension.md)
  - [vscode/newWorkspace.md](vscode/newWorkspace.md)
  - [vscode/openSimpleBrowser.md](vscode/openSimpleBrowser.md)
  - [vscode/runCommand.md](vscode/runCommand.md)
  - [vscode/vscodeAPI.md](vscode/vscodeAPI.md)
- todo
  - [todo.md](todo.md)

## 资料来源原则

- 优先引用 VS Code 官方文档（code.visualstudio.com）
- 不复刻原文，采用归纳总结 + 链接的方式
- 对于官方未公开的 schema/字段，明确标注为“Tripilot 建议接口”或“实现约定”，避免误当成官方承诺
