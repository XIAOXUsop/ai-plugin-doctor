import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const fixedFiles = ["package.json", "package-lock.json", "tsconfig.json", "README.md", "DELIVERY.md", ".gitignore", ".gitattributes", ".github/workflows/ci.yml",
  "scripts/build-native.mjs", "scripts/create-report-overview-example.mjs", "scripts/preview-report.mjs", "scripts/verify-report-integrity.mjs",
  "fixtures/manifest.json", "fixtures/manifest-schema-v2.json", "native/JobRunner.cs", "native/ConsoleInterruptTest.cs", "native/SafeFile.cs", "templates/manual-review.md",
  "docs/配置诊断使用指南.md", "docs/服务导入与路径选择指南.md"];
export interface SourceFile {path: string; size: number; sha256: string}
export interface SourceManifest {formatVersion: 1; name: string; version: string; aggregateSha256: string; files: SourceFile[]}
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function safeFile(root: string, path: string): Buffer {
  let current = root;
  if (lstatSync(root).isSymbolicLink()) throw new Error("Source root must not be a symbolic link");
  for (const part of path.split("/")) { current = join(current,part); if (lstatSync(current).isSymbolicLink()) throw new Error("Source contains a symbolic link"); }
  if (!lstatSync(current).isFile()) throw new Error(`Required source is not a file: ${path}`);
  return readFileSync(current);
}
export function collectSource(root: string): Array<{path: string; bytes: Buffer}> {
  root = resolve(root);
  const paths = [...fixedFiles];
  function walk(folder: string) {
    if (lstatSync(join(root,folder)).isSymbolicLink()) throw new Error("Source contains a symbolic link");
    for (const name of readdirSync(join(root,folder))) {
      if(name.startsWith(".")||["node_modules","dist","runs","research","releases"].includes(name))continue;
      const path = `${folder}/${name}`, stat = lstatSync(join(root,path));
      if (stat.isSymbolicLink()) throw new Error("Source contains a symbolic link");
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && name.endsWith(".ts")) paths.push(path);
    }
  }
  walk("src"); walk("fixtures");
  return [...new Set(paths)].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))).map(path=>({path,bytes:safeFile(root,path)}));
}
// Standard ZIP STORE entries: fixed DOS timestamp, UTF-8 names, fixed permissions.
// No ZIP64: a source bundle is intentionally limited to 16 MiB / 4096 files.
const crcTable = Array.from({length:256},(_,value)=>{for(let i=0;i<8;i++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
function crc32(bytes: Buffer): number {let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]!^(crc>>>8);return (crc^0xffffffff)>>>0;}
export function buildSourceArchive(root: string): {bytes: Buffer; manifest: SourceManifest} {
  const source = collectSource(root);
  if(source.length>4096 || source.reduce((sum,item)=>sum+item.bytes.length,0)>16*1024*1024)throw new Error("Source package exceeds size or file-count limit");
  const pkg = JSON.parse(source.find(item=>item.path==="package.json")!.bytes.toString("utf8"));
  if(pkg.name!=="ai-plugin-doctor"||typeof pkg.version!=="string")throw new Error("Unexpected project identity");
  const files = source.map(item=>({path:item.path,size:item.bytes.length,sha256:digest(item.bytes)}));
  const manifest: SourceManifest = {formatVersion:1,name:pkg.name,version:pkg.version,aggregateSha256:digest(JSON.stringify(files)),files};
  const entries = [...source,{path:"SOURCE_MANIFEST.json",bytes:Buffer.from(JSON.stringify(manifest,null,2)+"\n")}].sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
  const local: Buffer[]=[], central: Buffer[]=[]; let offset=0;
  for(const entry of entries){
    const name=Buffer.from("ai-plugin-doctor/"+entry.path), checksum=crc32(entry.bytes);
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(33,12);header.writeUInt32LE(checksum,14);header.writeUInt32LE(entry.bytes.length,18);header.writeUInt32LE(entry.bytes.length,22);header.writeUInt16LE(name.length,26);
    local.push(header,name,entry.bytes);
    const directory=Buffer.alloc(46);directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE(0x314,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt16LE(33,14);directory.writeUInt32LE(checksum,16);directory.writeUInt32LE(entry.bytes.length,20);directory.writeUInt32LE(entry.bytes.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE((0o100644<<16)>>>0,38);directory.writeUInt32LE(offset,42);central.push(directory,name);
    offset+=header.length+name.length+entry.bytes.length;
  }
  const directory=Buffer.concat(central), end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return {bytes:Buffer.concat([...local,directory,end]),manifest};
}
export function verifySourceDirectory(root: string): SourceManifest {
  root=resolve(root);
  const manifest=JSON.parse(safeFile(root,"SOURCE_MANIFEST.json").toString("utf8")) as SourceManifest;
  if(manifest.formatVersion!==1||manifest.name!=="ai-plugin-doctor"||!Array.isArray(manifest.files)||manifest.files.length>4096||digest(JSON.stringify(manifest.files))!==manifest.aggregateSha256)throw new Error("Invalid source manifest");
  const seen=new Set<string>();
  for(const file of manifest.files){
    if(typeof file.path!=="string"||/[:\\\u0000-\u001f]/.test(file.path)||file.path.startsWith("/")||file.path.split("/").some(part=>!part||part==="."||part==="..")||seen.has(file.path))throw new Error("Unsafe or duplicate manifest path");
    seen.add(file.path);const bytes=safeFile(root,file.path);
    if(bytes.length!==file.size||digest(bytes)!==file.sha256)throw new Error(`Source integrity failed: ${file.path}`);
  }
  const actual=collectSource(root).map(item=>item.path);
  if(actual.length!==seen.size||actual.some(path=>!seen.has(path)))throw new Error("Source manifest does not match the package allowlist");
  return manifest;
}
function main() {
  if(process.argv[2]==="--verify") {const manifest=verifySourceDirectory(process.argv[3]??process.cwd());console.log(JSON.stringify({verified:true,files:manifest.files.length,aggregateSha256:manifest.aggregateSha256}));return;}
  const root=fileURLToPath(new URL("../../",import.meta.url));
  const out=resolve(process.argv[2]??join(root,"releases/ai-plugin-doctor-source-0.1.0.zip"));
  const checksumPath=out+".sha256";
  if(existsSync(out)||existsSync(checksumPath))throw new Error("Refusing to overwrite an existing source package or checksum");
  const result=buildSourceArchive(root);mkdirSync(dirname(out),{recursive:true});
  writeFileSync(out,result.bytes,{flag:"wx"});writeFileSync(checksumPath,digest(result.bytes)+"  "+out.split(/[\\/]/).at(-1)+"\n",{flag:"wx"});
  console.log(JSON.stringify({archive:out,sha256:digest(result.bytes),sourceFiles:result.manifest.files.length,bytes:result.bytes.length},null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main();
