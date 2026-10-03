import { dirname, join } from "node:path";
import { findClaudeJs, findExecutable } from "../process.js";
import { at, readConfig, record } from "./parsers.js";
import { interpolate, resolveCommand, sourceDefinition } from "./scan.js";
import { runCaptured, safeDirectExecutable } from "./execution.js";
import type { DiagnosticServer, EvidenceReport, ScanReport } from "./types.js";
import { classifyAuthFailure } from "./network.js";
import { verifiedVersions } from "./rules.js";
import {InitializeResultSchema,ListToolsResultSchema,JSONRPCMessageSchema} from "@modelcontextprotocol/sdk/types.js";

export async function checkServer(report: ScanReport, id: string, native = false, executor:typeof runCaptured=runCaptured): Promise<EvidenceReport> {
  const safeExecutor:typeof runCaptured=async(...args)=>{try{return await executor(...args);}catch{return {exitCode:null,stdout:"",failed:true,timedOut:false,limited:false,spawnError:true};}};
  const server = report.servers.find(item => item.id === id);
  if (!server) throw new Error("请选择扫描报告中的服务 ID");
  const result: EvidenceReport = { schemaVersion: 1, kind: "configuration-check", createdAt: new Date().toISOString(), client: server.client, serverId: id, evidenceKind: native ? server.client === "codex" ? "cli-config" : "native-service" : "controlled-replay", status: "UNKNOWN", reason: "尚未取得证据", limitations: ["连接或配置成功不代表模型实际调用工具成功。", "未调用业务工具，也未请求模型。", "不读取或复制 OAuth、keychain 或 VS Code 保存的输入。"] };
  if (report.context.location !== "local") return { ...result, status: "UNSUPPORTED", reason: "请在远端环境采集证据，本地不能验证远程入口。" };
  if (server.enabled === false) return { ...result, status: "UNKNOWN", reason: "服务已被禁用或拒绝；检查不改变启用或审批状态。" };
  const { raw } = sourceDefinition(report, server);
  if (native && report.context.surfaces[server.client] && report.context.surfaces[server.client]!==`${server.client}-cli` && ["codex","claude"].includes(server.client))return {...result,status:"UNSUPPORTED",reason:"所选入口不是 CLI；请从原桌面入口采集会话证据。"};
  if (native) return nativeCheck(report, server, raw, result,safeExecutor);
  result.limitations.push("受控回放使用诊断器的基础环境，不代表原生 IDE/桌面会话环境。");
  if (server.client === "claude" && raw.cwd !== undefined) return { ...result, status: "UNSUPPORTED", reason: "当前 Claude Code 版本的服务 cwd 字段尚未验证，不能用回放替代原生行为。" };
  if (server.transport !== "stdio") return { ...result, status: "UNSUPPORTED", reason: "首版主动回放仅支持本地 stdio；HTTP/OAuth 需要原生取证。" };
  if (raw.headersHelper || raw.http_headers_helper || raw.apiKeyHelper || raw.envFile) return { ...result, status: "UNSUPPORTED", reason: "此定义依赖 helper 或环境文件，首版回放不会执行或加载它们。" };
  if (typeof raw.command !== "string" || raw.url || raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some(item => typeof item !== "string"))) return { ...result, status: "FAIL", reason: "服务入口或参数无效。" };
  const command = interpolate(raw.command, server.client, report.context, process.env);
  const cwd = interpolate(typeof raw.cwd === "string" ? raw.cwd : report.context.workspace, server.client, report.context, process.env);
  const args = (raw.args as string[] | undefined ?? []).map(value => interpolate(value, server.client, report.context, process.env));
  if (command.unresolved || cwd.unresolved || args.some(item => item.unresolved)) return { ...result, status: "UNKNOWN", reason: "启动表达式未解析，无法回放。" };
  const executable = resolveCommand(command.value, cwd.value, process.env);
  if (!executable || !safeDirectExecutable(executable)) return { ...result, status: "UNSUPPORTED", reason: "需要原生可执行文件；首版不拼接 shell 或自动运行脚本包装。" };
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP"]) if (process.env[key] !== undefined) environment[key] = process.env[key];
  environment.HOME ??= report.context.home;
  for (const entry of Array.isArray(raw.env_vars) ? raw.env_vars : []) {
    const name = typeof entry === "string" ? entry : record(entry).name;
    if (record(entry).source === "remote") return { ...result, status: "UNSUPPORTED", reason: "定义请求远程环境变量，无法本地回放。" };
    if (typeof name !== "string" || process.env[name] === undefined) return { ...result, status: "UNKNOWN", reason: "需转发的变量在诊断进程中缺失。" };
    environment[name] = process.env[name];
  }
  for (const [key, value] of Object.entries(record(raw.env))) {
    if (value === null && server.client === "vscode") { delete environment[key]; continue; }
    if (typeof value !== "string" && !(server.client === "vscode" && typeof value === "number")) return { ...result, status: "UNKNOWN", reason: "环境定义含不支持的值。" };
    const expanded = interpolate(String(value), server.client, report.context, process.env);
    if (expanded.unresolved) return { ...result, status: "UNKNOWN", reason: "环境引用尚未解析。" };
    environment[key] = expanded.value;
  }
  let discovered = false, malformed = false, unsupported = false, protocolError = false;
  let tools: string[] = [], initialized = false, requestId = 2, pages = 0;
  let stageTimer:NodeJS.Timeout|undefined,stageTimeout:"connect"|"list"|null=null;
  const execution = await runCaptured(executable, args.map(item => item.value), { cwd: cwd.value, env: environment, timeoutMs: 12000,
    onStart: (send,stop) => {stageTimer=setTimeout(()=>{stageTimeout="connect";stop();},6000);send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "ai-plugin-doctor-config-check", version: "0.2.0" } } });},
    onLine: (line, send, stop) => {
      let message: Record<string, unknown>;
      try { message = record(JSON.parse(line)); } catch { malformed = true; stop(); return; }
      if (!JSONRPCMessageSchema.safeParse(message).success||Object.hasOwn(message,"result")&&Object.hasOwn(message,"error")) { malformed = true; stop(); return; }
      if (message.error && (message.id === 1 || message.id === requestId)) { protocolError = true; stop(); return; }
      if (message.id === 1 && !initialized) {
        if(stageTimer)clearTimeout(stageTimer);stageTimer=setTimeout(()=>{stageTimeout="list";stop();},8000);
        const parsedInitialization=InitializeResultSchema.safeParse(message.result);if(!parsedInitialization.success){malformed=true;stop();return;}
        const initialization = parsedInitialization.data;
        if (!["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(String(initialization.protocolVersion))) { unsupported = true; stop(); return; }
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        initialized = true;
        send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      } else if (initialized && message.id === requestId) {
        const parsedList=ListToolsResultSchema.safeParse(message.result);if(!parsedList.success){malformed=true;stop();return;}
        const listed = parsedList.data.tools;
        tools.push(...listed.map(item => String(record(item).name)));
        if (++pages > 8 || tools.length > 1000) { unsupported = true; stop(); return; }
        const cursor = record(message.result).nextCursor;
        if (cursor !== undefined) {
          if (typeof cursor !== "string") { malformed = true; stop(); return; }
          send({ jsonrpc: "2.0", id: ++requestId, method: "tools/list", params: { cursor } }); return;
        }
        discovered = true; stop();
      }
    } });
  if(stageTimer)clearTimeout(stageTimer);
  if(stageTimeout)return {...result,status:"FAIL",reason:stageTimeout==="connect"?"MCP 连接/握手超过 6 秒时限，本次受管进程已收尾。":"工具发现超过 8 秒时限，本次受管进程已收尾。"};
  if (discovered && !execution.limited && !malformed && !protocolError && !unsupported && !execution.spawnError) return { ...result, status: "PASS", reason: "受控进程完成 MCP 握手及工具发现。", toolCount: tools.length, limitations: [...result.limitations, "服务提供的工具名称、描述、schema 和原始消息未导出。"] };
  return { ...result, status: unsupported ? "UNSUPPORTED" : "FAIL", reason: unsupported ? "服务协商的协议超出首版探针支持范围。" : execution.timedOut ? "握手或工具发现超过 12 秒时限，已终止本次进程树。" : execution.limited ? "服务输出超过限制，已终止本次进程树。" : malformed ? "服务 stdout 不是有效的 MCP 消息。" : protocolError ? "服务返回协议错误；原始内容未导出。" : "服务启动失败或未完成发现；原始输出未导出。" };
}
async function nativeCheck(report: ScanReport, server: DiagnosticServer, raw: Record<string, unknown>, result: EvidenceReport,execute:typeof runCaptured): Promise<EvidenceReport> {
  if (report.context.launchOverrides) return { ...result, status: "UNKNOWN", reason: "目标会话有额外启动覆盖，本次默认 CLI 不能代表它；请在原入口取证。" };
  if (!["codex", "claude"].includes(server.client)) return { ...result, evidenceKind: "native-session", status: "UNSUPPORTED", reason: server.client === "vscode" ? "在指定 Profile 的 MCP: List Servers 查看状态并导入取证记录。" : "在 Cursor 的 MCP 日志或 list-tools 中检查选中服务并导入取证记录。" };
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: report.context.home, USERPROFILE: report.context.home, CODEX_HOME: report.context.codexHome };
  if (report.context.claudeConfigDir !== join(report.context.home, ".claude")) env.CLAUDE_CONFIG_DIR = report.context.claudeConfigDir; else delete env.CLAUDE_CONFIG_DIR;
  if (server.client === "codex") {
    const command = process.env.DOCTOR_CODEX_EXE ?? findExecutable("codex");
    if (!command || !safeDirectExecutable(command)) return { ...result, status: "UNKNOWN", reason: "未找到受支持的 Codex 原生入口。" };
    const installed=await execute(command,["--version"],{cwd:report.context.workspace,env,timeoutMs:6000});const version=installed.failed?null:/\bcodex-cli\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/.exec(installed.stdout)?.[1]??null;
    result.observedVersion=version;if(!version||!verifiedVersions.codex?.includes(version))return {...result,status:"UNSUPPORTED",reason:"本次 Codex 安装版本不在原生输出解析的已验证范围，未执行服务配置读取。"};
    const captured = await execute(command, [...(report.context.profile ? ["--profile", report.context.profile] : []), "mcp", "list", "--json"], { cwd: report.context.workspace, env });
    const auth=captured.failed?classifyAuthFailure(captured.stdout):null;if(auth)return {...result,status:"FAIL",authTarget:auth,reason:"失败的原生检查包含认证信号，目标分类仅作线索；原始输出已丢弃。"};
    if (captured.failed) return { ...result, status: "UNKNOWN", reason: "原生配置读取失败或超时；未输出原始数据。" };
    let entries: unknown;
    try { entries = JSON.parse(captured.stdout); } catch { return { ...result, status: "UNKNOWN", reason: "客户端输出格式不在已验证范围。" }; }
    const entry = Array.isArray(entries) ? entries.map(record).find(item => item.name === server.name) : undefined;
    if (!entry) return { ...result, status: "FAIL", reason: "本次原生配置列表中没有选中服务；请检查信任、Profile 或作用域。" };
    const transport = record(entry.transport);
    if (entry.enabled === false) return { ...result, status: "FAIL", reason: "原生配置列表显示服务已禁用。" };
    const normalize = (object: Record<string, unknown>, key: string) => key === "args" ? object[key] ?? [] : object[key] ?? null;
    const matches = ["command", "args", "url", "cwd"].every(key => JSON.stringify(normalize(transport, key)) === JSON.stringify(normalize(raw, key)));
    return { ...result, status: matches ? "PASS" : "UNKNOWN", reason: matches ? "本次 Codex CLI 配置列表与选中定义的入口字段一致。" : "原生入口字段与扫描推断不同，请重新核对配置层。", limitations: [...result.limitations, "这只确认本次 CLI 配置，不证明已连接或已有桌面会话已加载。"] };
  }
  const script = findClaudeJs();
  const nativeExe = findExecutable("claude");
  if (!script && !nativeExe) return { ...result, status: "UNKNOWN", reason: "未找到受支持的 Claude Code 入口。" };
  const command = nativeExe ?? process.execPath;
  const installed=await execute(command,[...(nativeExe?[]:[script!]),"--version"],{cwd:report.context.workspace,env,timeoutMs:6000});const version=installed.failed?null:/\b(\d+\.\d+\.\d+)\s*\(Claude Code\)/.exec(installed.stdout)?.[1]??null;
  result.observedVersion=version;if(!version||!verifiedVersions.claude?.includes(version))return {...result,status:"UNSUPPORTED",reason:"本次 Claude Code 安装版本不在原生输出解析的已验证范围，未启动 MCP 服务。"};
  const captured = await execute(command, [...(nativeExe ? [] : [script!]), "mcp", "get", server.name], { cwd: report.context.workspace, env });
  const connected = !captured.failed && /(?:^|\n)\s*Status:\s*(?:[✓✔]\s*)?Connected\s*(?:\r?\n|$)/i.test(captured.stdout.replace(/\x1b\[[0-9;]*m/g, ""));
  const auth=connected?null:classifyAuthFailure(captured.stdout);if(auth)return {...result,status:"FAIL",authTarget:auth,reason:"未取得连接成功状态的原生检查包含认证信号，目标分类仅作线索；原始输出已丢弃。"};
  if (!connected && /(?:^|\n)\s*Status:\s*(?:[✗✘×]\s*)?(?:Failed to connect|Connection failed)\s*(?:\r?\n|$)/i.test(captured.stdout.replace(/\x1b\[[0-9;]*m/g, ""))) return { ...result, status: "FAIL", reason: "本次 Claude Code 原生健康检查显示连接失败；原始输出未导出。", limitations: [...result.limitations, "mcp get 跳过交互信任提示，不能代表已有会话审批。"] };
  return { ...result, status: connected ? "PASS" : captured.timedOut || captured.limited ? "FAIL" : "UNKNOWN", reason: connected ? "本次 Claude Code 原生健康检查显示已连接。" : "未取得可识别的原生连接成功状态；原始输出未导出。", limitations: [...result.limitations, "mcp get 会启动选中服务；它跳过交互信任提示，不能证明已有会话审批或工具可见。"] };
}
export function importNativeEvidence(report: ScanReport, payload: unknown): EvidenceReport {
  const input = record(payload);
  const server = report.servers.find(item => item.id === input.serverId);
  if (!server || input.client !== server.client || input.workspace !== report.context.workspace || typeof input.observedAt !== "string" || !Number.isFinite(Date.parse(input.observedAt))) throw new Error("取证记录必须匹配服务、客户端、工作区与有效时间");
  if (!input.surface || typeof input.surface !== "string" || !["connected", "failed", "unknown"].includes(String(input.status))) throw new Error("取证记录需要入口与状态");
  // Only accept an allowlisted surface; arbitrary logs, notes and secret values are discarded.
  const surfaces = ["codex-cli", "claude-cli", "cursor-ide", "vscode-chat", "codex-desktop", "claude-desktop-code"];
  if (!surfaces.includes(input.surface)) throw new Error("当前取证入口不受支持");
  if (!input.surface.startsWith(server.client)) throw new Error("取证入口与客户端不一致");
  return { schemaVersion: 1, kind: "configuration-check", createdAt: input.observedAt, client: server.client, serverId: server.id, evidenceKind: "native-session", status: "UNKNOWN", reason: `用户在 ${input.surface} 声明状态为 ${input.status}；本工具未独立验证。`, limitations: ["这是用户声明的原生状态，不是自动实测 PASS。", "原始日志和自由文本未写入分享报告。"] };
}
