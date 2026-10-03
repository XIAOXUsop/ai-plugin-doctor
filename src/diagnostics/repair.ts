import { closeSync, existsSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { hash } from "../config.js";
import { at, decode, editJson, renameRoot, ordinaryPath, parseConfig, readConfig, readOrdinary, record } from "./parsers.js";
import { configSources, contextFor, scan, loadingUncertain } from "./scan.js";
import type { RepairEdit, RepairOperation, RepairPlan, ScanReport } from "./types.js";
import { readMapping } from "./identity.js";
import {spawnSync} from "node:child_process";
import {nativeHelperPath} from "./native-tools.js";

export function makePlan(report: ScanReport, ids: string[], value?: string): RepairPlan {
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error("请提供不重复的 finding ID");
  const findings = ids.map(id => { const finding = report.findings.find(item => item.id === id); if (!finding) throw new Error("Finding 不在扫描报告中"); return finding; });
  const plan: RepairPlan = { schemaVersion: 1, kind: "configuration-repair-plan", id: randomUUID(), createdAt: new Date().toISOString(), context: report.context, findings: findings.map(({ id, code, serverId, sourceId }) => ({ id, code, serverId, sourceId })), edits: [], sourceVersions: report.sources.map(({ path, format, state, contentHash }) => ({ path, format, state, contentHash })), manualSteps: [], limits: ["只修改选择的字段；不放宽权限、修改信任、登录或安装依赖。", "应用前将核对所有已扫描配置的内容版本；其他程序修改后必须重新扫描。", "复杂 TOML 只提供人工动作；备份保留在本机且可能包含原有秘密。", "静态复查不代表原生会话通过，连接与模型任务需另行验证。"] };
  for (const finding of findings) {
    plan.mappingVersion=report.mapping;plan.manualPatches??=[];
    const targetServer=report.servers.find(server=>server.id===finding.serverId);
    if(targetServer&&report.comparisons.some(group=>group.relation==="candidate"&&group.serverIds.includes(targetServer.id))){plan.manualSteps.push(`${finding.code}：先确认跨客户端服务映射再为候选服务生成修复。`);continue;}
    if (loadingUncertain(report.context,report.sources,finding.client)) { plan.manualSteps.push(`${finding.code}：有效来源尚未确认，先处理损坏/不可读来源、托管配置、Profile 或启动覆盖，再重新扫描。`); continue; }
    const source = report.sources.find(item => item.id === finding.sourceId);
    if(source?.format==="toml"&&finding.keyPath&&value&&["COMMAND_NOT_FOUND","CWD_MISSING"].includes(finding.code)) {
      if(!isAbsolute(value)||!ordinaryPath(value))throw new Error("人工片段需要经过确认的绝对普通路径");
      const stat=lstatSync(value);if(finding.code==="COMMAND_NOT_FOUND"?!stat.isFile():!stat.isDirectory())throw new Error("人工片段路径类型不正确");
      const field=finding.code==="COMMAND_NOT_FOUND"?"command":"cwd";
      const snippet=`[${finding.keyPath.slice(0,-1).map(key=>JSON.stringify(String(key))).join(".")}]\n${field} = ${JSON.stringify(resolve(value))}\n`;
      if(parseConfig(snippet,"toml").issues.length)throw new Error("人工片段不能被当前 TOML 阅读器解析");
      plan.manualPatches.push({path:source.path,keyPath:finding.keyPath,snippet,action:"仅在指定表中替换该字段；不要追加重复表或整文件覆盖，修改后重新扫描及原生核对。"});
    }
    if (!source || !source.editable || !source.contentHash || !finding.repair || !finding.keyPath) { plan.manualSteps.push(`${finding.code}：${finding.nextStep}`); continue; }
    const loaded = readConfig(source);
    if (loaded.state !== "readable" || loaded.contentHash !== source.contentHash) throw new Error("配置已变化，请重新扫描");
    const edit: RepairEdit = { sourceId: source.id, path: source.path, format: source.format, beforeHash: source.contentHash, keyPath: finding.keyPath, action: "set", repair: finding.repair };
    if (finding.repair === "variable") {
      const current = at(loaded.value, finding.keyPath);
      if (typeof current !== "string") throw new Error("目标不是变量表达式字符串");
      if (source.client === "claude" && /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/.test(current) || ["cursor", "vscode"].includes(source.client) && /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.test(current)) { /* Transform at application time; never put original values in plan. */ }
      else throw new Error("此表达式不能安全自动转换");
    } else if (finding.repair === "root") {
      const destination = source.client === "vscode" ? "servers" : "mcpServers";
      if (loaded.value[destination] !== undefined) throw new Error("目标根键已经存在，拒绝自动合并");
      if (finding.keyPath.length !== 1 || !at(loaded.value, finding.keyPath) || typeof at(loaded.value, finding.keyPath) !== "object") throw new Error("根键不是服务映射");
      edit.action = "move-root"; edit.destination = destination;
    } else if (finding.repair === "transport") {
      if (!value || !["http", "sse", "ws"].includes(value)) throw new Error("请用 --value 明确指定 http、sse 或 ws");
      edit.value = value;
    } else {
      if (!value || !isAbsolute(value) || !ordinaryPath(value)) throw new Error("请用 --value 提供经过确认的绝对普通路径");
      const stat = lstatSync(value);
      if (finding.repair === "command" ? !stat.isFile() : !stat.isDirectory()) throw new Error("提供的执行文件或工作目录类型不正确");
      edit.value = resolve(value);
    }
    if (plan.edits.some(item => item.path === edit.path && JSON.stringify(item.keyPath) === JSON.stringify(edit.keyPath))) continue;
    plan.edits.push(edit);
  }
  return plan;
}
function allowedPlan(plan: RepairPlan, restoring = false): void {
  if (plan.schemaVersion !== 1 || plan.kind !== "configuration-repair-plan" || !/^[a-f0-9-]{36}$/.test(plan.id) || !Array.isArray(plan.edits) || !plan.edits.length || plan.edits.length > 32 || !Array.isArray(plan.sourceVersions)) throw new Error("计划格式无效或没有可应用修改");
  const sources = configSources(contextFor(plan.context));
  if (plan.sourceVersions.length !== sources.length || sources.some(source => !plan.sourceVersions.some(version => version.path === source.path && version.format === source.format))) throw new Error("计划未包含完整配置来源前置条件");
  for (const edit of plan.edits) {
    const source = sources.find(item => item.id === edit.sourceId && item.path === edit.path && item.format === edit.format);
    if (!source || source.format === "toml" || !ordinaryPath(edit.path) || !/^[a-f0-9]{64}$/.test(edit.beforeHash)) throw new Error("计划目标不受支持");
    if (!Array.isArray(edit.keyPath) || edit.keyPath.length < 1 || edit.keyPath.length > 12 || edit.keyPath.some(key => typeof key !== "string" && (!Number.isInteger(key) || key < 0))) throw new Error("计划字段路径无效");
    const field = edit.keyPath.at(-1);
    if (edit.repair === "root") { if (edit.action !== "move-root" || edit.keyPath.length !== 1 || edit.keyPath[0] !== (source.client === "vscode" ? "mcpServers" : "servers") || edit.destination !== (source.client === "vscode" ? "servers" : "mcpServers")) throw new Error("根键转换不受支持"); }
    else {
      if (edit.action !== "set") throw new Error("修改动作不受支持");
      const root = edit.keyPath[0];
      const serverField = root === "projects" && source.client === "claude" ? edit.keyPath[2] === "mcpServers" && edit.keyPath.length >= 5 : root === (source.client === "vscode" ? "servers" : "mcpServers") && edit.keyPath.length >= 3;
      if (!serverField) throw new Error("只支持 MCP 服务字段，不允许编辑权限或其他设置");
      if (edit.repair === "variable") {
        const tail = edit.keyPath.slice(root === "projects" ? 4 : 2);
        if (edit.value !== undefined || !(tail.length === 1 && ["command", "cwd", "url", "envFile"].includes(String(tail[0])) || tail.length === 2 && (["env", "headers", "http_headers"].includes(String(tail[0])) && typeof tail[1] === "string" || tail[0] === "args" && typeof tail[1] === "number"))) throw new Error("变量转换字段不受支持");
      }
      else if (edit.repair === "transport") { if (field !== "type" || !["http", "sse", "ws"].includes(edit.value ?? "")) throw new Error("传输修改无效"); }
      else if (edit.repair === "command" || edit.repair === "cwd") {
        if (field !== edit.repair || typeof edit.value !== "string" || !isAbsolute(edit.value) || !ordinaryPath(edit.value)) throw new Error("路径修改无效");
        if (!restoring) { const stat = lstatSync(edit.value); if (edit.repair === "command" ? !stat.isFile() : !stat.isDirectory()) throw new Error("修改值的文件类型不正确"); }
      } else throw new Error("未知修复类型");
    }
  }
}
function render(text: string, edit: RepairEdit, plan: RepairPlan): string {
  if (edit.format === "toml") throw new Error("首版不自动写 TOML");
  const parsed = parseConfig(decode(Buffer.from(text)), edit.format);
  if (parsed.issues.length) throw new Error("配置无效，拒绝修改");
  if (edit.action === "move-root") {
    if (parsed.value[edit.destination!] !== undefined) throw new Error("目标根键有冲突");
    return renameRoot(text, String(edit.keyPath[0]), edit.destination!, edit.format);
  }
  let value = edit.value;
  if (edit.repair === "variable") {
    const original = at(parsed.value, edit.keyPath);
    if (typeof original !== "string") throw new Error("变量目标类型已改变");
    const source = configSources(plan.context).find(item => item.id === edit.sourceId)!;
    value = source.client === "claude" ? original.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => `\${${name}}`) : original.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => `\${env:${name}}`);
    if (value === original) throw new Error("变量表达式没有可转换内容");
  }
  return editJson(text, edit.keyPath, value, edit.format);
}
function checkVersions(plan: RepairPlan): void {
  if(plan.mappingVersion){const current=readMapping(plan.context.workspace).version;if(current.state!==plan.mappingVersion.state||current.contentHash!==plan.mappingVersion.contentHash)throw new Error("服务映射已变化，旧计划失效");}
  for (const version of plan.sourceVersions) {
    const loaded = readConfig(version);
    if (loaded.state !== version.state || loaded.contentHash !== version.contentHash) throw new Error("配置来源已变化，旧计划失效；请重新扫描");
  }
}
function authenticPlan(plan: RepairPlan): void {
  const current = scan(plan.context);
  if (!Array.isArray(plan.findings) || !plan.findings.length || plan.findings.some(finding => !current.findings.some(item => item.id === finding.id && item.code === finding.code && item.sourceId === finding.sourceId && item.serverId === finding.serverId))) throw new Error("计划中的故障与当前扫描不一致");
  for (const edit of plan.edits) {
    const permitted = plan.findings.filter(finding => current.findings.some(item => item.id === finding.id && item.repair === edit.repair && item.sourceId === edit.sourceId)).flatMap(finding => makePlan(current, [finding.id], edit.value).edits);
    if (!permitted.some(candidate => JSON.stringify(candidate) === JSON.stringify(edit))) throw new Error("修改不是当前故障的受限修复动作");
  }
}
function publicPlan(plan: RepairPlan): RepairPlan {
  return { schemaVersion: 1, kind: "configuration-repair-plan", id: plan.id, createdAt: new Date().toISOString(), context: contextFor(plan.context),
    findings: plan.findings.map(({ id, code, sourceId, serverId }) => ({ id, code, sourceId, serverId })),
    edits: plan.edits.map(({ sourceId, path, format, beforeHash, keyPath, action, repair, value, destination }) => ({ sourceId, path, format, beforeHash, keyPath, action, repair, ...(value === undefined ? {} : { value }), ...(destination === undefined ? {} : { destination }) })),
    sourceVersions: plan.sourceVersions.map(({ path, format, state, contentHash }) => ({ path, format, state, contentHash })), mappingVersion:readMapping(plan.context.workspace).version,manualSteps: [], limits: ["本机备份可能包含秘密，不纳入分享包。", "静态复查不代表原生会话通过。"] };
}
export function safePreview(value:unknown):unknown {
  if(value===undefined)return {kind:"不存在"};if(typeof value!=="string")return {kind:Array.isArray(value)?"数组":typeof value,value:typeof value==="boolean"?value:undefined};
  const references=[...value.matchAll(/\$\{((?:env:|input:)?[A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)].map(match=>`\${${match[1]}}`);
  return {kind:references.length?"变量表达式（其他文本及默认值隐藏）":"字符串值（已隐藏）",references,length:value.length};
}
export function previewPlan(plan: RepairPlan): Array<{ path: string; fields: Array<{ keyPath: Array<string | number>; repair: string;before:unknown;after:unknown }>; contentChanged: boolean;scope:string;impact:string }> {
  allowedPlan(plan); checkVersions(plan); authenticPlan(plan);
  const groups = new Map<string, RepairEdit[]>();
  for (const edit of plan.edits) groups.set(edit.path, [...(groups.get(edit.path) ?? []), edit]);
  return [...groups].map(([path, edits]) => {
    const original = readOrdinary(path); let text = original.toString("utf8");
    const fields=edits.map(edit=>{const before=safePreview(at(parseConfig(decode(Buffer.from(text)),edit.format).value,edit.keyPath));text=render(text,edit,plan);const after=edit.action==="move-root"?{kind:"根键改名",from:edit.keyPath[0],to:edit.destination}:edit.value!==undefined?{kind:"用户明确确认的新值",value:edit.value}:safePreview(at(parseConfig(decode(Buffer.from(text)),edit.format).value,edit.keyPath));return {keyPath:edit.keyPath,repair:edit.repair,before,after};});
    const source=configSources(plan.context).find(item=>item.path===path)!;
    return { path, fields, contentChanged: hash(Buffer.from(text)) !== hash(original),scope:`${source.client}/${source.scope}`,impact:source.scope==="user"?"修改用户来源可能影响使用同一定义的其他工作区；不修改其他客户端、信任或权限。":"修改当前工作区的已选来源；已有会话需单独重新加载，其他字段保留。" };
  });
}
function exclusiveFile(path: string, bytes: Buffer | string): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function securedFile(path:string,bytes:Buffer|string,source?:string):void {
  if(process.platform!=="win32"){exclusiveFile(path,bytes);return;}
  const helper=nativeHelperPath("safe-file.exe");
  const result=spawnSync(helper,source?["preserve",resolve(path),resolve(source)]:["private",resolve(path)],{input:bytes,windowsHide:true,timeout:4000,maxBuffer:4096,stdio:["pipe","ignore","ignore"]});
  if(result.status!==0||result.error)throw new Error("备份或替换文件的 Windows 访问限制无法安全建立，已停止写入");
}
function requireFileProtection():void {
  if(process.platform==="win32"){
    const helper=nativeHelperPath("safe-file.exe");
    if(!existsSync(helper)||!ordinaryPath(helper))throw new Error("Windows 文件访问限制组件不可用，修复或恢复已停止，请重新构建");
  }
}
function replace(path: string, bytes: Buffer | string, expectedHash: string): void {
  if (hash(readOrdinary(path)) !== expectedHash) throw new Error("目标在修改期间发生变化");
  const temp = join(dirname(path), `.${basename(path)}.doctor-${randomUUID()}.tmp`);
  securedFile(temp, bytes, path);
  try { if (hash(readOrdinary(path)) !== expectedHash) throw new Error("目标在修改期间发生变化"); renameSync(temp, path); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}
function withLocks<T>(paths: string[], work: () => T): T {
  const locks: string[] = [];
  try {
    for (const path of [...new Set(paths)].sort()) {
      const lock = join(dirname(path), `${basename(path)}.doctor.lock`);
      if (!ordinaryPath(lock)) throw new Error("锁文件路径不安全");
      try { exclusiveFile(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); } catch { throw new Error("另一个修复正在操作此文件，或残留锁需要人工核对"); }
      locks.push(lock);
    }
    return work();
  } finally { for (const lock of locks.reverse()) try { unlinkSync(lock); } catch { /* Never remove unowned locks. */ } }
}
export function applyPlan(plan: RepairPlan, operationPath: string, hooks?: { beforeWrite?: (index: number) => void }): RepairOperation {
  allowedPlan(plan);
  requireFileProtection();
  return withLocks(plan.edits.map(edit => edit.path), () => applyLocked(plan, operationPath, hooks));
}
function applyLocked(plan: RepairPlan, operationPath: string, hooks?: { beforeWrite?: (index: number) => void }): RepairOperation {
  allowedPlan(plan); checkVersions(plan); authenticPlan(plan); plan = publicPlan(plan);
  if (!ordinaryPath(operationPath) || existsSync(operationPath)) throw new Error("操作记录路径必须为新普通文件");
  const groups = new Map<string, RepairEdit[]>();
  for (const edit of plan.edits) groups.set(edit.path, [...(groups.get(edit.path) ?? []), edit]);
  const staged = [...groups].map(([path, edits]) => {
    const before = readOrdinary(path); if (hash(before) !== edits[0]!.beforeHash) throw new Error("目标配置已变化");
    let text = before.toString("utf8"); for (const edit of edits) text = render(text, edit, plan);
    return { path, before, after: Buffer.from(text), beforeHash: hash(before), afterHash: hash(Buffer.from(text)) };
  });
  const operation: RepairOperation = { schemaVersion: 1, kind: "configuration-repair-operation", id: randomUUID(), plan, status: "applied", createdAt: new Date().toISOString(), files: [] };
  // Create a journal before the first configuration write. Each subsequent state is recoverable per file.
  exclusiveFile(operationPath, JSON.stringify({ ...operation, status: "conflict" }, null, 2) + "\n");
  const save = () => { const previous = readOrdinary(operationPath); replace(operationPath, JSON.stringify(operation, null, 2) + "\n", hash(previous)); };
  const written: typeof staged = [];
  try {
    for (const [index, item] of staged.entries()) {
      hooks?.beforeWrite?.(index);
      if (hash(readOrdinary(item.path)) !== item.beforeHash) throw new Error("目标在应用期间变化");
      const backup = `${item.path}.doctor-backup-${operation.id}.bak`;
      securedFile(backup, item.before);
      operation.files.push({ path: item.path, backup, beforeHash: item.beforeHash, afterHash: item.afterHash });
      operation.status = "conflict"; save();
      replace(item.path, item.after, item.beforeHash); written.push(item);
      save();
    }
    operation.status = "applied"; save(); return operation;
  } catch {
    let conflict = false;
    for (const item of [...written].reverse()) try { replace(item.path, item.before, item.afterHash); } catch { conflict = true; }
    operation.status = conflict ? "conflict" : "rolled-back"; save();
    throw new Error(conflict ? "应用失败，部分恢复发生冲突；查看操作记录和备份" : "应用失败，已恢复本次成功写入的文件；查看操作记录");
  }
}
function validateOperation(operation: RepairOperation): void {
  if (operation.schemaVersion !== 1 || operation.kind !== "configuration-repair-operation" || !/^[a-f0-9-]{36}$/.test(operation.id) || !Array.isArray(operation.files)) throw new Error("操作记录无效");
  allowedPlan(operation.plan, true);
  for (const file of operation.files) if (!operation.plan.edits.some(edit => edit.path === file.path && edit.beforeHash === file.beforeHash) || file.backup !== `${file.path}.doctor-backup-${operation.id}.bak` || !/^[a-f0-9]{64}$/.test(file.afterHash)) throw new Error("备份或目标与计划不一致");
}
export function restoreOperation(operation: RepairOperation, hooks?: { beforeWrite?: (index: number) => void }): RepairOperation {
  validateOperation(operation);
  requireFileProtection();
  return withLocks(operation.files.map(file => file.path), () => restoreLocked(operation, hooks));
}
function restoreLocked(operation: RepairOperation, hooks?: { beforeWrite?: (index: number) => void }): RepairOperation {
  if (operation.status !== "applied" && operation.status !== "conflict") throw new Error("此操作没有需要恢复的修改");
  const files = operation.files.map(file => { const before = readOrdinary(file.backup); if (hash(before) !== file.beforeHash) throw new Error("备份内容验证失败"); const current = hash(readOrdinary(file.path)); if (current !== file.afterHash && current !== file.beforeHash) throw new Error("目标已被其他程序修改，拒绝覆盖"); return { ...file, before, current }; });
  for (const [index, file] of files.entries()) { hooks?.beforeWrite?.(index); if (file.current === file.afterHash) replace(file.path, file.before, file.afterHash); }
  return { ...operation, status: "rolled-back", verification: undefined };
}
export function verifyOperation(operation: RepairOperation): { operation: RepairOperation; scan: ScanReport } {
  validateOperation(operation);
  const current = scan(operation.plan.context);
  const mappingUnchanged=!operation.plan.mappingVersion||current.mapping?.contentHash===operation.plan.mappingVersion.contentHash&&current.mapping?.state===operation.plan.mappingVersion.state;
  const integrity = operation.status === "applied" && operation.files.length > 0 && operation.files.every(file => { try { return hash(readOrdinary(file.path)) === file.afterHash; } catch { return false; } });
  const noProblem = operation.plan.findings.every(finding => !current.findings.some(item => item.id === finding.id) && (finding.serverId === null || current.servers.some(server => server.id === finding.serverId)));
  const sourceHealth = operation.files.every(file => current.sources.some(source => source.path === file.path && source.state === "readable"));
  const contextUnchanged = operation.plan.sourceVersions.every(previous => {
    const after = operation.files.find(file => file.path === previous.path);
    return current.sources.some(source => source.path === previous.path && source.state === (after ? "readable" : previous.state) && source.contentHash === (after?.afterHash ?? previous.contentHash));
  });
  const configuration = integrity && noProblem && sourceHealth && contextUnchanged && mappingUnchanged ? "PASS" : "FAIL";
  return { operation: { ...operation, verification: { configuration, nativeSession: "UNKNOWN", reason: configuration === "PASS" ? "文件内容与本次写入一致，选中静态故障已消失；原生会话尚未验证。" : "文件变化、来源不完整或选中故障仍存在，请重新扫描。" } }, scan: current };
}
