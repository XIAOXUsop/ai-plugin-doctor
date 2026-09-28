import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("init with a missing explicit source fails without creating a sample at that path", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-cli-init-"));
  try {
    const source = join(dir, "missing-plugin");
    const output = join(dir, "doctor.yaml");
    const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
    const result = spawnSync(process.execPath, [cli, "init", source, output], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Source not found/);
    assert.equal(existsSync(source), false);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
