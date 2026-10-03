import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runProcess } from "./process.js";
import { probe } from "./probe.js";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "doctor-release-tree-"));
  const pidFile = join(dir, "descendant.pid");
  const descendant = join(dir, "descendant.cjs");
  writeFileSync(descendant, `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
  const parent = join(dir, "parent.cjs");
  function setParent(tail: string) {
    writeFileSync(parent, `require('child_process').spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:'ignore'});${tail}`);
  }
  function cleanup() {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (alive(pid)) {
        if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
  return { dir, pidFile, parent, setParent, cleanup };
}
for (const mode of ["timeout", "abort", "auth-failure", "parent-exit"] as const) {
  test(`release runner removes descendants on ${mode}`, { skip: process.platform !== "win32" }, async () => {
    const f = fixture();
    const controller = new AbortController();
    let abortTimer: NodeJS.Timeout | undefined;
    try {
      f.setParent(mode === "auth-failure" ? `setTimeout(()=>console.log(JSON.stringify({type:'system',subtype:'api_retry',error:'authentication_failed'})),1200);setInterval(()=>{},1000);` :
        mode === "parent-exit" ? `setTimeout(()=>process.exit(0),1200);` : `setInterval(()=>{},1000);`);
      if (mode === "abort") abortTimer = setTimeout(() => controller.abort(), 1500);
      const started = Date.now();
      const result = await runProcess(process.execPath, [f.parent], { cwd: f.dir, env: process.env, stdoutPath: join(f.dir, "stdout"), stderrPath: join(f.dir, "stderr"), timeoutMs: mode === "timeout" ? 1500 : 6000, signal: controller.signal });
      assert.ok(Date.now() - started < 5500);
      assert.ok(existsSync(f.pidFile), "descendant actually started");
      const pid = Number(readFileSync(f.pidFile, "utf8"));
      for (let i = 0; i < 20 && alive(pid); i++) await pause(50);
      assert.equal(alive(pid), false);
      assert.equal(result.timedOut, mode === "timeout");
      if (mode === "abort") assert.match(result.abortReason ?? "", /取消/);
      if (mode === "auth-failure") assert.match(result.abortReason ?? "", /401/);
      if (mode === "parent-exit") assert.equal(result.exitCode, 0);
    } finally { if (abortTimer) clearTimeout(abortTimer); f.cleanup(); }
  });
}
test("release runner preserves split UTF-8 and redacts sensitive log fields", async () => {
  const f = fixture();
  try {
    writeFileSync(f.parent, `const b=Buffer.from(JSON.stringify({text:'中文🙂',api_key:'synthetic-secret'})+'\\n');process.stdout.write(b.subarray(0,12));setTimeout(()=>process.stdout.write(b.subarray(12)),30);console.error('diagnostic');`);
    const result = await runProcess(process.execPath, [f.parent], { cwd: f.dir, env: process.env, stdoutPath: join(f.dir, "stdout"), stderrPath: join(f.dir, "stderr"), timeoutMs: 4000 });
    assert.equal(result.exitCode, 0);
    const output = readFileSync(join(f.dir, "stdout"), "utf8");
    assert.match(output, /中文🙂/);
    assert.doesNotMatch(output, /synthetic-secret|�/);
    assert.match(readFileSync(join(f.dir, "stderr"), "utf8"), /diagnostic/);
  } finally { f.cleanup(); }
});
test("release runner stops promptly when its log destination cannot be written", async () => {
  const f = fixture();
  try {
    f.setParent(`setInterval(()=>{},1000);`);
    const start = Date.now();
    const result = await runProcess(process.execPath,[f.parent],{cwd:f.dir,env:process.env,stdoutPath:join(f.dir,"missing","stdout"),stderrPath:join(f.dir,"stderr"),timeoutMs:10000});
    assert.match(result.spawnError??"",/运行日志/);
    assert.ok(Date.now()-start<5000);
  } finally { f.cleanup(); }
});
test("SDK probe closes a tool discovery timeout and its descendants", { skip: process.platform !== "win32" }, async () => {
  const f = fixture();
  try {
    f.setParent(`require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}}}));});setInterval(()=>{},1000);`);
    const start = Date.now();
    const result = await probe({ command: process.execPath, args: [f.parent], cwd: f.dir });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /timed out/i);
    assert.ok(Date.now() - start < 14000);
    assert.ok(existsSync(f.pidFile));
    const pid = Number(readFileSync(f.pidFile, "utf8"));
    for (let i = 0; i < 20 && alive(pid); i++) await pause(50);
    assert.equal(alive(pid), false);
  } finally { f.cleanup(); }
});
test("transparent proxy closes its descendant service when SDK transport closes", { skip: process.platform !== "win32" }, async () => {
  const f = fixture();
  try {
    f.setParent(`require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}}}));if(m.method==='tools/list')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[]}}));});setInterval(()=>{},1000);`);
    const spec = join(f.dir, "spec.json");
    writeFileSync(spec, JSON.stringify({server:{command:process.execPath,args:[f.parent],cwd:f.dir},logPath:join(f.dir,"wire"),runId:"synthetic",fixtureLogPath:join(f.dir,"fixture")}));
    const result = await probe({command:process.execPath,args:[fileURLToPath(new URL("./stdio-proxy.js",import.meta.url)),spec],cwd:f.dir});
    assert.equal(result.ok, true, result.error);
    // The deliberately uncooperative service forces SDK close to terminate the proxy tree.
    assert.ok(existsSync(f.pidFile));
    const pid = Number(readFileSync(f.pidFile,"utf8"));
    for(let i=0;i<20&&alive(pid);i++)await pause(50);
    assert.equal(alive(pid),false);
  } finally { f.cleanup(); }
});
test("release descendants exit after the diagnostic parent is forcibly terminated", { skip: process.platform !== "win32" }, async () => {
  const f = fixture();
  let harness: ReturnType<typeof spawn> | undefined;
  try {
    f.setParent(`setInterval(()=>{},1000);`);
    const harnessFile = join(f.dir,"harness.mjs");
    writeFileSync(harnessFile, `import {runProcess} from ${JSON.stringify(new URL('./process.js',import.meta.url).href)};await runProcess(process.execPath,[${JSON.stringify(f.parent)}],{cwd:${JSON.stringify(f.dir)},env:process.env,stdoutPath:${JSON.stringify(join(f.dir,'stdout'))},stderrPath:${JSON.stringify(join(f.dir,'stderr'))},timeoutMs:30000});`);
    harness = spawn(process.execPath,[harnessFile],{stdio:"ignore",windowsHide:true});
    for(let i=0;i<60&&!existsSync(f.pidFile);i++)await pause(50);
    assert.ok(existsSync(f.pidFile));
    const pid = Number(readFileSync(f.pidFile,"utf8"));
    assert.equal(alive(pid),true);
    // Abrupt termination bypasses the diagnostic parent's normal cleanup handlers.
    assert.equal(harness.kill("SIGKILL"), true);
    for(let i=0;i<40&&alive(pid);i++)await pause(50);
    assert.equal(alive(pid),false);
  } finally { harness?.kill(); f.cleanup(); }
});
