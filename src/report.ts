import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { hash } from "./config.js";
import { createHash } from "node:crypto";
import { escapeHtml, evidenceHref, evidenceLayers, overviewScript, renderOverview, trialStatus } from "./report-overview.js";
import type { RunReport, TrialResult } from "./types.js";

const runEvidenceFiles = ["static.json", "probe.json", "config.snapshot.json"] as const;
export function captureRunEvidence(directory: string): Record<string, string> {
  return Object.fromEntries(runEvidenceFiles.map(file => [file, ordinaryEvidenceHash(join(directory, file))]));
}
function ordinaryEvidenceHash(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Evidence must be an ordinary file");
  return evidenceHash(path);
}
export function writeReport(directory: string, report: RunReport): void {
  writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  const runEvidence = runEvidenceFiles.map(file => `<li><a href="${file}">${file}</a> <small>sha256 ${escapeHtml(report.runEvidenceHashes?.[file] ?? "未记录；历史报告未覆盖此项完整性")}</small></li>`).join("");
  const rows = report.trials.map((t, index) => {
    const layers = Object.entries(t.layers).map(([name, item]) => {
      const verdict = ["PASS", "FAIL", "UNKNOWN", "SKIP"].includes(item.verdict) ? item.verdict : "UNKNOWN";
      return `<span class="${verdict.toLowerCase()}">${escapeHtml(name)} ${verdict}</span>`;
    }).join(" ");
    const files = Object.entries(t.files).map(([label, path]) => {
      const href = evidenceHref(path);
      return `${href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : `${escapeHtml(label)}（证据路径不可用）`} <small>sha256 ${escapeHtml(t.evidenceHashes?.[label] ?? "unavailable")}</small>`;
    }).join("<br>");
    const reasons = Object.entries(t.layers).map(([name, item]) => `<li><b>${escapeHtml(name)}</b>: ${escapeHtml(item.reason)}</li>`).join("");
    const metadata = `<p><small>run_id: ${escapeHtml(t.runId ?? "未知")}<br>协议：${escapeHtml(t.protocolVersion ?? "未知")}<br>模型费用 USD：${escapeHtml(t.modelCostUsd === null || t.modelCostUsd === undefined ? "未知" : String(t.modelCostUsd))}<br>退出码：${escapeHtml(String(t.exitCode ?? "未知"))}<br>错误码：${escapeHtml(t.errorCode ?? "无")}<br>修复建议：${escapeHtml(t.fixHint ?? "无")}<br>复现：<code>${escapeHtml(t.reproduceCommand ?? "未记录")}</code></small></p>`;
    const failedLayers = evidenceLayers.filter(layer => t.layers[layer]?.verdict === "FAIL").join(",");
    return `<tr id="trial-${index}" data-trial-index="${index}" data-client="${escapeHtml(t.client)}" data-case="${escapeHtml(t.caseId)}" data-status="${trialStatus(t)}" data-failed-layers="${failedLayers}"><td>${escapeHtml(t.client)}<br><small>${escapeHtml(t.clientVersion)}<br>模型：${escapeHtml(t.modelId ?? "未知")}<br>可执行文件：${escapeHtml(t.clientExecutable ?? "未知")}</small></td><td>${escapeHtml(t.caseId)}<br><small>${escapeHtml(t.id)}</small></td><td>${layers}<details><summary>证据与原因</summary><ul>${reasons}</ul>${metadata}${files}</details></td><td>${t.calls.map(c => escapeHtml(c.name)).join("<br>") || "—"}</td></tr>`;
  }).join("\n");
  const scriptHash = createHash("sha256").update(overviewScript).digest("base64");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none'"><title>AI 插件验收报告</title><style>
  body{font:15px/1.6 system-ui,sans-serif;max-width:1200px;margin:32px auto;padding:0 20px;color:#17212b;background:#f8fafc}h1{font-size:28px}h2{font-size:21px}section{background:white;border:1px solid #dce3eb;border-radius:12px;padding:20px;margin:20px 0}table{width:100%;border-collapse:collapse}th,td{padding:12px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#f1f5f9}span{display:inline-block;padding:2px 6px;margin:2px;border-radius:5px;background:#eee}.pass{background:#d9f5e3}.fail{background:#ffdede}.unknown{background:#fff0c8}.skip{background:#edf0f3}small{color:#56616f}details{margin-top:8px}summary{cursor:pointer}a{color:#0659a5}code{overflow-wrap:anywhere}.cards,.filters{display:flex;gap:16px;flex-wrap:wrap;align-items:center}.cards>div{padding:12px 16px;background:#f1f5f9;border-radius:8px}.cards strong{font-size:24px}.filters label{display:flex;flex-direction:column;gap:4px}select,input,button{font:inherit;padding:8px;border:1px solid #b6c3d2;border-radius:6px;background:white}button{cursor:pointer}a:focus-visible,summary:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #2563eb;outline-offset:3px}.table-scroll{overflow-x:auto}tr:target{background:#eff6ff}tr[hidden],[hidden]{display:none!important}@media(max-width:640px){body{margin:16px auto;padding:0 10px}section{padding:12px}.filters label{width:100%}td,th{padding:8px}table{min-width:560px}}
  </style></head><body><header><h1>AI 插件跨客户端验收报告</h1><p>生成时间：${escapeHtml(report.createdAt)}。PASS 仅代表对应证据层通过；UNKNOWN／SKIP 不计为通过。</p></header>
  ${renderOverview(report.trials)}
  <section><h2>逐次运行与证据</h2><div class="table-scroll"><table><thead><tr><th>客户端与模型</th><th>用例 / 运行编号</th><th>分层结论</th><th>实际工具调用</th></tr></thead><tbody>${rows}</tbody></table></div><p id="trial-empty"${report.trials.length ? ' hidden' : ''}>当前没有符合条件的运行。</p></section>
  <section><h2>环境与顶层证据</h2><details><summary>版本、摘要与总览证据</summary><p>配置哈希：<code>${escapeHtml(report.configHash)}</code><br>服务哈希：<code>${escapeHtml(report.serverHash)}</code><br>插件版本：${escapeHtml(report.pluginVersion ?? "未知")}<br>服务自报版本：${escapeHtml(report.serverVersion ?? "未知")}<br>manifest 哈希：<code>${escapeHtml(report.manifestHash ?? "未知")}</code><br>工具面哈希：<code>${escapeHtml(report.toolSurfaceHash ?? "未知")}</code><br>协议版本：${escapeHtml(report.protocolVersion ?? "未知")}</p><ul>${runEvidence}</ul><p><a href="manual-review.md">人工验收模板</a></p><p>摘要用于检测文件变化；不证明文件来源真实，也不防止报告与证据同时被改写。人工验收模板可编辑，不纳入此摘要。</p></details></section>
  <section><h2>限制</h2><ul>${report.notes.map(n => `<li>${escapeHtml(n)}</li>`).join("")}</ul></section><script>${overviewScript}</script></body></html>`;
  writeFileSync(join(directory, "report.html"), html);
}
export function loadReport(path: string): RunReport { return JSON.parse(readFileSync(path, "utf8")) as RunReport; }
export function verifyEvidence(directory: string, report: RunReport): void {
  const base = resolve(directory);
  if (!report.runEvidenceHashes) throw new Error("Historical report has no top-level evidence hashes; keep the original report and rerun to generate verified evidence.");
  for (const file of runEvidenceFiles) {
    const expected = report.runEvidenceHashes[file];
    let actual: string | null = null;
    try { actual = ordinaryEvidenceHash(join(base, file)); } catch { /* Missing or unsafe evidence fails verification. */ }
    if (!expected || actual !== expected) throw new Error(`Evidence integrity check failed: run/${file}`);
  }
  for (const trial of report.trials) {
    for (const [label, file] of Object.entries(trial.files)) {
      const target = resolve(base, file);
      const relativePath = relative(base, target);
      if (isAbsolute(file) || relativePath === ".." || relativePath.startsWith(`..\\`) || relativePath.startsWith("../")) throw new Error(`Evidence path leaves report directory: ${file}`);
      const expected = trial.evidenceHashes?.[label];
      let actual: string | null = null;
      try { actual = evidenceHash(target); } catch { /* Missing evidence is an integrity failure. */ }
      if (!expected || actual !== expected) throw new Error(`Evidence integrity check failed: ${trial.id}/${label} (${file})`);
    }
  }
}
export function compareReports(a: RunReport, b: RunReport): string {
  const map = new Map(a.trials.map(t => [`${t.client}/${t.caseId}/${t.id.split("-").at(-1)}`, t]));
  const afterKeys = new Set(b.trials.map(t => `${t.client}/${t.caseId}/${t.id.split("-").at(-1)}`));
  const lines = [`before=${a.createdAt}`, `after=${b.createdAt}`, `server_changed=${a.serverHash !== b.serverHash}`, `tool_surface_changed=${a.toolSurfaceHash !== b.toolSurfaceHash}`];
  for (const trial of b.trials) {
    const key = `${trial.client}/${trial.caseId}/${trial.id.split("-").at(-1)}`;
    const prev = map.get(key);
    const oldVerdict = prev?.layers.E3.verdict ?? "MISSING";
    const changedVersion = prev && prev.clientVersion !== trial.clientVersion;
    const changedModel = prev && prev.modelId !== trial.modelId;
    const unchangedSurface = a.toolSurfaceHash && b.toolSurfaceHash && a.toolSurfaceHash === b.toolSurfaceHash;
    const changedOutcome = prev && oldVerdict !== trial.layers.E3.verdict;
    const caveat = changedVersion || changedModel ? "client/model changed; attribution uncertain" : changedOutcome && unchangedSurface ? "tool surface unchanged; inspect model variance and server results" : "";
    lines.push(`${key}: ${oldVerdict} -> ${trial.layers.E3.verdict}${caveat ? ` (${caveat})` : ""}`);
  }
  for (const [key, trial] of map) {
    if (!afterKeys.has(key)) lines.push(`${key}: ${trial.layers.E3.verdict} -> MISSING (trial absent from after report)`);
  }
  return lines.join("\n");
}
export function hasRegression(a: RunReport, b: RunReport): boolean {
  const previous = new Map(a.trials.map(t => [`${t.client}/${t.caseId}/${t.id.split("-").at(-1)}`, t]));
  const afterKeys = new Set(b.trials.map(t => `${t.client}/${t.caseId}/${t.id.split("-").at(-1)}`));
  if (a.trials.some(t => !afterKeys.has(`${t.client}/${t.caseId}/${t.id.split("-").at(-1)}`) && (t.layers.E2.verdict === "PASS" || t.layers.E3.verdict === "PASS"))) return true;
  return b.trials.some(t => {
    const old = previous.get(`${t.client}/${t.caseId}/${t.id.split("-").at(-1)}`);
    return Boolean(old && ((old.layers.E2.verdict === "PASS" && t.layers.E2.verdict !== "PASS") || (old.layers.E3.verdict === "PASS" && t.layers.E3.verdict !== "PASS")));
  });
}
export function evidenceHash(path: string): string { return hash(readFileSync(path)); }
export function relativeEvidence(path: string): string { return basename(path); }
