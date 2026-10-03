import { mkdirSync, writeFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { hash } from "../config.js";
import { readConfig, record, ordinaryPath, readOrdinary } from "./parsers.js";
import { randomUUID } from "node:crypto";
import type { DiagnosticClient, ScanReport } from "./types.js";
export interface ServiceMapping { schemaVersion:1; workspace:string; groups:Array<{id:string;members:Array<{client:DiagnosticClient;name:string}>}> }
export function mappingPath(workspace:string):string { return join(workspace,".doctor","service-map.json"); }
export function readMapping(workspace:string):{mapping:ServiceMapping|null;version:NonNullable<ScanReport["mapping"]>} {
  const path=mappingPath(workspace), loaded=readConfig({path,format:"json"});
  const input=record(loaded.value); let mapping:ServiceMapping|null=null;
  if(loaded.state==="readable") {
    const seen=new Set<string>();
    if(input.schemaVersion!==1||input.workspace!==workspace||!Array.isArray(input.groups)||input.groups.length>100) throw new Error("服务映射格式或工作区不一致");
    const groups=input.groups.map(value=>{const group=record(value);if(typeof group.id!=="string"||!/^[a-f0-9]{16}$/.test(group.id)||!Array.isArray(group.members)||group.members.length<2||group.members.length>4)throw new Error("服务映射组无效");
      const clients=new Set<string>();const members=group.members.map(value=>{const member=record(value);if(!["codex","claude","cursor","vscode"].includes(String(member.client))||typeof member.name!=="string"||member.name.length>128||clients.has(String(member.client))||seen.has(`${member.client}:${member.name}`))throw new Error("服务映射有歧义或重复");clients.add(String(member.client));seen.add(`${member.client}:${member.name}`);return {client:member.client as DiagnosticClient,name:member.name};});return {id:group.id,members};});
    mapping={schemaVersion:1,workspace,groups};
  } else if(loaded.state!=="missing")throw new Error("服务映射无法读取或解析，不能按没有映射处理");
  return {mapping,version:{path,contentHash:loaded.contentHash,state:loaded.state}};
}
export function confirmMapping(report:ScanReport,ids:string[]):string {
  const members=ids.map(id=>{const service=report.servers.find(item=>item.id===id);if(!service)throw new Error("映射必须选择当前报告中的服务");return {client:service.client,name:service.name};});
  if(members.length<2||members.length>4||new Set(members.map(item=>item.client)).size!==members.length)throw new Error("映射需选择两个至四个不同客户端的服务");
  const current=readMapping(report.context.workspace);if(current.version.contentHash!==report.mapping?.contentHash)throw new Error("映射已变化，请重新扫描");
  const previous=current.mapping?.groups??[];
  if(previous.length>=100)throw new Error("服务映射最多支持 100 组；请先审阅现有映射");
  if(members.some(member=>member.name.length>128))throw new Error("服务映射名称不能超过 128 个字符");
  if(previous.some(group=>group.members.some(item=>members.some(member=>member.client===item.client&&member.name===item.name))))throw new Error("服务已有映射，拒绝隐式覆盖；先审阅映射文件");
  const id=hash(JSON.stringify(members)).slice(0,16),data={schemaVersion:1,workspace:report.context.workspace,groups:[...previous,{id,members}]};
  if(!ordinaryPath(current.version.path))throw new Error("映射路径不安全");
  mkdirSync(dirname(current.version.path),{recursive:true});
  const lock=current.version.path+".doctor.lock",temp=current.version.path+`.doctor-${randomUUID()}.tmp`;let owned=false;
  try {writeFileSync(lock,"mapping update",{flag:"wx",mode:0o600});owned=true;
    const fresh=readMapping(report.context.workspace);if(fresh.version.contentHash!==current.version.contentHash||fresh.version.state!==current.version.state)throw new Error("映射在保存期间变化");
    if(!current.mapping)writeFileSync(current.version.path,JSON.stringify(data,null,2)+"\n",{flag:"wx",mode:0o600});
    else {writeFileSync(temp,JSON.stringify(data,null,2)+"\n",{flag:"wx",mode:0o600});if(hash(readOrdinary(current.version.path))!==current.version.contentHash)throw new Error("映射在保存期间变化");renameSync(temp,current.version.path);}return current.version.path;
  } finally {if(existsSync(temp))unlinkSync(temp);if(owned)unlinkSync(lock);}
}
