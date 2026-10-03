#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { createExample, createFromSource, loadConfig, resolveServer, serverHash } from "./config.js";
import { findClaudeJs, findExecutable, version } from "./process.js";
import { runProcess } from "./process.js";
import { probe } from "./probe.js";
import { compareReports, hasRegression, loadReport, verifyEvidence, writeReport } from "./report.js";
import { runSuite } from "./runner.js";
import { isExpectedAuthReply } from "./auth.js";
import type { ClientName, DoctorConfig } from "./types.js";
import { configurationCli, configurationCommands } from "./diagnostics/cli.js";
import { installInterruptCleanup } from "./diagnostics/execution.js";
import { inspectImportSource } from "./import-source.js";

const [command, ...args] = process.argv.slice(2);
function option(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
function positionals(): string[] { return args.filter((x, i) => !x.startsWith("--") && (i === 0 || !args[i - 1]?.startsWith("--"))); }
function help(): void {
  console.log(`AI Plugin Doctor 0.1.0
Usage:
  doctor init [source-directory-or-mcp-config] [doctor.yaml] [--server name | --entry bin-name] [--cwd directory] [--proxy-url http://127.0.0.1:port] [--codex-model id] [--claude-model id]
  doctor init <source-directory-or-mcp-config> --list
  doctor preflight [doctor.yaml] [--live-auth]
  doctor run [doctor.yaml] [--client codex|claude|all] [--case id] [--out directory]
  doctor report <run-directory>
  doctor compare <before/report.json> <after/report.json>
  doctor scan --workspace directory [--clients codex,claude,cursor,vscode] [--out new-directory]
  doctor diagnose <scan.json> [--service id]
  doctor map <scan.json> --services id,id
  doctor network-check <scan.json> --client client --out new-file.json
  doctor check <scan.json> --service id [--native] --out new-file.json
  doctor plan <scan.json> --finding id[,id] [--value path-or-type] --out plan.json
  doctor apply <plan.json> --dry-run
  doctor apply <plan.json> --out operation.json
  doctor verify <operation.json> --out new-directory
  doctor restore <operation.json> --out recovery.json
  doctor share <scan.json> --out share.json
  doctor import-evidence <scan.json> <native-record.json> --out evidence.json

Scan context: --versions client=x.y.z,... --surfaces client=surface,...
doctor.yaml uses JSON syntax, which is a valid YAML 1.2 subset. Build before running the example.`);
}
async function checkClaudeAuth(script: string | null, config: DoctorConfig): Promise<"verified" | "failed" | "unknown"> {
  if (!script) return "unknown";
  const env = { ...process.env, ...(config.proxyUrl ? { HTTPS_PROXY: config.proxyUrl, HTTP_PROXY: config.proxyUrl } : {}) };
  const dir = mkdtempSync(join(process.cwd(), "doctor-auth-"));
  try {
    const stdoutPath = join(dir, "stdout.jsonl");
    const stderrPath = join(dir, "stderr.log");
    const mcpPath = join(dir, "empty-mcp.json");
    writeFileSync(mcpPath, '{"mcpServers":{}}');
    const result = await runProcess(process.execPath, [script, "--bare", "-p", "Reply OK", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--strict-mcp-config", "--mcp-config", mcpPath, ...(config.claudeModel ? ["--model", config.claudeModel] : []), "--permission-mode", "dontAsk", "--tools", "", "--allowedTools", "", "--max-budget-usd", String(config.maxClaudeBudgetUsd ?? 0.15)], {
      cwd: dir, env, stdoutPath, stderrPath, timeoutMs: Math.min(config.timeoutMs ?? 120000, 45000),
    });
    const output = readFileSync(stdoutPath, "utf8");
    const diagnostics = readFileSync(stderrPath, "utf8");
    let expectedReply = false;
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      try {
        const event = JSON.parse(line) as { type?: string; is_error?: boolean; result?: string };
        if (event.type === "result" && result.exitCode === 0 && !event.is_error && isExpectedAuthReply(event.result)) expectedReply = true;
        if (event.is_error && /401|authentication_failed|invalid.*(?:key|token)/i.test(event.result ?? "")) return "failed";
      } catch { /* Ignore non-JSON diagnostics. */ }
    }
    if (/401|authentication_failed|invalid.*(?:key|token)/i.test(diagnostics)) return "failed";
    return expectedReply ? "verified" : "unknown";
  } finally {
    const target = resolve(dir);
    if (target.startsWith(resolve(process.cwd()) + sep) && target.split(sep).at(-1)?.startsWith("doctor-auth-")) rmSync(target, { recursive: true, force: true });
  }
}
async function main(): Promise<void> {
  if (!command || command === "help" || command === "--help") { help(); return; }
  if (configurationCommands.includes(command)) { await configurationCli(command, args); return; }
  const positional = positionals();
  if (command === "init") {
    const initPositionals: string[] = [], initOptions = new Map<string,string>();
    let list = false;
    for (let index=0;index<args.length;index++) {
      const arg=args[index]!;
      if(arg==="--list"){if(list)throw new Error("--list 重复");list=true;continue;}
      if(arg.startsWith("--")) {
        if(!["--server","--entry","--cwd","--proxy-url","--codex-model","--claude-model"].includes(arg))throw new Error("init 包含未知选项；请查看 help");
        if(initOptions.has(arg))throw new Error(`${arg} 重复`);
        const value=args[++index];if(!value||value.startsWith("--"))throw new Error(`${arg} requires a value`);initOptions.set(arg,value);
      } else initPositionals.push(arg);
    }
    if(list){
      if(initPositionals.length!==1||initOptions.size)throw new Error("--list 只接受一个来源路径，不创建输出；请在列出后单独执行导入");
      const inspected=inspectImportSource(initPositionals[0]!);
      console.log(JSON.stringify({source:inspected.file,kind:inspected.kind,entries:inspected.entries,nextStep:inspected.kind==="mcp"?"使用 --server 选择服务；必要时用 --cwd 指定原客户端目录。":"使用 --entry 选择本地 bin/main 入口。",startedServices:false},null,2));return;
    }
    if (initPositionals.length > 2) throw new Error("init accepts at most a source and output path");
    const source = initPositionals[0] ? resolve(initPositionals[0]) : undefined;
    if ((initPositionals.length === 2 || initOptions.has("--server") || initOptions.has("--entry") || initOptions.has("--cwd")) && (!source || !existsSync(source))) throw new Error(`Source not found: ${source}`);
    const fromSource = source && existsSync(source);
    const path = resolve(fromSource ? initPositionals[1] ?? "doctor.yaml" : initPositionals[0] ?? "doctor.yaml");
    if (fromSource) console.log(JSON.stringify(createFromSource(source, path, initOptions.get("--server"), initOptions.get("--proxy-url"), initOptions.get("--codex-model"), initOptions.get("--claude-model"), {cwd:initOptions.get("--cwd"),entry:initOptions.get("--entry")}),null,2)); else createExample(path, initOptions.get("--proxy-url"), initOptions.get("--codex-model"), initOptions.get("--claude-model"));
    console.log(`Created ${path}`); return;
  }
  if (command === "preflight") {
    const path = resolve(positional[0] ?? "doctor.yaml");
    const config = loadConfig(path);
    const server = resolveServer(config, path);
    const codex = process.env.DOCTOR_CODEX_EXE ?? findExecutable("codex");
    const claude = findClaudeJs();
    let claudeEndpoint: "official" | "custom" | "default" = "default";
    if (process.env.ANTHROPIC_BASE_URL) {
      try { claudeEndpoint = new URL(process.env.ANTHROPIC_BASE_URL).hostname === "api.anthropic.com" ? "official" : "custom"; }
      catch { claudeEndpoint = "custom"; }
    }
    const codexAuth = codex ? spawnSync(codex, ["login", "status"], { encoding: "utf8", timeout: 6000, windowsHide: true, env: { ...process.env, CODEX_HOME: process.env.CODEX_HOME ?? resolve(process.env.USERPROFILE ?? "", ".codex") } }).status === 0 : false;
    const result = await probe(server, config.probeCall);
    const liveAuth = args.includes("--live-auth") ? await checkClaudeAuth(claude, config) : null;
    const summary = {
      node: process.version,
      proxyConfigured: Boolean(config.proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY),
      serverHash: serverHash(server),
      protocol: result,
      clients: {
        codex: { installed: Boolean(codex), version: codex ? version(codex, ["--version"]) : null, authAvailable: codexAuth },
        claude: { installed: Boolean(claude), version: claude ? version(process.execPath, [claude, "--version"]) : null, credentialPresent: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN), credentialValidity: liveAuth ?? "not-verified", endpoint: claudeEndpoint, modelOverridePresent: Boolean(process.env.ANTHROPIC_MODEL) },
      },
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!result.ok || liveAuth === "failed") process.exitCode = 2;
    return;
  }
  if (command === "run") {
    const path = resolve(positional[0] ?? "doctor.yaml");
    const config = loadConfig(path);
    const selected = option("--client");
    if (selected && !["codex", "claude", "all"].includes(selected)) throw new Error("--client must be codex, claude, or all");
    const selectedCase = option("--case");
    if (selectedCase) {
      config.cases = config.cases.filter(item => item.id === selectedCase);
      if (!config.cases.length) throw new Error(`Case not found: ${selectedCase}`);
    }
    const selectedClients: ClientName[] | undefined = selected && selected !== "all" ? [selected as ClientName] : undefined;
    const out = resolve(option("--out") ?? `runs/${new Date().toISOString().replace(/[:.]/g, "-")}`);
    const report = await runSuite(config, path, out, selectedClients);
    console.log(`Report: ${resolve(out, "report.html")}`);
    if (report.trials.some(trial => trial.layers.E0.verdict === "FAIL" || trial.layers.E1.verdict !== "PASS" || trial.layers.E2.verdict !== "PASS" || trial.layers.E3.verdict !== "PASS")) process.exitCode = 2;
    return;
  }
  if (command === "report") {
    const directory = resolve(positional[0] ?? "");
    if (!existsSync(resolve(directory, "report.json"))) throw new Error("report.json not found");
    const report = loadReport(resolve(directory, "report.json"));
    verifyEvidence(directory, report);
    writeReport(directory, report);
    console.log(resolve(directory, "report.html")); return;
  }
  if (command === "compare") {
    if (positional.length !== 2) throw new Error("compare needs two report.json files");
    const before = loadReport(resolve(positional[0]!));
    const after = loadReport(resolve(positional[1]!));
    console.log(compareReports(before, after));
    if (hasRegression(before, after)) process.exitCode = 2;
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
installInterruptCleanup();
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
