import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ServerConfig } from "./types.js";
import { expandEnvReferences } from "./config.js";
import { hash } from "./config.js";

export interface ProbeResult {
  ok: boolean;
  tools: string[];
  toolSurfaceHash: string | null;
  serverVersion: string | null;
  call: { tool: string; isError: boolean; resultHash: string } | null;
  error?: string;
}
export async function probe(server: ServerConfig, probeCall?: { tool: string; arguments?: Record<string, unknown> }): Promise<ProbeResult> {
  const client = new Client({ name: "ai-plugin-doctor", version: "0.1.0" });
  let timer: NodeJS.Timeout | undefined;
  try {
    if (isAbsolute(server.command) && !existsSync(server.command)) throw new Error(`Server executable not found: ${server.command}`);
    const transport = new StdioClientTransport({
      command: server.command, args: server.args, cwd: server.cwd,
      env: { ...process.env, ...expandEnvReferences(server.env) } as Record<string, string>,
      stderr: "pipe",
    });
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MCP handshake timed out")), 12000); }),
    ]);
    const result = await client.listTools();
    const info = client.getServerVersion();
    if (probeCall && !result.tools.some(tool => tool.name === probeCall.tool)) throw new Error(`Controlled probe tool not found: ${probeCall.tool}`);
    const called = probeCall ? await client.callTool({ name: probeCall.tool, arguments: probeCall.arguments ?? {} }) : null;
    return {
      ok: true,
      tools: result.tools.map(x => x.name),
      toolSurfaceHash: hash(JSON.stringify(result.tools)),
      serverVersion: info ? `${info.name} ${info.version}` : null,
      call: called && probeCall ? { tool: probeCall.tool, isError: called.isError === true, resultHash: hash(JSON.stringify(called)) } : null,
    };
  } catch (error) {
    return { ok: false, tools: [], toolSurfaceHash: null, serverVersion: null, call: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
