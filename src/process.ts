import { spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { killTree, managedInvocation, spawnManaged } from "./diagnostics/execution.js";
import { createWriteStream, existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { redactLine } from "./redact.js";

export function findExecutable(name: string): string | null {
  for (const folder of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(folder, process.platform === "win32" ? `${name}.exe` : name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
export function findClaudeJs(): string | null {
  if (process.env.DOCTOR_CLAUDE_CLI_JS && existsSync(process.env.DOCTOR_CLAUDE_CLI_JS)) return process.env.DOCTOR_CLAUDE_CLI_JS;
  for (const folder of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(folder, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    if (existsSync(candidate)) return candidate;
    const cmd = join(folder, "claude.cmd");
    if (existsSync(cmd)) {
      const adjacent = join(dirname(cmd), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
      if (existsSync(adjacent)) return adjacent;
    }
  }
  return null;
}
export function version(command: string, args: string[]): string {
  try {
    const invocation = managedInvocation(command, args, process.env, process.cwd());
    const result = spawnSync(invocation.command, invocation.args, { encoding: "utf8", timeout: 6000, maxBuffer: 1024 * 1024, windowsHide: true });
    return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] ?? "unknown" : "unknown";
  } catch { return "unknown"; }
}
export interface ProcessResult { exitCode: number | null; timedOut: boolean; spawnError?: string; abortReason?: string }
export async function runProcess(command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; stdoutPath: string; stderrPath: string; timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ProcessResult> {
  if (options.signal?.aborted) return { exitCode: null, timedOut: false, abortReason: "运行已取消" };
  let child: ReturnType<typeof spawnManaged>;
  try { child = spawnManaged(command, args, options); }
  catch (error) { return { exitCode: null, timedOut: false, spawnError: error instanceof Error ? error.message : "Protected launch failed" }; }
  return new Promise(resolve => {
    const stdout = createWriteStream(options.stdoutPath);
    const stderr = createWriteStream(options.stderrPath);
    let timedOut = false;
    let settled = false;
    let abortReason: string | undefined;
    let spawnError: string | undefined;
    let bytes = 0;
    let forceTimer: NodeJS.Timeout | undefined;
    const stop = () => { killTree(child); if (!forceTimer) forceTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); void finish({ exitCode: null, timedOut, spawnError }); }, 2500); };
    const abort = () => { abortReason = "运行已取消"; stop(); };
    child.stdin.on("error", () => {});
    child.stdin.end();
    const streamLines = (target: NodeJS.WritableStream, inspect: boolean) => {
      let buffer = "";
      const decoder = new StringDecoder("utf8");
      const onData = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024 * 1024) { abortReason = "客户端输出超过 64 MiB 限制"; stop(); return; }
        buffer += decoder.write(chunk);
        let i: number;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, i).trimEnd();
          target.write(redactLine(line) + "\n");
          if (inspect) {
            try {
              const event = JSON.parse(line) as Record<string, unknown>;
              if (event.type === "system" && event.subtype === "api_retry" && event.error === "authentication_failed") {
                abortReason = "客户端模型认证失败（401）";
                stop();
              }
            } catch { /* stdout can contain non-JSON diagnostics */ }
          }
          buffer = buffer.slice(i + 1);
        }
        if (buffer.length > 1024 * 1024) { buffer = ""; abortReason = "客户端单行输出超过限制"; stop(); }
      };
      return { onData, flush: () => { if (buffer) target.write(redactLine(buffer) + "\n"); } };
    };
    const stdoutLines = streamLines(stdout, true);
    const stderrLines = streamLines(stderr, false);
    child.stdout?.on("data", stdoutLines.onData);
    child.stderr?.on("data", stderrLines.onData);
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    const finish = async (result: ProcessResult) => {
      if (settled) return;
      settled = true; clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); options.signal?.removeEventListener("abort", abort); stdoutLines.flush(); stderrLines.flush();
      await Promise.all([new Promise<void>(done => stdout.end(done)), new Promise<void>(done => stderr.end(done))]);
      resolve({ ...result, spawnError: spawnError ?? result.spawnError, abortReason });
    };
    for (const stream of [stdout, stderr]) stream.on("error", () => { spawnError = "无法写入运行日志"; stop(); });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.on("error", error => finish({ exitCode: null, timedOut, spawnError: error.message }));
    child.on("close", code => finish({ exitCode: code, timedOut }));
  });
}
