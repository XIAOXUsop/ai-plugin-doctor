# Windows 干净目录复现证据 · 2026-09-28

在工作区内建立独立副本，运行 `npm ci`、`npm run build`、`npm test`（16/16），随后用 `init` 生成配置、执行 `preflight`，再让本机 Codex 和 Claude 各运行一条直接查询任务。两个报告的 E0–E3 均为 PASS，并保留逐次客户端事件、服务端调用、统一 `events.jsonl`、版本和哈希。

`codex-clean/` 与 `claude-clean/` 是从该独立副本复制出的原始证据。`doctor-local.yaml` 是当时生成的配置快照，其绝对路径指向已清理的临时副本，**不能直接拿来重跑**；复现时按项目根目录 [README](../../README.md) 的命令在新目录重新执行 `init`，填写当前机器的服务路径与模型。
