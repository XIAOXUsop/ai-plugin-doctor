import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hash, resolveServer, serverHash } from "./config.js";
import { normalizeEvents } from "./events.js";
import { redact } from "./redact.js";
import { findClaudeJs, findExecutable, runProcess, version } from "./process.js";
import { probe } from "./probe.js";
import { writeReport } from "./report.js";
import type { CaseConfig, ClientName, DoctorConfig, LayerResult, RunReport, ServerConfig, TrialResult, Verdict } from "./types.js";

const layer = (verdict: Verdict, reason: string, ...evidence: string[]): LayerResult => ({ verdict, reason, evidence });
const readLines = (path: string): Record<string, unknown>[] => {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } });
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const idKey = (value: unknown): string => JSON.stringify(value);

interface WireSummary {
  discovered: boolean;
  protocolVersion: string | null;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  toolErrors: boolean[];
}
export function summarizeWire(events: Record<string, unknown>[]): WireSummary {
  const requests = new Map<string, Record<string, unknown>>();
  let discovered = false;
  let protocolVersion: string | null = null;
  const calls: WireSummary["calls"] = [];
  const toolErrors: boolean[] = [];
  for (const event of events) {
    const message = object(event.message);
    if (event.direction === "client_to_server" && "id" in message) requests.set(idKey(message.id), message);
    if (event.direction !== "server_to_client") continue;
    const request = requests.get(idKey(message.id));
    if (!request) continue;
    const result = object(message.result);
    if (request.method === "initialize" || request.method === "server/discover") {
      if (typeof result.protocolVersion === "string") protocolVersion = result.protocolVersion;
    }
    if (request.method === "tools/list" && Array.isArray(result.tools)) discovered = true;
    if (request.method === "tools/call") {
      const params = object(request.params);
      calls.push({ name: String(params.name ?? ""), arguments: object(params.arguments) });
      toolErrors.push(result.isError === true || Boolean(message.error));
    }
    requests.delete(idKey(message.id));
  }
  return { discovered, protocolVersion, calls, toolErrors };
}
function finalAnswer(events: Record<string, unknown>[]): string {
  for (const event of [...events].reverse()) {
    if (event.type === "result" && typeof event.result === "string") return event.result;
    const item = object(event.item);
    if (item.type === "agent_message" && typeof item.text === "string") return item.text;
    if (event.type === "assistant") {
      const message = object(event.message);
      const content = message.content;
      if (Array.isArray(content)) {
        const texts = content.map(x => object(x)).filter(x => x.type === "text" && typeof x.text === "string").map(x => String(x.text));
        if (texts.length) return texts.join("\n");
      }
    }
  }
  return "";
}
function modelId(events: Record<string, unknown>[]): string | null {
  for (const event of events) {
    if (event.type === "system" && event.subtype === "init" && typeof event.model === "string") return event.model;
    if (event.type === "thread.started" && typeof event.model === "string") return event.model;
  }
  return null;
}
export function modelCostUsd(events: Record<string, unknown>[]): number | null {
  const result = [...events].reverse().find(event => event.type === "result" && typeof event.total_cost_usd === "number");
  return result && typeof result.total_cost_usd === "number" && Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null;
}
function selectedClientTools(events: Record<string, unknown>[]): string[] {
  const selected: string[] = [];
  for (const event of events) {
    const item = object(event.item);
    if (event.type === "item.started" && item.type === "mcp_tool_call" && typeof item.tool === "string") selected.push(item.tool);
    if (event.type === "assistant") {
      const content = object(event.message).content;
      if (Array.isArray(content)) for (const part of content) {
        const tool = object(part);
        if (tool.type === "tool_use" && typeof tool.name === "string") selected.push(tool.name);
      }
    }
  }
  return selected;
}
function errorCode(e0: LayerResult, e1: LayerResult, e2: LayerResult, e3: LayerResult): string | null {
  if (e0.verdict === "FAIL") return "MANIFEST_INVALID";
  if (e1.verdict === "FAIL") {
    if (/ENOENT|not found|cannot find|failed to spawn|spawn/i.test(e1.reason)) return "SERVER_STARTUP";
    if (e1.reason.includes("Controlled probe tool")) return "PROBE_TOOL_MISSING";
    if (e1.reason.includes("返回错误")) return "PROBE_TOOL_RESULT";
    return "MCP_HANDSHAKE";
  }
  if (e1.verdict === "UNKNOWN") return "PROBE_CALL_NOT_CONFIGURED";
  if (e2.verdict !== "PASS") return "CLIENT_DISCOVERY";
  if (e3.verdict === "PASS") return null;
  if (e3.reason.includes("认证失败")) return "MODEL_AUTH";
  if (e3.reason.includes("连接超时") || e3.reason.includes("运行超时")) return "TIMEOUT";
  if (e3.reason.includes("参数")) return "TOOL_ARGUMENTS";
  if (e3.reason.includes("工具错误状态")) return "TOOL_RESULT";
  if (e3.reason.includes("最终回答")) return "FINAL_ANSWER";
  if (e3.reason.includes("未调用预期工具") || e3.reason.includes("不应调用工具") || e3.reason.includes("禁止的工具")) return "TOOL_SELECTION";
  return "TASK_UNKNOWN";
}
export function fixHint(code: string | null): string | null {
  switch (code) {
    case "MANIFEST_INVALID": return "检查 manifestPath、JSON 结构、name/version 与入口文件；修复后重跑 preflight。";
    case "SERVER_STARTUP": return "在配置的 cwd 中单独运行 server.command 和 args，检查路径与启动日志。";
    case "MCP_HANDSHAKE": return "先运行 doctor preflight，检查 probe.json 中的握手错误及服务端 stderr。";
    case "PROBE_TOOL_MISSING": return "核对 probeCall.tool 与服务 tools/list 暴露的名称。";
    case "PROBE_TOOL_RESULT": return "检查受控调用参数及 probe.json 的工具错误结果。";
    case "PROBE_CALL_NOT_CONFIGURED": return "为安全、只读工具配置 probeCall，取得 E1 的真实 tools/call 证据。";
    case "CLIENT_DISCOVERY": return "核对客户端版本、启动参数及 wire.jsonl 中的 initialize/tools/list；同时查看 stderr。";
    case "MODEL_AUTH": return "核对模型端点、凭据和模型权限，再用 preflight --live-auth 验证。";
    case "TIMEOUT": return "检查本机代理、模型端点和客户端重试日志；必要时提高 timeoutMs。";
    case "TOOL_SELECTION": return "检查工具描述、任务提示和客户端可见的其他工具；按复现命令重跑并比对客户端轨迹。";
    case "TOOL_ARGUMENTS": return "核对工具 inputSchema 的参数名与类型，再检查客户端实际传参。";
    case "TOOL_RESULT": return "检查 wire.jsonl 的 tools/call 响应及服务端日志中的 isError。";
    case "FINAL_ANSWER": return "对照工具返回值和最终回答，确认关键字段来自本次调用。";
    case "TASK_UNKNOWN": return "先查看客户端 stdout/stderr 与 wire.jsonl，确认失败发生在模型回合的哪一步。";
    default: return null;
  }
}
export function evaluateCase(test: CaseConfig, wire: WireSummary, answer: string, fixtureEvents: Record<string, unknown>[], isFixture: boolean, exitCode: number | null, timedOut: boolean, abortReason?: string, clientEvents: Record<string, unknown>[] = []): LayerResult {
  if (abortReason) return layer("FAIL", abortReason, "client.stdout.jsonl");
  if (timedOut) return layer("FAIL", "客户端运行超时；检查客户端模型连接和重试事件", "client.stdout.jsonl", "client.stderr.log");
  if (exitCode !== 0) return layer("FAIL", `客户端退出码 ${exitCode ?? "无"}`, "client.stderr.log");
  if (!wire.discovered) return layer("UNKNOWN", "未取得工具发现证据", "wire.jsonl");
  const clientTools = selectedClientTools(clientEvents);
  const forbiddenClientTool = clientTools.find(name => test.expect.forbiddenTools?.includes(name));
  if (forbiddenClientTool) return layer("FAIL", `客户端选择了禁止的工具 ${forbiddenClientTool}`, "client.stdout.jsonl");
  const forbidden = wire.calls.find(call => test.expect.forbiddenTools?.includes(call.name));
  if (forbidden) return layer("FAIL", `调用了禁止的工具 ${forbidden.name}`, "wire.jsonl");
  if (test.expect.noToolCalls) {
    if (clientTools.length) return layer("FAIL", `不应调用工具，但客户端选择了 ${clientTools.join(", ")}`, "client.stdout.jsonl");
    if (wire.calls.length) return layer("FAIL", `不应调用工具，但调用了 ${wire.calls.map(x => x.name).join(", ")}`, "wire.jsonl");
    if (!answer) return layer("UNKNOWN", "未取得最终回答，无法确认任务完成", "client.stdout.jsonl");
    return layer("PASS", "真实客户端未发出 tools/call，且有最终回答", "wire.jsonl", "client.stdout.jsonl");
  }
  if (!test.expect.tool) {
    if (!answer) return layer("UNKNOWN", "未取得最终回答，无法确认任务完成", "client.stdout.jsonl");
    if (isFixture && wire.calls.some(call => !fixtureEvents.some(event => event.type === "tool_called" && event.name === call.name))) return layer("UNKNOWN", "代理见到调用，但 fixture 服务端日志未证实", "wire.jsonl", "fixture.jsonl");
    return layer("PASS", "未调用禁止工具，且有最终回答", "wire.jsonl", "client.stdout.jsonl");
  }
  const expected = test.expect.tool!;
  const match = wire.calls.find(x => x.name === expected);
  if (!match) return layer("FAIL", `未调用预期工具 ${expected}；实际 ${wire.calls.map(x => x.name).join(", ") || "无"}`, "wire.jsonl");
  if (wire.calls.some(x => x.name === "delete_release") && expected !== "delete_release") return layer("FAIL", "发生未预期的模拟删除调用", "wire.jsonl");
  for (const [key, value] of Object.entries(test.expect.arguments ?? {})) {
    if (JSON.stringify(match.arguments[key]) !== JSON.stringify(value)) return layer("FAIL", `参数 ${key} 不匹配`, "wire.jsonl");
  }
  for (const [key, value] of Object.entries(test.expect.argumentsContains ?? {})) {
    const actual = match.arguments[key];
    if (typeof actual !== "string" || !actual.includes(value)) return layer("FAIL", `参数 ${key} 未包含 ${value}`, "wire.jsonl");
  }
  if (isFixture) {
    const serverCalls = fixtureEvents.filter(x => x.type === "tool_called");
    if (!serverCalls.some(x => x.name === expected)) return layer("UNKNOWN", "代理见到调用，但 fixture 服务端日志未证实", "wire.jsonl", "fixture.jsonl");
  }
  const callIndex = wire.calls.indexOf(match);
  if (test.expect.toolError !== undefined && wire.toolErrors[callIndex] !== test.expect.toolError) return layer("FAIL", "工具错误状态与预期不符", "wire.jsonl");
  if (!answer) return layer("UNKNOWN", "工具已调用，但没有最终回答证据", "client.stdout.jsonl");
  if (test.expect.finalContains && !answer.includes(test.expect.finalContains)) return layer("FAIL", `最终回答未包含 ${test.expect.finalContains}`, "client.stdout.jsonl");
  if (isFixture && expected === "lookup_release" && !wire.toolErrors[callIndex]) {
    const receipt = fixtureEvents.find(event => event.type === "tool_called" && event.name === expected);
    if (typeof receipt?.runId !== "string" || !answer.includes(receipt.runId)) return layer("FAIL", "最终回答未包含本次工具结果中的 run_id", "fixture.jsonl", "client.stdout.jsonl");
  }
  return layer("PASS", "真实客户端工具调用、参数和任务断言通过", "wire.jsonl", "client.stdout.jsonl", ...(isFixture ? ["fixture.jsonl"] : []));
}
function clientCommand(client: ClientName, proxyPath: string, specPath: string, trialDir: string, prompt: string, config: DoctorConfig): { command: string; args: string[]; env: NodeJS.ProcessEnv; version: string } | null {
  const clientEnv: NodeJS.ProcessEnv = { ...process.env, ...(config.proxyUrl ? { HTTPS_PROXY: config.proxyUrl, HTTP_PROXY: config.proxyUrl } : {}) };
  if (client === "codex") {
    const command = process.env.DOCTOR_CODEX_EXE ?? findExecutable("codex");
    if (!command) return null;
    const mcpArgs = [proxyPath, specPath];
    const approvals = (config.approvedTools ?? []).flatMap(tool => ["-c", `mcp_servers.doctor.tools.${tool}.approval_mode="approve"`]);
    const forwardedEnv = Object.values(config.server.env ?? {}).map(reference => reference.slice(2, -1));
    return {
      command,
      args: ["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--disable", "apps", "--disable", "remote_plugin", "--disable", "hooks", "--disable", "multi_agent", "--disable", "shell_tool", "--skip-git-repo-check", "--sandbox", "read-only", "-C", trialDir,
        ...(config.codexModel ? ["--model", config.codexModel] : []),
        "-c", `mcp_servers.doctor.command=${JSON.stringify(process.execPath)}`,
        "-c", `mcp_servers.doctor.args=${JSON.stringify(mcpArgs)}`,
        "-c", `mcp_servers.doctor.env_vars=${JSON.stringify(forwardedEnv)}`,
        "-c", "mcp_servers.doctor.required=true",
        "-c", "mcp_servers.doctor.startup_timeout_sec=30",
        "-c", `mcp_servers.doctor.enabled_tools=${JSON.stringify(config.approvedTools ?? [])}`,
        ...approvals,
        prompt],
      env: { ...clientEnv, CODEX_HOME: process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? "", ".codex"), HOME: process.env.HOME ?? process.env.USERPROFILE },
      version: version(command, ["--version"]),
    };
  }
  const script = findClaudeJs();
  if (!script) return null;
  const mcpPath = join(trialDir, "claude-mcp.json");
  writeFileSync(mcpPath, JSON.stringify({ mcpServers: { doctor: { command: process.execPath, args: [proxyPath, specPath] } } }, null, 2));
  return {
    command: process.execPath,
    args: [script, "-p", prompt, "--bare", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--strict-mcp-config", "--mcp-config", mcpPath,
      ...(config.claudeModel ? ["--model", config.claudeModel] : []),
      "--permission-mode", "dontAsk", "--tools", "", "--allowedTools", (config.approvedTools ?? []).map(tool => `mcp__doctor__${tool}`).join(","), "--max-budget-usd", String(config.maxClaudeBudgetUsd ?? 0.15)],
    env: clientEnv,
    version: version(process.execPath, [script, "--version"]),
  };
}
export async function runSuite(config: DoctorConfig, configPath: string, outDir: string, selectedClients?: ClientName[]): Promise<RunReport> {
  if (existsSync(outDir) && readdirSync(outDir).length) throw new Error(`Output directory is not empty: ${outDir}; choose a new --out to preserve previous evidence`);
  mkdirSync(outDir, { recursive: true });
  const server = resolveServer(config, configPath);
  const configHash = hash(readFileSync(configPath));
  const resolvedServerHash = serverHash(server);
  let manifestHash: string | null = null;
  let pluginVersion: string | null = null;
  let e0: LayerResult;
  if (!config.manifestPath) {
    e0 = layer("UNKNOWN", "未提供 manifestPath；仅验证了 doctor 配置结构", "config.snapshot.json");
  } else {
    const manifestPath = resolve(dirname(configPath), config.manifestPath);
    try {
      const raw = readFileSync(manifestPath, "utf8");
      const manifest = JSON.parse(raw) as Record<string, unknown>;
      const serverEntries = manifest.mcpServers ?? manifest.servers;
      const isMcpConfig = serverEntries !== undefined;
      if (isMcpConfig) {
        if (!serverEntries || typeof serverEntries !== "object" || Array.isArray(serverEntries) || !Object.keys(serverEntries).length) throw new Error("MCP config needs a nonempty server map");
        const validStdio = Object.values(serverEntries).some(value => {
          const entry = object(value);
          return typeof entry.command === "string" && Array.isArray(entry.args) && entry.args.every(arg => typeof arg === "string");
        });
        if (!validStdio) throw new Error("MCP config has no valid stdio server entry");
      }
      if (!isMcpConfig && (typeof manifest.name !== "string" || typeof manifest.version !== "string")) throw new Error("manifest needs name and version");
      if (typeof manifest.version === "string") pluginVersion = manifest.version;
      const entry = manifest.serverEntry ?? (typeof manifest.bin === "string" ? manifest.bin : manifest.bin && typeof manifest.bin === "object" ? Object.values(manifest.bin)[0] : manifest.main);
      if (typeof entry === "string" && !existsSync(resolve(dirname(manifestPath), entry))) throw new Error(`server entry not found: ${entry}`);
      manifestHash = hash(raw);
      e0 = layer("PASS", isMcpConfig ? "MCP 配置结构已读取" : "插件 manifest 与入口文件已读取", "static.json");
    } catch (error) {
      e0 = layer("FAIL", `静态 manifest 检查失败：${error instanceof Error ? error.message : String(error)}`, "static.json");
    }
  }
  writeFileSync(join(outDir, "static.json"), JSON.stringify({ verdict: e0.verdict, reason: e0.reason, manifestHash, pluginVersion }, null, 2));
  const probeResult = await probe(server, config.probeCall);
  writeFileSync(join(outDir, "probe.json"), JSON.stringify(probeResult, null, 2));
  writeFileSync(join(outDir, "config.snapshot.json"), JSON.stringify(redact(config), null, 2));
  const builtTemplate = fileURLToPath(new URL("../../templates/manual-review.md", import.meta.url));
  const sourceTemplate = fileURLToPath(new URL("../templates/manual-review.md", import.meta.url));
  const manualTemplate = existsSync(builtTemplate) ? builtTemplate : sourceTemplate;
  writeFileSync(join(outDir, "manual-review.md"), readFileSync(manualTemplate));
  const e1 = !probeResult.ok ? layer("FAIL", `SDK 协议探针失败：${probeResult.error}`, "probe.json")
    : !probeResult.call ? layer("UNKNOWN", "SDK 握手和工具发现通过，但未配置受控 tools/call", "probe.json")
    : probeResult.call.isError ? layer("FAIL", `受控工具 ${probeResult.call.tool} 返回错误`, "probe.json")
    : layer("PASS", `SDK 握手、发现 ${probeResult.tools.length} 个工具并调用 ${probeResult.call.tool}`, "probe.json");
  const report: RunReport = { schemaVersion: 1, createdAt: new Date().toISOString(), configHash, serverHash: resolvedServerHash, toolSurfaceHash: probeResult.toolSurfaceHash, manifestHash, pluginVersion, serverVersion: probeResult.serverVersion, protocolVersion: null, trials: [], notes: ["E4 为完整插件/UI 人工验收，CLI 运行不会自动判通过。", "报告只代表本次客户端、模型、环境和用例；不代表通用兼容性。", "模型费用仅在客户端输出明确提供时记录；未知不表示零费用。"] };
  const proxyPath = fileURLToPath(new URL("./stdio-proxy.js", import.meta.url));
  const isFixture = server.args.some(x => /release-server(?:-schema-v2)?\.js$/.test(x));
  for (const client of selectedClients ?? config.clients) {
    for (const test of config.cases) {
      for (let trial = 1; trial <= (test.trials ?? 1); trial++) {
        const runId = randomUUID();
        const id = `${client}-${test.id}-${trial}`;
        const trialDir = resolve(outDir, id);
        mkdirSync(trialDir, { recursive: true });
        const startedAt = new Date().toISOString();
        const files = { stdout: "client.stdout.jsonl", stderr: "client.stderr.log", wire: "wire.jsonl", fixture: "fixture.jsonl", events: "events.jsonl" };
        const specPath = join(trialDir, "proxy-spec.json");
        writeFileSync(specPath, JSON.stringify({ server, logPath: join(trialDir, files.wire), runId, fixtureLogPath: join(trialDir, files.fixture) }));
        const command = clientCommand(client, proxyPath, specPath, trialDir, test.prompt, config);
        let exitCode: number | null = null;
        let timedOut = false;
        let processError: string | undefined;
        let abortReason: string | undefined;
        if (probeResult.ok && command) {
          const result = await runProcess(command.command, command.args, { cwd: trialDir, env: command.env, stdoutPath: join(trialDir, files.stdout), stderrPath: join(trialDir, files.stderr), timeoutMs: config.timeoutMs ?? 120000 });
          exitCode = result.exitCode; timedOut = result.timedOut; processError = result.spawnError; abortReason = result.abortReason;
        }
        const wire = summarizeWire(readLines(join(trialDir, files.wire)));
        const clientEvents = readLines(join(trialDir, files.stdout));
        if (timedOut && clientEvents.some(event => typeof event.message === "string" && event.message.includes("request timed out"))) abortReason = "模型服务连接超时；客户端 MCP 工具发现已单独验证";
        const answer = finalAnswer(clientEvents);
        const fixtureEvents = readLines(join(trialDir, files.fixture));
        if (wire.protocolVersion) report.protocolVersion = wire.protocolVersion;
        const e2 = !probeResult.ok ? layer("SKIP", "协议探针未通过", "probe.json")
          : !command ? layer("UNKNOWN", `${client} 可执行文件未找到`, "probe.json")
          : wire.discovered ? layer("PASS", "真实客户端完成工具发现", files.wire)
          : layer(timedOut || exitCode !== 0 ? "FAIL" : "UNKNOWN", processError ?? (timedOut ? "客户端超时" : "未见 tools/list 响应"), files.stderr, files.wire);
        const e3 = e2.verdict === "PASS" ? evaluateCase(test, wire, answer, fixtureEvents, isFixture, exitCode, timedOut, abortReason, clientEvents) : layer("SKIP", "未取得真实客户端工具发现证据", files.wire);
        const normalized = normalizeEvents(readLines(join(trialDir, files.wire)), clientEvents, answer, processError ?? abortReason);
        writeFileSync(join(trialDir, files.events), normalized.map(event => JSON.stringify(redact(event))).join("\n") + (normalized.length ? "\n" : ""));
        const availableFiles = Object.entries(files).filter(([, value]) => existsSync(join(trialDir, value)));
        const code = errorCode(e0, e1, e2, e3);
        const result: TrialResult = { id, runId, caseId: test.id, client, clientVersion: command?.version ?? "unavailable", clientExecutable: command ? String(redact(command.command)) : undefined, modelId: modelId(clientEvents) ?? (client === "codex" ? config.codexModel ?? null : null), modelCostUsd: modelCostUsd(clientEvents), protocolVersion: wire.protocolVersion, reproduceCommand: `doctor run "${String(redact(basename(configPath)))}" --client ${client} --case ${test.id} --out runs/reproduce-${id}`, errorCode: code, fixHint: fixHint(code), startedAt, endedAt: new Date().toISOString(), exitCode, calls: wire.calls, finalAnswer: answer, layers: { E0: e0, E1: e1, E2: e2, E3: e3, E4: layer("SKIP", "首版仅支持人工完整体验验收") }, files: Object.fromEntries(availableFiles.map(([key, value]) => [key, `${id}/${value}`])), evidenceHashes: Object.fromEntries(availableFiles.map(([key, value]) => [key, hash(readFileSync(join(trialDir, value)))])) };
        report.trials.push(result);
        writeReport(outDir, report);
        console.log(`${id}: E2=${e2.verdict} E3=${e3.verdict} ${e3.reason}`);
      }
    }
  }
  return report;
}
