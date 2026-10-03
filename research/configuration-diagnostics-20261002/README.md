# 跨客户端配置诊断：可行性实测

日期：2026-10-02。此目录保留调研及本轮实现验证证据；产品功能在 `src/diagnostics/`。

实现后实测：先 `npm run build`，再执行 `node research/configuration-diagnostics-20261002/implementation-validation.mjs`。脚本只针对合成目录和已知空工具服务，包含双 CLI 原生核对、Claude 字段修复、Codex TOML 人工合成修改与受控回放。结果见 `implementation-results.json`（两组双 CLI 样例，9/9）；已有桌面/IDE 会话状态仍未独立验证。

`feasibility.mjs` 使用合成的 Codex/Claude 配置目录核对覆盖规则；`probe-server.mjs` 只实现握手和空工具列表，不提供工具调用。没有模型请求，未更改用户原有配置。Claude 的 `mcp get` 会启动选中的服务，故此实验只针对已知的合成服务；扫描用户机器时不可把它当成无副作用的读取命令。

在 PowerShell 中复现：

```powershell
$env:DOCTOR_CODEX_EXE = (Get-Command codex.exe).Source
$env:DOCTOR_CLAUDE_CLI_JS = 'C:\Program Files\nodejs\node_global\node_modules\@anthropic-ai\claude-code\cli.js'
node research/configuration-diagnostics-20261002/feasibility.mjs
```

请按自己的安装位置调整 Claude 脚本路径。临时配置留在 `synthetic/` 中并被本目录 `.gitignore` 排除。报告只记录合成标记和布尔值，不记录真实凭据。

当前结果见 `feasibility-results.json`：Codex 0.159.2 的用户配置、未信任项目、已信任项目、命令行覆盖；Claude Code 2.1.89 的用户配置、项目覆盖、local 覆盖和变量语法，共 8 个断言。

这些证据仅证明相应版本 CLI 的配置读取行为，以及 Claude 对合成服务的连接。它们不能证明已有桌面会话的环境、配置缓存、工具可见性或第三方模型能力。Codex 返回的 env 字符串在列表输出中保留 `${VAR}`，此结果不单独证明服务进程最终收到什么值；产品诊断必须结合版本规则或进程探针。

Windows 项目键的初步探索发现，直接用反斜杠路径构造 Claude local 条目未被选择；改用原生 `add-json --scope local` 在合成目录中生成条目后，键为正斜杠路径，local 覆盖生效。正式实现必须核对客户端路径规范化规则，不能仅比较字符串。

## 严格完成验收

`toml-compatibility.mjs` 将 4 个合法 TOML 子集结构和 2 个重复键/表错误与 Codex 0.159.2 的只读列表逐项核对，6/6 通过。`record-strict-delivery.mjs` 在 JUnit 和上述真实结果均通过后生成 `strict-delivery-results.json`，并输出不启动服务的 `strict-example-report.html`。完整逐条记录见 [严格完成验收](../../docs/配置诊断严格完成验收-2026-10-02.md)。
