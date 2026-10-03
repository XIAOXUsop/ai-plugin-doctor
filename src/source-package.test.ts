import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { buildSourceArchive, collectSource, verifySourceDirectory } from "./source-package.js";
function fixture(t: TestContext) {
  const root=mkdtempSync(join(tmpdir(),"doctor-source-package-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,"source");mkdirSync(source);
  for(const item of collectSource(process.cwd())){const path=join(source,item.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,item.bytes);}
  return {root,source};
}
test("source archive is byte-repeatable despite timestamps and excludes local data",t=>{
  const f=fixture(t),first=buildSourceArchive(f.source);
  const canary="synthetic-private-"+randomUUID();
  for(const file of [".env","doctor.yaml",".doctor/service-map.json","runs/private.json","research/private.ts","node_modules/private.ts","src/node_modules/private.ts","src/.doctor/private.ts","native/private.exe"]){const path=join(f.source,file);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,canary);}
  utimesSync(join(f.source,"README.md"),new Date(),new Date());
  const second=buildSourceArchive(f.source);assert.deepEqual(second.bytes,first.bytes);
  assert.equal(second.bytes.includes(Buffer.from(canary)),false);
  assert.ok(second.manifest.files.some(item=>item.path==="docs/服务导入与路径选择指南.md"));
});
test("Windows ZIP extraction preserves Unicode paths and manifest detects changed or missing source",{skip:process.platform!=="win32"},t=>{
  const f=fixture(t),bundle=buildSourceArchive(f.source),zip=join(f.root,"source.zip"),destination=join(f.root,"extracted");writeFileSync(zip,bundle.bytes);
  const literal=(path:string)=>"'"+path.replaceAll("'","''")+"'";
  const extracted=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",`$ErrorActionPreference='Stop';[void][Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem');[IO.Compression.ZipFile]::ExtractToDirectory(${literal(zip)},${literal(destination)})`],{encoding:"utf8",windowsHide:true,timeout:30000});assert.equal(extracted.status,0,extracted.stderr);
  const root=join(destination,"ai-plugin-doctor");assert.deepEqual(verifySourceDirectory(root),bundle.manifest);
  assert.deepEqual(readFileSync(join(root,"docs/服务导入与路径选择指南.md")),readFileSync(join(f.source,"docs/服务导入与路径选择指南.md")));
  writeFileSync(join(root,"README.md"),"tampered");assert.throws(()=>verifySourceDirectory(root),/Source integrity failed/);
  rmSync(join(root,"README.md"));assert.throws(()=>verifySourceDirectory(root));
});
test("manifest verification refuses escaping and duplicate paths before reading outside",t=>{
  const f=fixture(t),bundle=buildSourceArchive(f.source),path=join(f.source,"SOURCE_MANIFEST.json");
  for(const unsafe of ["../outside","C:/outside","src/../../outside"]){const files=[...bundle.manifest.files,{path:unsafe,size:0,sha256:""}];writeFileSync(path,JSON.stringify({...bundle.manifest,files,aggregateSha256:createHash("sha256").update(JSON.stringify(files)).digest("hex")}));assert.throws(()=>verifySourceDirectory(f.source),/Unsafe or duplicate/);}
  const files=[...bundle.manifest.files,bundle.manifest.files[0]!];writeFileSync(path,JSON.stringify({...bundle.manifest,files,aggregateSha256:createHash("sha256").update(JSON.stringify(files)).digest("hex")}));assert.throws(()=>verifySourceDirectory(f.source),/Unsafe or duplicate/);
});
test("source package CLI refuses overwriting either the archive or its checksum",t=>{
  const f=fixture(t),zip=join(f.root,"review.zip"),cli=resolve("dist/src/source-package.js");
  writeFileSync(zip,"original");const existing=spawnSync(process.execPath,[cli,zip],{encoding:"utf8",windowsHide:true});assert.equal(existing.status,1);assert.equal(readFileSync(zip,"utf8"),"original");
  rmSync(zip);writeFileSync(zip+".sha256","original checksum");const checksum=spawnSync(process.execPath,[cli,zip],{encoding:"utf8",windowsHide:true});assert.equal(checksum.status,1);assert.equal(existsSync(zip),false);assert.equal(readFileSync(zip+".sha256","utf8"),"original checksum");
});
