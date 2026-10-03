import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createConnection } from "node:net";
import { record } from "./parsers.js";
import type { DiagnosticClient, Finding, ScanContext, ScanReport } from "./types.js";
export interface NetworkObservation { client:DiagnosticClient;serverId:string|null;target:"model"|"mcp";proxySource:string;proxyPresent:boolean;proxyKind:"http"|"https"|"unsupported"|"invalid"|"unobserved"|"none";bypassCandidate:boolean|null;certificate:"present"|"missing"|"unobserved"|"none";authTarget:"unclassified" }
const proxyKeys=["https_proxy","HTTPS_PROXY","http_proxy","HTTP_PROXY"];
function selected(env:NodeJS.ProcessEnv):{key:string|null;value:string|null} {const key=proxyKeys.find(key=>env[key]!==undefined);return {key:key??null,value:key?env[key]??null:null};}
export function proxyValue(env:NodeJS.ProcessEnv):string|null{return selected(env).value;}
function bypass(url:string|undefined,env:NodeJS.ProcessEnv):boolean|null {
  if(!url)return null;let host:string,port:string;try{const parsed=new URL(url);host=parsed.hostname;port=parsed.port|| (parsed.protocol==="https:"?"443":"80");}catch{return null;}
  if(url.includes("${")||(env.no_proxy??env.NO_PROXY??"").includes("${"))return null;
  return (env.no_proxy??env.NO_PROXY??"").split(/[ ,]+/).filter(Boolean).some(value=>{if(value==="*")return true;const parts=value.split(":");const pattern=parts[0]!.replace(/^\./,"").toLowerCase();if(parts.length>1&&parts[1]!==port)return false;return host.toLowerCase()===pattern||host.toLowerCase().endsWith("."+pattern);});
}
export function observeNetwork(client:DiagnosticClient,serverId:string|null,target:"model"|"mcp",url:string|undefined,base:NodeJS.ProcessEnv,configured:Record<string,unknown>,source:string,context:ScanContext):{observation:NetworkObservation;issues:Array<Pick<Finding,"code"|"detail"|"nextStep"|"confidence">>} {
  const env={...base};for(const[key,value]of Object.entries(configured))if(typeof value==="string")env[key]=value;
  const proxy=selected(env);let proxyKind:NetworkObservation["proxyKind"]="none";
  if(proxy.value?.includes("${"))proxyKind="unobserved";
  else if(proxy.value)try{const protocol=new URL(proxy.value).protocol;proxyKind=protocol==="http:"?"http":protocol==="https:"?"https":"unsupported";}catch{proxyKind="invalid";}
  let certificate:NetworkObservation["certificate"]="none";
  for(const key of ["NODE_EXTRA_CA_CERTS","SSL_CERT_FILE","ANTHROPIC_CLIENT_CERT","ANTHROPIC_CLIENT_KEY"]){const value=env[key];if(!value)continue;if(value.includes("${")){certificate="unobserved";continue;}try{if(!existsSync(resolve(context.workspace,value))||!statSync(resolve(context.workspace,value)).isFile())certificate="missing";else if(certificate!=="missing")certificate="present";}catch{certificate="unobserved";}}
  const issues:Array<Pick<Finding,"code"|"detail"|"nextStep"|"confidence">>=[];
  if(selected(base).value!==proxy.value)issues.push({code:"PROXY_CONTEXT_DIFFERENCE",detail:"已知配置与诊断进程的代理定义不同；可能有意，不证明原生网络失败。",nextStep:"在相同客户端入口核对实际启动环境和代理来源。",confidence:"possible"});
  if(proxyKind==="unsupported"||proxyKind==="invalid")issues.push({code:"PROXY_FORMAT_UNSUPPORTED",detail:"发现非 HTTP(S) 或无法解析的代理定义；未连接该地址。",nextStep:"核对目标客户端支持的代理协议和格式。",confidence:"inferred"});
  const candidate=bypass(url,env);if(proxy.value&&candidate)issues.push({code:"NO_PROXY_CANDIDATE",detail:"目标域名可能匹配已知 NO_PROXY；实际匹配仍由原客户端决定。",nextStep:"在目标入口核对 NO_PROXY、端口与连接日志，保留有意绕过。",confidence:"possible"});
  if(certificate==="missing")issues.push({code:"CERT_PATH_MISSING",detail:"已知证书或证书密钥路径不是当前可读取的普通文件，未读取证书内容。",nextStep:"在客户端启动环境核对证书路径和访问权限，不关闭 TLS 验证。",confidence:"inferred"});
  return {observation:{client,serverId,target,proxySource:proxy.key&&configured[proxy.key]!==undefined?source:"scanner-environment",proxyPresent:Boolean(proxy.value),proxyKind,bypassCandidate:candidate,certificate,authTarget:"unclassified"},issues};
}
export async function loopbackProxyCheck(report:ScanReport,client:DiagnosticClient):Promise<{status:"PASS"|"FAIL"|"UNKNOWN";target:"proxy-port";reason:string;limitations:string[]}> {
  if(!report.context.clients.includes(client)||report.context.location!=="local")throw new Error("请选择本地扫描中的客户端");
  const proxy=proxyValue(process.env);if(!proxy)return {status:"UNKNOWN",target:"proxy-port",reason:"诊断进程未设置代理；此检查不猜测系统或客户端代理。",limitations:["只检查诊断进程代理，不代表原生网络。"]};
  let url:URL;try{url=new URL(proxy);}catch{throw new Error("代理格式无法安全解析");}
  if(!["http:","https:"].includes(url.protocol)||!["127.0.0.1","localhost","[::1]"].includes(url.hostname))throw new Error("首版端口检查仅支持明确配置的回环 HTTP(S) 代理");
  const port=Number(url.port||(url.protocol==="https:"?443:80));
  const status=await new Promise<"PASS"|"FAIL">(done=>{const socket=createConnection({host:url.hostname.replace(/[\[\]]/g,""),port});let settled=false;const finish=(value:"PASS"|"FAIL")=>{if(settled)return;settled=true;socket.destroy();done(value);};socket.setTimeout(1500,()=>finish("FAIL"));socket.once("connect",()=>finish("PASS"));socket.once("error",()=>finish("FAIL"));});
  return {status,target:"proxy-port",reason:status==="PASS"?"已知回环代理 TCP 端口可达。":"已知回环代理 TCP 端口连接失败或超时。",limitations:["未发送 HTTP 请求、凭据或模型请求；TCP 可达不证明 TLS、认证或 MCP 可用。","只描述诊断进程，不证明 IDE/桌面会话使用同一代理。"]};
}
export function classifyAuthFailure(output:string):"model"|"mcp"|"unclassified"|null {
  if(!/\b401\b|authentication_failed|unauthorized/i.test(output))return null;
  const model=/anthropic|openai|model[_ -]?(?:api|request)|api\.anthropic\.com/i.test(output),mcp=/mcp|server[_ -]?(?:connection|transport)/i.test(output);
  return model&&!mcp?"model":mcp&&!model?"mcp":"unclassified";
}
