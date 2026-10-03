import test from "node:test";
import { spawnSync, spawn } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, renameSync } from "node:fs";
import { join, resolve, sep, delimiter } from "node:path";
import { scan, sourceDefinition } from "./scan.js";
import { makePlan, previewPlan, applyPlan, verifyOperation, restoreOperation } from "./repair.js";
import { checkServer, importNativeEvidence } from "./check.js";
import { scanHtml, shareReport, loadScan } from "./cli.js";
import { runCaptured } from "./execution.js";
import { confirmMapping } from "./identity.js";
import { classifyAuthFailure, observeNetwork, loopbackProxyCheck } from "./network.js";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import type { ScanOptions, ScanReport } from "./types.js";

const sandbox = resolve("runs/diagnostics-tests"); mkdirSync(sandbox, { recursive: true });
function fixture(t: { after: (callback: () => void) => void }) {
  const root = mkdtempSync(join(sandbox, "case-"));
  t.after(() => { const target = resolve(root); assert.ok(target.startsWith(sandbox + sep)); rmSync(target, { recursive: true, force: true }); });
  const workspace = join(root, "workspace"), home = join(root, "home"); mkdirSync(workspace); mkdirSync(home);
  const options: ScanOptions = { workspace, home, env: { PATH: "" }, codexSystemDir: join(root, "system-codex"), claudeManagedDir: join(root, "managed-claude"),clientVersions:{codex:"0.159.2",claude:"2.1.89",vscode:"1.120.0"},surfaces:{codex:"codex-cli",claude:"claude-cli",cursor:"cursor-ide",vscode:"vscode-chat"} };
  const put = (path: string, value: unknown) => { const file = join(root, path); mkdirSync(resolve(file, ".."), { recursive: true }); writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); return file; };
  const service = { command: process.execPath, args: [] as string[] };
  return { root, workspace, home, options, put, service, read: () => scan(options) };
}
type Fixture = ReturnType<typeof fixture>;
const scenarios: Array<[string, (f: Fixture) => void, (r: ScanReport, f: Fixture) => void]> = [
  ["01 JSON syntax", f => f.put("home/.claude.json", '{"mcpServers":'), r => assert.ok(r.findings.some(x => x.code === "CFG_PARSE_ERROR"))],
  ["02 JSONC comments/trailing comma", f => f.put("workspace/.vscode/mcp.json", `{// comment\n"servers":{"demo":{"command":${JSON.stringify(process.execPath)},},},}`), r => assert.equal(r.servers.filter(x => x.client === "vscode").length, 1)],
  ["03 TOML parse", f => f.put("home/.codex/config.toml", `[mcp_servers.demo]\ncommand=${JSON.stringify(process.execPath)}\nargs=[]`), r => assert.equal(r.servers[0]?.client, "codex")],
  ["04 duplicate key", f => f.put("home/.claude.json", '{"mcpServers":{},"mcpServers":{}}'), r => assert.ok(r.findings.some(x => x.code === "CFG_DUPLICATE_KEY"))],
  ["05 wrong root", f => f.put("workspace/.vscode/mcp.json", { mcpServers: { demo: f.service } }), r => assert.ok(r.findings.some(x => x.code === "CFG_ROOT_KEY" && x.repair === "root"))],
  ["06 required entry", f => f.put("home/.claude.json", { mcpServers: { demo: {} } }), r => assert.ok(r.findings.some(x => x.code === "CFG_REQUIRED_FIELD"))],
  ["07 Claude local replaces whole entry", f => { f.put("home/.claude.json", { mcpServers: { demo: { ...f.service, env: { KEEP: "global" } } }, projects: { [f.workspace.replaceAll("\\", "/")]: { mcpServers: { demo: { ...f.service, args: ["local"] } } } } }); }, (r, f) => { assert.deepEqual(sourceDefinition(r, r.servers[0]!).raw.args, ["local"]); assert.equal(sourceDefinition(r, r.servers[0]!).raw.env, undefined); }],
  ["08 project replaces user", f => { f.put("home/.cursor/mcp.json", { mcpServers: { demo: { ...f.service, args: ["user"] } } }); f.put("workspace/.cursor/mcp.json", { mcpServers: { demo: f.service } }); }, r => { assert.equal(r.servers[0]?.argumentCount, 0); assert.ok(r.findings.some(x => x.code === "CFG_SHADOWED" && x.severity === "info")); }],
  ["09 Codex trust", f => f.put("workspace/.codex/config.toml", `[mcp_servers.demo]\ncommand=${JSON.stringify(process.execPath)}`), r => { assert.equal(r.servers.length, 0); assert.ok(r.findings.some(x => x.code === "PROJECT_TRUST_REQUIRED")); }],
  ["10 unknown launch overrides", f => { f.options.launchOverrides = true; f.put("home/.claude.json", { mcpServers: { demo: f.service } }); }, r => { assert.equal(r.servers[0]?.state, "unknown"); assert.ok(r.findings.some(x => x.code === "LAUNCH_OVERRIDE_UNOBSERVED")); }],
  ["11 unknown Profile", f => { f.options.profile = "missing"; }, r => assert.ok(r.findings.some(x => x.code === "PROFILE_UNOBSERVED" && x.confidence === "unknown"))],
  ["12 managed source unsafe/unreadable", f => { mkdirSync(join(f.root, "managed-claude", "managed-mcp.json"), { recursive: true }); f.put("home/.claude.json", { mcpServers: { demo: f.service } }); }, r => { assert.ok(r.findings.some(x => x.code === "MANAGED_STATE_UNOBSERVED")); assert.equal(r.servers[0]?.state, "unknown"); }],
  ["13 variable dialect", f => f.put("home/.claude.json", { mcpServers: { demo: { ...f.service, env: { KEY: "${env:KEY}" } } } }), r => assert.ok(r.findings.some(x => x.code === "VAR_DIALECT_MISMATCH"))],
  ["14 missing variable", f => f.put("home/.claude.json", { mcpServers: { demo: { ...f.service, env: { KEY: "${KEY}" } } } }), r => assert.ok(r.findings.some(x => x.code === "VAR_MISSING" && x.confidence === "inferred"))],
  ["15 VS Code input unknown", f => f.put("workspace/.vscode/mcp.json", { servers: { demo: { ...f.service, env: { KEY: "${input:key}" } } } }), r => assert.ok(r.findings.some(x => x.code === "INPUT_VALUE_UNOBSERVED" && x.confidence === "unknown"))],
  ["16 envFile missing", f => f.put("workspace/.vscode/mcp.json", { servers: { demo: { ...f.service, envFile: "not-present.env" } } }), r => assert.ok(r.findings.some(x => x.code === "ENVFILE_MISSING"))],
  ["17 command missing", f => f.put("home/.claude.json", { mcpServers: { demo: { command: "missing-exe-98271" } } }), r => assert.ok(r.findings.some(x => x.code === "COMMAND_NOT_FOUND"))],
  ["18 cwd and relative paths", f => f.put("workspace/.vscode/mcp.json", { servers: { demo: { ...f.service, cwd: "missing", args: ["./server.js"] } } }), r => { assert.ok(r.findings.some(x => x.code === "CWD_MISSING")); assert.ok(r.findings.some(x => x.code === "RELATIVE_PATH_CONTEXT")); }],
  ["19 multiple installations", f => { const name = process.platform === "win32" ? "demo.exe" : "demo"; f.put(`one/${name}`, ""); f.put(`two/${name}`, ""); f.options.env = { PATH: [join(f.root, "one"), join(f.root, "two")].join(delimiter) }; f.put("home/.claude.json", { mcpServers: { demo: { command: "demo" } } }); }, r => assert.ok(r.findings.some(x => x.code === "MULTIPLE_INSTALLATIONS"))],
  ["20 Windows script launcher", f => { f.put("home/.claude.json", { mcpServers: { demo: { command: f.put("launcher.cmd", "@exit /b 0") } } }); }, r => assert.equal(r.findings.some(x => x.code === "WINDOWS_LAUNCHER_MISMATCH"), process.platform === "win32")],
  ["21 intentionally disabled", f => f.put("home/.claude.json", { mcpServers: { demo: { ...f.service, disabled: true } } }), r => { assert.equal(r.servers[0]?.enabled, false); assert.ok(r.findings.some(x => x.code === "SERVER_DISABLED" && x.repair === null)); }],
  ["22 permission deny", f => { f.put("home/.claude.json", { mcpServers: { demo: f.service } }); f.put("workspace/.claude/settings.json", { permissions: { deny: ["mcp__demo__delete"] } }); }, r => assert.ok(r.findings.some(x => x.code === "TOOL_FILTERED" && x.repair === null))],
  ["23 remote context", f => { f.options.location = "remote"; }, r => assert.ok(r.findings.some(x => x.code === "EXECUTION_LOCATION_UNSUPPORTED" && x.confidence === "unknown"))],
  ["24 multi fault ordered", f => f.put("workspace/.vscode/mcp.json", { servers: { demo: { command: "missing", env: { KEY: "${env:KEY}" }, cwd: "missing" } } }), r => { const codes = r.findings.map(x => x.code); assert.ok(codes.indexOf("VAR_MISSING") < codes.indexOf("COMMAND_NOT_FOUND")); assert.ok(codes.includes("CWD_MISSING")); }],
];
for (const [name, setup, check] of scenarios) test(`scenario ${name}`, t => { const f = fixture(t); setup(f); check(f.read(), f); });

// One explicit correct/expected-unknown counterpart for every scenario above.
const pairedControls:Array<(f:Fixture)=>void>=[
 f=>f.put("home/.claude.json",{mcpServers:{demo:f.service}}),
 f=>f.put("workspace/.vscode/mcp.json",{servers:{demo:f.service}}),
 f=>f.put("home/.codex/config.toml",`[mcp_servers.demo]\ncommand=${JSON.stringify(process.execPath)}\nargs=[]`),
 f=>f.put("home/.claude.json",'{"mcpServers":{}}'),
 f=>f.put("workspace/.vscode/mcp.json",{servers:{demo:f.service}}),
 f=>f.put("home/.claude.json",{mcpServers:{demo:f.service}}),
 f=>f.put("home/.claude.json",{mcpServers:{demo:f.service},projects:{[f.workspace.replaceAll("\\","/")]:{mcpServers:{demo:f.service}}}}),
 f=>{f.put("home/.cursor/mcp.json",{mcpServers:{demo:f.service}});f.put("workspace/.cursor/mcp.json",{mcpServers:{demo:f.service}});},
 f=>{f.put("home/.codex/config.toml",`[projects.${JSON.stringify(f.workspace)}]\ntrust_level="trusted"`);f.put("workspace/.codex/config.toml",`[mcp_servers.demo]\ncommand=${JSON.stringify(process.execPath)}`);},
 f=>{f.options.launchOverrides=false;f.put("home/.claude.json",{mcpServers:{demo:f.service}});},
 f=>{f.options.profile=null;f.put("home/.codex/config.toml",`[mcp_servers.demo]\ncommand=${JSON.stringify(process.execPath)}`);},
 f=>{f.put("managed-claude/managed-mcp.json",{mcpServers:{demo:f.service}});},
 f=>{f.options.env={KEY:"present"};f.put("home/.claude.json",{mcpServers:{demo:{...f.service,env:{KEY:"${KEY}"}}}});},
 f=>{f.options.env={KEY:"present"};f.put("home/.claude.json",{mcpServers:{demo:{...f.service,env:{KEY:"${KEY}"}}}});},
 f=>f.put("workspace/.vscode/mcp.json",{servers:{demo:{...f.service,env:{KEY:"literal"}}}}),
 f=>{f.put("workspace/present.env","KEY=value");f.put("workspace/.vscode/mcp.json",{servers:{demo:{...f.service,envFile:"present.env"}}});},
 f=>f.put("home/.claude.json",{mcpServers:{demo:f.service}}),
 f=>f.put("workspace/.vscode/mcp.json",{servers:{demo:{...f.service,cwd:f.workspace,args:[process.execPath]}}}),
 f=>f.put("home/.claude.json",{mcpServers:{demo:f.service}}),
 f=>f.put("home/.claude.json",{mcpServers:{demo:f.service}}),
 f=>f.put("home/.claude.json",{mcpServers:{demo:{...f.service,disabled:false}}}),
 f=>{f.put("home/.claude.json",{mcpServers:{demo:f.service}});f.put("workspace/.claude/settings.json",{permissions:{deny:[]}});},
 f=>{f.options.location="local";f.put("home/.claude.json",{mcpServers:{demo:f.service}});},
 f=>f.put("workspace/.vscode/mcp.json",{servers:{demo:{...f.service,cwd:f.workspace}}}),
];
pairedControls.forEach((setup,index)=>test(`paired correct control ${scenarios[index]![0]}`,t=>{const f=fixture(t);setup(f);const r=f.read();assert.equal(r.findings.filter(x=>x.severity==="error").length,0);assert.equal(r.findings.filter(x=>x.repair).length,0);}));

const controls: Array<[string, (f: Fixture) => void]> = [
  ["Claude literal executable", f => f.put("home/.claude.json", { mcpServers: { demo: f.service } })],
  ["Cursor variable supplied", f => { f.options.env = { KEY: "supplied" }; f.put("home/.cursor/mcp.json", { mcpServers: { demo: { ...f.service, env: { KEY: "${env:KEY}" } } } }); }],
  ["Claude default value", f => f.put("home/.claude.json", { mcpServers: { demo: { ...f.service, env: { KEY: "${KEY:-fallback}" } } } })],
  ["VS Code workspace variable", f => f.put("workspace/.vscode/mcp.json", { servers: { demo: { ...f.service, cwd: "${workspaceFolder}" } } })],
  ["Claude explicit http", f => f.put("home/.claude.json", { mcpServers: { demo: { type: "http", url: "https://example.com/mcp" } } })],
  ["Claude SSE intentional", f => f.put("home/.claude.json", { mcpServers: { demo: { type: "sse", url: "https://example.com/sse" } } })],
  ["VS Code null env", f => f.put("workspace/.vscode/mcp.json", { servers: { demo: { ...f.service, env: { KEY: null } } } })],
  ["intentional cross-client difference", f => { f.put("home/.claude.json", { mcpServers: { demo: { ...f.service, args: ["one"] } } }); f.put("home/.cursor/mcp.json", { mcpServers: { demo: { ...f.service, args: ["two"] } } }); }],
  ["intentional override", f => { f.put("home/.cursor/mcp.json", { mcpServers: { demo: f.service } }); f.put("workspace/.cursor/mcp.json", { mcpServers: { demo: { ...f.service, args: ["two"] } } }); }],
  ["disabled by choice", f => f.put("home/.claude.json", { disabledMcpServers: ["demo"], mcpServers: { demo: f.service } })],
  ["Codex tool filtering by choice", f => f.put("home/.codex/config.toml", `[mcp_servers.demo]\ncommand=${JSON.stringify(process.execPath)}\nenabled_tools=["safe"]`)],
  ["unknown dynamic input stays unknown", f => f.put("workspace/.vscode/mcp.json", { servers: { demo: { ...f.service, env: { KEY: "${input:key}" } } } })],
];
for (const [name, setup] of controls) test(`healthy/intentional control ${name}`, t => { const f = fixture(t); setup(f); const r = f.read(); assert.equal(r.findings.filter(x => x.severity === "error").length, 0); assert.equal(r.findings.filter(x => x.repair).length, 0); });

test("passive scan never starts server/helper; public reports exclude arbitrary secrets", t => {
  const f = fixture(t), canary = "SECRET_CANARY_8912_VALUE";
  const marker = join(f.root, "started");
  const script = f.put("server.cjs", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`);
  f.put("home/.claude.json", { notes: canary, mcpServers: { demo: { command: process.execPath, args: [script, canary], env: { KEY: canary }, headersHelper: script }, remote: { type: "http", url: `https://user:${canary}@example.com/${canary}?token=${canary}`, headers: { Authorization: canary } } } });
  const report = f.read(); assert.equal(existsSync(marker), false);
  for (const output of [JSON.stringify(report), scanHtml(report), JSON.stringify(shareReport(report))]) assert.equal(output.includes(canary), false);
  assert.equal(JSON.stringify(shareReport(report)).includes(f.home), false);
  assert.ok(scanHtml({ ...report, servers: [{ ...report.servers[0]!, name: '<script>alert("x")</script>' }] }).includes("&lt;script&gt;"));
});

for (const repair of ["variable", "command", "cwd", "root"] as const) test(`repair lifecycle ${repair}`, t => {
  const f = fixture(t); f.options.clients = [repair === "root" || repair === "cwd" ? "vscode" : "claude"];
  if (repair === "variable") f.options.env = { KEY: "present" };
  const path = repair === "root" ? f.put("workspace/.vscode/mcp.json", `{// retained comment\n"mcpServers":{"demo":{"command":${JSON.stringify(process.execPath)}}}, "unrelated":true}`) : f.put("home/.claude.json", { unrelated: { keep: "SECRET_CANARY_UNRELATED" }, mcpServers: { demo: { ...f.service, ...(repair === "variable" ? { env: { KEY: "${env:KEY}" } } : repair === "command" ? { command: "missing" } : { cwd: "missing" }) } } });
  if (repair === "cwd") {
    f.put("workspace/.vscode/mcp.json", { unrelated: { keep: "SECRET_CANARY_UNRELATED" }, servers: { demo: { ...f.service, cwd: "missing" } } });
  }
  const target = repair === "cwd" ? join(f.workspace, ".vscode", "mcp.json") : path;
  const before = readFileSync(target); const report = f.read(); const finding = report.findings.find(x => x.repair === repair)!; assert.ok(finding);
  const plan = makePlan(report, [finding.id], repair === "command" ? process.execPath : repair === "cwd" ? f.workspace : undefined);
  assert.equal(JSON.stringify(plan).includes("SECRET_CANARY_UNRELATED"), false);
  assert.equal(previewPlan(plan)[0]?.contentChanged, true);
  const operation = applyPlan(plan, join(f.root, "operation.json"));
  assert.equal(verifyOperation(operation).operation.verification?.configuration, "PASS");
  assert.equal(verifyOperation(operation).operation.verification?.nativeSession, "UNKNOWN");
  if (repair === "root") assert.ok(readFileSync(target, "utf8").includes("// retained comment"));
  assert.ok(readFileSync(target, "utf8").includes(repair === "root" ? '"unrelated":true' : "SECRET_CANARY_UNRELATED"));
  restoreOperation(operation); assert.deepEqual(readFileSync(target), before);
});

test("stale scan/plan, concurrent lock, restore conflict and context change fail closed", t => {
  const f = fixture(t); const path = f.put("home/.claude.json", { mcpServers: { demo: { command: "missing" } } });
  const report = f.read(); const plan = makePlan(report, [report.findings.find(x => x.repair === "command")!.id], process.execPath);
  const snapshot = f.put("scan.json", report); const lock = join(resolve(path, ".."), ".claude.json.doctor.lock"); writeFileSync(lock, "other");
  assert.throws(() => applyPlan(plan, join(f.root, "op-lock.json")), /修复|锁/); assert.equal(readFileSync(lock, "utf8"), "other");
  rmSync(lock); const op = applyPlan(plan, join(f.root, "op.json"));
  assert.throws(() => previewPlan(plan), /变化/); assert.throws(() => loadScan(snapshot), /变化/);
  f.put("workspace/.claude/settings.local.json", { permissions: { deny: ["mcp__demo"] } });
  assert.equal(verifyOperation(op).operation.verification?.configuration, "FAIL");
  writeFileSync(path, '{"other":"external"}'); assert.throws(() => restoreOperation(op), /其他程序/); assert.equal(readFileSync(path, "utf8"), '{"other":"external"}');
});

test("failure writing second file restores first and journals rollback", t => {
  const f = fixture(t); f.put("home/.claude.json", { mcpServers: { demo: { command: "missing" } } }); f.put("home/.cursor/mcp.json", { mcpServers: { demo: { command: "missing" } } });
  confirmMapping(f.read(),f.read().servers.map(item=>item.id));const report = f.read(); const plan = makePlan(report, report.findings.filter(x => x.repair === "command").map(x => x.id), process.execPath);
  const before = plan.edits.map(x => readFileSync(x.path)); const journal = join(f.root, "op.json");
  assert.throws(() => applyPlan(plan, journal, { beforeWrite(index) { if (index === 1) throw new Error("injected"); } }), /已恢复/);
  plan.edits.forEach((edit, i) => assert.deepEqual(readFileSync(edit.path), before[i])); assert.equal(JSON.parse(readFileSync(journal, "utf8")).status, "rolled-back");
});

test("arbitrary repair field and permission changes cannot be imported", t => {
  const f = fixture(t); f.put("home/.claude.json", { mcpServers: { demo: { ...f.service, env: { KEY: "${env:KEY}" } } } });
  const report = f.read(); const plan = makePlan(report, [report.findings.find(x => x.repair === "variable")!.id]); plan.edits[0]!.keyPath = ["mcpServers", "demo", "permissions"];
  assert.throws(() => previewPlan(plan), /字段/);
  const evidence = importNativeEvidence(report, { client: "claude", serverId: report.servers[0]!.id, workspace: f.workspace, observedAt: new Date().toISOString(), status: "connected", surface: "claude-cli", log: "SECRET_CANARY" });
  assert.equal(evidence.status, "UNKNOWN"); assert.equal(JSON.stringify(evidence).includes("SECRET_CANARY"), false);
});

test("controlled replay discovers tools and never calls them or echoes process output", async t => {
  const f = fixture(t);
  const script = f.put("probe.cjs", `const rl=require('readline').createInterface({input:process.stdin}); rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'SECRET_CANARY',version:'1'}}}));else if(m.method==='tools/list')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'safe',description:'SECRET_CANARY',inputSchema:{type:'object'}}]}}));else if(m.method==='tools/call')require('fs').writeFileSync('called','bad');});`);
  f.put("home/.claude.json", { mcpServers: { demo: { ...f.service, args: [script] } } });
  const report = f.read(); const evidence = await checkServer(report, report.servers[0]!.id);
  assert.equal(evidence.status, "PASS"); assert.equal(evidence.evidenceKind, "controlled-replay"); assert.equal(evidence.toolCount, 1); assert.equal(existsSync(join(f.workspace, "called")), false); assert.equal(JSON.stringify(evidence).includes("SECRET_CANARY"), false);
});

test("timeout, crash and huge output have bounded cleanup", async t => {
  const f = fixture(t); const start = Date.now();
  const timeout = await runCaptured(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: f.workspace, env: process.env, timeoutMs: 200 }); assert.equal(timeout.timedOut, true);
  const crash = await runCaptured(process.execPath, ["-e", "process.stderr.write('SECRET_CANARY');process.exit(3)"], { cwd: f.workspace, env: process.env }); assert.equal(crash.failed, true); assert.equal(crash.stdout, "");
  const huge = await runCaptured(process.execPath, ["-e", "setInterval(()=>process.stdout.write('a'.repeat(20000)),1)"], { cwd: f.workspace, env: process.env, maxBytes: 1024 }); assert.equal(huge.limited, true); assert.ok(Date.now() - start < 10000);
});

test("timeout terminates attached descendant tree", async t => {
  const f = fixture(t); const pidFile = join(f.root, "descendant.pid");
  const child = f.put("descendant.cjs", `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
  const parent = f.put("parent.cjs", `require('child_process').spawn(process.execPath,[${JSON.stringify(child)}],{stdio:'inherit'});setInterval(()=>{},1000);`);
  const result = await runCaptured(process.execPath, [parent], { cwd: f.workspace, env: process.env, timeoutMs: 1500 }); assert.equal(result.timedOut, true); assert.ok(existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, "utf8")); let alive = false; try { process.kill(pid, 0); alive = true; } catch { /* gone */ } assert.equal(alive, false);
});

test("cancellation before and during execution has bounded cleanup", async t => {
  const f = fixture(t); const cancelled = new AbortController(); cancelled.abort();
  const before = await runCaptured(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: f.workspace, env: process.env, signal: cancelled.signal }); assert.equal(before.failed, true);
  const during = new AbortController(); const timer = setTimeout(() => during.abort(), 250);
  try { const result = await runCaptured(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: f.workspace, env: process.env, signal: during.signal }); assert.equal(result.failed, true); assert.equal(result.timedOut, false); } finally { clearTimeout(timer); }
});

test("CLI scan -> diagnose -> plan -> preview -> apply -> verify -> share -> restore", t => {
  const f = fixture(t); const config = f.put("home/.claude.json", { mcpServers: { demo: { command: "not-present" } } }); const original = readFileSync(config);
  const cli = (...args: string[]) => { const result = spawnSync(process.execPath, [resolve("dist/src/cli.js"), ...args], { encoding: "utf8", timeout: 10000, env: process.env }); assert.equal(result.status, 0, result.stderr); return result.stdout; };
  const directory = join(f.root, "report");
  cli("scan", "--home", f.home, "--workspace", f.workspace, "--clients", "claude", "--out", directory);
  const snapshot = join(directory, "scan.json"), report = JSON.parse(readFileSync(snapshot, "utf8")); const finding = report.findings.find((x: {code: string}) => x.code === "COMMAND_NOT_FOUND");
  assert.ok(cli("diagnose", snapshot).includes("COMMAND_NOT_FOUND"));
  const plan = join(f.root, "plan.json"), operation = join(f.root, "operation.json");
  cli("plan", snapshot, "--finding", finding.id, "--value", process.execPath, "--out", plan); cli("apply", plan, "--dry-run");
  assert.deepEqual(readFileSync(config), original); cli("apply", plan, "--out", operation); assert.ok(cli("verify", operation, "--out", join(f.root, "verified")).includes('"configuration": "PASS"'));
  const after = join(f.root, "verified", "scan.json"), shared = join(f.root, "share.json"); cli("share", after, "--out", shared); assert.equal(readFileSync(shared, "utf8").includes(f.home), false);
  cli("restore", operation, "--out", join(f.root, "recovered.json")); assert.deepEqual(readFileSync(config), original);
});

test("BOM, CRLF, neighboring comments and unrelated keys survive variable repair", t => {
  const f = fixture(t); f.options.clients = ["vscode"];
  const path = f.put("workspace/.vscode/mcp.json", '\uFEFF{\r\n  // preserve\r\n  "servers": {"demo": {"command": ' + JSON.stringify(process.execPath) + ', "env": {"KEY":"${KEY}"}}},\r\n  "other": 42\r\n}\r\n');
  const report = f.read(), plan = makePlan(report, [report.findings.find(x => x.code === "VAR_DIALECT_MISMATCH")!.id]); const op = applyPlan(plan, join(f.root, "op.json")); const result = readFileSync(path, "utf8");
  assert.ok(result.startsWith('\uFEFF')); assert.ok(result.includes('// preserve\r\n')); assert.ok(result.includes('"other": 42')); assert.ok(result.includes('${env:KEY}')); restoreOperation(op);
});

test("tool pagination completes without exporting names, descriptions or cursors", async t => {
  const f = fixture(t); const script = f.put("pages.cjs", `require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); if(m.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}}));if(m.method==='tools/list')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'SECRET_CANARY',inputSchema:{type:'object'}}],...(!m.params?{nextCursor:'SECRET_CANARY'}:{})}}));});`);
  f.put("home/.claude.json", { mcpServers: { demo: { ...f.service, args: [script] } } }); const r = f.read(); const result = await checkServer(r, r.servers[0]!.id); assert.equal(result.status, "PASS"); assert.equal(result.toolCount, 2); assert.equal(JSON.stringify(result).includes("SECRET_CANARY"), false);
});
test("VS Code SSE is supported configuration; discovery and access remain observational", t => {
  const f = fixture(t); f.put("workspace/.vscode/mcp.json", { servers: { demo: { type: "sse", url: "https://example.com/sse" } } });
  f.put("workspace/.vscode/settings.json", { "chat.mcp.discovery.enabled": { "cursor-global": true }, "chat.mcp.access": "none" });
  const r = f.read(); assert.equal(r.findings.some(x => x.code === "TRANSPORT_UNSUPPORTED"), false); assert.ok(r.findings.some(x => x.code === "DISCOVERY_STATE_UNOBSERVED" && x.repair === null)); assert.ok(r.findings.some(x => x.code === "CLIENT_ACCESS_UNOBSERVED" && x.confidence === "unknown"));
});
test("Codex HTTP env credential references are observations, not exported values", t => {
  const f = fixture(t); f.options.env = { KEY: "SECRET_CANARY" };
  f.put("home/.codex/config.toml", '[mcp_servers.demo]\nurl="https://example.com/mcp"\nbearer_token_env_var="KEY"\n[mcp_servers.demo.env_http_headers]\nAuthorization="OTHER_KEY"');
  const r = f.read(); assert.equal(r.servers[0]?.variables.length, 2); assert.ok(r.findings.some(x => x.code === "VAR_MISSING")); assert.equal(JSON.stringify(r).includes("SECRET_CANARY"), false);
});
test("trusted Codex layer keeps map leaf origins including dotted keys", t => {
  const f = fixture(t); f.options.clients = ["codex"];
  f.put("home/.codex/config.toml", `[projects.${JSON.stringify(f.workspace)}]\ntrust_level="trusted"\n[mcp_servers.demo]\ncommand=${JSON.stringify(process.execPath)}\n[mcp_servers.demo.env]\n"A.B"="lower"\nKEEP="lower"`);
  f.put("workspace/.codex/config.toml", '[mcp_servers.demo]\nargs=[]\n[mcp_servers.demo.env]\nKEEP="upper"');
  const report = f.read(), raw = sourceDefinition(report, report.servers[0]!).raw;
  assert.deepEqual(raw.env, {"A.B":"lower", KEEP:"upper"}); assert.ok(report.servers[0]!.origins.some(origin => origin.field === "env.A.B"));
});

test("confirmed different-name mapping persists, appends and invalidates old plans",t=>{
 const f=fixture(t);f.put("home/.claude.json",{mcpServers:{alpha:{command:"missing"},second:f.service}});f.put("home/.cursor/mcp.json",{mcpServers:{beta:f.service,other:f.service}});
 const before=f.read(),finding=before.findings.find(x=>x.code==="COMMAND_NOT_FOUND")!,old=makePlan(before,[finding.id],process.execPath);
 const ids=before.servers.filter(x=>["alpha","beta"].includes(x.name)).map(x=>x.id);confirmMapping(before,ids);
 assert.throws(()=>previewPlan(old),/映射/);assert.throws(()=>sourceDefinition(before,before.servers[0]!),/映射/);
 const first=f.read();assert.equal(first.comparisons[0]?.relation,"confirmed");assert.ok(first.comparisons[0]?.differingFields.includes("command"));
 confirmMapping(first,first.servers.filter(x=>["second","other"].includes(x.name)).map(x=>x.id));assert.equal(f.read().comparisons.filter(x=>x.relation==="confirmed").length,2);
 assert.throws(()=>confirmMapping(f.read(),ids),/已有映射/);
});
test("same-name candidates block repair until the user confirms identity",t=>{
 const f=fixture(t);f.put("home/.claude.json",{mcpServers:{demo:{command:"missing"}}});f.put("home/.cursor/mcp.json",{mcpServers:{demo:f.service}});
 const r=f.read(),finding=r.findings.find(x=>x.code==="COMMAND_NOT_FOUND")!;assert.equal(r.comparisons[0]?.relation,"candidate");assert.equal(makePlan(r,[finding.id],process.execPath).edits.length,0);
 confirmMapping(r,r.servers.map(x=>x.id));const after=f.read();assert.equal(makePlan(after,[finding.id],process.execPath).edits.length,1);
});
test("HTML exposes field locations and override chains without argument values",t=>{
 const f=fixture(t);f.put("home/.cursor/mcp.json",{mcpServers:{demo:{...f.service,args:["SECRET_CANARY"]}}});f.put("workspace/.cursor/mcp.json",{mcpServers:{demo:{...f.service,args:[]}}});
 const r=f.read(),origin=r.servers[0]!.origins.find(x=>x.field==="command")!;assert.ok(origin.location?.line);assert.ok(origin.overridden?.length);const html=scanHtml(r);assert.ok(html.includes("command"));assert.ok(html.includes(r.sources.find(x=>x.id===origin.sourceId)!.path));assert.equal(html.includes("SECRET_CANARY"),false);
});
test("repair preview hides old secrets and shows scope and the explicit new value",t=>{
 const f=fixture(t);f.put("home/.claude.json",{mcpServers:{demo:{command:"SECRET_CANARY_missing"}}});const r=f.read(),p=makePlan(r,[r.findings.find(x=>x.code==="COMMAND_NOT_FOUND")!.id],process.execPath),preview=previewPlan(p);
 assert.equal(JSON.stringify(preview).includes("SECRET_CANARY"),false);assert.ok(preview[0]?.scope.includes("user"));assert.ok(preview[0]?.impact);assert.ok(preview[0]?.fields[0]?.before);assert.ok(JSON.stringify(preview).includes(process.execPath.replaceAll("\\","\\\\")));
});
test("CLI scan, diagnose and share terminal/artifact outputs contain zero secret canaries",t=>{
 const f=fixture(t),canary="SECRET_CANARY_TERMINAL_8320";f.put("home/.claude.json",{notes:canary,mcpServers:{demo:{...f.service,args:[canary],env:{KEY:canary}},remote:{type:"http",url:`https://user:${canary}@example.com/${canary}?token=${canary}`,headers:{Authorization:canary}}}});
 const directory=join(f.root,"report"),shared=join(f.root,"share.json");
 for(const args of [["scan","--home",f.home,"--workspace",f.workspace,"--clients","claude","--out",directory],["diagnose",join(directory,"scan.json")],["share",join(directory,"scan.json"),"--out",shared]]){const result=spawnSync(process.execPath,[resolve("dist/src/cli.js"),...args],{encoding:"utf8",timeout:10000,windowsHide:true});assert.equal(result.status,0);assert.equal((result.stdout+result.stderr).includes(canary),false);}
 for(const path of [join(directory,"scan.json"),join(directory,"report.html"),shared])assert.equal(readFileSync(path,"utf8").includes(canary),false);
});
test("TOML exports a reparsable manual patch and keeps source bytes unchanged",t=>{
 const f=fixture(t);const path=f.put("home/.codex/config.toml",'[mcp_servers."odd.name"]\ncommand="missing"\n# keep\nargs=[]');const bytes=readFileSync(path),r=f.read(),p=makePlan(r,[r.findings.find(x=>x.code==="COMMAND_NOT_FOUND")!.id],process.execPath);
 assert.equal(p.edits.length,0);assert.ok(p.manualPatches?.[0]?.snippet.includes(process.execPath.replaceAll("\\","\\\\")));assert.deepEqual(readFileSync(path),bytes);
});
test("unsupported declared version downgrades dialect rules; incompatible surfaces rejected",t=>{
 const f=fixture(t);f.options.clientVersions={claude:"99.0.0"};f.put("home/.claude.json",{mcpServers:{demo:{...f.service,env:{KEY:"${env:KEY}"}}}});const finding=f.read().findings.find(x=>x.code==="VAR_DIALECT_MISMATCH")!;
 assert.equal(finding.confidence,"unknown");assert.equal(finding.repair,null);assert.equal(finding.rule?.versionStatus,"unknown");f.options.surfaces={codex:"vscode-chat"};assert.throws(()=>f.read(),/入口/);
});
test("missing or desktop surface never borrows verified CLI expression rules",t=>{
 const f=fixture(t);f.put("home/.claude.json",{mcpServers:{demo:{...f.service,env:{KEY:"${env:KEY}"}}}});
 for(const surfaces of [{},{claude:"claude-desktop-code"}]){f.options.surfaces=surfaces;const finding=f.read().findings.find(x=>x.code==="VAR_DIALECT_MISMATCH")!;assert.equal(finding.rule?.versionStatus,"unknown");assert.equal(finding.repair,null);}
});
test("proxy, NO_PROXY and certificate observations are redacted and auth targets stay separate",t=>{
 const f=fixture(t),context=f.read().context;const r=observeNetwork("claude",null,"model","https://example.com/mcp",{HTTPS_PROXY:"http://127.0.0.1:33210"},{HTTPS_PROXY:"socks5://SECRET_CANARY@127.0.0.1:1",NO_PROXY:"example.com",NODE_EXTRA_CA_CERTS:join(f.root,"missing-cert")},"settings",context);
 assert.ok(["PROXY_CONTEXT_DIFFERENCE","PROXY_FORMAT_UNSUPPORTED","NO_PROXY_CANDIDATE","CERT_PATH_MISSING"].every(code=>r.issues.some(x=>x.code===code)));assert.equal(JSON.stringify(r).includes("SECRET_CANARY"),false);
 assert.equal(classifyAuthFailure("401 model api"),"model");assert.equal(classifyAuthFailure("401 MCP transport"),"mcp");assert.equal(classifyAuthFailure("401"),"unclassified");assert.equal(classifyAuthFailure("OK"),null);
});
test("loopback port check sends zero request bytes",async t=>{
 const f=fixture(t),server=createServer(socket=>{socket.on("data",()=>assert.fail("no application data expected"));});await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));t.after(()=>server.close());
 const prior=process.env.https_proxy;process.env.https_proxy=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 try{assert.equal((await loopbackProxyCheck(f.read(),"claude")).status,"PASS");}finally{if(prior===undefined)delete process.env.https_proxy;else process.env.https_proxy=prior;}
});
test("opaque network expressions remain unobserved rather than becoming scanner facts",t=>{
 const f=fixture(t);const r=observeNetwork("claude",null,"model","https://example.com",{HTTPS_PROXY:"http://127.0.0.1:33210"},{HTTPS_PROXY:"${PROXY}",NO_PROXY:"${BYPASS}",NODE_EXTRA_CA_CERTS:"${CERT}"},"settings",f.read().context);
 assert.equal(r.observation.proxyKind,"unobserved");assert.equal(r.observation.proxySource,"settings");assert.equal(r.observation.bypassCandidate,null);assert.equal(r.observation.certificate,"unobserved");assert.equal(r.issues.some(x=>x.code==="PROXY_FORMAT_UNSUPPORTED"),false);
});
test("native output and thrown exceptions cannot export canaries; version gate stops execution",async t=>{
 const f=fixture(t);f.options.clients=["codex"];f.put("home/.codex/config.toml",`[mcp_servers.demo]\ncommand=${JSON.stringify(process.execPath)}`);const report=f.read(),server=report.servers[0]!,prior=process.env.DOCTOR_CODEX_EXE;process.env.DOCTOR_CODEX_EXE=process.execPath;
 const captured=(stdout:string)=>({exitCode:0,stdout,failed:false,timedOut:false,limited:false,spawnError:false});
 try{
  for(const mode of ["output","exception","version"]){let calls=0;const result=await checkServer(report,server.id,true,async()=>{calls++;if(mode==="exception")throw new Error("SECRET_CANARY");if(calls===1)return captured(mode==="version"?"codex-cli 99.0.0":"codex-cli 0.159.2");return captured('401 MCP SECRET_CANARY');});assert.equal(JSON.stringify(result).includes("SECRET_CANARY"),false);assert.equal(JSON.stringify(shareReport(report)).includes("SECRET_CANARY"),false);if(mode==="version"){assert.equal(calls,1);assert.equal(result.status,"UNSUPPORTED");}}
  f.options.surfaces={codex:"codex-desktop"};assert.equal((await checkServer(f.read(),server.id,true)).status,"UNSUPPORTED");
 }finally{if(prior===undefined)delete process.env.DOCTOR_CODEX_EXE;else process.env.DOCTOR_CODEX_EXE=prior;}
});

const pause=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
async function waitFile(path:string){for(let i=0;i<120&&!existsSync(path);i++)await pause(50);assert.ok(existsSync(path),"fixture did not become ready");}
async function assertGone(pid:number){for(let i=0;i<60;i++){try{process.kill(pid,0);}catch{return;}await pause(50);}assert.fail("owned descendant remained alive");}
test("Windows job cleans descendants when the target parent exits first",{skip:process.platform!=="win32"},async t=>{
 const f=fixture(t),pidFile=join(f.root,"pid");const child=f.put("child.cjs",`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
 const parent=f.put("parent.cjs",`const fs=require('fs');require('child_process').spawn(process.execPath,[${JSON.stringify(child)}],{stdio:'inherit'});const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)})){clearInterval(timer);process.exit(0);}},25);`);
 const r=await runCaptured(process.execPath,[parent],{cwd:f.workspace,env:process.env,timeoutMs:5000});assert.equal(r.exitCode,0);await assertGone(Number(readFileSync(pidFile,"utf8")));
});
test("Windows job preserves exact argv, cwd and environment",{skip:process.platform!=="win32"},async t=>{
 const f=fixture(t),args=['中文 空格','quote"inside',"trailing\\",'',"a\\\"b"];
 const r=await runCaptured(process.execPath,["-e","console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),env:process.env.DOCTOR_TEST_VALUE}))",...args],{cwd:f.workspace,env:{...process.env,DOCTOR_TEST_VALUE:"中文"}});assert.equal(r.failed,false);assert.deepEqual(JSON.parse(r.stdout),{args,cwd:f.workspace,env:"中文"});
});

test("semantic candidates retain URL path/query differences and require identity confirmation",t=>{
 const f=fixture(t);f.put("home/.claude.json",{mcpServers:{one:f.service,httpOne:{type:"http",url:"https://example.com/a?account=1"}}});f.put("home/.cursor/mcp.json",{mcpServers:{two:f.service,httpTwo:{type:"http",url:"https://example.com/a?account=2"}}});
 const r=f.read();assert.ok(r.comparisons.some(x=>x.relation==="candidate"&&x.serverIds.includes(r.servers.find(s=>s.name==="one")!.id)&&x.serverIds.includes(r.servers.find(s=>s.name==="two")!.id)));
 assert.equal(r.comparisons.some(x=>x.serverIds.includes(r.servers.find(s=>s.name==="httpOne")!.id)),false);
});
for(const stage of ["connect","list"] as const)test(`controlled ${stage} deadline terminates its owned process`,async t=>{
 const f=fixture(t),pidFile=join(f.root,"pid");const script=f.put("stall.cjs",`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(${JSON.stringify(stage)}==='list'&&m.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}}));});setInterval(()=>{},1000);`);
 f.put("home/.claude.json",{mcpServers:{demo:{...f.service,args:[script]}}});const r=f.read(),start=Date.now(),result=await checkServer(r,r.servers[0]!.id);assert.equal(result.status,"FAIL");assert.ok(result.reason.includes(stage==="connect"?"6 秒":"8 秒"));assert.ok(Date.now()-start<11500);await assertGone(Number(readFileSync(pidFile,"utf8")));
});
test("Windows forced diagnostic-parent death closes the job and its child",{skip:process.platform!=="win32"},async t=>{
 const f=fixture(t),pidFile=join(f.root,"pid"),module=pathToFileURL(resolve("dist/src/diagnostics/execution.js")).href;
 const child=f.put("child.cjs",`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
 const parent=f.put("parent.mjs",`import {runCaptured} from ${JSON.stringify(module)};await runCaptured(process.execPath,[${JSON.stringify(child)}],{cwd:${JSON.stringify(f.workspace)},env:process.env,timeoutMs:30000});`);
 const processParent=spawn(process.execPath,[parent],{windowsHide:true,stdio:"ignore"});t.after(()=>processParent.kill());await waitFile(pidFile);const pid=Number(readFileSync(pidFile,"utf8"));processParent.kill("SIGKILL");await assertGone(pid);
});
test("Windows real console Ctrl+C runs cleanup and leaves no descendant",{skip:process.platform!=="win32"},async t=>{
 const f=fixture(t),pidFile=join(f.root,"ready"),receipt=join(f.root,"sigint"),module=pathToFileURL(resolve("dist/src/diagnostics/execution.js")).href;
 const child=f.put("child.cjs",`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
 const parent=f.put("parent.mjs",`import {writeFileSync} from 'node:fs';import {runCaptured,installInterruptCleanup} from ${JSON.stringify(module)};process.on('SIGINT',()=>writeFileSync(${JSON.stringify(receipt)},'received'));installInterruptCleanup();await runCaptured(process.execPath,[${JSON.stringify(child)}],{cwd:${JSON.stringify(f.workspace)},env:process.env,timeoutMs:30000});`);
 const result=await new Promise<{code:number|null}>(done=>{const harness=spawn(resolve("dist/native/console-interrupt-test.exe"),[Buffer.from(JSON.stringify([process.execPath,parent,pidFile])).toString("base64")],{windowsHide:true,stdio:"ignore"});harness.once("close",code=>done({code}));});
 assert.equal(result.code,0);assert.ok(existsSync(receipt),"a real SIGINT must be observed");await assertGone(Number(readFileSync(pidFile,"utf8")));
});

test("successful Codex configuration values containing 401 are not authentication failures",async t=>{
 const f=fixture(t);f.options.clients=["codex"];f.put("home/.codex/config.toml",`[mcp_servers.demo]\ncommand=${JSON.stringify(process.execPath)}\nargs=[]\n[mcp_servers.demo.env]\nKEY="401 MCP SECRET_CANARY"`);const r=f.read(),prior=process.env.DOCTOR_CODEX_EXE;process.env.DOCTOR_CODEX_EXE=process.execPath;
 try{let count=0;const result=await checkServer(r,r.servers[0]!.id,true,async()=>({exitCode:0,stdout:++count===1?"codex-cli 0.159.2":JSON.stringify([{name:"demo",enabled:true,transport:{type:"stdio",command:process.execPath,args:[],env:{KEY:"401 MCP SECRET_CANARY"}}}]),failed:false,timedOut:false,limited:false,spawnError:false}));assert.equal(result.status,"PASS");assert.equal(JSON.stringify(result).includes("SECRET_CANARY"),false);}finally{if(prior===undefined)delete process.env.DOCTOR_CODEX_EXE;else process.env.DOCTOR_CODEX_EXE=prior;}
});
test("Windows backups have an owner-only protected ACL and replacements preserve target ACL",{skip:process.platform!=="win32"},t=>{
 const f=fixture(t),path=f.put("home/.claude.json",{mcpServers:{demo:{command:"missing"}}}),helper=resolve("dist/native/safe-file.exe");
 const inspect=(path:string)=>{const result=spawnSync(helper,["inspect",path],{encoding:"utf8",windowsHide:true,timeout:4000});assert.equal(result.status,0);return JSON.parse(result.stdout) as {owner:string;protectedAcl:boolean;rules:Array<{sid:string;inherited:boolean;rights:number;type:string}>;sddl:string};};
 const before=inspect(path),r=f.read(),plan=makePlan(r,[r.findings.find(x=>x.code==="COMMAND_NOT_FOUND")!.id],process.execPath),operation=applyPlan(plan,join(f.root,"op.json"));
 const backup=inspect(operation.files[0]!.backup);assert.equal(backup.protectedAcl,true);assert.ok(backup.rules.length>0);assert.ok(backup.rules.every(rule=>rule.sid===backup.owner&&!rule.inherited&&rule.type==="Allow"&&rule.rights===0x1f01ff));
 // Windows can refresh AUTO_INHERITED bookkeeping during creation; compare the
 // owner, inheritance protection and all principal/right/allow/deny entries.
 const access=(value:ReturnType<typeof inspect>)=>({owner:value.owner,protectedAcl:value.protectedAcl,rules:value.rules});assert.deepEqual(access(inspect(path)),access(before));restoreOperation(operation);assert.deepEqual(access(inspect(path)),access(before));
});
test("Windows backup protection failure stops before changing the selected configuration",{skip:process.platform!=="win32"},t=>{
 const f=fixture(t),path=f.put("home/.claude.json",{mcpServers:{demo:{command:"missing"}}}),before=readFileSync(path),r=f.read(),plan=makePlan(r,[r.findings.find(x=>x.code==="COMMAND_NOT_FOUND")!.id],process.execPath),helper=resolve("dist/native/safe-file.exe"),disabled=helper+".acceptance-disabled";
 assert.equal(existsSync(disabled),false);renameSync(helper,disabled);
 try{assert.throws(()=>applyPlan(plan,join(f.root,"op.json")),/组件不可用/);assert.deepEqual(readFileSync(path),before);assert.equal(existsSync(join(f.root,"op.json")),false);}finally{renameSync(disabled,helper);}
});
test("capture concurrency is bounded and a queued cancellation never starts its process",async t=>{
 const f=fixture(t),first=join(f.root,"first"),second=join(f.root,"second"),third=join(f.root,"third");
 const script=(path:string)=>`require('fs').writeFileSync(${JSON.stringify(path)},'started');setInterval(()=>{},1000);`;
 const a=new AbortController(),b=new AbortController(),c=new AbortController();
 const p1=runCaptured(process.execPath,["-e",script(first)],{cwd:f.workspace,env:process.env,signal:a.signal}),p2=runCaptured(process.execPath,["-e",script(second)],{cwd:f.workspace,env:process.env,signal:b.signal});
 try{await waitFile(first);await waitFile(second);const p3=runCaptured(process.execPath,["-e",script(third)],{cwd:f.workspace,env:process.env,signal:c.signal});await pause(150);assert.equal(existsSync(third),false);c.abort();assert.equal((await p3).failed,true);assert.equal(existsSync(third),false);}finally{a.abort();b.abort();await Promise.all([p1,p2]);}
 const next=await runCaptured(process.execPath,["-e","process.exit(0)"],{cwd:f.workspace,env:process.env});assert.equal(next.failed,false);
});
test("a damaged higher-priority source makes effective selection unknown and blocks fallback repair",t=>{
 const f=fixture(t);f.options.clients=["claude"];const user=f.put("home/.claude.json",{mcpServers:{demo:{command:"missing"},disabled:{...f.service,disabled:true}}});f.put("workspace/.mcp.json",'{"mcpServers":');const before=readFileSync(user),r=f.read();
 assert.ok(r.servers.every(server=>server.state==="unknown"));const plan=makePlan(r,[r.findings.find(x=>x.code==="COMMAND_NOT_FOUND")!.id],process.execPath);assert.equal(plan.edits.length,0);assert.ok(plan.manualSteps.length);assert.deepEqual(readFileSync(user),before);
});
for(const fault of ["initialize-shape","tool-schema","envelope","late-protocol-error"] as const)test(`controlled replay rejects invalid ${fault} instead of reporting PASS`,async t=>{
 const f=fixture(t);const initialization=fault==="initialize-shape"?{protocolVersion:"2025-11-25"}:{protocolVersion:"2025-11-25",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}};
 const script=f.put("invalid.cjs",`require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:${JSON.stringify(initialization)},...(${JSON.stringify(fault)}==='envelope'?{error:null}:{})}));if(m.method==='tools/list')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'SECRET_CANARY',inputSchema:{type:${JSON.stringify(fault==="tool-schema"?"string":"object")}}}]}})+'\u005cn'+(${JSON.stringify(fault)}==='late-protocol-error'?JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'SECRET_CANARY'}})+'\u005cn':''));});`);
 f.put("home/.claude.json",{mcpServers:{demo:{...f.service,args:[script]}}});const r=f.read(),result=await checkServer(r,r.servers[0]!.id);assert.equal(result.status,"FAIL");assert.equal(JSON.stringify(result).includes("SECRET_CANARY"),false);
});
test("selected Profile never loads an invented external profile file or permits guessed repairs",t=>{
 const f=fixture(t);f.options.clients=["codex"];f.options.profile="named";f.put("home/.codex/config.toml",'[mcp_servers.demo]\ncommand="missing"\nargs=[]');const invented=f.put("home/.codex/named.config.toml",'[mcp_servers.demo]\ncommand="SECRET_CANARY"\nargs=["override"]');const r=f.read();
 assert.equal(r.sources.some(x=>x.path===invented),false);assert.equal(JSON.stringify(r).includes("SECRET_CANARY"),false);assert.equal(r.servers[0]?.state,"unknown");assert.deepEqual(sourceDefinition(r,r.servers[0]!).raw.args,[]);assert.equal(makePlan(r,[r.findings.find(x=>x.code==="COMMAND_NOT_FOUND")!.id],process.execPath).manualPatches?.length,0);
});
