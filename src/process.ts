import { spawn, spawnSync } from "node:child_process";
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
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 6000, windowsHide: true });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] ?? "unknown" : "unknown";
}
export interface ProcessResult { exitCode: number | null; timedOut: boolean; spawnError?: string; abortReason?: string }
export async function runProcess(command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; stdoutPath: string; stderrPath: string; timeoutMs: number;
}): Promise<ProcessResult> {
  return new Promise(resolve => {
    const stdout = createWriteStream(options.stdoutPath);
    const stderr = createWriteStream(options.stderrPath);
    let timedOut = false;
    let settled = false;
    let abortReason: string | undefined;
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const streamLines = (target: NodeJS.WritableStream, inspect: boolean) => {
      let buffer = "";
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let i: number;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, i).trimEnd();
          target.write(redactLine(line) + "\n");
          if (inspect) {
            try {
              const event = JSON.parse(line) as Record<string, unknown>;
              if (event.type === "system" && event.subtype === "api_retry" && event.error === "authentication_failed") {
                abortReason = "客户端模型认证失败（401）";
                child.kill("SIGTERM");
              }
            } catch { /* stdout can contain non-JSON diagnostics */ }
          }
          buffer = buffer.slice(i + 1);
        }
      };
      return { onData, flush: () => { if (buffer) target.write(redactLine(buffer) + "\n"); } };
    };
    const stdoutLines = streamLines(stdout, true);
    const stderrLines = streamLines(stderr, false);
    child.stdout?.on("data", stdoutLines.onData);
    child.stderr?.on("data", stderrLines.onData);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, options.timeoutMs);
    const finish = async (result: ProcessResult) => {
      if (settled) return;
      settled = true; clearTimeout(timer); stdoutLines.flush(); stderrLines.flush();
      await Promise.all([new Promise<void>(done => stdout.end(done)), new Promise<void>(done => stderr.end(done))]);
      resolve({ ...result, abortReason });
    };
    child.on("error", error => finish({ exitCode: null, timedOut, spawnError: error.message }));
    child.on("close", code => finish({ exitCode: code, timedOut }));
  });
}
