# AI Plugin Doctor 实施与验收状态 · 2026-09-28

2026-10-02 增加跨客户端配置诊断首版。新工作流已完成约定首版的严格本地验收（128/128 回归、干净安装 128/128、双 CLI 两组样例 9/9），详见 [严格完成验收](./docs/配置诊断严格完成验收-2026-10-02.md)。历史实施结果见 [配置诊断实施记录](./docs/配置诊断实施记录-2026-10-02.md)，使用见 [配置诊断使用指南](./docs/配置诊断使用指南.md)。本文以下保留原发行验收的历史结果。

## 本次范围

按原《可行性与实施方案》实现 Windows 本机、Codex CLI 和 Claude Code、stdio MCP 工具的发行验收 CLI。用户于 2026-09-28 明确移除“三位真实用户访谈”和“至少两位试用者反馈”两项要求；以下不把它们计为待完成门槛，也不把用户价值说成已验证。HTTP/OAuth、MCP Apps UI、Skills 自动验收和其他客户端自动化仍按原方案属于延后范围。E4 完整插件体验按原方案保留人工检查表，未签署时为 SKIP。

## 实现

- `init` 从插件目录或 MCP 配置生成安全的可编辑配置；支持明确设置本机代理、Codex/Claude 模型，并将内联环境值改为 `${VARIABLE}` 引用。
- `preflight` 检查运行时、真实客户端版本、凭据存在性、SDK 握手/列工具/受控调用；`--live-auth` 可验证 Claude 模型响应。
- `run` 在逐用例独立目录中启动真实 Codex/Claude。Codex 禁用账号应用连接器、远程插件、钩子及非必要内置能力；Claude 使用 `--bare` 和严格 MCP 配置。客户端事件、MCP 代理、fixture 服务端日志和统一事件文件分别保留。已有内容的输出目录不覆盖。
- `report` 输出 HTML/JSON、E0–E4 分层结论、客户端/模型/服务版本、模型费用（客户端未给出时为未知）、配置/服务/工具表面/证据 SHA-256、错误码、修复建议和复现命令。敏感键、Bearer 与 URL 访问参数脱敏。
- `compare` 对相同用例的前后 E2/E3 退化返回退出码 2，并标记客户端/模型版本变化与工具表面变化。

## 验收证据

| 原方案要求 | 结果 |
|---|---|
| 构建与测试 | `npm run build` 与 `npm test` 通过，当前 21 项测试；干净目录复现时为 16 项。 |
| 双端受控 fixture，五类任务各三次 | Claude `runs/final-claude-gate/report.json` 15/15 E0–E3 PASS。Codex 先前 `runs/final-codex-gate/` 14/15，间接用例一次转向账号连接器；加入显式隔离开关后 `runs/final-codex-isolated-gate/report.json` 15/15 PASS，未再调用账号连接器。Codex 自带 MCP 资源列表工具仍可能出现，不能称为仅有目标工具。 |
| 真实服务升级前后 | 官方 Memory 服务包 `2026.7.4` → `2026.8.31`，固定相同客户端与模型，各端旧/新版四题均 4/4 PASS；`research/memory-upgrade/claude-compare-pinned.txt` 和 `codex-compare-isolated.txt` 均无退化，工具表面哈希相同。详见 `research/memory-upgrade/UPGRADE_TRIAL.md`。 |
| schema/描述变更回归 | fixture 的 `lookup_release` 参数从 `releaseId` 改为 `releaseCode`，两端由 PASS 转 FAIL；`research/regression/` 中的比较均返回退出码 2，前后原始报告保留。 |
| 错误与启动失败分类 | `runs/startup-failure-final-contract/` 将不存在的入口判为 E1 FAIL / SERVER_STARTUP，E2/E3 SKIP，退出码 2，并给出修复方向。工具返回错误、无关负例、禁止删除均有真实任务报告。 |
| MCPJam 同题实测 | 本地探针和 Cloud 托管模型五类任务各三次完成；Cloud 12/15 trial 通过，三次预期工具错误被评为响应阶段失败，真实调用与最终回答存在。Cloud 模型/宿主/权限与本机不同。详见 `research/comparison/COMPETITOR_COMPARISON.md`。 |
| Windows 干净目录复现 | 独立副本执行 `npm ci`、构建、16 项测试、`init --proxy-url --codex-model --claude-model`、`preflight`，并在两端各执行一条真实任务，均 E0–E3 PASS。报告保存在 `research/clean-install-evidence/`。 |
| 统一数据契约与证据 | 干净目录双端报告均包含 `events.jsonl` 的 client_init、server_discovered、tool_selected、tool_called、tool_result、final_answer，插件与服务版本、模型标识及哈希。Claude 记录实际 USD 费用；Codex 无费用字段，记为未知。 |

## 结论与边界

用户移除的访谈和试用反馈之外，原方案首版技术交付与验收清单已完成。E4 属人工验收范围，当前为 SKIP；本工具不宣称覆盖完整 UI 或其他客户端。报告只证明指定本机版本、模型、插件和任务的运行结果，不外推为通用成功率。历史失败和断言误报仍保留，便于复核修复前后的差别。竞品已有重复评测、负例和阶段归因；本项目的本机安装态价值仍是未经过目标用户验证的产品假设。

## 精细打磨第一轮

已修复 `init` 显式源路径不存在时误生成样例、`preflight --live-auth` 将任意非空回答标为验证通过、`compare` 漏报升级后缺失的用例、无工具负例漏看客户端内置工具调用，以及 `report` 重生 HTML 前不核验逐次证据哈希。新增对应测试，当前 21/21 通过。最终双端验收报告未修改；六条历史负例客户端轨迹均未出现工具选择事件。后续待处理项见 [项目打磨记录](./POLISH_AUDIT.md)。
