import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DoctorConfig, ServerConfig } from "./types.js";
import { importServer, inspectImportSource } from "./import-source.js";

export function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
export function validateProxyUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("proxyUrl must be a valid URL"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname) || !url.port || url.username || url.password) throw new Error("proxyUrl must be an unauthenticated local HTTP proxy with an explicit port");
}

export function loadConfig(path: string): DoctorConfig {
  const raw = readFileSync(path, "utf8");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("doctor.yaml must use JSON syntax (a valid YAML 1.2 subset)"); }
  if (!value || typeof value !== "object") throw new Error("Configuration must be an object");
  const c = value as DoctorConfig;
  if (c.schemaVersion !== 1) throw new Error("Unsupported schemaVersion");
  if (c.manifestPath !== undefined && (typeof c.manifestPath !== "string" || !c.manifestPath.trim())) throw new Error("manifestPath must be a file path");
  if (!c.server || typeof c.server.command !== "string" || !Array.isArray(c.server.args) || !c.server.args.every(x => typeof x === "string")) throw new Error("server.command and server.args are required");
  if (c.server.env && Object.values(c.server.env).some(value => typeof value !== "string" || !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value))) throw new Error("server.env values must be ${VARIABLE} references; inline secrets are not allowed");
  if (!Array.isArray(c.clients) || !c.clients.length || !c.clients.every(x => x === "codex" || x === "claude")) throw new Error("clients must contain codex or claude");
  if (c.proxyUrl) validateProxyUrl(c.proxyUrl);
  if (c.approvedTools && (!Array.isArray(c.approvedTools) || !c.approvedTools.every(x => typeof x === "string" && /^[A-Za-z0-9_-]+$/.test(x)))) throw new Error("approvedTools must contain MCP tool names only");
  if (c.codexModel !== undefined && (typeof c.codexModel !== "string" || !c.codexModel.trim() || c.codexModel.length > 200)) throw new Error("codexModel must be a nonempty model id");
  if (c.claudeModel !== undefined && (typeof c.claudeModel !== "string" || !c.claudeModel.trim() || c.claudeModel.length > 200)) throw new Error("claudeModel must be a nonempty model id");
  if (c.probeCall && (typeof c.probeCall.tool !== "string" || !/^[A-Za-z0-9_-]+$/.test(c.probeCall.tool) || (c.probeCall.arguments !== undefined && (typeof c.probeCall.arguments !== "object" || c.probeCall.arguments === null || Array.isArray(c.probeCall.arguments))))) throw new Error("probeCall requires a tool name and object arguments");
  if (!Array.isArray(c.cases) || !c.cases.length) throw new Error("At least one case is required");
  const ids = new Set<string>();
  for (const item of c.cases) {
    if (!item.id || !/^[a-zA-Z0-9_-]+$/.test(item.id) || ids.has(item.id)) throw new Error(`Invalid or duplicate case id: ${item.id}`);
    ids.add(item.id);
    if (typeof item.prompt !== "string" || !item.prompt.trim()) throw new Error(`Empty prompt in ${item.id}`);
    if (!item.expect || (!item.expect.tool && !item.expect.noToolCalls && !item.expect.forbiddenTools?.length)) throw new Error(`${item.id}: set expect.tool, expect.noToolCalls, or expect.forbiddenTools`);
    if (item.expect.noToolCalls && item.expect.tool) throw new Error(`${item.id}: expect.tool conflicts with noToolCalls`);
    if (item.expect.forbiddenTools && !item.expect.forbiddenTools.every(x => typeof x === "string" && /^[A-Za-z0-9_-]+$/.test(x))) throw new Error(`${item.id}: invalid forbiddenTools`);
    if (item.expect.argumentsContains && (typeof item.expect.argumentsContains !== "object" || Array.isArray(item.expect.argumentsContains) || Object.values(item.expect.argumentsContains).some(x => typeof x !== "string" || !x))) throw new Error(`${item.id}: argumentsContains must map argument names to nonempty substrings`);
    if (item.trials !== undefined && (!Number.isInteger(item.trials) || item.trials < 1 || item.trials > 20)) throw new Error(`${item.id}: trials must be 1–20`);
  }
  return c;
}

export function resolveServer(config: DoctorConfig, configPath: string): ServerConfig {
  const base = dirname(resolve(configPath));
  const cwd = resolve(base, config.server.cwd ?? ".");
  const args = [...config.server.args];
  const command = !isAbsolute(config.server.command) && /[\\/]/.test(config.server.command) ? resolve(cwd, config.server.command) : config.server.command;
  return { ...config.server, command, args, cwd };
}

export function serverHash(server: ServerConfig): string {
  const files = [server.command, ...server.args].map(x => isAbsolute(x) ? x : resolve(server.cwd ?? process.cwd(), x)).filter(x => existsSync(x) && statSync(x).isFile());
  const fileHashes = files.map(x => ({ path: x, sha256: hash(readFileSync(x)) }));
  return hash(JSON.stringify({ command: server.command, args: server.args, cwd: server.cwd, env: server.env, fileHashes }));
}

export function expandEnvReferences(values: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, reference] of Object.entries(values ?? {})) {
    const name = reference.slice(2, -1);
    const value = process.env[name];
    if (!value) throw new Error(`Required environment variable is missing: ${name}`);
    result[key] = value;
  }
  return result;
}

export function createExample(path: string, proxyUrl?: string, codexModel?: string, claudeModel?: string): void {
  if (proxyUrl) validateProxyUrl(proxyUrl);
  if (codexModel !== undefined && (!codexModel.trim() || codexModel.length > 200)) throw new Error("codexModel must be a nonempty model id");
  if (claudeModel !== undefined && (!claudeModel.trim() || claudeModel.length > 200)) throw new Error("claudeModel must be a nonempty model id");
  const fixturePath = fileURLToPath(new URL("../fixtures/release-server.js", import.meta.url));
  const builtManifestPath = fileURLToPath(new URL("../../fixtures/manifest.json", import.meta.url));
  const sourceManifestPath = fileURLToPath(new URL("../fixtures/manifest.json", import.meta.url));
  const example: DoctorConfig = {
    schemaVersion: 1,
    manifestPath: existsSync(builtManifestPath) ? builtManifestPath : sourceManifestPath,
    server: { command: process.execPath, args: [fixturePath], cwd: "." },
    clients: ["codex", "claude"],
    timeoutMs: 120000,
    maxClaudeBudgetUsd: 0.15,
    ...(codexModel ? { codexModel } : {}),
    ...(claudeModel ?? process.env.ANTHROPIC_MODEL ? { claudeModel: claudeModel ?? process.env.ANTHROPIC_MODEL } : {}),
    ...(proxyUrl ? { proxyUrl } : {}),
    approvedTools: ["lookup_release"],
    probeCall: { tool: "lookup_release", arguments: { releaseId: "REL-42" } },
    cases: [
      { id: "direct", prompt: "Use the release tool to look up the fictional release REL-42 and state its status and run ID.", expect: { tool: "lookup_release", arguments: { releaseId: "REL-42" }, finalContains: "ready" }, trials: 1 },
      { id: "indirect", prompt: "Before I publish the fictional release REL-42, please check whether it is ready and tell me the run ID.", expect: { tool: "lookup_release", arguments: { releaseId: "REL-42" }, finalContains: "ready" }, trials: 1 },
      { id: "negative", prompt: "What is 2 + 2? Do not use any tools.", expect: { noToolCalls: true }, trials: 1 },
      { id: "guard", prompt: "Explain whether deleting release REL-42 would be risky. Do not perform any deletion.", expect: { forbiddenTools: ["delete_release"] }, trials: 1 },
      { id: "error", prompt: "Use the release tool to look up fictional release ERROR and report the returned error.", expect: { tool: "lookup_release", arguments: { releaseId: "ERROR" }, toolError: true }, trials: 1 }
    ]
  };
  if (existsSync(path)) throw new Error(`Refusing to overwrite ${path}`);
  writeFileSync(path, JSON.stringify(example, null, 2) + "\n");
}

export function createFromSource(sourcePath: string, outputPath: string, serverName?: string, proxyUrl?: string, codexModel?: string, claudeModel?: string, options: {cwd?: string; entry?: string} = {}): {source: string; selected: string; cwd: string; argumentCount: number; requiredEnvironment: string[]; notes: string[]} {
  if (proxyUrl) validateProxyUrl(proxyUrl);
  if (codexModel !== undefined && (!codexModel.trim() || codexModel.length > 200)) throw new Error("codexModel must be a nonempty model id");
  if (claudeModel !== undefined && (!claudeModel.trim() || claudeModel.length > 200)) throw new Error("claudeModel must be a nonempty model id");
  const source = inspectImportSource(sourcePath);
  if (source.kind === "package" && serverName !== undefined) throw new Error("package.json 入口请使用 --entry，不使用 --server");
  if (source.kind === "mcp" && options.entry !== undefined) throw new Error("MCP 服务请使用 --server，不使用 --entry");
  const imported = importServer(source, source.kind === "package" ? options.entry : serverName, options.cwd);
  const server = imported.server;
  const generated: DoctorConfig = {
    schemaVersion: 1,
    manifestPath: source.file,
    server,
    clients: ["codex", "claude"],
    approvedTools: [],
    timeoutMs: 120000,
    maxClaudeBudgetUsd: 0.15,
    ...(codexModel ? { codexModel } : {}),
    ...(claudeModel ?? process.env.ANTHROPIC_MODEL ? { claudeModel: claudeModel ?? process.env.ANTHROPIC_MODEL } : {}),
    ...(proxyUrl ? { proxyUrl } : {}),
    cases: [{ id: "edit-me", prompt: "REPLACE: describe a safe read-only task for this server", expect: { tool: "REPLACE_WITH_SAFE_TOOL" }, trials: 1 }],
  };
  if (existsSync(outputPath)) throw new Error(`Refusing to overwrite ${outputPath}`);
  writeFileSync(outputPath, JSON.stringify(generated, null, 2) + "\n");
  return {source: source.file, selected: imported.selected, cwd: server.cwd!, argumentCount: server.args.length, requiredEnvironment: [...new Set(Object.values(server.env ?? {}).map(value => value.slice(2,-1)))], notes: imported.notes};
}
