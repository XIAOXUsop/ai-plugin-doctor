# 官方 Memory MCP 服务升级试验 · 2026-09-28

## 范围与证据

- 对象：`@modelcontextprotocol/server-memory` npm 包，从 `2026.7.4` 升至 `2026.8.31`。版本以各安装目录的 `package-lock.json` 为准；服务内报的版本均为 `memory-server 0.6.3`，不能用它区分包版本。
- 数据：`../real-server/fixture-memory.jsonl` 中的虚构实体；仅允许只读 `search_nodes`，由 `DOCTOR_MEMORY_FILE_PATH` 指向测试文件。
- 最终固定条件复测：Claude 旧版 `../../runs/memory-claude-old-pinned/report.json`、新版 `../../runs/memory-claude-new-pinned/report.json`，均使用 `deepseek-v4-pro[1m]`；Codex 旧版 `../../runs/memory-codex-old-isolated/report.json`、新版 `../../runs/memory-codex-new-isolated/report.json`，均使用 `gpt-6-sol` 及相同隔离参数。四组各有四条真实客户端任务，E2/E3 均通过。比较输出为 `claude-compare-pinned.txt` 与 `codex-compare-isolated.txt`，四题在两端均为 PASS→PASS。
- 升级后按时间顺序复跑：`../../runs/memory-claude-upgrade-after/report.json`、`../../runs/memory-codex-upgrade-after/report.json`。Codex 全部通过；Claude 间接问题有一次被旧的精确参数断言判为失败，原始回答和 `tools/call` 实际正确，查询参数为 `Orion release owner` 而非固定字符串 `Project Orion`。
- 将该用例改为断言 `query` 包含 `Orion`，并加单元测试；旧版和新版在两端各复跑一次，见 `../../runs/memory-claude-old-indirect-v2/`、`../../runs/memory-claude-new-indirect-v2/`、`../../runs/memory-codex-old-indirect-v2/`、`../../runs/memory-codex-new-indirect-v2/`，四次均通过。

## 结论

在固定客户端、模型和隔离条件下，真实服务升级前后均能被两端发现并完成这些只读任务，工具表面哈希相同；服务包版本和服务文件哈希发生变化。早期那次 Claude 报告失败是断言过窄造成的误报，不能归因于服务升级；历史报告保留。用户于 2026-09-28 移除了试用者反馈要求。本试验仅验证这些任务的技术兼容性，不能证明实际用户的诊断效率。
