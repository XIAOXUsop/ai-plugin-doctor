import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { resolve, parse as parsePath, dirname } from "node:path";
import { parse, parseTree, findNodeAtLocation, type Node as JsonNode, modify, applyEdits } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { hash } from "../config.js";
import type { ConfigSource, JsonPath } from "./types.js";

export const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
export function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function at(value: unknown, path: JsonPath): unknown { return path.reduce<unknown>((current, key) => Array.isArray(current) && typeof key === "number" ? current[key] : Object.hasOwn(record(current), String(key)) ? record(current)[String(key)] : undefined, value); }
export function ordinaryPath(path: string): boolean {
  let current = resolve(path);
  for (;;) {
    try { if (lstatSync(current).isSymbolicLink()) return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    const parent = dirname(current);
    if (parent === current || current === parsePath(current).root) return true;
    current = parent;
  }
}
export function readOrdinary(path: string): Buffer {
  if (!ordinaryPath(path)) throw new Error("UNSAFE_PATH");
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error("UNSAFE_PATH");
  if (stat.size > MAX_CONFIG_BYTES) throw new Error("CONFIG_TOO_LARGE");
  const bytes = readFileSync(path);
  if (bytes.length > MAX_CONFIG_BYTES) throw new Error("CONFIG_TOO_LARGE");
  if (resolve(realpathSync(path)).toLowerCase() !== resolve(path).toLowerCase()) throw new Error("UNSAFE_PATH");
  return bytes;
}
export function decode(bytes: Buffer): string { return bytes.toString("utf8").replace(/^\uFEFF/, ""); }
export function locateNode(text:string,format:ConfigSource["format"],path:JsonPath):{offset:number;line:number;column:number}|null {
  text=text.replace(/^\uFEFF/,""); let offset:number|undefined;
  if(format!=="toml") { const tree=parseTree(text,[],{disallowComments:format==="json",allowTrailingComma:format==="jsonc"});offset=tree?findNodeAtLocation(tree,path)?.offset:undefined; }
  else {
    let table:string[]=[],position=0;
    const keys=(value:Record<string,unknown>):string[]=>{const result:string[]=[];let current=value;while(Object.keys(current).length===1){const key=Object.keys(current)[0]!;result.push(key);current=record(current[key]);}return result;};
    for(const line of text.split(/(?<=\n)/)) {
      const header=/^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line.trimEnd());
      if(header)try{table=keys(record(parseToml(`[${header[1]}]\n__doctor_position=0`))).slice(0,-1);if(JSON.stringify(table)===JSON.stringify(path))offset=position+line.indexOf("[");}catch{/* Complex table remains unlocated. */}
      else { const assignment=/^\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.-]+))\s*=/.exec(line);if(assignment)try{const field=keys(record(parseToml(`${assignment[1]}=0`)));if(JSON.stringify([...table,...field])===JSON.stringify(path))offset=position+line.indexOf(assignment[1]!);}catch{/* Opaque key. */} }
      position+=line.length;
    }
  }
  if(offset===undefined)return null;
  const prefix=text.slice(0,offset);return {offset,line:prefix.split("\n").length,column:offset-(prefix.lastIndexOf("\n")+1)+1};
}
function duplicateKeys(node: JsonNode | undefined, result: string[], depth = 0): void {
  if (depth > 128) throw new Error("CONFIG_COMPLEXITY_LIMIT");
  if (!node) return;
  if (node.type === "object") {
    const keys = new Set<string>();
    for (const child of node.children ?? []) {
      const key = String(child.children?.[0]?.value);
      if (keys.has(key)) result.push("CFG_DUPLICATE_KEY");
      keys.add(key);
    }
  }
  for (const child of node.children ?? []) duplicateKeys(child, result, depth + 1);
}
function bounded(value: unknown, depth = 0, counter = { value: 0 }): void {
  if (depth > 64 || ++counter.value > 50000) throw new Error("CONFIG_COMPLEXITY_LIMIT");
  if (value && typeof value === "object") for (const child of Object.values(value)) bounded(child, depth + 1, counter);
}
export function parseConfig(text: string, format: ConfigSource["format"]): { value: Record<string, unknown>; issues: string[] } {
  text = text.replace(/^\uFEFF/, "");
  let value: unknown;
  const issues: string[] = [];
  if (format === "toml") {
    try { value = parseToml(text); } catch { return { value: {}, issues: ["CFG_PARSE_ERROR"] }; }
  } else {
    const errors: Array<{ error: number; offset: number; length: number }> = [];
    const options = { disallowComments: format === "json", allowTrailingComma: format === "jsonc", allowEmptyContent: false };
    try {
      value = parse(text, errors, options);
      if (errors.length) issues.push("CFG_PARSE_ERROR");
      duplicateKeys(parseTree(text, [], options), issues);
    } catch { return { value: {}, issues: ["CONFIG_COMPLEXITY_LIMIT"] }; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) issues.push("CFG_PARSE_ERROR");
  try { bounded(value); } catch { issues.push("CONFIG_COMPLEXITY_LIMIT"); }
  return { value: record(value), issues: [...new Set(issues)] };
}
export function readConfig(source: Pick<ConfigSource, "path" | "format">): { state: ConfigSource["state"]; value: Record<string, unknown>; contentHash: string | null; text: string | null; issues: string[] } {
  try {
    const bytes = readOrdinary(source.path);
    const text = decode(bytes);
    const parsed = parseConfig(text, source.format);
    return { state: parsed.issues.length ? "invalid" : "readable", ...parsed, text, contentHash: hash(bytes) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = error instanceof Error ? error.message : "";
    return { state: code === "ENOENT" ? "missing" : reason === "UNSAFE_PATH" || reason === "CONFIG_TOO_LARGE" ? "unsafe" : "unreadable", value: {}, text: null, contentHash: null, issues: [reason === "CONFIG_TOO_LARGE" ? "CONFIG_TOO_LARGE" : reason === "UNSAFE_PATH" ? "CONFIG_UNSAFE_PATH" : code === "ENOENT" ? "CONFIG_MISSING" : "CONFIG_UNREADABLE"] };
  }
}
export function editJson(text: string, keyPath: JsonPath, value: unknown, format: "json" | "jsonc"): string {
  const parsed = parseConfig(text, format);
  if (parsed.issues.length) throw new Error("配置无效，拒绝修改");
  const original = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const result = applyEdits(original, modify(original, keyPath, value, { formattingOptions: { insertSpaces: !/^\t/m.test(original), tabSize: /^ {4}\S/m.test(original) ? 4 : 2, eol: original.includes("\r\n") ? "\r\n" : "\n" } }));
  if (parseConfig(result, format).issues.length) throw new Error("修改后的配置无效");
  return (text.startsWith("\uFEFF") ? "\uFEFF" : "") + result;
}
export function renameRoot(text: string, from: string, to: string, format: "json" | "jsonc"): string {
  const original = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const tree = parseTree(original, [], { disallowComments: format === "json", allowTrailingComma: format === "jsonc" });
  const key = tree && findNodeAtLocation(tree, [from])?.parent?.children?.[0];
  if (!key || parseConfig(original, format).issues.length || record(parseConfig(original, format).value)[to] !== undefined) throw new Error("根键转换存在冲突");
  const result = original.slice(0, key.offset) + JSON.stringify(to) + original.slice(key.offset + key.length);
  if (parseConfig(result, format).issues.length) throw new Error("转换后配置无效");
  return (text.startsWith("\uFEFF") ? "\uFEFF" : "") + result;
}
