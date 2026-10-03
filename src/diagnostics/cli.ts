import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { scan, diagnosticClients } from "./scan.js";
import { readOrdinary, record, ordinaryPath } from "./parsers.js";
import { checkServer, importNativeEvidence } from "./check.js";
import { makePlan, previewPlan, applyPlan, verifyOperation, restoreOperation } from "./repair.js";
import type { DiagnosticClient, RepairOperation, RepairPlan, ScanOptions, ScanReport } from "./types.js";
import { scanHtml } from "./report.js";
export { scanHtml } from "./report.js";
import { confirmMapping } from "./identity.js";
import { loopbackProxyCheck } from "./network.js";

export const configurationCommands = ["scan", "diagnose", "check", "plan", "apply", "verify", "restore", "import-evidence", "share", "map", "network-check"];
function json(path: string): unknown { try { return JSON.parse(readOrdinary(resolve(path)).toString("utf8")); } catch { throw new Error("输入文件不是受支持的普通 JSON 文件"); } }
export function loadScan(path: string): ScanReport {
  const saved = record(json(path));
  if (saved.kind !== "configuration-scan" || saved.schemaVersion !== 1 || !Array.isArray(saved.sources)) throw new Error("需要配置扫描报告");
  const context = record(saved.context);
  if (typeof context.workspace !== "string" || typeof context.home !== "string" || !Array.isArray(context.clients)) throw new Error("扫描上下文无效");
  // Rebuild public data from files; arbitrary text from imported snapshots is never echoed.
  const fresh = scan(context as unknown as ScanOptions);
  if(record(saved.mapping).contentHash!==fresh.mapping?.contentHash||record(saved.mapping).state!==fresh.mapping?.state)throw new Error("服务映射已经变化，请重新扫描");
  if (fresh.sources.length !== saved.sources.length || fresh.sources.some(source => !(saved.sources as unknown[]).some(value => { const prior = record(value); return prior.id === source.id && prior.state === source.state && prior.contentHash === source.contentHash; }))) throw new Error("配置已经变化，请重新扫描后继续");
  return fresh;
}
function newFile(path: string, value: unknown): void {
  path = resolve(path);
  if (!ordinaryPath(path) || existsSync(path)) throw new Error("输出必须是新的普通文件，避免覆盖已有证据");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
function writeScan(directory: string, report: ScanReport): void {
  directory = resolve(directory);
  if (!ordinaryPath(directory) || existsSync(directory)) throw new Error("报告目录必须为新普通目录");
  mkdirSync(directory, { recursive: true });
  newFile(join(directory, "scan.json"), report);
  writeFileSync(join(directory, "report.html"), scanHtml(report), { flag: "wx", mode: 0o600 });
}
export function shareReport(report: ScanReport): unknown {
  // Local paths, names, variable names, hashes and executable paths may identify the user.
  // Share only deterministic categories and counts; no arbitrary configuration strings.
  return { schemaVersion: 1, kind: "configuration-share", clients: report.context.clients,
    location: report.context.location, sourceStates: report.sources.map(source => ({ client: source.client, scope: source.scope, state: source.state })),
    services: report.servers.map(server => ({ client: server.client, transport: server.transport, enabled: server.enabled, argumentCount: server.argumentCount })),
    findings: report.findings.map(finding => ({ client: finding.client, code: finding.code, severity: finding.severity, confidence: finding.confidence, evidenceKind: finding.evidenceKind })),
    comparisons: report.comparisons.map(comparison => ({ count: comparison.serverIds.length, differingFields: comparison.differingFields, credentialRelation: comparison.credentialRelation })), nativeSession: "UNKNOWN" };
}
export async function configurationCli(command: string, args: string[]): Promise<void> {
  const options = new Map<string, string>(); const flags = new Set<string>(); const positional: string[] = [];
  const valueOptions = ["--workspace", "--home", "--clients", "--profile", "--codex-home", "--claude-config-dir", "--vscode-config", "--location", "--out", "--service", "--finding", "--value", "--versions", "--surfaces", "--services", "--client"];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (["--native", "--dry-run", "--launch-overrides"].includes(arg)) { flags.add(arg); continue; }
    if (arg.startsWith("--")) { if (!valueOptions.includes(arg) || !args[index + 1] || args[index + 1]!.startsWith("--") || options.has(arg)) throw new Error("选项无效、重复或缺少值"); options.set(arg, args[++index]!); }
    else positional.push(arg);
  }
  const out = options.get("--out");
  if (out && (!ordinaryPath(resolve(out)) || existsSync(resolve(out)))) throw new Error("输出路径必须是新的普通文件或目录");
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (command === "scan") {
    if (positional.length) throw new Error("scan 请使用 --workspace 指定工作区");
    const clients = options.get("--clients")?.split(",") as DiagnosticClient[] | undefined;
    if (clients?.some(client => !diagnosticClients.includes(client))) throw new Error("客户端选项无效");
    const location = options.get("--location") as "local" | "remote" | undefined; if (location && location !== "local" && location !== "remote") throw new Error("位置必须是 local 或 remote");
    const pairs=(value:string|undefined)=>Object.fromEntries((value??"").split(",").filter(Boolean).map(item=>{const pair=item.split("=");if(pair.length!==2||!diagnosticClients.includes(pair[0] as DiagnosticClient))throw new Error("版本/入口需使用 client=value");return pair;}));
    const report = scan({ workspace: options.get("--workspace") ?? process.cwd(), home: options.get("--home"), clients, profile: options.get("--profile"), codexHome: options.get("--codex-home"), claudeConfigDir: options.get("--claude-config-dir"), vscodeConfig: options.get("--vscode-config"), location, launchOverrides: flags.has("--launch-overrides"),clientVersions:pairs(options.get("--versions")),surfaces:pairs(options.get("--surfaces")) });
    const directory = out ?? `runs/config-${Date.now()}`; writeScan(directory, report);
    print({ report: resolve(directory, "report.html"), snapshot: resolve(directory, "scan.json"), servers: report.servers.map(({ id, client, name }) => ({ id, client, name })), findings: report.findings.length }); return;
  }
  if (!positional[0]) throw new Error("请提供扫描报告、修复计划或操作记录路径");
  if (["apply", "verify", "restore"].includes(command)) {
    if (!out && !flags.has("--dry-run")) throw new Error("请提供 --out 保存新的操作证据");
    if (command === "apply") {
      const plan = json(positional[0]) as RepairPlan;
      if (flags.has("--dry-run")) { print(previewPlan(plan)); return; }
      if (!ordinaryPath(resolve(out!))) throw new Error("输出路径不安全");
      mkdirSync(dirname(resolve(out!)), { recursive: true });
      const operation = applyPlan(plan, resolve(out!)); print({ operation: resolve(out!), status: operation.status, backups: operation.files.map(file => file.backup) }); return;
    }
    const operation = json(positional[0]) as RepairOperation;
    if (operation.kind !== "configuration-repair-operation" || !/^[a-f0-9-]{36}$/.test(operation.id)) throw new Error("需要有效的修复操作记录");
    if (command === "verify") { const verified = verifyOperation(operation); writeScan(out!, verified.scan); newFile(join(out!, "verification.json"), verified.operation.verification); print(verified.operation.verification); if (verified.operation.verification?.configuration !== "PASS") process.exitCode = 2; return; }
    // Reserve recovery journal before changing any file; partial failures are marked conflict.
    newFile(out!, { schemaVersion: 1, kind: "configuration-recovery", operationId: operation.id, status: "pending" });
    try { const restored = restoreOperation(operation); writeFileSync(resolve(out!), JSON.stringify({ schemaVersion: 1, kind: "configuration-recovery", operationId: restored.id, status: restored.status }, null, 2)); print({ recovery: resolve(out!), status: restored.status }); }
    catch { writeFileSync(resolve(out!), JSON.stringify({ schemaVersion: 1, kind: "configuration-recovery", operationId: operation.id, status: "conflict" })); throw new Error("恢复未全部完成，请核对操作记录、目标文件和备份；没有宣告恢复成功"); }
    return;
  }
  const report = loadScan(positional[0]);
  if (command === "diagnose") { const service = options.get("--service");if(service&&!report.servers.some(item=>item.id===service))throw new Error("服务 ID 不在扫描报告中");print({servers:report.servers.filter(item=>!service||item.id===service),findings: report.findings.filter(finding => !service || finding.serverId === service), comparisons: report.comparisons.filter(group=>!service||group.serverIds.includes(service)),network:report.network,notes: report.notes }); return; }
  if(command==="map"){const ids=options.get("--services")?.split(",")??[];print({mapping:confirmMapping(report,ids),nextStep:"重新扫描后使用已确认映射生成修复计划。"});return;}
  if (!out) throw new Error("请提供 --out 保存新的证据文件");
  if (command === "share") { newFile(out, shareReport(report)); print({ share: resolve(out), containsLocalPaths: false }); return; }
  if (command === "plan") { const plan = makePlan(report, options.get("--finding")?.split(",") ?? [], options.get("--value")); newFile(out, plan); print({ plan: resolve(out), preview:plan.edits.length?previewPlan(plan):[],manualPatches:plan.manualPatches, manualSteps: plan.manualSteps }); return; }
  if(command==="network-check"){const client=options.get("--client") as DiagnosticClient;if(!diagnosticClients.includes(client))throw new Error("网络检查需选择扫描中的客户端");console.error("将仅连接诊断进程已配置的回环代理 TCP 端口；不发送认证或模型请求。");const result=await loopbackProxyCheck(report,client);newFile(out,result);print(result);return;}
  if (command === "import-evidence") { if (!positional[1]) throw new Error("请提供原生取证 JSON 文件"); const evidence = importNativeEvidence(report, json(positional[1])); newFile(out, evidence); print(evidence); return; }
  const service = options.get("--service"); if (!service) throw new Error("check 必须使用 --service 选择一个服务；会启动该服务");
  const selected=report.servers.find(item=>item.id===service);if(!selected)throw new Error("服务 ID 不在扫描报告中");console.error(JSON.stringify({action:flags.has("--native")&&selected.client==="codex"?"读取本次 CLI 配置，不启动 MCP":"检查选中服务，受支持入口会启动服务",client:selected.client,serverId:service,executable:selected.resolvedExecutable,argumentCount:selected.argumentCount,cwd:selected.cwd??"工作区（原生可能不同）",credentials:"值隐藏；不调用业务工具或模型"}));
  const evidence = await checkServer(report, service, flags.has("--native")); newFile(out, evidence); print(evidence); if (evidence.status === "FAIL") process.exitCode = 2;
}
