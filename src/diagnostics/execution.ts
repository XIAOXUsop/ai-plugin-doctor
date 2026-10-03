import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { nativeHelperPath } from "./native-tools.js";
const activeChildren = new Set<ChildProcessWithoutNullStreams>();
process.once("exit", () => { for (const child of activeChildren) killTree(child); });
export function installInterruptCleanup(): void {
  process.once("SIGINT", () => process.exit(130));
  process.once("SIGTERM", () => process.exit(143));
  if(process.platform==="win32")process.once("SIGBREAK",()=>process.exit(131));
}

export function killTree(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { timeout: 2000, windowsHide: true, stdio: "ignore" });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
  child.kill("SIGKILL");
}
export function managedInvocation(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): {command: string; args: string[]} {
  if (process.platform !== "win32") return { command, args };
  const runner = nativeHelperPath("job-runner.exe");
  if (!existsSync(runner)) throw new Error("Windows process protection unavailable; build the project before running.");
  let executable = command;
  if (!isAbsolute(command)) {
    const candidates = command.includes("/") || command.includes("\\") ? [resolve(cwd, command)] :
      (env.PATH ?? env.Path ?? "").split(delimiter).flatMap(folder => [join(folder, command), join(folder, command + ".exe")]);
    executable = candidates.find(path => existsSync(path)) ?? "";
  }
  if (!executable || !safeDirectExecutable(executable)) throw new Error("A direct executable is required for protected process execution.");
  return { command: runner, args: [Buffer.from(JSON.stringify([resolve(executable), ...args])).toString("base64"), String(process.pid)] };
}
export function spawnManaged(command: string, args: string[], options: {cwd: string; env: NodeJS.ProcessEnv}): ChildProcessWithoutNullStreams {
  const invocation = managedInvocation(command, args, options.env, options.cwd);
  const child = spawn(invocation.command, invocation.args, { cwd: options.cwd, env: options.env, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  activeChildren.add(child);
  child.once("close", () => activeChildren.delete(child));
  return child;
}
export interface CapturedResult { exitCode: number | null; stdout: string; failed: boolean; timedOut: boolean; limited: boolean; spawnError: boolean }
interface CaptureOptions {
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; maxBytes?: number;
  onStart?: (send: (message: unknown) => void, stop: () => void) => void;
  onLine?: (line: string, send: (message: unknown) => void, stop: () => void) => void;
  signal?: AbortSignal;
}
let runningCaptures=0;
const pendingCaptures:Array<{grant:()=>void}>=[];
function acquireCapture(signal?:AbortSignal):Promise<boolean> {
  if(signal?.aborted||pendingCaptures.length>=16)return Promise.resolve(false);
  if(runningCaptures<2){runningCaptures++;return Promise.resolve(true);}
  return new Promise(resolve=>{
    const entry={grant:()=>{signal?.removeEventListener("abort",cancel);runningCaptures++;resolve(true);}};
    const cancel=()=>{const index=pendingCaptures.indexOf(entry);if(index>=0)pendingCaptures.splice(index,1);resolve(false);};
    pendingCaptures.push(entry);signal?.addEventListener("abort",cancel,{once:true});if(signal?.aborted)cancel();
  });
}
export async function runCaptured(command:string,args:string[],options:CaptureOptions):Promise<CapturedResult> {
  if(!await acquireCapture(options.signal))return {exitCode:null,stdout:"",failed:true,timedOut:false,limited:false,spawnError:true};
  try{return await launchCaptured(command,args,options);}finally{runningCaptures--;pendingCaptures.shift()?.grant();}
}
function launchCaptured(command:string,args:string[],options:CaptureOptions):Promise<CapturedResult> {
  if (options.signal?.aborted) return Promise.resolve({ exitCode: null, stdout: "", failed: true, timedOut: false, limited: false, spawnError: true });
  const runner = nativeHelperPath("job-runner.exe");
  if (process.platform === "win32" && !existsSync(runner)) return Promise.resolve({ exitCode: null, stdout: "", failed: true, timedOut: false, limited: false, spawnError: true });
  return new Promise(resolve => {
    const child = spawn(process.platform === "win32" ? runner : command, process.platform === "win32" ? [Buffer.from(JSON.stringify([command, ...args])).toString("base64"),String(process.pid)] : args, { cwd: options.cwd, env: options.env, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    activeChildren.add(child);
    const decoder = new StringDecoder("utf8");
    let stdout = "", lines = "", bytes = 0, timedOut = false, limited = false, settled = false, spawnError = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer);
      activeChildren.delete(child); options.signal?.removeEventListener("abort", abort);
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
      resolve({ exitCode, stdout, failed: spawnError || timedOut || limited || exitCode !== 0, timedOut, limited, spawnError });
    };
    const stop = () => { killTree(child); if (!forceTimer) forceTimer = setTimeout(() => finish(null), 2500); };
    const abort = () => { spawnError = true; stop(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    const send = (message: unknown) => { if (child.stdin.writable && !child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + "\n"); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 12000);
    const consume = (chunk: Buffer, output: boolean) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 1024 * 1024)) { limited = true; stop(); return; }
      if (!output) return; // stderr is deliberately discarded, never persisted.
      const decoded = decoder.write(chunk); stdout += decoded; lines += decoded;
      let offset: number;
      while ((offset = lines.indexOf("\n")) >= 0) {
        const line = lines.slice(0, offset).trimEnd(); lines = lines.slice(offset + 1);
        try { options.onLine?.(line, send, stop); } catch { spawnError = true; stop(); }
      }
    };
    child.stdout.on("data", chunk => consume(chunk, true));
    child.stderr.on("data", chunk => consume(chunk, false));
    child.stdin.on("error", () => { /* Closed input is handled by exit or timeout. */ });
    child.on("spawn", () => { if (options.signal?.aborted) { abort(); return; } try { options.onStart?.(send, stop); } catch { spawnError = true; stop(); } });
    child.on("error", () => { spawnError = true; finish(null); });
    child.on("close", code => finish(code));
    if (options.signal?.aborted) abort();
  });
}
export function safeDirectExecutable(command: string): boolean { return !/\.(cmd|bat|ps1)$/i.test(command) && !/^(cmd|powershell|pwsh|bash|sh|zsh|fish)(\.exe)?$/i.test(basename(command)); }
