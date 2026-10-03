import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
if(process.platform!=='win32')throw new Error('This evidence experiment targets Windows.');
const out=resolve(process.argv[2]??'runs/release-cleanup-baseline-20261002');
mkdirSync(out,{recursive:true});
const pidFile=join(out,'descendant.pid');
if(existsSync(pidFile))throw new Error('Choose a new evidence directory before repeating this experiment.');
const descendant=join(out,'descendant.cjs'),parent=join(out,'parent.cjs');
writeFileSync(descendant,`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
writeFileSync(parent,`require('child_process').spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000);`);
const prior=resolve('runs/configuration-third-clean-install-20261002/dist/src/process.js');
const {runProcess}=await import(pathToFileURL(prior).href);
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
let pid;
try {
  const result=await runProcess(process.execPath,[parent],{cwd:out,env:process.env,stdoutPath:join(out,'stdout'),stderrPath:join(out,'stderr'),timeoutMs:2000});
  assert.equal(result.timedOut,true);
  assert.ok(existsSync(pidFile));
  pid=Number(readFileSync(pidFile,'utf8'));
  const leaked=alive(pid);
  writeFileSync(join(out,'results.json'),JSON.stringify({priorModule:prior,timedOut:true,descendantActuallyStarted:true,descendantStillAliveAfterTimeout:leaked,modelRequests:0},null,2));
  console.log(leaked?'Observed: prior runner left the synthetic descendant alive.':'Observed: this timeout sample left no live descendant in the prior build.');
} finally {
  if(pid&&alive(pid))spawnSync('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
}
