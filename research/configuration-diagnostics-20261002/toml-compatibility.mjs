// Read-only Codex list against isolated fixtures: never starts a server or model.
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseConfig} from '../../dist/src/diagnostics/parsers.js';
import {runCaptured} from '../../dist/src/diagnostics/execution.js';
import {findExecutable} from '../../dist/src/process.js';
const root=dirname(fileURLToPath(import.meta.url)),directory=join(root,'synthetic',`toml-${Date.now()}`),codex=process.env.DOCTOR_CODEX_EXE??findExecutable('codex');
if(!codex)throw new Error('Installed Codex executable required.');
mkdirSync(directory,{recursive:true});
const command=JSON.stringify(process.execPath),cases=[
 {name:'table, scalars, array and environment map',valid:true,text:`[mcp_servers.sample]\ncommand=${command}\nargs=["one", "two"]\nenabled=false\n[mcp_servers.sample.env]\nKEY="literal"\n`},
 {name:'quoted dotted service name and dotted field key',valid:true,text:`[mcp_servers."odd.name"]\ncommand=${command}\nargs=[]\nenabled=false\nenv."A.B"="literal"\n`},
 {name:'inline environment table and multiline literal',valid:true,text:`[mcp_servers.sample]\ncommand=${command}\nargs=[]\nenabled=false\nenv={KEY='''line one\nline two'''}\n`},
 {name:'escaped backslashes, Unicode and comments',valid:true,text:`# preserved\n[mcp_servers.sample]\ncommand=${command}\nargs=["中文", 'C:\\fixture\\server.js']\nenabled=false\n`},
 {name:'duplicate scalar rejected',valid:false,text:'[mcp_servers.sample]\ncommand="node"\ncommand="node"\n'},
 {name:'duplicate table rejected',valid:false,text:'[mcp_servers.sample]\ncommand="node"\n[mcp_servers.sample]\nargs=[]\n'},
];
const rows=[];
for(const [i,c]of cases.entries()){
 const home=join(directory,String(i),'home'),workspace=join(directory,String(i),'workspace');mkdirSync(home,{recursive:true});mkdirSync(workspace,{recursive:true});writeFileSync(join(home,'config.toml'),c.text);
 const parsed=parseConfig(c.text,'toml'),native=await runCaptured(codex,['mcp','list','--json'],{cwd:workspace,env:{...process.env,CODEX_HOME:home},timeoutMs:6000});
 let comparable=false;if(c.valid&&!native.failed)try{const list=JSON.parse(native.stdout),entries=parsed.value.mcp_servers;comparable=Array.isArray(list)&&Object.entries(entries).every(([name,value])=>{const actual=list.find(x=>x.name===name);return actual?.enabled===false&&actual.transport.command===value.command&&JSON.stringify(actual.transport.args)===JSON.stringify(value.args)&&JSON.stringify(actual.transport.env??{})===JSON.stringify(value.env??{});});}catch{}
 rows.push({name:c.name,expectedValid:c.valid,parserValid:parsed.issues.length===0,nativeValid:!native.failed,semanticMatch:c.valid?comparable:null,passed:(parsed.issues.length===0)===c.valid&&(!native.failed)===c.valid&&(!c.valid||comparable)});
}
const observed=await runCaptured(codex,['--version'],{cwd:directory,env:process.env,timeoutMs:6000});const version=/codex-cli (\d+\.\d+\.\d+)/.exec(observed.stdout)?.[1]??null;
const report={date:new Date().toISOString(),version,scope:'Fixed subset only; no arbitrary TOML equivalence or automatic TOML editing claim',rows,passed:rows.filter(x=>x.passed).length,total:rows.length};writeFileSync(join(root,'toml-compatibility-results.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));if(report.passed!==report.total||version!=='0.159.2')process.exitCode=2;
