import type { TrialResult, Verdict } from "./types.js";

export const evidenceLayers = ["E0", "E1", "E2", "E3"] as const;
export function trialStatus(trial: TrialResult): Verdict {
  const values = evidenceLayers.map(layer => {
    const value = trial.layers[layer]?.verdict;
    return value && ["PASS", "FAIL", "UNKNOWN", "SKIP"].includes(value) ? value : "UNKNOWN";
  });
  return values.includes("FAIL") ? "FAIL" : values.includes("UNKNOWN") ? "UNKNOWN" : values.includes("SKIP") ? "SKIP" : "PASS";
}
export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
export function evidenceHref(file: string): string | null {
  if (!file || /^[\\/]/.test(file) || /[:\u0000-\u001f]/.test(file)) return null;
  const parts = file.replaceAll("\\", "/").split("/");
  if (parts.some(part => part === ".." || part === "." || !part)) return null;
  return parts.map(encodeURIComponent).join("/");
}
function badge(verdict: Verdict, text = verdict): string {
  return `<span class="badge ${verdict.toLowerCase()}">${escapeHtml(text)}</span>`;
}
export function renderOverview(trials: TrialResult[]): string {
  const clients = [...new Set(trials.map(trial => trial.client))];
  const cases = [...new Set(trials.map(trial => trial.caseId))];
  const counts = (items: TrialResult[]) => (["PASS", "FAIL", "UNKNOWN", "SKIP"] as const).map(status => `${badge(status)} ${items.filter(trial => trialStatus(trial) === status).length}`).join(" · ");
  const options = (values: string[]) => values.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
  const matrix = cases.map(caseId => `<tr><th scope="row">${escapeHtml(caseId)}</th>${clients.map(client => {
    const items = trials.filter(trial => trial.caseId === caseId && trial.client === client);
    return `<td>${items.length ? counts(items) + `<br><small>${items.length} 次运行</small>` : "未运行"}</td>`;
  }).join("")}</tr>`).join("");
  const problems = trials.flatMap((trial, index) => {
    const status = trialStatus(trial);
    if (status === "PASS") return [];
    const first = evidenceLayers.find(layer => trial.layers[layer]?.verdict === (status === "FAIL" ? "FAIL" : status));
    const reason = first ? trial.layers[first].reason : "缺少分层证据";
    return [`<tr data-problem-index="${index}"><td>${escapeHtml(trial.client)} / ${escapeHtml(trial.caseId)}<br><small>${escapeHtml(trial.id)}</small></td><td>${badge(status)} ${first ?? "未知层"}</td><td>${escapeHtml(reason)}<br><small>${escapeHtml(trial.fixHint ?? "请展开对应运行，查看各层原因及证据。")}</small></td><td><button type="button" data-open-trial="${index}" hidden>定位证据</button><noscript><a href="#trial-${index}">定位运行</a></noscript></td></tr>`];
  }).join("");
  return `<section aria-labelledby="overview-title"><h2 id="overview-title">运行总览</h2><div class="cards"><div><strong>${trials.length}</strong><br>运行次数</div><div><strong>${clients.length}</strong><br>客户端</div><div><strong>${cases.length}</strong><br>用例</div><div>${counts(trials)}</div></div><p>状态按 E0–E3 汇总：有失败为 FAIL，其次 UNKNOWN、SKIP，四层全部通过才为 PASS。E4 人工验收单独展示，不计入此总览。版本和模型不同时，数量不能用于比较客户端兼容性。</p><details><summary>客户端 × 用例（完整报告，不随筛选变化）</summary><div class="table-scroll"><table><thead><tr><th>用例</th>${clients.map(client => `<th scope="col">${escapeHtml(client)}</th>`).join("")}</tr></thead><tbody>${matrix || '<tr><td>尚无任务运行</td></tr>'}</tbody></table></div></details></section>
<section id="filters" hidden aria-label="筛选运行"><h2>查找问题</h2><div class="filters"><label>客户端<select id="filter-client"><option value="">全部</option>${options(clients)}</select></label><label>用例<select id="filter-case"><option value="">全部</option>${options(cases)}</select></label><label>状态<select id="filter-status"><option value="">全部</option>${options(["PASS","FAIL","UNKNOWN","SKIP"])}</select></label><label>失败层<select id="filter-layer"><option value="">全部</option>${options([...evidenceLayers])}</select></label><label>搜索<input id="filter-search" type="search" placeholder="运行编号、错误码、工具或原因"></label><button id="filter-reset" type="button">清除筛选</button></div><p id="filter-count" role="status" aria-live="polite"></p></section><noscript><p>筛选需要浏览器允许本页脚本；下方完整总览、问题及证据仍可查看。</p></noscript>
<section><h2>需要处理的运行</h2><p>优先列出最早失败层；UNKNOWN 和 SKIP 也保留，避免被当作通过。</p><div class="table-scroll"><table><thead><tr><th>运行</th><th>状态 / 首个问题层</th><th>原因与下一步</th><th>证据</th></tr></thead><tbody>${problems}</tbody></table></div><p id="problem-empty"${problems ? ' hidden' : ''}>当前没有符合条件的问题运行。</p></section>`;
}
// Fixed code only: report content stays in escaped HTML attributes/text, never executable JS.
export const overviewScript = `(() => {
  const rows = [...document.querySelectorAll('[data-trial-index]')];
  const problems = [...document.querySelectorAll('[data-problem-index]')];
  const fields = ['client', 'case', 'status', 'layer', 'search'].map(name => document.getElementById('filter-' + name));
  function update() {
    const [client, caseId, status, layer, search] = fields.map(field => field.value);
    const shown = new Set();
    rows.forEach(row => {
      row.hidden = Boolean((client && row.dataset.client !== client) || (caseId && row.dataset.case !== caseId) || (status && row.dataset.status !== status) || (layer && !row.dataset.failedLayers.split(',').includes(layer)) || (search && !row.textContent.toLocaleLowerCase().includes(search.toLocaleLowerCase())));
      if (!row.hidden) shown.add(row.dataset.trialIndex);
    });
    problems.forEach(row => { row.hidden = !shown.has(row.dataset.problemIndex); });
    document.getElementById('filter-count').textContent = '显示 ' + shown.size + ' / ' + rows.length + ' 次运行；完整报告统计保持不变。';
    document.getElementById('trial-empty').hidden = shown.size > 0;
    document.getElementById('problem-empty').hidden = problems.some(row => !row.hidden);
  }
  fields.forEach(field => { field.addEventListener('input', update); field.addEventListener('change', update); });
  document.getElementById('filter-reset').addEventListener('click', () => { fields.forEach(field => { field.value = ''; }); update(); });
  document.querySelectorAll('[data-open-trial]').forEach(button => { button.hidden = false; button.addEventListener('click', () => { const row = document.getElementById('trial-' + button.dataset.openTrial); row.querySelector('details').open = true; row.scrollIntoView({block: 'center'}); }); });
  document.getElementById('filters').hidden = false;
  update();
})();`;
