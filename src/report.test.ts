import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureRunEvidence, compareReports, hasRegression, verifyEvidence, writeReport } from "./report.js";
import { evidenceHref, trialStatus, renderOverview, overviewScript } from "./report-overview.js";
import { createHash } from "node:crypto";
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

function fullTrial(client: "codex" | "claude", caseId: string, id: string): TrialResult {
  return { id, client, caseId, clientVersion: "synthetic", modelId: null, startedAt: "", endedAt: "", exitCode: 0, calls: [], finalAnswer: "", files: {}, evidenceHashes: {}, layers: {
    E0: { verdict: "PASS", reason: "配置可读", evidence: [] }, E1: { verdict: "PASS", reason: "协议通过", evidence: [] },
    E2: { verdict: "PASS", reason: "发现工具", evidence: [] }, E3: { verdict: "PASS", reason: "任务通过", evidence: [] }, E4: { verdict: "SKIP", reason: "待人工检查", evidence: [] },
  } };
}
test("overview status excludes manual E4 and preserves failure, unknown and skip precedence", () => {
  const trial = fullTrial("codex", "direct", "one");
  assert.equal(trialStatus(trial), "PASS");
  trial.layers.E2.verdict = "SKIP";
  assert.equal(trialStatus(trial), "SKIP");
  trial.layers.E1.verdict = "UNKNOWN";
  assert.equal(trialStatus(trial), "UNKNOWN");
  trial.layers.E0.verdict = "FAIL";
  assert.equal(trialStatus(trial), "FAIL");
  trial.layers.E0.verdict = "PASS";
  trial.layers.E1.verdict = "PASS";
  trial.layers.E2.verdict = "PASS";
  trial.layers.E3.verdict = "INVALID" as "PASS";
  assert.equal(trialStatus(trial), "UNKNOWN");
});
test("overview counts repeated runs and marks absent client/case combinations as not run", () => {
  const trials = [fullTrial("codex", "direct", "one"), fullTrial("codex", "direct", "two"), fullTrial("claude", "negative", "three")];
  trials[0]!.layers.E2 = { verdict: "FAIL", reason: "最早失败", evidence: [] };
  trials[0]!.layers.E3 = { verdict: "FAIL", reason: "后续失败", evidence: [] };
  const html = renderOverview(trials);
  assert.match(html, /2 次运行/);
  assert.match(html, /未运行/);
  assert.match(html, /最早失败/);
  assert.doesNotMatch(html, /后续失败/);
  assert.match(html, /href="#trial-0"/);
  assert.match(renderOverview([]), /尚无任务运行/);
});
test("evidence links reject executable and escaping paths and encode reserved filename characters", () => {
  for (const path of ["javascript:alert(1)", "https://example.com", "../secret", "trial/../../secret", "C:\\secret", "/secret", "\\\\server\\secret", "a\u0000b"]) assert.equal(evidenceHref(path), null);
  assert.equal(evidenceHref('trial/wire #&".jsonl'), "trial/wire%20%23%26%22.jsonl");
  assert.equal(evidenceHref("trial\\wire.jsonl"), "trial/wire.jsonl");
});
test("report escapes untrusted content, has fixed hashed script and retains all evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-overview-render-"));
  try {
    const trial = fullTrial("codex", '</script><img src=x onerror="alert(1)">', "synthetic");
    trial.layers.E3 = {verdict:"FAIL",reason:"unsafe <img src=x>",evidence:[]};
    trial.files = { wire: "synthetic/wire #&.jsonl", unsafe: "javascript:alert(1)" };
    const value = { ...report("PASS", "PASS"), trials: [trial], configHash: "<img src=x>" };
    writeReport(dir,value);
    const html = readFileSync(join(dir,"report.html"),"utf8");
    assert.doesNotMatch(html, /<img|href="javascript:/);
    assert.match(html, /synthetic\/wire%20%23%26.jsonl/);
    assert.match(html, /证据路径不可用/);
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.equal(script, overviewScript);
    const digest = createHash("sha256").update(script!).digest("base64");
    assert.ok(html.includes(`script-src 'sha256-${digest}'`));
    assert.match(html, /connect-src 'none'/);
    assert.equal((html.match(/data-trial-index=/g)??[]).length,1);
  } finally { rmSync(dir,{recursive:true,force:true}); }
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
    for (const file of ["static.json", "probe.json", "config.snapshot.json"]) writeFileSync(join(dir, file), "{}\n");
    value.runEvidenceHashes = captureRunEvidence(dir);
    value.trials[0]!.files = { wire: "wire.jsonl" };
    value.trials[0]!.evidenceHashes = { wire: hash("original\n") };
    assert.doesNotThrow(() => verifyEvidence(dir, value));
    writeFileSync(join(dir, "wire.jsonl"), "tampered\n");
    assert.throws(() => verifyEvidence(dir, value), /Evidence integrity check failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const file of ["static.json", "probe.json", "config.snapshot.json"]) {
  test(`report rejects changed, missing or unrecorded top-level evidence: ${file}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-run-evidence-"));
    try {
      for (const name of ["static.json", "probe.json", "config.snapshot.json"]) writeFileSync(join(dir, name), "original\n");
      const value = { ...report("PASS", "PASS"), trials: [], runEvidenceHashes: captureRunEvidence(dir) };
      assert.doesNotThrow(() => verifyEvidence(dir, value));
      writeFileSync(join(dir, file), "changed\n");
      assert.throws(() => verifyEvidence(dir, value), /Evidence integrity check failed/);
      rmSync(join(dir, file));
      assert.throws(() => verifyEvidence(dir, value), /Evidence integrity check failed/);
      writeFileSync(join(dir, file), "original\n");
      delete value.runEvidenceHashes[file];
      assert.throws(() => verifyEvidence(dir, value), /Evidence integrity check failed/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
test("historical report is not silently upgraded by hashing present files", () => {
  const value = { ...report("PASS", "PASS"), trials: [] };
  assert.throws(() => verifyEvidence(".", value), /Historical report/);
});
test("report CLI preserves existing outputs after top-level tampering", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-report-cli-"));
  try {
    for (const file of ["static.json", "probe.json", "config.snapshot.json"]) writeFileSync(join(dir, file), "{}\n");
    const value = { ...report("PASS", "PASS"), trials: [], runEvidenceHashes: captureRunEvidence(dir) };
    const json = JSON.stringify(value);
    writeFileSync(join(dir, "report.json"), json);
    writeFileSync(join(dir, "report.html"), "original HTML");
    writeFileSync(join(dir, "probe.json"), "tampered");
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./cli.js", import.meta.url)), "report", dir], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Evidence integrity check failed: run\/probe.json/);
    assert.equal(readFileSync(join(dir, "report.html"), "utf8"), "original HTML");
    assert.equal(readFileSync(join(dir, "report.json"), "utf8"), json);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
