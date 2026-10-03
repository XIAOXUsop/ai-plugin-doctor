import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, delimiter } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { hash } from "../config.js";
import { findClaudeJs, findExecutable } from "../process.js";
import { at, readConfig, record, locateNode } from "./parsers.js";
import { readMapping } from "./identity.js";
import { ruleFor } from "./rules.js";
import { observeNetwork } from "./network.js";
import type { ConfigSource, DiagnosticClient, DiagnosticServer, Finding, JsonPath, ScanContext, ScanOptions, ScanReport } from "./types.js";

export const diagnosticClients: DiagnosticClient[] = ["codex", "claude", "cursor", "vscode"];
interface Definition { client: DiagnosticClient; name: string; source: ConfigSource; path: JsonPath; raw: Record<string, unknown>; origins: Map<string, { sourceId: string; keyPath: JsonPath; overridden?: Array<{sourceId:string;keyPath:JsonPath}> }>; shadowed: string[] }
export function contextFor(options: ScanOptions): ScanContext {
  const environment = options.env ?? process.env;
  const home = resolve(options.home ?? environment.USERPROFILE ?? homedir());
  const workspace = resolve(options.workspace);
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) throw new Error("工作区不存在或不是目录");
  const clients = options.clients ?? diagnosticClients;
  if (!clients.length || clients.some(client => !diagnosticClients.includes(client))) throw new Error("客户端必须为 codex、claude、cursor 或 vscode");
  if (options.profile && !/^[A-Za-z0-9_-]{1,80}$/.test(options.profile)) throw new Error("Profile 名称只能使用字母、数字、下划线或短横线");
  const surfaces=options.surfaces??{},clientVersions=options.clientVersions??{};
  if([...Object.keys(surfaces),...Object.keys(clientVersions)].some(client=>!diagnosticClients.includes(client as DiagnosticClient)))throw new Error("版本或入口指定了未知客户端");
  const supportedSurfaces:Record<string,string[]>={codex:["codex-cli","codex-desktop"],claude:["claude-cli","claude-desktop-code"],cursor:["cursor-ide"],vscode:["vscode-chat"]};
  for(const [client,surface] of Object.entries(surfaces))if(surface!=="unknown"&&!supportedSurfaces[client]?.includes(surface))throw new Error("入口名称不受支持");
  for(const version of Object.values(clientVersions))if(!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version))throw new Error("客户端版本格式无效");
  return { workspace, home, clients: [...new Set(clients)], profile: options.profile ?? null,
    codexHome: resolve(options.codexHome ?? (!options.home ? environment.CODEX_HOME : undefined) ?? join(home, ".codex")),
    claudeConfigDir: resolve(options.claudeConfigDir ?? (!options.home ? environment.CLAUDE_CONFIG_DIR : undefined) ?? join(home, ".claude")),
    vscodeConfig: resolve(options.vscodeConfig ?? join(!options.home && environment.APPDATA ? environment.APPDATA : join(home, "AppData", "Roaming"), "Code", "User", "mcp.json")),
    location: options.location ?? "local", platform: process.platform,
    codexSystemDir: resolve(options.codexSystemDir ?? (process.platform === "win32" ? join(environment.ProgramData ?? "C:/ProgramData", "OpenAI", "Codex") : "/etc/codex")),
    claudeManagedDir: resolve(options.claudeManagedDir ?? (process.platform === "win32" ? "C:/Program Files/ClaudeCode" : process.platform === "darwin" ? "/Library/Application Support/ClaudeCode" : "/etc/claude-code")),
    launchOverrides: options.launchOverrides === true, surfaces:{...surfaces},clientVersions:{...clientVersions} };
}
function projectDirectories(workspace: string): string[] {
  const parts: string[] = [];
  let current = workspace;
  for (let i = 0; i < 32; i++) {
    parts.unshift(current);
    if (existsSync(join(current, ".git"))) return parts;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [workspace];
}
export function configSources(context: ScanContext): ConfigSource[] {
  const result: ConfigSource[] = [];
  const add = (client: DiagnosticClient, scope: string, path: string, format: ConfigSource["format"], priority: number) => {
    if (!context.clients.includes(client)) return;
    result.push({ id: hash(`${client}:${scope}:${path}`).slice(0, 16), client, scope, path, format, priority, state: "missing", contentHash: null, editable: format !== "toml" && !scope.endsWith("observation"), issues: [], included: !scope.endsWith("observation") });
  };
  add("codex", "user", join(context.codexHome, "config.toml"), "toml", 10);
  add("codex", "system-observation", join(context.codexSystemDir, "config.toml"), "toml", 0);
  add("codex", "managed-observation", join(context.codexSystemDir, "requirements.toml"), "toml", 0);
  add("codex", "legacy-managed-observation", join(process.platform === "win32" ? context.codexHome : context.codexSystemDir, "managed_config.toml"), "toml", 0);
  projectDirectories(context.workspace).forEach((path, index) => add("codex", "project", join(path, ".codex", "config.toml"), "toml", 30 + index));
  const redirectedClaude = context.claudeConfigDir !== join(context.home, ".claude");
  add("claude", "user", redirectedClaude ? join(context.claudeConfigDir, ".claude.json") : join(context.home, ".claude.json"), "json", 10);
  add("claude", "project", join(context.workspace, ".mcp.json"), "json", 20);
  add("claude", "user-settings", join(context.claudeConfigDir, "settings.json"), "json", 10);
  add("claude", "project-settings", join(context.workspace, ".claude", "settings.json"), "json", 20);
  add("claude", "local-settings", join(context.workspace, ".claude", "settings.local.json"), "json", 30);
  add("claude", "managed-observation", join(context.claudeManagedDir, "managed-mcp.json"), "json", 0);
  add("claude", "managed-settings-observation", join(context.claudeManagedDir, "managed-settings.json"), "json", 0);
  add("cursor", "user", join(context.home, ".cursor", "mcp.json"), "json", 10);
  add("cursor", "project", join(context.workspace, ".cursor", "mcp.json"), "json", 20);
  add("vscode", "user", context.vscodeConfig, "jsonc", 10);
  add("vscode", "project", join(context.workspace, ".vscode", "mcp.json"), "jsonc", 20);
  add("vscode", "user-settings", join(dirname(context.vscodeConfig), "settings.json"), "jsonc", 10);
  add("vscode", "project-settings", join(context.workspace, ".vscode", "settings.json"), "jsonc", 20);
  return result;
}
export function loadingUncertain(context:ScanContext,sources:ConfigSource[],client:DiagnosticClient):boolean {
  return context.launchOverrides||client==="codex"&&Boolean(context.profile)||sources.some(source=>source.client===client&&(["invalid","unreadable","unsafe"].includes(source.state)||source.scope.endsWith("observation")&&source.state!=="missing"));
}
function sameWorkspace(a: string, b: string): boolean { const normalize = (path: string) => resolve(path).replaceAll("\\", "/"); return process.platform === "win32" ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b); }
function projectEntry(value: Record<string, unknown>, workspace: string): { key: string; value: Record<string, unknown> } | null {
  for (const [key, entry] of Object.entries(record(value.projects))) if (sameWorkspace(key, workspace)) return { key, value: record(entry) };
  return null;
}
function trusted(value: Record<string, unknown>, workspace: string): boolean {
  let current = workspace;
  for (let i = 0; i < 32; i++) {
    const entry = projectEntry(value, current);
    if (entry) return entry.value.trust_level === "trusted";
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  return false;
}
function mergeDefinition(old: Definition | undefined, next: Definition): Definition {
  if (!old) return next;
  const raw: Record<string, unknown> = { ...old.raw, ...next.raw };
  for (const key of ["env", "tools", "http_headers", "env_http_headers"]) if (old.raw[key] && next.raw[key]) raw[key] = { ...record(old.raw[key]), ...record(next.raw[key]) };
  const origins = new Map(old.origins);
  for (const [key, origin] of next.origins) { const prior=old.origins.get(key);origins.set(key, {...origin,overridden:prior?[...(prior.overridden??[]),{sourceId:prior.sourceId,keyPath:prior.keyPath}]:[]}); }
  return { ...next, raw, origins, shadowed: [...old.shadowed, old.source.id] };
}
function definition(source: ConfigSource, name: string, path: JsonPath, raw: Record<string, unknown>): Definition {
  const origins = new Map<string, { sourceId: string; keyPath: JsonPath }>();
  for (const [key, value] of Object.entries(raw)) {
    origins.set(key, { sourceId: source.id, keyPath: [...path, key] });
    if (value && typeof value === "object" && !Array.isArray(value)) for (const child of Object.keys(value)) origins.set(`${key}.${child}`, { sourceId: source.id, keyPath: [...path, key, child] });
  }
  return { client: source.client, name, source, path, raw, origins, shadowed: [] };
}
function safeOrigin(value: unknown): string | null { if (typeof value !== "string") return null; try { const url = new URL(value); return /^(http|https|ws|wss):$/.test(url.protocol) ? url.origin : null; } catch { return null; } }
export function resolveCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): string | null {
  return commandCandidates(command, cwd, env)[0] ?? null;
}
export function commandCandidates(command: string, cwd: string, env: NodeJS.ProcessEnv): string[] {
  if (!command || /[\r\n\0]/.test(command) || command.includes("${")) return [];
  const candidates = isAbsolute(command) || command.includes("/") || command.includes("\\") ? [resolve(cwd, command)] : (env.PATH ?? "").split(delimiter).flatMap(folder => process.platform === "win32" ? [join(folder, command), ...[".exe", ".cmd", ".bat", ".ps1"].map(ext => join(folder, command + ext))] : [join(folder, command)]);
  const found: string[] = [];
  for (const candidate of candidates) try { if (statSync(candidate).isFile()) found.push(resolve(candidate)); } catch { /* Try next candidate. */ }
  return [...new Set(found)];
}
export function interpolate(value: string, client: DiagnosticClient, context: ScanContext, env: NodeJS.ProcessEnv): { value: string; unresolved: boolean } {
  let unresolved = false;
  const expanded = value.replace(/\$\{([^{}]+)\}/g, (literal, body: string) => {
    if ((client === "cursor" || client === "vscode") && body === "workspaceFolder") return context.workspace;
    if ((client === "cursor" || client === "vscode") && body === "userHome") return context.home;
    if ((client === "cursor" || client === "vscode") && body === "workspaceFolderBasename") return basename(context.workspace);
    if ((client === "cursor" || client === "vscode") && ["pathSeparator", "/"].includes(body)) return process.platform === "win32" ? "\\" : "/";
    const expression = client === "claude" ? /^([A-Za-z_][A-Za-z0-9_]*)(?::-([^]*))?$/.exec(body) : client !== "codex" ? /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(body) : null;
    if (expression && expression[1]) { const candidate = env[expression[1]] ?? expression[2]; if (candidate !== undefined) return candidate; }
    unresolved = true; return literal;
  });
  return { value: expanded, unresolved };
}
export function scan(options: ScanOptions): ScanReport {
  const context = contextFor(options);
  const environment = options.env ?? process.env;
  const sources = configSources(context);
  const values = new Map<string, Record<string, unknown>>();
  const findings: Finding[] = [];
  const network:NonNullable<ScanReport["network"]>=[];
  const add = (code: string, source: ConfigSource, server: DiagnosticServer | null, keyPath: JsonPath | null, title: string, detail: string, nextStep: string, severity: Finding["severity"] = "warning", confidence: Finding["confidence"] = "inferred", repair: Finding["repair"] = null) => {
    findings.push({ id: hash(JSON.stringify([code, source.id, server?.id, keyPath])).slice(0, 18), code, client: source.client, serverId: server?.id ?? null, sourceId: source.id, keyPath, severity, confidence, evidenceKind: "file", title, detail, nextStep, repair });
  };
  for (const source of sources) {
    const loaded = readConfig(source);
    Object.assign(source, { state: loaded.state, contentHash: loaded.contentHash, issues: loaded.issues, editable: source.editable && loaded.state === "readable" });
    values.set(source.id, loaded.value);
    if (["invalid", "unreadable", "unsafe"].includes(source.state)) for (const code of source.issues) add(code, source, null, null, "配置无法可靠读取", `此来源状态为 ${source.state}，未使用部分解析结果。`, "检查文件格式、访问权限及是否为普通文件；原始错误内容不写入报告。", "error", "confirmed");
    if (source.scope === "profile" && source.state === "missing") add("PROFILE_UNOBSERVED", source, null, null, "指定 Profile 文件未找到", "不能确认指定 Profile 是否由其他版本格式提供。", "核对实际启动 Profile 与当前客户端版本。", "warning", "unknown");
    if (source.scope.endsWith("observation") && source.state !== "missing") add("MANAGED_STATE_UNOBSERVED", source, null, null, "系统或托管来源需要原生核对", "已读取文件状态，尚未完整解释本版本的托管约束与云端策略。", "在原客户端核对最终配置或联系管理员；不改写托管来源。", "warning", "unknown");
    if (context.launchOverrides && source.scope === "user") add("LAUNCH_OVERRIDE_UNOBSERVED", source, null, null, "会话存在额外启动覆盖", "当前扫描不包含运行中会话的命令行覆盖值。", "在带相同启动参数的目标入口核对最终配置。", "warning", "unknown");
  }
  const userCodex = sources.find(source => source.client === "codex" && source.scope === "user");
  if(context.profile&&userCodex)add("PROFILE_UNOBSERVED",userCodex,null,null,"已选 Profile 的加载规则尚未独立验证","记录 Profile 名称用于原生 CLI 核对；扫描不猜测独立的 Profile 配置文件或其 MCP 合并行为。","使用相同 Profile 的原生 CLI 配置列表核对后，再在真实来源文件中处理。","warning","unknown");
  const userCodexValue = userCodex ? values.get(userCodex.id) ?? {} : {};
  const codexTrusted = trusted(userCodexValue, context.workspace);
  const selected = new Map<string, Definition>();
  const disabledClaude = new Set<string>();
  const rejectedClaude = new Set<string>();
  const approvedClaude = new Set<string>();
  const permissionDeny: string[] = [];
  for (const source of sources.filter(source => source.client === "vscode" && source.scope.endsWith("settings") && source.state === "readable")) {
    const settings = values.get(source.id)!;
    if (settings["chat.mcp.discovery.enabled"] !== undefined) add("DISCOVERY_STATE_UNOBSERVED", source, null, ["chat.mcp.discovery.enabled"], "已发现跨应用配置发现设置", "本扫描不解析动态发现后的服务集合，设置仅来自已知本地文件。", "在指定 Profile 的 MCP: List Servers 核对；Agent Host 不使用此发现开关。", "info", "unknown");
    if (settings["chat.mcp.access"] !== undefined) add("CLIENT_ACCESS_UNOBSERVED", source, null, ["chat.mcp.access"], "MCP 使用受客户端访问设置约束", "最终可用服务需由原生入口解释设置和托管策略。", "查看 MCP: List Servers 与设置来源；诊断器不放宽访问。", "info", "unknown");
  }
  for (const source of sources.filter(source => source.client === "claude" && source.scope.endsWith("settings") && source.state === "readable")) {
    const value = values.get(source.id)!;
    for (const rule of Array.isArray(record(value.permissions).deny) ? record(value.permissions).deny as unknown[] : []) if (typeof rule === "string") permissionDeny.push(rule);
    if (Array.isArray(value.disabledMcpjsonServers)) for (const name of value.disabledMcpjsonServers) if (typeof name === "string") rejectedClaude.add(name);
    if (Array.isArray(value.enabledMcpjsonServers)) for (const name of value.enabledMcpjsonServers) if (typeof name === "string") approvedClaude.add(name);
  }
  const collect = (source: ConfigSource, root: Record<string, unknown>, prefix: JsonPath, local = false) => {
    for (const [name, entry] of Object.entries(root)) {
      const candidate = definition(source, name, [...prefix, name], record(entry));
      const key = `${source.client}:${name}`;
      const previous = selected.get(key);
      if (previous) candidate.shadowed = [...previous.shadowed, previous.source.id];
      if(previous&&source.client!=="codex")for(const [field,origin]of candidate.origins){const prior=previous.origins.get(field);if(prior)candidate.origins.set(field,{...origin,overridden:[...(prior.overridden??[]),{sourceId:prior.sourceId,keyPath:prior.keyPath}]});}
      if (local || source.client !== "codex") selected.set(key, candidate);
      else selected.set(key, mergeDefinition(previous, candidate));
    }
  };
  for (const source of sources.filter(source => !source.scope.endsWith("settings") && !source.scope.endsWith("observation")).sort((a, b) => a.priority - b.priority)) {
    if (source.state !== "readable") continue;
    const value = values.get(source.id)!;
    const rootKey = source.client === "codex" ? "mcp_servers" : source.client === "vscode" ? "servers" : "mcpServers";
    const wrongKey = source.client === "vscode" ? "mcpServers" : source.client === "codex" ? "mcpServers" : "servers";
    if (value[wrongKey] !== undefined) add("CFG_ROOT_KEY", source, null, [wrongKey], "配置根键不适用于目标客户端", `此配置需要 ${rootKey}，发现另一种客户端格式。`, "预览根键转换，保留其余设置；有目标键冲突时不要自动合并。", "error", "confirmed", source.format === "toml" ? null : "root");
    if (source.client === "codex" && source.scope === "project" && !codexTrusted) {
      source.included = false;
      if (Object.keys(record(value[rootKey])).length) add("PROJECT_TRUST_REQUIRED", source, null, [rootKey], "项目配置尚未确认可加载", "诊断器未找到适用于当前工作区的用户层信任记录，项目定义未计入有效配置。", "在目标 Codex 入口审阅信任状态，使用配置列表核对；诊断器不修改信任。", "warning", "inferred");
      continue;
    }
    collect(source, record(value[rootKey]), [rootKey]);
    if (source.client === "claude" && source.scope === "user") {
      const local = projectEntry(value, context.workspace);
      for (const container of [value, local?.value ?? {}]) {
        for (const name of Array.isArray(container.disabledMcpServers) ? container.disabledMcpServers : []) if (typeof name === "string") disabledClaude.add(name);
        for (const name of Array.isArray(container.disabledMcpjsonServers) ? container.disabledMcpjsonServers : []) if (typeof name === "string") rejectedClaude.add(name);
        for (const name of Array.isArray(container.enabledMcpjsonServers) ? container.enabledMcpjsonServers : []) if (typeof name === "string") approvedClaude.add(name);
      }
    }
  }
  const claudeUser = sources.find(source => source.client === "claude" && source.scope === "user" && source.state === "readable");
  if (claudeUser) { const local = projectEntry(values.get(claudeUser.id)!, context.workspace); if (local) collect(claudeUser, record(local.value.mcpServers), ["projects", local.key, "mcpServers"], true); }
  const servers: DiagnosticServer[] = [];
  for(const client of context.clients) {
    const configured:Record<string,unknown>={};let owner=sources.find(source=>source.client===client&&source.scope==="user")!;
    for(const source of sources.filter(source=>source.client===client&&source.scope.endsWith("settings")&&source.state==="readable").sort((a,b)=>a.priority-b.priority)){Object.assign(configured,record(values.get(source.id)?.env));if(Object.keys(record(values.get(source.id)?.env)).length)owner=source;}
    const observation=observeNetwork(client,null,"model",undefined,environment,configured,owner.id,context);network.push(observation.observation);
    for(const issue of observation.issues)add(issue.code,owner,null,null,"网络配置来源需要核对",issue.detail,issue.nextStep,"warning",issue.confidence);
    const stateStep=client==="vscode"?"在指定工作区和 Profile 使用 MCP: List Servers 查看状态及日志；仅在工具变更证据存在时使用 MCP: Reset Cached Tools，再重新发现。":client==="cursor"?"在原 Cursor 工作区查看 Output > MCP Logs，确认文件修改后重启 Cursor 并核对工具；不删除客户端数据库。":"在相同 CLI/桌面入口重新加载并查看选中服务状态；文件扫描不能确认已有会话缓存。";
    add("CLIENT_STATE_UNOBSERVED",owner,null,null,"已有会话和工具缓存尚未观察", "文件状态不能说明已有会话、动态注册服务或缓存已刷新。", stateStep, "info", "unknown");
  }
  const originals = new Map<string, Record<string, unknown>>();
  for (const item of selected.values()) {
    const { raw, source } = item;
    const transport = typeof raw.command === "string" && !raw.url ? "stdio" : raw.type === "sse" ? "sse" : raw.type === "ws" ? "ws" : typeof raw.url === "string" ? "http" : "unknown";
    const commandResult = typeof raw.command === "string" ? interpolate(raw.command, item.client, context, environment) : null;
    const cwdValue = item.client !== "claude" && typeof raw.cwd === "string" ? interpolate(raw.cwd, item.client, context, environment) : null;
    const cwd = cwdValue?.unresolved ? null : cwdValue ? resolve(context.workspace, cwdValue.value) : context.workspace;
    const executable = commandResult && !commandResult.unresolved ? resolveCommand(commandResult.value, cwd ?? context.workspace, environment) : null;
    // Expanded paths from environment expressions stay private. Literal filesystem paths are local evidence.
    const displayExecutable = typeof raw.command === "string" && !raw.command.includes("${") ? executable : null;
    const server: DiagnosticServer = { id: hash(`${item.client}:${item.name}:${source.id}`).slice(0, 18), client: item.client, name: item.name, sourceId: source.id, keyPath: item.path, transport, enabled: raw.enabled === false || raw.disabled === true || item.client === "claude" && (disabledClaude.has(item.name) || rejectedClaude.has(item.name)) ? false : true,
      commandPresent: typeof raw.command === "string", resolvedExecutable: displayExecutable, argumentCount: Array.isArray(raw.args) ? raw.args.length : 0,
      cwd: typeof raw.cwd === "string" && !raw.cwd.includes("${") ? cwd : null, origin: typeof raw.url === "string" && !raw.url.includes("${") ? safeOrigin(raw.url) : null,
      variables: [], origins: [...item.origins].map(([field, origin]) => ({ field, ...origin })), shadowedSources: [...new Set(item.shadowed)], state: "inferred" };
    servers.push(server); originals.set(server.id, raw);
    const observedNetwork=observeNetwork(item.client,server.id,"mcp",typeof raw.url==="string"?raw.url:undefined,environment,record(raw.env),source.id,context);network.push(observedNetwork.observation);
    for(const networkIssue of observedNetwork.issues)add(networkIssue.code,source,server,null,"服务网络来源需要核对",networkIssue.detail,networkIssue.nextStep,"warning",networkIssue.confidence);
    if(server.transport!=="stdio")add("AUTH_TARGET_UNCLASSIFIED",source,server,null,"认证目标和有效状态尚未验证", "静态定义无法判断 401 来自模型、MCP、代理还是网关。", "对选中服务取得原生错误状态，区分模型和 MCP 认证；不要导出原始凭据或全量日志。", "info", "unknown");
    if (loadingUncertain(context,sources,item.client)) {server.state = "unknown";add("CFG_SELECTION_UNOBSERVED",source,server,null,"有效配置选择尚未确认","存在损坏、不可读、托管、Profile 或启动上下文缺口；当前字段只是可读候选，不保证原生已加载。","先解决来源或在原入口取证，然后重新扫描；不自动修改猜测生效的低层定义。","warning","unknown");}
    const originFor = (path: JsonPath) => { const dotted = path.map(String).join("."); return item.origins.get(dotted) ?? item.origins.get(String(path[0])) ?? { sourceId: source.id, keyPath: item.path }; };
    const issue = (code: string, path: JsonPath, title: string, detail: string, nextStep: string, severity: Finding["severity"] = "warning", confidence: Finding["confidence"] = "inferred", repair: Finding["repair"] = null) => {
      const origin = originFor(path); const owner = sources.find(candidate => candidate.id === origin.sourceId) ?? source;
      const base = path.length > 1 && item.origins.has(path.map(String).join(".")) ? origin.keyPath : [...origin.keyPath.slice(0, -1), ...path];
      add(code, owner, server, base, title, detail, nextStep, severity, confidence, owner.editable ? repair : null);
    };
    if (server.shadowedSources.length) issue("CFG_SHADOWED", [], "存在同名配置覆盖", "当前定义由更高优先级来源决定；这可能是有意的配置差异。", "查看字段来源，确认编辑的是生效来源。", "info");
    if (item.client === "claude" && raw.cwd !== undefined) issue("FIELD_UNOBSERVED", ["cwd"], "Claude 服务 cwd 字段尚未验证", "本适配器不会据此推断原生服务工作目录或自动修复它。", "在原生入口核对工作目录，必要时按服务文档使用绝对参数。", "info", "unknown");
    if (raw.command && raw.url) issue("TRANSPORT_AMBIGUOUS", [], "启动命令和 URL 同时出现", "无法可靠判断此定义要使用哪种传输。", "依据服务文档选择一种传输并保留对应字段。", "error", "confirmed");
    if (transport === "unknown" || raw.command !== undefined && typeof raw.command !== "string") issue("CFG_REQUIRED_FIELD", [], "缺少有效服务入口", "服务需要字符串命令或 URL。", "核对目标客户端格式与服务安装说明。", "error", "confirmed");
    if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some(value => typeof value !== "string"))) issue("CFG_REQUIRED_FIELD", ["args"], "启动参数不是字符串数组", "参数必须逐项传递。", "按安装说明拆分参数，不拼接 shell 字符串。", "error", "confirmed");
    if (item.client === "claude" && raw.url && !raw.type) issue("CFG_TRANSPORT_TYPE", ["type"], "远程配置缺少传输类型", "Claude 需要显式指定远程传输；URL 后缀不足以确认类型。", "根据服务文档选择 http、sse 或 ws。", "error", "inferred", "transport");
    if (raw.type && !["stdio", "http", "streamable-http", "sse", "ws"].includes(String(raw.type))) issue("TRANSPORT_UNSUPPORTED", ["type"], "传输类型不在已知范围", "此类型需由目标客户端或嵌入宿主提供支持。", "核对入口及版本；诊断器不尝试启动。", "warning", "unknown");
    if (item.client === "codex" && ["sse", "ws"].includes(String(raw.type)) || item.client === "vscode" && raw.type === "ws") issue("TRANSPORT_UNSUPPORTED", ["type"], "目标适配器未验证此传输", "本工具不将其视为受支持的配置。", "核对目标入口文档，或使用服务支持的 HTTP 端点。", "warning", "unknown");
    if (server.enabled === false) { if(server.state!=="unknown")server.state = "not-loaded"; issue("SERVER_DISABLED", [], "已读定义包含禁用或拒绝", "该候选定义的禁用状态可能影响加载；来源不完整时有效加载状态仍保留 unknown。", "在目标客户端确认是否为有意禁用；诊断器不自动启用。", "info"); }
    if (transport === "stdio" && commandResult && !commandResult.unresolved && !executable) issue("COMMAND_NOT_FOUND", ["command"], "诊断进程中找不到启动命令", "在当前诊断器 PATH 和工作目录内未解析到文件，IDE 环境可能不同。", "在目标入口核对 PATH，或指定经过确认的绝对执行路径。", "error", "inferred", "command");
    if (cwd && (!existsSync(cwd) || !statSync(cwd).isDirectory())) issue("CWD_MISSING", ["cwd"], "指定工作目录不存在", "按当前工作区解释后无法找到目录。", "指定存在且经过确认的绝对工作目录。", "error", "inferred", "cwd");
    if (commandResult && !commandResult.unresolved && commandCandidates(commandResult.value, cwd ?? context.workspace, environment).length > 1) issue("MULTIPLE_INSTALLATIONS", ["command"], "启动命令存在多个安装入口", "当前 PATH 顺序选择第一个入口，其他客户端可能采用不同顺序。", "在原入口核对安装位置与版本，必要时明确绝对路径。", "warning", "possible");
    if (transport === "stdio" && (typeof raw.cwd === "string" && !isAbsolute(raw.cwd) || Array.isArray(raw.args) && raw.args.some(value => typeof value === "string" && /^\.{1,2}[\\/]/.test(value)))) issue("RELATIVE_PATH_CONTEXT", [], "启动定义依赖相对路径", "相对路径在不同入口可能使用不同工作目录。", "对照原生工作目录或指定绝对路径；不要自动按配置文件目录展开。", "warning", "possible");
    if (process.platform === "win32" && executable && /\.(?:cmd|bat|ps1)$/i.test(executable)) issue("WINDOWS_LAUNCHER_MISMATCH", ["command"], "Windows 脚本启动方式需要核对", "脚本文件与原生进程启动方式不同；终端可执行不证明客户端可启动。", "核对客户端包装方式，或使用原生可执行文件；不自动添加 shell。", "warning", "possible");
    if (raw.envFile !== undefined) {
      if (transport !== "stdio") issue("ENVFILE_UNSUPPORTED", ["envFile"], "远程服务的 envFile 不受本适配器支持", "不能据此推断认证变量已传递。", "使用目标客户端支持的变量引用。", "warning", "inferred");
      else if (typeof raw.envFile === "string") { const expanded = interpolate(raw.envFile, item.client, context, environment); if (!expanded.unresolved && !existsSync(resolve(context.workspace, expanded.value))) issue("ENVFILE_MISSING", ["envFile"], "环境文件未找到", "诊断器按当前工作区解释后找不到文件。", "核对 envFile 基准目录；不读取或生成秘密文件。", "error", "inferred"); }
    }
    if (Array.isArray(raw.enabled_tools) || Array.isArray(raw.disabled_tools)) issue("TOOL_FILTERED", [], "工具可见性受名单约束", "工具名单可能导致连接成功但部分工具不出现。", "对照服务 tools/list 与目标客户端可见工具；保留有意限制。", "info");
    if (item.client === "claude" && permissionDeny.some(rule => rule === "mcp__*" || rule === `mcp__${item.name}` || rule.startsWith(`mcp__${item.name}__`))) issue("TOOL_FILTERED", [], "Claude 权限拒绝规则涉及此服务", "已知拒绝规则可能隐藏或拒绝工具；托管规则和版本差异尚未完整观察。", "在目标入口查看具体权限来源；诊断器不删除 deny。", "warning", "inferred");
    if (item.client === "claude" && source.scope === "project" && !approvedClaude.has(item.name) && !rejectedClaude.has(item.name)) issue("PROJECT_APPROVAL_REQUIRED", [], "项目服务的交互审批未观察到", "CLI 健康检查与交互会话审批的行为可能不同。", "在原生交互会话中查看项目审批。", "info", "unknown");
    const inspectString = (value: string, path: JsonPath) => {
      for (const match of value.matchAll(/\$\{([^{}]+)\}/g)) {
        const body = match[1]!;
        const dialect = item.client === "claude" ? /^([A-Za-z_][A-Za-z0-9_]*)(?::-([^]*))?$/.exec(body) : item.client !== "codex" ? /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(body) : null;
        if (dialect?.[1]) {
          const name = dialect[1]; const present = environment[name] !== undefined;
          server.variables.push({ name, field: path.map(String).join("."), status: present ? "present-in-scanner" : "missing-in-scanner" });
          if (!present && dialect[2] === undefined) issue("VAR_MISSING", path, "变量在诊断进程中缺失", "目标客户端的变量来源尚需另行确认；报告不包含变量值。", "在目标客户端启动环境中设置专用变量，再复查。", "error", "inferred");
        } else if (body.startsWith("input:") && item.client === "vscode") server.variables.push({ name: body.slice(6), field: path.map(String).join("."), status: "client-input" }), issue("INPUT_VALUE_UNOBSERVED", path, "值由 VS Code 交互输入提供", "诊断器不读取客户端保存的输入。", "在目标 Profile 中检查输入与连接状态。", "info", "unknown");
        else if (["workspaceFolder", "workspaceFolderBasename", "userHome", "pathSeparator", "/"].includes(body) && ["cursor", "vscode"].includes(item.client)) { /* Known path variable. */ }
        else if (/^(?:env:)?[A-Za-z_][A-Za-z0-9_]*$/.test(body)) {
          server.variables.push({ name: body.replace(/^env:/, ""), field: path.map(String).join("."), status: "unsupported-dialect" });
          issue("VAR_DIALECT_MISMATCH", path, "变量表达式不符合目标客户端格式", "此表达式可能原样进入服务；只转换明确的变量引用。", "查看目标客户端的变量规则，预览表达式转换。", "error", "inferred", item.client === "claude" || item.client === "cursor" || item.client === "vscode" ? "variable" : null);
        } else issue("VAR_UNOBSERVED", path, "表达式需要额外宿主上下文", "插件变量、默认值或动态输入未被本适配器验证。", "在提供此定义的插件或宿主中核对。", "info", "unknown");
      }
    };
    for (const [key, value] of Object.entries(raw)) {
      if (["command", "cwd", "url", "envFile"].includes(key) && typeof value === "string") inspectString(value, [key]);
      if (["env", "headers", "http_headers"].includes(key)) for (const [name, child] of Object.entries(record(value))) if (typeof child === "string") inspectString(child, [key, name]);
      if (key === "args" && Array.isArray(value)) value.forEach((child, index) => { if (typeof child === "string") inspectString(child, [key, index]); });
    }
    for (const name of Array.isArray(raw.env_vars) ? raw.env_vars : []) {
      const reference = typeof name === "string" ? name : record(name).name;
      if (typeof reference !== "string") continue;
      const remote = record(name).source === "remote";
      server.variables.push({ name: reference, field: "env_vars", status: remote ? "unobserved" : environment[reference] !== undefined ? "present-in-scanner" : "missing-in-scanner" });
      if (!remote && environment[reference] === undefined) issue("VAR_MISSING", ["env_vars"], "转发变量在诊断进程中缺失", "目标客户端是否持有该变量尚未观察。", "核对启动环境；不要把值写入诊断快照。", "error", "inferred");
    }
    if (item.client === "codex") for (const [field, reference] of [["bearer_token_env_var", raw.bearer_token_env_var], ...Object.entries(record(raw.env_http_headers)).map(([name, value]) => [`env_http_headers.${name}`, value])]) {
      if (typeof reference !== "string") continue;
      const present = environment[reference] !== undefined;
      server.variables.push({ name: reference, field: String(field), status: present ? "present-in-scanner" : "missing-in-scanner" });
      if (!present) issue("VAR_MISSING", [String(field)], "HTTP 认证引用变量在诊断进程中缺失", "这只描述诊断进程，不能证明原生客户端没有该变量。", "在原入口核对环境变量；不把凭据写入报告。", "error", "inferred");
    }
    if (raw.headersHelper || raw.http_headers_helper || raw.apiKeyHelper) issue("HELPER_UNOBSERVED", [], "凭据由辅助命令提供", "扫描没有执行辅助命令，无法确认其结果。", "在目标客户端查看辅助命令状态，主动检查需单独授权。", "info", "unknown");
  }
  const secret = randomBytes(32);
  const comparisons: ScanReport["comparisons"] = [];
  const mapping=readMapping(context.workspace);
  const confirmed=(mapping.mapping?.groups??[]).map(group=>({name:`已确认映射 ${group.id}`,servers:servers.filter(server=>group.members.some(member=>member.client===server.client&&member.name===server.name))}));
  const mappedIds=new Set(confirmed.flatMap(group=>group.servers.map(server=>server.id)));
  const candidates=[...new Set(servers.map(server=>server.name))].map(name=>({name,servers:servers.filter(server=>server.name===name&&!mappedIds.has(server.id))}));
  // Compare full entry semantics in memory, including URL path/query. Never export
  // the signature or imply that equivalent launch fields establish account identity.
  const semanticGroups=new Map<string,DiagnosticServer[]>();
  for(const server of servers.filter(item=>!mappedIds.has(item.id))){const raw=originals.get(server.id)!;if(server.transport==="unknown"||!server.resolvedExecutable&&!raw.url)continue;
    const signature=JSON.stringify([server.transport,server.resolvedExecutable??null,raw.args??[],raw.cwd??null,raw.url??null]);semanticGroups.set(signature,[...(semanticGroups.get(signature)??[]),server]);}
  for(const group of semanticGroups.values())if(new Set(group.map(item=>item.client)).size>1&&new Set(group.map(item=>item.name)).size>1)candidates.push({name:"入口字段相同的候选服务（身份未确认）",servers:group});
  for (const matched of [...confirmed,...candidates]) {
    const name=matched.name,group=matched.servers;
    if (group.length < 2) continue;
    const definitions = group.map(server => originals.get(server.id)!);
    const differingFields = ["command", "args", "cwd", "url", "type", "enabled", "enabled_tools", "disabled_tools"].filter(key => new Set(definitions.map(raw => JSON.stringify(raw[key]))).size > 1);
    const credentials = definitions.map(raw => Object.entries(record(raw.env)).filter(([key]) => /token|key|secret|password|credential|auth/i.test(key)));
    let credentialRelation: "equal" | "different" | "unknown" = "unknown";
    if (credentials.every(values => values.length > 0)) {
      const signatures = credentials.map(values => createHmac("sha256", secret).update(JSON.stringify(values.sort(([a], [b]) => a.localeCompare(b)))).digest("hex"));
      // Expressions are not credential values; comparing them must never establish secret equality.
      if (credentials.every(values => values.every(([, value]) => typeof value === "string" && !value.includes("${")))) credentialRelation = new Set(signatures).size === 1 ? "equal" : "different";
    }
    comparisons.push({ name, serverIds: group.map(server => server.id), relation: confirmed.includes(matched)?"confirmed":"candidate", differingFields, credentialRelation });
  }
  const observations = context.clients.map(client => {
    // Observation metadata does not execute version commands.
    const executable = client === "codex" ? findExecutable("codex") : client === "claude" ? findClaudeJs() : resolveCommand(client === "vscode" ? "code" : "cursor", context.workspace, environment);
    let version: string | null = context.clientVersions[client]??null;
    if (!version && client === "claude" && executable) try { const value = record(JSON.parse(readFileSync(join(dirname(executable), "package.json"), "utf8"))); if (typeof value.version === "string"&&/^\d+\.\d+\.\d+$/.test(value.version)) version = value.version; } catch { /* Metadata unavailable. */ }
    return { client, version, versionSource:context.clientVersions[client]?"declared" as const:version?"package-metadata" as const:"unobserved" as const,executable, evidenceKind: "file" as const, status: "scanner-context-only" as const };
  });
  for(const observation of observations)if(!observation.version||observation.client!=="cursor"&&!({codex:["0.159.2"],claude:["2.1.89"],vscode:["1.120.0"]}[observation.client]??[]).includes(observation.version)) {
    const source=sources.find(source=>source.client===observation.client&&source.scope==="user")!;add("CLIENT_VERSION_UNOBSERVED",source,null,null,"客户端版本不在已验证范围", "扫描未运行版本命令；版本缺失或超出实测版本的相关规则保留 unknown。", "明确填写原入口版本，或主动核对安装版本后复验规则；不要将未知版本推断视为已确认。", "info", "unknown");
  }
  if (context.location === "remote") for (const source of sources.filter(source => source.scope === "user")) add("EXECUTION_LOCATION_UNSUPPORTED", source, null, null, "远程入口不能由本地配置判定", "扫描到的本地文件不代表远端已加载。", "在远端环境采集配置和日志。", "warning", "unknown");
  for(const server of servers)for(const origin of server.origins){const source=sources.find(item=>item.id===origin.sourceId)!;const loaded=readConfig(source);origin.location=loaded.text?locateNode(loaded.text,source.format,origin.keyPath):null;}
  for(const finding of findings){const source=sources.find(item=>item.id===finding.sourceId);const loaded=source?readConfig(source):null;finding.location=source&&loaded?.text&&finding.keyPath?locateNode(loaded.text,source.format,finding.keyPath):null;finding.rule=ruleFor(finding,observations.find(item=>item.client===finding.client)?.version??null);
    const verifiedSurface={codex:"codex-cli",claude:"claude-cli",cursor:"cursor-ide",vscode:"vscode-chat"}[finding.client];
    if(["verified","documented"].includes(finding.rule.versionStatus)&&context.surfaces[finding.client]!==verifiedSurface)finding.rule.versionStatus="unknown";
    if(finding.rule.versionStatus==="unknown"&&finding.confidence==="inferred"){finding.confidence="unknown";finding.repair=null;}}
  const stage = (code: string) => /PARSE|DUPLICATE|COMPLEXITY|UNSAFE|UNREADABLE/.test(code) ? 0 : /ROOT|PROFILE|TRUST|MANAGED|OVERRIDE/.test(code) ? 1 : /VAR|INPUT|ENVFILE/.test(code) ? 2 : /COMMAND|CWD|RELATIVE|LAUNCHER|TRANSPORT|REQUIRED/.test(code) ? 3 : 4;
  findings.sort((a, b) => stage(a.code) - stage(b.code));
  return { schemaVersion: 1, kind: "configuration-scan", createdAt: new Date().toISOString(), context, sources, servers, findings, comparisons, observations, mapping: mapping.version, network, notes: ["扫描仅读取已知路径，不启动 MCP 服务、凭据 helper 或模型。", "字段来源和加载状态按已知规则推断；托管策略、未知启动覆盖、动态注册、Profile 和已有会话状态可能改变结果。", "PATH、环境变量与安装入口属于诊断进程，不代表正在运行的 IDE/桌面会话。", "同名服务只是匹配候选；差异可能有意，修复不会自动同步所有客户端。", "复杂 TOML、项目信任、工具权限、OAuth 和远程状态不自动修改。"] };
}
export function sourceDefinition(report: ScanReport, server: DiagnosticServer): { raw: Record<string, unknown>; source: ConfigSource } {
  // Rehydrate from current files instead of persisting credentials in a scan.
  const fresh = scan({ ...report.context });
  if(fresh.mapping?.contentHash!==report.mapping?.contentHash||fresh.mapping?.state!==report.mapping?.state)throw new Error("服务映射已变化，请重新扫描");
  if (fresh.sources.length !== report.sources.length || fresh.sources.some(source => !report.sources.some(previous => previous.id === source.id && previous.state === source.state && previous.contentHash === source.contentHash))) throw new Error("配置来源已变化，请重新扫描");
  const current = fresh.servers.find(item => item.id === server.id);
  if (!current) throw new Error("服务定义已改变或无法解释，请重新扫描");
  const merged: Record<string, unknown> = {};
  for (const origin of current.origins.filter(origin => !origin.field.includes("."))) {
    const source = fresh.sources.find(item => item.id === origin.sourceId)!;
    const previous = report.sources.find(item => item.id === source.id);
    if (!previous || previous.contentHash !== source.contentHash) throw new Error("配置已变化，请重新扫描");
    const loaded = readConfig(source); if (loaded.state !== "readable") throw new Error("无法读取服务来源");
    merged[origin.field] = at(loaded.value, origin.keyPath);
  }
  // Leaf origins preserve merged env maps across Codex layers.
  for (const origin of current.origins.filter(origin => origin.field.includes("."))) {
    const source = fresh.sources.find(item => item.id === origin.sourceId)!;
    const previous = report.sources.find(item => item.id === source.id);
    if (!previous || previous.contentHash !== source.contentHash) throw new Error("配置已变化，请重新扫描");
    const boundary = origin.field.indexOf(".");
    const field = origin.field.slice(0, boundary), child = origin.field.slice(boundary + 1);
    merged[field] = { ...record(merged[field]), [child]: at(readConfig(source).value, origin.keyPath) };
  }
  return { raw: merged, source: fresh.sources.find(item => item.id === current.sourceId)! };
}
