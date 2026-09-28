import { readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { hash } from "./config.js";
import type { RunReport, TrialResult } from "./types.js";

function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
export function writeReport(directory: string, report: RunReport): void {
  writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  const rows = report.trials.map(t => {
    const layers = Object.entries(t.layers).map(([name, item]) => `<span class="${item.verdict.toLowerCase()}">${name} ${item.verdict}</span>`).join(" ");
    const files = Object.entries(t.files).map(([label, path]) => `<a href="${encodeURI(escapeHtml(path))}">${escapeHtml(label)}</a> <small>sha256 ${escapeHtml(t.evidenceHashes?.[label] ?? "unavailable")}</small>`).join("<br>");
    const reasons = Object.entries(t.layers).map(([name, item]) => `<li><b>${name}</b>: ${escapeHtml(item.reason)}</li>`).join("");
    const metadata = `<p><small>run_id: ${escapeHtml(t.runId ?? "未知")}<br>协议：${escapeHtml(t.protocolVersion ?? "未知")}<br>模型费用 USD：${escapeHtml(t.modelCostUsd === null || t.modelCostUsd === undefined ? "未知" : String(t.modelCostUsd))}<br>退出码：${escapeHtml(String(t.exitCode ?? "未知"))}<br>错误码：${escapeHtml(t.errorCode ?? "无")}<br>修复建议：${escapeHtml(t.fixHint ?? "无")}<br>复现：<code>${escapeHtml(t.reproduceCommand ?? "未记录")}</code></small></p>`;
    return `<tr><td>${escapeHtml(t.client)}<br><small>${escapeHtml(t.clientVersion)}<br>模型：${escapeHtml(t.modelId ?? "未知")}<br>可执行文件：${escapeHtml(t.clientExecutable ?? "未知")}</small></td><td>${escapeHtml(t.caseId)}</td><td>${layers}<details><summary>证据与原因</summary><ul>${reasons}</ul>${metadata}${files}</details></td><td>${t.calls.map(c => escapeHtml(c.name)).join("<br>") || "—"}</td></tr>`;
  }).join("\n");
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>AI 插件验收报告</title><style>body{font:15px/1.6 system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 16px;color:#17212b}h1{font-size:26px}table{width:100%;border-collapse:collapse}th,td{padding:12px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}span{display:inline-block;padding:2px 6px;margin:2px;border-radius:5px;background:#eee}.pass{background:#d9f5e3}.fail{background:#ffdede}.unknown,.skip{background:#fff0c8}small{color:#666}details{margin-top:8px}a{color:#0659a5}code{overflow-wrap:anywhere}</style><h1>AI 插件跨客户端验收报告</h1><p>生成时间：${escapeHtml(report.createdAt)}。PASS 仅代表对应证据层通过；UNKNOWN／SKIP 不计为通过。</p><p>配置哈希：<code>${report.configHash}</code><br>服务哈希：<code>${report.serverHash}</code><br>插件版本：${escapeHtml(report.pluginVersion ?? "未知")}<br>服务自报版本：${escapeHtml(report.serverVersion ?? "未知")}<br>manifest 哈希：<code>${escapeHtml(report.manifestHash ?? "未知")}</code><br>工具面哈希：<code>${escapeHtml(report.toolSurfaceHash ?? "未知")}</code><br>协议版本：${escapeHtml(report.protocolVersion ?? "未知")}</p><p>总览证据：<a href="static.json">静态检查</a> · <a href="probe.json">协议探针</a> · <a href="config.snapshot.json">配置快照</a> · <a href="manual-review.md">人工验收模板</a></p><table><thead><tr><th>客户端</th><th>用例</th><th>分层结论</th><th>实际工具调用</th></tr></thead><tbody>${rows}</tbody></table><h2>限制</h2><ul>${report.notes.map(n => `<li>${escapeHtml(n)}</li>`).join("")}</ul></html>`;
  writeFileSync(join(directory, "report.html"), html);
}
export function loadReport(path: string): RunReport { return JSON.parse(readFileSync(path, "utf8")) as RunReport; }
export function verifyEvidence(directory: string, report: RunReport): void {
  const base = resolve(directory);
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
