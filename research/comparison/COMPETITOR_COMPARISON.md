# MCPJam 同 fixture 实测 · 2026-09-28

## 条件

- 本产品：本机 Codex CLI `0.158.0-alpha.2.1`，模型 `gpt-6-sol`；Claude Code `2.1.89`，第三方端点模型 `deepseek-flash[1m]`。各五类任务三次，最终证据为 `../../runs/final-codex-isolated-gate/report.json` 和 `../../runs/final-claude-gate/report.json`。两端配置/服务/工具表面/manifest 哈希一致。隔离修复前的 Codex 报告保存在 `../../runs/final-codex-gate/report.json`。
- MCPJam CLI `5.11.3`：同一虚构发行记录 stdio fixture 由临时 Cloud tunnel 提供。项目 `Default`、专用客户端 `Doctor Fixture Eval`，托管执行模型 `anthropic/claude-haiku-4.5`，五类任务各三次。运行 ID `mh739qvz1wcrq0qwpsathy9qr58f772k`。证据：`mcpjam-cloud-5x3-report.json`、`mcpjam-cloud-iterations.json`，直接查询与错误用例的原始 trace。关闭额外自动裁判后运行。tunnel 已停止。
- 本地 MCPJam 的 `server doctor`、`tools call`、`compat --offline` 产物分别是 `mcpjam-doctor.json`、`mcpjam-tool-call.json`、`mcpjam-compat.json`。`compat` 的 `works` 来自协议探针，不能代表本机真实客户端完成模型任务。
- Cloud 和本机运行并非同模型同宿主。Cloud fixture 没有本机运行时注入的随机 `DOCTOR_RUN_ID`，默认返回 `manual`；Cloud 套件也不能使用文件中的 `toolPolicy`，托管运行开放了模拟删除工具。`delete_release` 仅写测试日志，无外部破坏。以上差异限制了结果的横向成功率比较。

| 维度 | 本产品本机结果 | MCPJam 同题结果 |
|---|---|---|
| 真实模型任务 | Claude 15/15；隔离修复后 Codex 15/15。修复前 Codex 14/15，曾有一次间接意图发现目标服务后改用账号连接的 Drive/Gmail，判为工具选择失败；历史失败报告保留。 | 托管 MCPJam 客户端 12/15 trial 通过；直接、间接、无关负例、禁止删除四类各 3/3。不是本机 Codex/Claude CLI。 |
| 预期工具错误 | 本产品把 `lookup_release(ERROR)` 的工具错误和模型正确说明视为任务通过，并保留工具 `isError` 证据。 | 同一用例三次都调用正确工具、参数为 `ERROR`，模型最终说明 `Fixture error`；MCPJam 把工具响应 `isError:true` 归为 `response/serverData` 失败。两者的评分目标不同，不能把它写成 MCPJam 漏调用。 |
| 发现和调用证据 | 本机客户端 JSONL、透明代理 JSONL、fixture 日志按 run ID 关联，并记录文件哈希。 | 本地 doctor 发现两个工具；Cloud trace 包含模型消息、工具参数、响应及阶段链，覆盖完整调用证据。 |
| 故障定位 | E0–E4 层级、错误码、针对已知失败的修复建议与复现命令；仍不能保证覆盖所有故障类型。 | Cloud 报告明确给出 connection/discovery/selection/call/response/userValue 链，且对错误用例指出 response 阶段；故不能把“有故障层级”作为独有差异。 |
| 客户端安装态 | 启动本机 Codex/Claude 并记录 CLI 版本、模型、协议；Codex 隔离修复后本轮未再调用账号连接器，自带 MCP 资源列表工具仍可出现。 | Cloud eval 使用托管 `mcpjam` hostStyle 和 `emulated` engine；本地 compat 未启动本机 CLI。 |
| 权限和重现 | 本机明确许可 `lookup_release`，不许可模拟删除；有配置/服务/表面哈希和证据文件。 | 套件文件的 `toolPolicy` 在托管运行被 `TOOL_POLICY_UNSUPPORTED` 拒绝；改用断言 `delete_release` 未调用。Cloud 保存了 suite、逐次结果和 trace。 |

## 过程限制

MCPJam 的版本化 suite 文件已通过离线与项目校验，但 Cloud run 因 `toolPolicy` 不受支持和 Environment 绑定要求被拒。免费组织创建 Environment 返回 `FORBIDDEN`。随后改用 CLI 的可编辑 suite API、附加专用客户端与 tunnel 服务，完成了五题三次的真实托管 eval。CI 管理的 suite 和可编辑 suite 是两份 Cloud 记录；本地分别保留 `mcpjam-suite.json` 与 `mcpjam-api-suite.json`。本次不使用免费组织无法创建的 Environment，不把托管结果说成本机宿主结果。

## 判断

门槛 A 的**竞品同题实测部分已完成**。MCPJam 已有重复真实模型运行、负例断言、原始 trace 和阶段归因，产品不能以这些能力作为独占卖点。本机已安装客户端的发布验收、环境差异和证据留存是待验证的产品方向；Codex 账号连接器曾造成真实失败，隔离修复后本轮 15/15 通过。用户于 2026-09-28 移除了访谈和试用反馈要求，因此不再以这些材料作为本次验收门槛。产品差异与节省诊断时间仍未经目标用户验证。

来源：[MCPJam 仓库](https://github.com/MCPJam/inspector)、[MCPJam CLI 包](https://www.npmjs.com/package/@mcpjam/cli)。
