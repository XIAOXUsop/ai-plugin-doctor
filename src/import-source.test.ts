import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { createFromSource, loadConfig, resolveServer, serverHash } from "./config.js";
import { inspectImportSource } from "./import-source.js";
import { runSuite } from "./runner.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(),"doctor-import-flow-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const put = (name: string, value: unknown) => {const path=join(root,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==="string"?value:JSON.stringify(value));return path;};
  return {root,put};
}
test("multiple MCP services require exact selection and do not choose a supported service implicitly",t=>{
  const f=fixture(t),source=f.put("mcp.json",{mcpServers:{remote:{url:"https://example.com"},local:{command:"node"}}}),out=join(f.root,"doctor.yaml");
  assert.throws(()=>createFromSource(source,out),/--server/);
  assert.equal(existsSync(out),false);
  assert.throws(()=>createFromSource(source,out,"toString"),/available/);
  assert.throws(()=>createFromSource(source,out,"remote"),/stdio/);
  const summary=createFromSource(source,out,"local");
  assert.equal(summary.selected,"local");assert.deepEqual(loadConfig(out).server.args,[]);
});
test("multiple source files in a directory require an explicit file",t=>{
  const f=fixture(t);f.put(".mcp.json",{mcpServers:{first:{command:"node"}}});f.put(".vscode/mcp.json",{servers:{second:{command:"node"}}});
  assert.throws(()=>inspectImportSource(f.root),/多份 MCP 配置/);
  assert.equal(inspectImportSource(join(f.root,".mcp.json")).entries[0]!.name,"first");
});
test("environment references preserve their referenced name and literals never enter the output",t=>{
  const f=fixture(t),source=f.put("mcp.json",{mcpServers:{one:{command:"node",env:{API_KEY:"${SHARED_TOKEN}",SECOND:"synthetic-secret"}}}}),out=join(f.root,"doctor.yaml");
  const summary=createFromSource(source,out);
  assert.deepEqual(loadConfig(out).server.env,{API_KEY:"${SHARED_TOKEN}",SECOND:"${SECOND}"});
  assert.deepEqual(summary.requiredEnvironment,["SHARED_TOKEN","SECOND"]);
  assert.doesNotMatch(readFileSync(out,"utf8"),/synthetic-secret/);
});
test("JSONC and TOML import share bounded parsing and reject duplicate or array definitions",t=>{
  const f=fixture(t),jsonc=f.put("mcp.jsonc",'\uFEFF{/* comment */"servers":{"one":{"command":"node",},},}');
  createFromSource(jsonc,join(f.root,"jsonc.yaml"));
  const toml=f.put("config.toml",'[mcp_servers.one]\ncommand="node"\nargs=[]\n');
  createFromSource(toml,join(f.root,"toml.yaml"));
  assert.equal(loadConfig(join(f.root,"toml.yaml")).server.command,"node");
  const duplicate=f.put("bad.json",'{"mcpServers":{},"mcpServers":{"one":{"command":"node"}}}');
  assert.throws(()=>inspectImportSource(duplicate),/解析失败/);
  assert.throws(()=>inspectImportSource(f.put("array.json",{servers:[]})),/根键必须为对象/);
  assert.throws(()=>inspectImportSource(f.put("roots.json",{servers:{},mcpServers:{}})),/多个服务根键/);
});
test("package import requires a choice among bins and verifies the selected local file",t=>{
  const f=fixture(t);f.put("first.js","// first");f.put("second.js","// second");
  const pkg=f.put("package.json",{name:"synthetic",version:"1.0.0",bin:{first:"first.js",second:"second.js"}}),out=join(f.root,"doctor.yaml");
  assert.throws(()=>createFromSource(pkg,out),/--entry/);assert.equal(existsSync(out),false);
  assert.throws(()=>createFromSource(pkg,out,"second"),/--entry/);
  createFromSource(pkg,out,undefined,undefined,undefined,undefined,{entry:"second"});
  assert.deepEqual(loadConfig(out).server.args,[join(f.root,"second.js")]);
  const missing=f.put("missing/package.json",{bin:"absent.js"});
  assert.throws(()=>createFromSource(missing,join(f.root,"absent.yaml")),/入口不存在/);
});
test("disabled, unresolved and host-controlled services are not silently imported",t=>{
  const f=fixture(t);
  for(const [index,fields] of [{disabled:true},{enabled:false},{envFile:'.env'},{args:['${input:key}']},{env:{KEY:'${OTHER:-default}'}},{env:{KEY:123}},{trust:true},{type:'http',url:'https://example.com'}].entries()){
    const source=f.put(`case-${index}.json`,{mcpServers:{one:{command:'node',...fields}}}),out=join(f.root,`case-${index}.yaml`);
    assert.equal(inspectImportSource(source).entries[0]!.kind,'unsupported');assert.throws(()=>createFromSource(source,out),/不能导入/);assert.equal(existsSync(out),false);
  }
});
test("imported JSONC retains cwd and literal argv across output relocation and real SDK startup",async t=>{
  const f=fixture(t),runtime=join(f.root,"runtime");
  f.put("runtime/server.cjs",`const fs=require('fs');fs.writeFileSync('receipt.json',JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}}}));if(m.method==='tools/list')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[]}}));}).on('close',()=>process.exit(0));`);
  const source=f.put("source/mcp.jsonc",`// synthetic\n${JSON.stringify({servers:{one:{command:process.execPath,args:['./server.cjs','./literal-value','../literal'],cwd:'../runtime'}}})}`);
  mkdirSync(join(f.root,"destination"));const out=join(f.root,"destination/doctor.yaml");
  createFromSource(source,out);const config=loadConfig(out),server=resolveServer(config,out);
  assert.equal(server.cwd,runtime);assert.deepEqual(server.args,['./server.cjs','./literal-value','../literal']);
  const report=await runSuite(config,out,join(f.root,"run"),[]);
  assert.equal(report.trials.length,0);
  assert.equal(JSON.parse(readFileSync(join(f.root,"run/static.json"),"utf8")).verdict,"PASS");
  assert.equal(JSON.parse(readFileSync(join(f.root,"run/probe.json"),"utf8")).ok,true);
  assert.deepEqual(JSON.parse(readFileSync(join(runtime,"receipt.json"),"utf8")),{cwd:runtime,args:['./literal-value','../literal']});
});
test("explicit cwd and relative executable resolve without rewriting arbitrary arguments or hashing directories",t=>{
  const f=fixture(t);f.put("bin/runner.exe","synthetic");f.put("data/input.txt","one");
  const source=f.put("source/mcp.json",{mcpServers:{one:{command:"../bin/runner.exe",args:['../data','./literal','../data/input.txt']}}}),out=join(f.root,"doctor.yaml");
  createFromSource(source,out,undefined,undefined,undefined,undefined,{cwd:join(f.root,"source")});
  const server=resolveServer(loadConfig(out),out);assert.equal(server.command,join(f.root,"bin/runner.exe"));
  assert.deepEqual(server.args,['../data','./literal','../data/input.txt']);assert.doesNotThrow(()=>serverHash(server));
  const before=serverHash(server);f.put("data/input.txt","two");assert.notEqual(serverHash(server),before);
  assert.notEqual(serverHash({...server,cwd:f.root}),serverHash(server));
});
