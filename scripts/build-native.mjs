import { mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
if(process.platform==='win32') {
  const compiler=join(process.env.SystemRoot??'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  if(!existsSync(compiler))throw new Error('Windows .NET Framework compiler unavailable; active diagnostics must remain disabled.');
  mkdirSync('dist/native',{recursive:true});
  const result=spawnSync(compiler,['/nologo','/target:exe','/platform:x64','/reference:System.Web.Extensions.dll',`/out:${resolve('dist/native/job-runner.exe')}`,resolve('native/JobRunner.cs')],{encoding:'utf8',windowsHide:true,timeout:15000});
  if(result.status!==0)throw new Error('Windows job runner build failed: '+result.stdout);
  const harness=spawnSync(compiler,['/nologo','/target:exe','/platform:x64','/reference:System.Web.Extensions.dll',`/out:${resolve('dist/native/console-interrupt-test.exe')}`,resolve('native/ConsoleInterruptTest.cs')],{encoding:'utf8',windowsHide:true,timeout:15000});
  if(harness.status!==0)throw new Error('Console acceptance harness build failed: '+harness.stdout);
  const files=spawnSync(compiler,['/nologo','/target:exe','/platform:x64','/reference:System.Web.Extensions.dll',`/out:${resolve('dist/native/safe-file.exe')}`,resolve('native/SafeFile.cs')],{encoding:'utf8',windowsHide:true,timeout:15000});
  if(files.status!==0)throw new Error('Private file helper build failed: '+files.stdout);
}
