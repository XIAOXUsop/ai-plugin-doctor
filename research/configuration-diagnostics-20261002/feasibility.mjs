// Research only: synthetic configs, no model calls, no MCP server execution.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const codex = process.env.DOCTOR_CODEX_EXE;
if (!codex) throw new Error('Set DOCTOR_CODEX_EXE to the installed Codex executable.');
const env = Object.fromEntries(['PATH', 'SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
env.HOME = process.env.USERPROFILE;
const rows = [];
for (const mode of ['user-only', 'untrusted-project', 'trusted-project', 'cli-override']) {
  const home = join(root, 'synthetic', mode, 'home');
  const workspace = join(root, 'synthetic', mode, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(workspace, '.codex'), { recursive: true });
  const global = '[mcp_servers.sample]\ncommand = "node"\nargs = ["global-placeholder.js"]\nenabled = false\n[mcp_servers.sample.env]\nDOCTOR_RESEARCH_TEST_TOKEN = "${DOCTOR_RESEARCH_TEST_TOKEN}"\n';
  const trust = mode === 'trusted-project' || mode === 'cli-override' ? `\n[projects.${JSON.stringify(resolve(workspace))}]\ntrust_level = "trusted"\n` : '';
  writeFileSync(join(home, 'config.toml'), global + trust);
  if (mode !== 'user-only') writeFileSync(join(workspace, '.codex', 'config.toml'), '[mcp_servers.sample]\ncommand = "node"\nargs = ["project-placeholder.js"]\nenabled = false\n');
  const args = ['mcp', 'list', '--json', ...(mode === 'cli-override' ? ['-c', 'mcp_servers.sample.args=["cli-placeholder.js"]'] : [])];
  const result = spawnSync(codex, args, { cwd: workspace, env: { ...env, CODEX_HOME: home, DOCTOR_RESEARCH_TEST_TOKEN: 'SYNTHETIC_CANARY_ONLY' }, encoding: 'utf8', timeout: 10000, windowsHide: true });
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
  const entry = Array.isArray(parsed) ? parsed.find(item => item.name === 'sample') : null;
  rows.push({ mode, exitCode: result.status, timedOut: result.error?.code === 'ETIMEDOUT', diagnosticPresent: Boolean(result.stderr), entryPresent: Boolean(entry), enabled: entry?.enabled ?? null, command: entry?.transport?.command ?? null, args: entry?.transport?.args ?? null, envValueKind: entry?.transport?.env?.DOCTOR_RESEARCH_TEST_TOKEN === '${DOCTOR_RESEARCH_TEST_TOKEN}' ? 'literal-placeholder' : entry?.transport?.env?.DOCTOR_RESEARCH_TEST_TOKEN === 'SYNTHETIC_CANARY_ONLY' ? 'expanded-canary' : 'not-exposed' });
}
const report = { date: '2026-10-02', scope: 'Installed Codex mcp list with synthetic configs only; does not prove running desktop session state.', rows };
report.codexVersion = spawnSync(codex, ['--version'], { env: { ...env, CODEX_HOME: join(root, 'synthetic', 'user-only', 'home') }, encoding: 'utf8', timeout: 6000, windowsHide: true }).stdout.trim();
const claudeScript = process.env.DOCTOR_CLAUDE_CLI_JS;
if (claudeScript) {
  report.claudeVersion = spawnSync(process.execPath, [claudeScript, '--version'], { env, encoding: 'utf8', timeout: 6000, windowsHide: true }).stdout.trim();
  report.claudeScope = 'Installed Claude mcp get against a synthetic read-only local server only; no model requests.';
  report.claudeRows = [];
  for (const mode of ['user-only', 'project-over-user', 'local-over-project', 'variable-dialects']) {
    const home = join(root, 'synthetic', `claude-${mode}`, 'home');
    const workspace = join(root, 'synthetic', `claude-${mode}`, 'workspace');
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const capturePath = join(workspace, 'variable-capture.json');
    const definition = label => ({ type: 'stdio', command: process.execPath, args: [join(root, 'probe-server.mjs'), label], ...(label === 'user-placeholder' ? { env: { SYNTHETIC_GLOBAL_ONLY: 'non-secret' } } : mode === 'variable-dialects' ? { env: { FROM_SIMPLE: '${DOCTOR_RESEARCH_TEST_TOKEN}', FROM_CURSOR: '${env:DOCTOR_RESEARCH_TEST_TOKEN}', DOCTOR_RESEARCH_CAPTURE_PATH: capturePath } } : {}) });
    const global = { mcpServers: { sample: definition('user-placeholder') }, projects: { [workspace]: { enabledMcpjsonServers: ['sample'] } } };
    writeFileSync(join(home, '.claude.json'), JSON.stringify(global, null, 2));
    if (mode !== 'user-only') writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: { sample: definition('project-placeholder') } }, null, 2));
    const options = { cwd: workspace, env: { ...env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: home, DOCTOR_RESEARCH_TEST_TOKEN: 'SYNTHETIC_CANARY_ONLY', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1' }, encoding: 'utf8', timeout: 10000, windowsHide: true };
    const added = mode === 'local-over-project' ? spawnSync(process.execPath, [claudeScript, 'mcp', 'add-json', '--scope', 'local', 'sample', JSON.stringify(definition('local-placeholder'))], options) : null;
    const result = spawnSync(process.execPath, [claudeScript, 'mcp', 'get', 'sample'], options);
    const generated = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    const localKey = Object.entries(generated.projects ?? {}).find(([, value]) => value.mcpServers?.sample)?.[0];
    report.claudeRows.push({ mode, localSetupExitCode: added?.status ?? null, projectKeyStyle: localKey ? localKey.includes('\\') ? 'backslash' : 'forward-slash' : null, exitCode: result.status, timedOut: result.error?.code === 'ETIMEDOUT', selectedLabel: ['user-placeholder', 'project-placeholder', 'local-placeholder'].find(label => result.stdout.includes(label)) ?? null, inheritedGlobalEnvVisible: result.stdout.includes('SYNTHETIC_GLOBAL_ONLY'), connected: /Connected/i.test(result.stdout), diagnosticPresent: Boolean(result.stderr), ...(mode === 'variable-dialects' && result.status === 0 ? { variables: JSON.parse(readFileSync(capturePath, 'utf8')) } : {}) });
  }
}
report.checks = rows.map((row, index) => ({ name: `codex-${row.mode}`, passed: row.exitCode === 0 && row.entryPresent && row.enabled === false && row.args?.[0] === ['global-placeholder.js', 'global-placeholder.js', 'project-placeholder.js', 'cli-placeholder.js'][index] && row.envValueKind === 'literal-placeholder' }));
for (const [index, row] of (report.claudeRows ?? []).entries()) report.checks.push({ name: `claude-${row.mode}`, passed: row.exitCode === 0 && row.connected && row.selectedLabel === ['user-placeholder', 'project-placeholder', 'local-placeholder', 'project-placeholder'][index] && row.inheritedGlobalEnvVisible === (index === 0) && (index !== 2 || row.localSetupExitCode === 0 && row.projectKeyStyle === 'forward-slash') && (index !== 3 || row.variables.simpleResolved && !row.variables.cursorResolved && row.variables.cursorLiteral) });
report.passed = report.checks.filter(check => check.passed).length;
report.total = report.checks.length;
writeFileSync(join(root, 'feasibility-results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (report.passed !== report.total) process.exitCode = 2;
