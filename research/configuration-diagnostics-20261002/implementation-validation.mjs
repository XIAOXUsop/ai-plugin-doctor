// Known synthetic local server only. No model calls or business tools.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../../dist/src/diagnostics/scan.js';
import { checkServer } from '../../dist/src/diagnostics/check.js';
import { confirmMapping } from '../../dist/src/diagnostics/identity.js';
import { makePlan, applyPlan, verifyOperation } from '../../dist/src/diagnostics/repair.js';
import { findExecutable, findClaudeJs, version } from '../../dist/src/process.js';
const root = dirname(fileURLToPath(import.meta.url));
const directory = join(root, 'synthetic', `implementation-${Date.now()}`);
const home = join(directory, 'home'), workspace = join(directory, 'workspace');
mkdirSync(join(home, '.codex'), {recursive:true}); mkdirSync(workspace, {recursive:true});
const probe = join(root, 'probe-server.mjs');
const missing = 'doctor-nonexistent-entry-832191';
const writeCodex = command => writeFileSync(join(home, '.codex', 'config.toml'), `[mcp_servers.sample]\ncommand=${JSON.stringify(command)}\nargs=[${JSON.stringify(probe)}]\n`);
writeCodex(missing);
writeFileSync(join(home, '.claude.json'), JSON.stringify({mcpServers:{sample:{type:'stdio',command:missing,args:[probe]}}}));
const options = {home, workspace, claudeConfigDir:home, clients:['codex','claude'],clientVersions:{codex:'0.159.2',claude:'2.1.89'},surfaces:{codex:'codex-cli',claude:'claude-cli'}};
const before = scan(options);
const results = {date:new Date().toISOString(), scope:'Synthetic config roots; selected known no-tools MCP; no model requests; original running desktop/IDE sessions remain UNKNOWN', versions:{codex:version(process.env.DOCTOR_CODEX_EXE??findExecutable('codex'),['--version']),claude:version(process.execPath,[findClaudeJs(),'--version'])}, before:[], after:[], repairs:[]};
for(const server of before.servers) results.before.push(await checkServer(before,server.id,true));
// Claude mcp get may update its own metadata file; rescan before generating a plan.
const unmapped = scan(options);confirmMapping(unmapped,unmapped.servers.map(server=>server.id));
const refreshed = scan(options);
const finding = refreshed.findings.find(item=>item.client==='claude'&&item.code==='COMMAND_NOT_FOUND');
const plan = makePlan(refreshed,[finding.id],process.execPath);
const operation=applyPlan(plan,join(directory,'operation.json'));
results.repairs.push({client:'claude',mode:'field-repair',configuration:verifyOperation(operation).operation.verification.configuration,nativeSession:'UNKNOWN'});
// TOML remains manual: this known synthetic fixture is edited to exercise native recheck.
writeCodex(process.execPath);
results.repairs.push({client:'codex',mode:'manual-TOML-fixture-edit',nativeSession:'UNKNOWN'});
const after = scan(options);
for(const server of after.servers) { results.after.push(await checkServer(scan(options),server.id,true));results.after.push(await checkServer(scan(options),server.id)); }
results.checks=[
  {name:'both missing commands diagnosed',passed:before.findings.filter(x=>x.code==='COMMAND_NOT_FOUND').length===2},
  {name:'Claude field repair static verification',passed:results.repairs[0].configuration==='PASS'},
  {name:'both native evidence categories preserved',passed:results.after.filter(x=>x.status==='PASS'&&['cli-config','native-service'].includes(x.evidenceKind)).length===2},
  {name:'both controlled replays pass',passed:results.after.filter(x=>x.status==='PASS'&&x.evidenceKind==='controlled-replay').length===2},
  {name:'none claims existing native session',passed:results.after.every(x=>x.evidenceKind!=='native-session')}
];
// A second dual-CLI fault: executable exists, but its script entry does not.
// Keep this manual: rewriting arbitrary args is outside the bounded repair set.
const missingScript=join(directory,'not-present-server.mjs');
writeFileSync(join(home,'.codex','config.toml'),`[mcp_servers.sample]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(missingScript)}]\n`);
writeFileSync(join(home,'.claude.json'),JSON.stringify({mcpServers:{sample:{type:'stdio',command:process.execPath,args:[missingScript]}}}));
const second={name:'existing executable with missing script argument',manualSteps:'Confirm the installed server entry and replace only its script argument in each synthetic config; rescan, then native check and controlled discovery separately.',before:[],after:[]};
for(const client of ['codex','claude']){const r=scan(options),server=r.servers.find(x=>x.client===client);second.before.push(await checkServer(r,server.id,true));second.before.push(await checkServer(scan(options),server.id));}
writeCodex(process.execPath);writeFileSync(join(home,'.claude.json'),JSON.stringify({mcpServers:{sample:{type:'stdio',command:process.execPath,args:[probe]}}}));
for(const client of ['codex','claude']){const r=scan(options),server=r.servers.find(x=>x.client===client);second.after.push(await checkServer(r,server.id,true));second.after.push(await checkServer(scan(options),server.id));}
results.secondExample=second;
results.checks.push(
 {name:'second example controlled failures observed in both CLIs',passed:second.before.filter(x=>x.evidenceKind==='controlled-replay'&&x.status==='FAIL').length===2},
 {name:'second example Claude native connection failure observed',passed:second.before.some(x=>x.client==='claude'&&x.evidenceKind==='native-service'&&x.status==='FAIL')},
 {name:'second example both native categories pass after manual correction',passed:second.after.filter(x=>x.status==='PASS'&&['cli-config','native-service'].includes(x.evidenceKind)).length===2},
 {name:'second example both controlled checks pass after manual correction',passed:second.after.filter(x=>x.status==='PASS'&&x.evidenceKind==='controlled-replay').length===2});
results.passed=results.checks.filter(x=>x.passed).length;results.total=results.checks.length;
writeFileSync(join(root,'implementation-results.json'),JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify({passed:results.passed,total:results.total,before:results.before.map(({client,status,evidenceKind})=>({client,status,evidenceKind})),after:results.after.map(({client,status,evidenceKind,reason})=>({client,status,evidenceKind,reason}))},null,2));
if(results.passed!==results.total)process.exitCode=2;
