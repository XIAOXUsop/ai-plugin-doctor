import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("init --list is read-only and never prints argument or environment values",()=>{
  const dir=mkdtempSync(join(tmpdir(),"doctor-cli-list-"));
  try{
    const source=join(dir,"mcp.json");writeFileSync(source,JSON.stringify({mcpServers:{one:{command:"node",args:["synthetic-argument-secret"],env:{KEY:"synthetic-env-secret"}},remote:{url:"https://example.com"}}}));
    const cli=fileURLToPath(new URL('./cli.js',import.meta.url));
    const result=spawnSync(process.execPath,[cli,'init','--list',source],{cwd:dir,encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout+result.stderr,/synthetic-argument-secret|synthetic-env-secret/);
    const listing=JSON.parse(result.stdout);assert.equal(listing.startedServices,false);assert.deepEqual(listing.entries.map((x:{name:string})=>x.name),['one','remote']);
    assert.equal(existsSync(join(dir,'doctor.yaml')),false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("init explicit selection and cwd work from another invocation directory and preserve source bytes",()=>{
  const dir=mkdtempSync(join(tmpdir(),"doctor-cli-select-"));
  try{
    const source=join(dir,'mcp.json'),bytes=JSON.stringify({mcpServers:{one:{command:'node'},two:{command:'node',env:{KEY:'${SHARED}'}}}});writeFileSync(source,bytes);mkdirSync(join(dir,'runtime'));
    const out=join(dir,'doctor.yaml'),cli=fileURLToPath(new URL('./cli.js',import.meta.url));
    const result=spawnSync(process.execPath,[cli,'init',source,out,'--server','two','--cwd','runtime'],{cwd:dir,encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(readFileSync(out,'utf8')).server.cwd,join(dir,'runtime'));assert.match(result.stdout,/SHARED/);assert.equal(readFileSync(source,'utf8'),bytes);
    const before=readFileSync(out,'utf8');const again=spawnSync(process.execPath,[cli,'init',source,out,'--server','two'],{encoding:'utf8',windowsHide:true});assert.equal(again.status,1);assert.equal(readFileSync(out,'utf8'),before);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("init rejects unknown, duplicate, missing and invalid listing options before output",()=>{
  const dir=mkdtempSync(join(tmpdir(),"doctor-cli-options-"));
  try{
    const out=join(dir,'doctor.yaml'),cli=fileURLToPath(new URL('./cli.js',import.meta.url));
    for(const extra of [['--serve','one'],['--server'],['--server','one','--server','two'],['--list'],['--list','--list']]){
      const result=spawnSync(process.execPath,[cli,'init',out,...extra],{encoding:'utf8',windowsHide:true});assert.equal(result.status,1);assert.equal(existsSync(out),false);
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
