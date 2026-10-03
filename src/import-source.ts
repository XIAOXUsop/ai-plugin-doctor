import { existsSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { decode, parseConfig, readOrdinary, record } from "./diagnostics/parsers.js";
import type { ServerConfig } from "./types.js";

export interface ImportEntry { name: string; kind: "stdio" | "unsupported" | "package-entry"; reason: string; argumentCount: number }
export interface ImportSource { file: string; kind: "mcp" | "package"; entries: ImportEntry[]; value: Record<string, unknown> }
export function readImportDocument(file: string): Record<string, unknown> {
  return parseImportDocument(file, readOrdinary(file));
}
export function parseImportDocument(file: string, bytes: Buffer): Record<string, unknown> {
  const format = extname(file).toLowerCase() === ".toml" ? "toml" : extname(file).toLowerCase() === ".jsonc" || dirname(file).endsWith(".vscode") ? "jsonc" : "json";
  const parsed = parseConfig(decode(bytes), format);
  if (parsed.issues.length) throw new Error("源配置解析失败：请修正语法、重复键或文件大小后重试；未写入输出。");
  return parsed.value;
}
const configNames = [".mcp.json", "mcp.json", "mcp.jsonc", "claude_desktop_config.json", ".vscode/mcp.json", ".cursor/mcp.json", "config.toml"];
function serverReason(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "服务定义必须为对象";
  const c = record(value);
  if (c.disabled === true || c.enabled === false) return "服务已禁用；不自动启用";
  if (c.type !== undefined && c.type !== "stdio" || c.transport !== undefined && c.transport !== "stdio" || c.url !== undefined) return "此导入只支持本地 stdio 服务";
  if (typeof c.command !== "string" || !c.command.trim()) return "缺少 stdio command";
  if (c.args !== undefined && (!Array.isArray(c.args) || !c.args.every(x => typeof x === "string"))) return "args 必须为字符串数组";
  if (c.cwd !== undefined && (typeof c.cwd !== "string" || !c.cwd.trim())) return "cwd 必须为非空目录路径";
  if (c.envFile !== undefined || c.oauth !== undefined || c.headers !== undefined || c.sandbox !== undefined) return "包含不能迁移的 envFile/认证/隔离配置，请先人工确认";
  if ([c.command, c.cwd, ...((c.args ?? []) as unknown[])].some(x => typeof x === "string" && x.includes("${"))) return "启动字段含客户端变量；请先换成明确值或绝对路径";
  if (c.env !== undefined) {
    if (!c.env || typeof c.env !== "object" || Array.isArray(c.env)) return "env 必须为对象";
    for (const [key, value] of Object.entries(record(c.env))) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string") return "env 需使用合法变量名及字符串值";
      if (value.includes("${") && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) return "env 包含不能迁移的变量表达式";
    }
  }
  // Fields carrying host permissions/defaults are not silently dropped.
  const allowed = new Set(["command", "args", "cwd", "env", "type", "transport", "disabled", "enabled"]);
  if (Object.keys(c).some(key => !allowed.has(key))) return "包含未支持的宿主字段；不自动丢弃后导入";
  return null;
}
export function inspectImportSource(sourcePath: string): ImportSource {
  const source = resolve(sourcePath);
  if (!existsSync(source)) throw new Error("Source not found: 请提供存在的配置文件或插件目录");
  const directory = statSync(source).isDirectory();
  const configs = directory ? configNames.map(name => join(source, name)).filter(existsSync) : [source];
  if (configs.length > 1) throw new Error(`目录中有多份 MCP 配置，请显式传入其中一个文件：${configs.map(path => path.slice(source.length + 1)).join(", ")}`);
  const file = configs[0] ?? join(source, "package.json");
  if (!existsSync(file)) throw new Error("目录中没有支持的 MCP 配置或 package.json；请显式指定配置文件");
  const value = readImportDocument(file);
  const roots = ["mcpServers", "servers", "mcp_servers"].filter(key => Object.hasOwn(value, key));
  if (roots.length > 1) throw new Error("发现多个服务根键，无法确定应导入哪一组；请整理配置后重试");
  if (roots.length) {
    const raw = value[roots[0]!];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("服务根键必须为对象");
    const entries = Object.entries(record(raw)).map(([name, definition]): ImportEntry => {
      const reason = serverReason(definition);
      return { name, kind: reason ? "unsupported" : "stdio", reason: reason ?? "可导入本地 stdio；未启动或验证服务", argumentCount: Array.isArray(record(definition).args) ? (record(definition).args as unknown[]).length : 0 };
    });
    if (!entries.length) throw new Error("配置中没有服务");
    return { file, kind: "mcp", entries, value };
  }
  if (!directory && file.split(/[\\/]/).at(-1) !== "package.json") throw new Error("MCP config must contain mcpServers, servers or mcp_servers");
  let entries: ImportEntry[] = [];
  if (typeof value.bin === "string") entries = [{ name: "bin", kind: "package-entry", reason: "Node 本地入口，未执行", argumentCount: 1 }];
  else if (value.bin !== undefined) entries = Object.entries(record(value.bin)).map(([name, path]) => ({ name, kind: typeof path === "string" ? "package-entry" : "unsupported", reason: typeof path === "string" ? "Node 本地入口，未执行" : "入口路径必须为字符串", argumentCount: 1 }));
  else if (typeof value.main === "string") entries = [{name:"main",kind:"package-entry",reason:"Node 本地入口，未执行",argumentCount:1}];
  if (!entries.length) throw new Error("插件 package.json 没有可选择的 bin/main 入口");
  return { file, kind: "package", entries, value };
}
export function importServer(source: ImportSource, name?: string, cwdOverride?: string): { server: ServerConfig; selected: string; notes: string[] } {
  const selected = name ?? (source.entries.length === 1 ? source.entries[0]!.name : undefined);
  const entry = source.entries.find(entry => entry.name === selected);
  if (!entry) throw new Error(`请明确选择${source.kind === "package" ? " --entry" : " --server"}；available: ${source.entries.map(entry => entry.name).join(", ")}。可先使用 --list 只读查看。`);
  if (entry.kind === "unsupported") throw new Error(`所选服务/入口不能导入：${entry.reason}`);
  const base = dirname(source.file);
  if (cwdOverride !== undefined && !cwdOverride.trim()) throw new Error("--cwd 需为非空目录路径");
  if (source.kind === "package") {
    const path = typeof source.value.bin === "string" ? source.value.bin : selected === "main" && source.value.bin === undefined ? source.value.main : record(source.value.bin)[selected!];
    if (typeof path !== "string" || !existsSync(resolve(base,path)) || !statSync(resolve(base,path)).isFile()) throw new Error("所选本地入口不存在或不是文件；请先构建插件");
    const cwd = cwdOverride ? resolve(cwdOverride) : base;
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error("工作目录不存在或不是目录");
    return {server:{command:process.execPath,args:[resolve(base,path)],cwd},selected:selected!,notes:["仅选择本地 Node 入口；不会安装依赖或运行包脚本。"]};
  }
  const root = ["mcpServers","servers","mcp_servers"].find(key=>Object.hasOwn(source.value,key))!;
  const definition = record(record(source.value[root])[selected!]);
  const cwd = cwdOverride ? resolve(cwdOverride) : resolve(base, typeof definition.cwd === "string" ? definition.cwd : ".");
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error("工作目录不存在或不是目录；可用 --cwd 指定原客户端的实际目录");
  const command = definition.command as string;
  const server: ServerConfig = {command:!isAbsolute(command)&&/[\\/]/.test(command)?resolve(cwd,command):command,args:(definition.args as string[] | undefined)??[],cwd};
  const env = record(definition.env);
  if (Object.keys(env).length) server.env = Object.fromEntries(Object.entries(env).map(([key,value])=>[key,/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value as string)?value as string:`\${${key}}`]));
  return {server,selected:selected!,notes:["工作目录已固定为上方路径；未声明 cwd 时采用源配置目录，请核对原客户端启动目录，必要时用 --cwd 重试。","相对执行文件按工作目录转成绝对路径；参数原样保留并相对工作目录解释，不猜测参数是文件、包名还是普通文本。","原有 ${VARIABLE} 引用保留；内联 env 值改为同名变量引用，请在当前进程环境中设置所需变量。","导入只读取指定来源，不证明原客户端实际加载、信任、权限或已有会话状态。"]};
}
