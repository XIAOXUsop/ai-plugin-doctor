# AI Plugin Doctor

Windows 本机 AI 工具诊断 CLI。现支持跨客户端 MCP 配置扫描、故障解释、受控连接检查及受限修复闭环；原有插件发行任务验收继续使用真实 Codex CLI／Claude Code，覆盖 E0–E3。

源码包的安装、文件摘要校验和重建步骤见 [源码交付指南](./DELIVERY.md)。包按明确清单生成，包含锁文件和必要源码，不带本机配置、认证、依赖目录或历史运行材料。

## 跨客户端配置诊断（2026-10-02）

无需模型密钥，扫描不启动 MCP 服务或凭据 helper：

```powershell
npm ci
npm run build
node dist/src/cli.js scan --workspace "D:\你的项目" --clients codex,claude,cursor,vscode --out runs/config-scan
node dist/src/cli.js diagnose runs/config-scan/scan.json
```

打开 `runs/config-scan/report.html` 查看中文发现、来源和证据等级。需要原生检查或修复时，从报告中选择服务/发现编号。完整命令、恢复步骤与支持矩阵见 [配置诊断使用指南](./docs/配置诊断使用指南.md)，本轮实现与验收见 [配置诊断实施记录](./docs/配置诊断实施记录-2026-10-02.md)。

Codex CLI 和 Claude Code 已完成合成配置的原生入口实测；Cursor/VS Code 支持本地文件诊断，原生会话保留人工取证。JSON/JSONC 可修复明确变量语法、执行路径、工作目录和根键；Codex TOML、权限、信任、托管策略和 OAuth 提供人工动作。旧 `preflight/run` 的模型费用与隔离环境规则只适用于发行任务验收。

项目依据见 [可行性与实施方案](./docs/AI插件跨客户端体检室-可行性与实施方案-2026-09-27.md)。

## 快速开始（Windows / Node.js 24）

导入已有 MCP 配置时，先用 `init "D:\项目\.mcp.json" --list` 只读查看候选，再用 `init "D:\项目\.mcp.json" "D:\验收\doctor.yaml" --server tools --cwd "D:\项目"` 明确选择。多份配置需指定文件，多个 package 入口用 `--entry`；已有变量引用保留，内联环境值不复制。JSONC/TOML、工作目录与参数规则见 [服务导入与路径选择指南](./docs/服务导入与路径选择指南.md)。

```powershell
npm ci
npm run build
node dist/src/cli.js init doctor-local.yaml --proxy-url http://127.0.0.1:33210 --codex-model gpt-6-sol --claude-model 'deepseek-v4-pro[1m]'
node dist/src/cli.js preflight doctor-local.yaml
node dist/src/cli.js run doctor-local.yaml --client codex --out runs/codex-smoke
node dist/src/cli.js run doctor-local.yaml --client claude --out runs/claude-smoke
```

默认配置使用无外部副作用的虚构发行记录服务。`doctor.yaml` 采用 JSON 语法（YAML 1.2 子集），修改 `server.command`／`server.args` 可测试其他 stdio MCP 服务。**真实插件可能有外部副作用；先使用测试账号和测试数据。** 不要把密钥直接写入配置。

样例包含直接查询、间接意图、无关负例、模拟删除保护及工具报错 5 个场景。`doctor.yaml` 默认每项 1 次，供低成本冒烟检查；`doctor-stability.yaml` 每项 3 次，用于本机稳定性验收。

`approvedTools` 是显式的客户端调用许可名单。样例只许可无副作用的 `lookup_release`，模拟删除工具不在名单中。测试真实服务时，请只加入你已确认可以在测试账号执行的工具。

本机示例的代理端口为 `33210`；`init --proxy-url` 将该地址写入新配置，运行器只传给 Codex／Claude 子进程，不修改系统代理。无需代理时省略此选项；迁移到另一台机器时使用实际端口。

`run` 产出 `report.html`、`report.json` 和每次用例的客户端日志、MCP 代理日志及 `events.jsonl`。报告状态为 `PASS`、`FAIL`、`UNKNOWN`、`SKIP`；E0/E1 不会替代 E2/E3。使用 `node dist/src/cli.js compare before/report.json after/report.json` 查看两次结果。升级后缺失原本通过的用例也会判为退化。`report` 重新生成 HTML 前会核对每次运行的证据文件哈希。

新运行在 `report.json` 的 `runEvidenceHashes` 中保存 `static.json`、`probe.json`、`config.snapshot.json` 的 SHA-256，并在 HTML 展示。`report` 重生成前同时核验这些顶层证据与逐次日志；修改、丢失或摘要缺失时停止，保留已有报告。没有顶层摘要的历史报告仍可直接查看和比较，但须重新运行才能生成具备完整核验的新报告。摘要用于检测变化，不是数字签名；人工模板允许编辑。

Windows 的任务运行器、版本读取、SDK 探针和透明代理使用构建生成的进程树保护组件，超时、取消、认证失败和父进程退出时清理普通后代。缺少组件时需先重新构建。SDK 探针分别限制握手、工具发现和受控调用为 12、8、12 秒；任务日志累计输出上限 64 MiB，超限或写入失败会停止运行并记录原因。

发行任务 HTML 现有跨客户端与用例总览，可筛选客户端、用例、状态、失败层，并搜索工具名、错误码和原因。点击“定位证据”展开对应运行。总览只汇总 E0–E3，UNKNOWN/SKIP 保持原状态；E4 人工验收单独展示。统计和矩阵保持完整报告口径，筛选只影响运行列表。HTML 单文件可本地打开，无需注册或联网；配置诊断 HTML 仍为静态报告。

每次运行还会生成 `manual-review.md`，用于 VS Code、ChatGPT 或完整插件 UI 的 E4 人工验收；填写它不会自动把 CLI 的失败改为通过。`compare` 发现原本通过的 E2／E3 退化时返回退出码 2。

Claude 的 `--bare` 模式需要 `ANTHROPIC_API_KEY`。Codex 使用当前 `CODEX_HOME` 的认证状态，同时忽略用户配置并禁用账号应用连接器、远程插件和钩子；可以用 `DOCTOR_CODEX_EXE` 指定可执行文件路径。`init --codex-model` 和 `--claude-model` 用于固定模型。一次模型运行会产生费用，样例配置将 Claude 的单次预算限制为 0.15 美元；客户端未提供实际费用时报告写“未知”。

`run` 可用 `--case direct` 只跑一个用例；E0 明确失败或 E1–E3 未通过时返回退出码 2。已有内容的 `--out` 目录会被拒绝，以保留上次证据。`server.env` 只能写 `${VARIABLE}` 引用，实际值从当前进程环境取得，不会写入配置快照。

## 当前边界

- 只支持本地 stdio MCP 工具；不支持 HTTP、OAuth、MCP Apps UI 和 ChatGPT／VS Code 自动验收。
- `preflight` 检查协议和凭据是否存在；加 `--live-auth` 时发起小额真实模型请求，只有明确收到预期的 `OK` 响应才报告凭据已验证。
- 报告会保留任务文本、工具名和经过键名脱敏的参数；测试真实插件时使用测试账号和测试数据。代理日志是本地文件，不会自动上传。
- MCPJam Cloud 托管模型同题 eval 已完成，但其模型、宿主和权限条件与本机不同。用户已将访谈和试用反馈移出本次验收范围；产品价值未经过目标用户验证。

## 本机实施验证（2026-09-28）

- `npm run build` 与 `npm test` 通过，当前共 21 项测试；SDK 直连发现两个 fixture 工具，透明代理的真实 MCP 调用集成测试通过。干净目录复现时为 16 项测试，后续精细打磨新增 5 项。
- Codex CLI `0.158.0-alpha.2.1` 与 Claude Code `2.1.89` 均实际完成 MCP 握手和 `tools/list`，因此各自 E2 为 PASS。
- Claude `runs/final-claude-gate/` 15/15 E0–E3 通过。Codex 曾有一次转向账号连接的 Drive/Gmail；增加显式隔离开关后，`runs/final-codex-isolated-gate/` 15/15 通过，历史失败保留。
- 已实测 MCPJam 本地 CLI 和 Cloud 同 fixture、官方 Memory 服务升级前后及双端 schema 退化。Cloud 托管评测为 12/15 trial 通过，其中三次预期工具错误被评为响应失败。干净目录的双端运行证据见 `research/clean-install-evidence/`。详见 [实施状态](./IMPLEMENTATION_STATUS.md)。

本轮代码审查与后续打磨顺序见 [项目打磨记录](./POLISH_AUDIT.md)。

`runs/` 是本机运行证据目录，默认不纳入 Git；仓库保留一份干净目录冒烟证据在 `research/clean-install-evidence/`。README 中的历史 `runs/` 路径指本机验收记录，克隆仓库后需自行重跑生成。

## 当前环境的连接排查

`preflight` 只输出是否使用自定义 Claude 端点／模型，不显示 URL 或密钥。旧配置曾使 Claude 模型请求返回 401；用户修正后已完成任务级验收。若后续再次出现 401，请核对第三方网关的端点、凭据、认证头和模型权限。无需申请 Claude 官方 API key，也不要把第三方密钥发到聊天或提交到仓库。

Codex 已通过 `proxyUrl` 使用用户提供的本机代理。若网络环境变化，可运行 `curl.exe -I --max-time 8 https://api.openai.com/v1/models`；收到 HTTP 响应（即便是 401）表示网络可达，连接超时则检查本机代理是否启动或端口是否改变。

## 跨客户端配置诊断严格验收（2026-10-02）

约定的 Windows 本地首版 P0–P4 已补齐。128/128 回归和独立安装测试通过；24 个场景分别配对正确对照，另保留 12 个健康/有意差异对照。双 CLI 两组故障样例 9/9、TOML 子集兼容 6/6。字段来源、版本/入口降级、持久服务映射、网络分层、脱敏修复预览和 Windows 进程收尾均有对应验收。

查看 [严格完成验收](./docs/配置诊断严格完成验收-2026-10-02.md) 和 [使用指南](./docs/配置诊断使用指南.md)。主动检查仅覆盖已明确选择的能力；已有 IDE/桌面会话、HTTP/OAuth 和模型任务按计划保留原生人工步骤或后续范围。Windows CI 定义已交付，本轮未远端运行。
