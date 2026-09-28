import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compareReports, hasRegression, verifyEvidence } from "./report.js";
import { hash } from "./config.js";
import type { RunReport, TrialResult } from "./types.js";

function report(e2: "PASS" | "FAIL", e3: "PASS" | "FAIL"): RunReport {
  const trial = { id: "codex-direct-1", client: "codex", caseId: "direct", layers: { E2: { verdict: e2 }, E3: { verdict: e3 } } } as TrialResult;
  return { schemaVersion: 1, createdAt: "", configHash: "", serverHash: "", protocolVersion: null, trials: [trial], notes: [] };
}
test("compare flags a formerly passing task that now fails", () => {
  assert.equal(hasRegression(report("PASS", "PASS"), report("PASS", "FAIL")), true);
  assert.equal(hasRegression(report("PASS", "FAIL"), report("PASS", "FAIL")), false);
});

test("compare warns when behavior changes without a tool-surface change", () => {
  const before = report("PASS", "PASS");
  const after = report("PASS", "FAIL");
  before.toolSurfaceHash = "same";
  after.toolSurfaceHash = "same";
  assert.match(compareReports(before, after), /tool surface unchanged; inspect model variance/);
});

test("compare treats a previously passing trial missing from the new report as regression", () => {
  const before = report("PASS", "PASS");
  const after = { ...report("PASS", "PASS"), trials: [] };
  assert.equal(hasRegression(before, after), true);
  assert.match(compareReports(before, after), /PASS -> MISSING/);
});

test("report refuses tampered or missing trial evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-evidence-"));
  try {
    writeFileSync(join(dir, "wire.jsonl"), "original\n");
    const value = report("PASS", "PASS");
    value.trials[0]!.files = { wire: "wire.jsonl" };
    value.trials[0]!.evidenceHashes = { wire: hash("original\n") };
    assert.doesNotThrow(() => verifyEvidence(dir, value));
    writeFileSync(join(dir, "wire.jsonl"), "tampered\n");
    assert.throws(() => verifyEvidence(dir, value), /Evidence integrity check failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
