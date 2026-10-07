# AI Plugin Doctor

Windows 本地 AI 工具诊断 CLI，用于扫描 Codex、Claude Code、Cursor 和 VS Code 的 MCP 配置，解释故障、检查选定服务，并执行受限修复。也支持使用真实 Codex CLI 和 Claude Code 验证 stdio MCP 工具的发现、选择和调用。

## 安装与构建

需要 Windows x64、Node.js 24，以及系统 .NET Framework 编译器。构建会检查原生组件编译环境，缺失时明确失败；仓库和源码包不包含预编译程序。

```powershell
npm ci --ignore-scripts
npm run build
npm test
node dist/src/cli.js help
```

开发入口 `npm run dev` 也需要先构建，以使用 Windows 进程树和文件保护组件。

## 扫描与诊断

扫描无需模型密钥，不启动 MCP 服务或凭据 helper：

```powershell
node dist/src/cli.js scan --workspace "D:\你的项目" --clients codex,claude,cursor,vscode --out runs/config-scan
node dist/src/cli.js diagnose runs/config-scan/scan.json
```

打开 `runs/config-scan/report.html` 查看发现、来源和证据等级。主动检查和修复需要明确选择服务或发现编号。JSON/JSONC 支持受限修复；Codex TOML、权限、信任、托管策略和 OAuth 提供人工处理建议。

完整命令、恢复步骤与支持矩阵见 [配置诊断使用指南](docs/配置诊断使用指南.md)。Codex 和 Claude Code 支持原生入口检查；Cursor 和 VS Code 的已有原生会话保留人工取证。

## 导入已有服务

```powershell
node dist/src/cli.js init "D:\项目\.mcp.json" --list
node dist/src/cli.js init "D:\项目\.mcp.json" "D:\验收\doctor.yaml" --server tools --cwd "D:\项目"
```

多个配置文件或多个服务时，需要明确选择；多个 package 入口使用 `--entry`。导入保留已有环境变量引用，不复制内联环境值。JSONC/TOML、工作目录和参数规则见 [服务导入与路径选择指南](docs/服务导入与路径选择指南.md)。

## 验证工具调用

```powershell
node dist/src/cli.js init doctor.yaml
node dist/src/cli.js preflight doctor.yaml
node dist/src/cli.js run doctor.yaml --client codex --out runs/codex-smoke
node dist/src/cli.js run doctor.yaml --client claude --out runs/claude-smoke
```

`init` 生成无外部副作用的合成 stdio MCP 服务样例，不请求模型。`doctor.yaml` 使用 JSON 语法（YAML 1.2 子集），可修改 `server.command` 和 `server.args` 检查其他服务。真实服务应使用测试账号与测试数据；`approvedTools` 只填写已允许执行的工具。

`run` 使用真实模型，可能产生费用。Claude `--bare` 模式需要 `ANTHROPIC_API_KEY`；Codex 使用当前 `CODEX_HOME` 的认证状态。可用 `DOCTOR_CODEX_EXE` 指定 Codex 可执行文件，用 `init --codex-model`、`--claude-model` 固定模型，用 `--proxy-url` 设置当前子进程的代理。不要将密钥或本机代理配置提交到仓库。

`server.env` 仅允许 `${VARIABLE}` 引用；实际值从当前进程环境取得，不写入配置快照。`preflight --live-auth` 会进行小额真实模型请求；普通 `preflight` 只检查协议和凭据是否存在。

每次运行生成 `report.html`、`report.json`、客户端日志、代理事件及 `manual-review.md`。E0–E3 与人工 E4 分开记录；状态为 `PASS`、`FAIL`、`UNKNOWN` 或 `SKIP`。可用 `--case direct` 选择单个场景。

```powershell
node dist/src/cli.js compare runs/before/report.json runs/after/report.json
```

缺失原本通过的场景也视为退化；E2/E3 退化返回退出码 2。报告重新生成前检查证据文件 SHA-256，证据修改、丢失或缺少必要摘要时停止。摘要用于完整性检查，不是数字签名。

任务运行器、SDK 探针和代理在超时、取消或认证失败时清理普通后代进程；日志有累计大小限制。已有内容的输出目录会被拒绝，以保留上次证据。

## 源码打包与校验

```powershell
npm run package:source
# 也可指定新的输出路径；已有包或校验文件不会被覆盖。
npm run package:source -- releases/source-review.zip
```

源码包按明确清单包含源码、测试、锁文件、原生组件源代码、必要脚本、使用指南和 CI 定义。研究记录、交付说明、运行证据、本机配置、认证文件、依赖目录和构建产物均排除。必要文件缺失或发现符号链接时打包失败。

ZIP 使用固定顺序、时间与权限。旁边的 `.sha256` 校验整包；包内 `SOURCE_MANIFEST.json` 记录源码长度、SHA-256 和清单摘要。解压后在项目目录重建并校验：

```powershell
npm ci --ignore-scripts
npm run build
npm run verify:source
npm test
```

Windows CI 执行构建、测试、打包、原生解压、独立重建及完整性验证，并保存源码包和摘要。

## 支持边界

- 工具调用验收支持本地 stdio MCP；HTTP、OAuth、MCP Apps UI 和完整桌面界面保留原生人工步骤。
- 报告保存任务文本、工具名及按键名脱敏的参数；真实插件测试使用测试数据。运行证据位于本机 `runs/`，不会自动上传。
- 调研、历史验收与本机工作记录不随源码分发。克隆后按上述命令重新生成自己的验证结果。
