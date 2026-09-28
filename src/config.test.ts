import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExample, createFromSource, loadConfig } from "./config.js";

test("generated example carries an explicit local proxy and rejects remote proxy URLs", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-example-"));
  try {
    const output = join(dir, "doctor.yaml");
    createExample(output, "http://127.0.0.1:33210");
    assert.equal(loadConfig(output).proxyUrl, "http://127.0.0.1:33210");
    assert.match(loadConfig(output).manifestPath ?? "", /manifest\.json$/);
    assert.throws(() => createExample(join(dir, "bad.yaml"), "https://example.com:443"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init imports one stdio server and replaces literal environment values with references", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-import-"));
  try {
    const input = join(dir, "mcp.json");
    const output = join(dir, "doctor.yaml");
    writeFileSync(input, JSON.stringify({ mcpServers: { sample: { command: "node", args: ["server.js"], env: { ACCESS_TOKEN: "example-secret" } } } }));
    createFromSource(input, output);
    const raw = readFileSync(output, "utf8");
    assert(!raw.includes("example-secret"));
    const config = loadConfig(output);
    assert.deepEqual(config.server.env, { ACCESS_TOKEN: "${ACCESS_TOKEN}" });
    assert.equal(config.server.command, "node");
    assert.equal(config.cases[0]?.id, "edit-me");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
