import { appendFileSync, readFileSync } from "node:fs";
import { installInterruptCleanup, spawnManaged } from "./diagnostics/execution.js";
import { redact } from "./redact.js";
import type { ServerConfig } from "./types.js";
import { expandEnvReferences } from "./config.js";

interface ProxySpec { server: ServerConfig; logPath: string; runId: string; fixtureLogPath: string }
const specPath = process.argv[2];
if (!specPath) throw new Error("Missing proxy spec path");
const spec = JSON.parse(readFileSync(specPath, "utf8")) as ProxySpec;
installInterruptCleanup();
const child = spawnManaged(spec.server.command, spec.server.args, {
  cwd: spec.server.cwd ?? process.cwd(),
  env: { ...process.env, ...expandEnvReferences(spec.server.env), DOCTOR_RUN_ID: spec.runId, DOCTOR_FIXTURE_LOG: spec.fixtureLogPath },
});
child.stdin.on("error", () => {});
function log(direction: string, line: string): void {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    appendFileSync(spec.logPath, JSON.stringify({ at: new Date().toISOString(), direction, message: redact(parsed) }) + "\n");
  } catch {
    appendFileSync(spec.logPath, JSON.stringify({ at: new Date().toISOString(), direction, invalidJson: true }) + "\n");
  }
}
function tap(direction: string): (chunk: Buffer) => void {
  let buffer = "";
  return chunk => {
    buffer += chunk.toString("utf8");
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) log(direction, line);
    }
  };
}
const tapClient = tap("client_to_server");
const tapServer = tap("server_to_client");
process.stdin.on("data", (chunk: Buffer) => { tapClient(chunk); child.stdin.write(chunk); });
process.stdin.on("end", () => child.stdin.end());
child.stdout.on("data", (chunk: Buffer) => { tapServer(chunk); process.stdout.write(chunk); });
child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
