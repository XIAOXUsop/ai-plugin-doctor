import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEvents } from "./events.js";

test("normalized events retain distinct client selection and server call evidence", () => {
  const wire = [
    { direction: "client_to_server", message: { id: 1, method: "initialize" } },
    { direction: "server_to_client", message: { id: 1, result: { protocolVersion: "2025-11-25" } } },
    { direction: "client_to_server", message: { id: 2, method: "tools/list" } },
    { direction: "server_to_client", message: { id: 2, result: { tools: [{ name: "lookup_release" }] } } },
    { direction: "client_to_server", message: { id: 3, method: "tools/call", params: { name: "lookup_release", arguments: { releaseId: "REL-42" } } } },
    { direction: "server_to_client", message: { id: 3, result: { content: [] } } },
  ];
  const client = [{ type: "item.started", item: { type: "mcp_tool_call", tool: "lookup_release", arguments: { releaseId: "REL-42" } } }];
  assert.deepEqual(normalizeEvents(wire, client, "ready").map(event => event.type), ["client_init", "server_discovered", "tool_called", "tool_result", "tool_selected", "final_answer"]);
});
