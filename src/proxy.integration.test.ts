import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { summarizeWire } from "./runner.js";

test("transparent proxy records a real MCP tool call and fixture receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-proxy-test-"));
  const fixture = fileURLToPath(new URL("../fixtures/release-server.js", import.meta.url));
  const proxy = fileURLToPath(new URL("./stdio-proxy.js", import.meta.url));
  const wire = join(dir, "wire.jsonl");
  const fixtureLog = join(dir, "fixture.jsonl");
  const spec = join(dir, "spec.json");
  writeFileSync(spec, JSON.stringify({ server: { command: process.execPath, args: [fixture], cwd: dir }, logPath: wire, runId: "test-run", fixtureLogPath: fixtureLog }));
  const client = new Client({ name: "doctor-test", version: "0.1.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [proxy, spec], cwd: dir }));
    const tools = await client.listTools();
    assert(tools.tools.some(x => x.name === "lookup_release"));
    const result = await client.callTool({ name: "lookup_release", arguments: { releaseId: "REL-42" } });
    assert.equal(result.isError, undefined);
    assert(JSON.stringify(result.content).includes("REL-42"));
    const events = readFileSync(wire, "utf8").trim().split("\n").map(x => JSON.parse(x) as Record<string, unknown>);
    const summary = summarizeWire(events);
    assert.equal(summary.discovered, true);
    assert.deepEqual(summary.calls, [{ name: "lookup_release", arguments: { releaseId: "REL-42" } }]);
    assert(readFileSync(fixtureLog, "utf8").includes('"runId":"test-run"'));
  } finally {
    await client.close().catch(() => {});
    const root = resolve(tmpdir()) + sep;
    if (resolve(dir).startsWith(root)) rmSync(dir, { recursive: true, force: true });
  }
});
