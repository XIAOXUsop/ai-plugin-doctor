export type EventKind = "client_init" | "server_discovered" | "tool_selected" | "tool_called" | "tool_result" | "final_answer" | "error";
export interface NormalizedEvent {
  type: EventKind;
  source: "wire.jsonl" | "client.stdout.jsonl" | "client.stderr.log";
  sourceIndex?: number;
  at?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  isError?: boolean;
  text?: string;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function normalizeEvents(wire: Record<string, unknown>[], client: Record<string, unknown>[], answer: string, processError?: string): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  const requestMethods = new Map<string, Record<string, unknown>>();
  for (const [index, event] of wire.entries()) {
    const message = object(event.message);
    const id = JSON.stringify(message.id);
    const at = typeof event.at === "string" ? event.at : undefined;
    if (event.direction === "client_to_server") {
      if (message.id !== undefined) requestMethods.set(id, message);
      if (message.method === "tools/call") {
        const params = object(message.params);
        out.push({ type: "tool_called", source: "wire.jsonl", sourceIndex: index, at, tool: String(params.name ?? ""), arguments: object(params.arguments) });
      }
    } else if (event.direction === "server_to_client" && message.id !== undefined) {
      const request = requestMethods.get(id);
      if (!request) continue;
      if (request.method === "initialize" && object(message.result).protocolVersion) out.push({ type: "client_init", source: "wire.jsonl", sourceIndex: index, at });
      if (request.method === "tools/list" && Array.isArray(object(message.result).tools)) out.push({ type: "server_discovered", source: "wire.jsonl", sourceIndex: index, at });
      if (request.method === "tools/call") {
        const params = object(request.params);
        out.push({ type: "tool_result", source: "wire.jsonl", sourceIndex: index, at, tool: String(params.name ?? ""), isError: object(message.result).isError === true || Boolean(message.error) });
      }
      requestMethods.delete(id);
    }
  }
  for (const [index, event] of client.entries()) {
    const item = object(event.item);
    if (event.type === "item.started" && item.type === "mcp_tool_call") out.push({ type: "tool_selected", source: "client.stdout.jsonl", sourceIndex: index, tool: String(item.tool ?? ""), arguments: object(item.arguments) });
    if (event.type === "assistant") {
      const content = object(event.message).content;
      if (Array.isArray(content)) for (const part of content) {
        const tool = object(part);
        if (tool.type === "tool_use" && typeof tool.name === "string") out.push({ type: "tool_selected", source: "client.stdout.jsonl", sourceIndex: index, tool: tool.name, arguments: object(tool.input) });
      }
    }
  }
  if (answer) out.push({ type: "final_answer", source: "client.stdout.jsonl", text: answer });
  if (processError) out.push({ type: "error", source: "client.stderr.log", text: processError });
  return out;
}
