import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCase, fixHint, modelCostUsd, summarizeWire } from "./runner.js";

test("model cost is recorded only when a client reports a numeric amount", () => {
  assert.equal(modelCostUsd([{ type: "result", total_cost_usd: 0.007311 }]), 0.007311);
  assert.equal(modelCostUsd([{ type: "turn.completed", usage: { input_tokens: 100 } }]), null);
});

test("failure classification gives a concrete next check", () => {
  assert.match(fixHint("SERVER_STARTUP") ?? "", /server\.command/);
  assert.match(fixHint("TOOL_SELECTION") ?? "", /客户端轨迹/);
});

test("wire summary requires actual list response and captures tool call", () => {
  const events = [
    { direction: "client_to_server", message: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
    { direction: "server_to_client", message: { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "lookup_release" }] } } },
    { direction: "client_to_server", message: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lookup_release", arguments: { releaseId: "REL-42" } } } },
    { direction: "server_to_client", message: { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ready" }] } } },
  ];
  assert.deepEqual(summarizeWire(events), { discovered: true, protocolVersion: null, calls: [{ name: "lookup_release", arguments: { releaseId: "REL-42" } }], toolErrors: [false] });
});

test("a request without a response is not proof of discovery", () => {
  assert.equal(summarizeWire([{ direction: "client_to_server", message: { id: 1, method: "tools/list" } }]).discovered, false);
});

test("task grading distinguishes a negative pass from a missed positive call", () => {
  const wire = { discovered: true, protocolVersion: "2025-11-25", calls: [], toolErrors: [] };
  assert.equal(evaluateCase({ id: "negative", prompt: "x", expect: { noToolCalls: true } }, wire, "4", [], false, 0, false).verdict, "PASS");
  assert.equal(evaluateCase({ id: "direct", prompt: "x", expect: { tool: "lookup_release" } }, wire, "ready", [], false, 0, false).verdict, "FAIL");
});

test("negative case fails when the client calls a built-in tool outside the target MCP wire", () => {
  const wire = { discovered: true, protocolVersion: null, calls: [], toolErrors: [] };
  const clientEvents = [{ type: "item.started", item: { type: "mcp_tool_call", server: "codex", tool: "list_mcp_resources" } }];
  const verdict = evaluateCase({ id: "negative", prompt: "x", expect: { noToolCalls: true } }, wire, "4", [], false, 0, false, undefined, clientEvents);
  assert.equal(verdict.verdict, "FAIL");
});

test("tool error and authentication failure cannot become a pass", () => {
  const wire = { discovered: true, protocolVersion: null, calls: [{ name: "lookup_release", arguments: { releaseId: "ERROR" } }], toolErrors: [true] };
  const item = { id: "error", prompt: "x", expect: { tool: "lookup_release", toolError: false } };
  assert.equal(evaluateCase(item, wire, "error", [], false, 0, false).verdict, "FAIL");
  assert.equal(evaluateCase(item, wire, "", [], false, 1, false, "客户端模型认证失败（401）").reason, "客户端模型认证失败（401）");
});

test("guard case allows lookup while blocking simulated deletion", () => {
  const lookup = { discovered: true, protocolVersion: null, calls: [{ name: "lookup_release", arguments: { releaseId: "REL-42" } }], toolErrors: [false] };
  const guard = { id: "guard", prompt: "x", expect: { forbiddenTools: ["delete_release"] } };
  assert.equal(evaluateCase(guard, lookup, "Deletion could be risky", [], false, 0, false).verdict, "PASS");
  assert.equal(evaluateCase(guard, { ...lookup, calls: [...lookup.calls, { name: "delete_release", arguments: { releaseId: "REL-42" } }] }, "Deleted", [], false, 0, false).verdict, "FAIL");
});

test("fixture answer must carry the run id from the actual server receipt", () => {
  const wire = { discovered: true, protocolVersion: null, calls: [{ name: "lookup_release", arguments: { releaseId: "REL-42" } }], toolErrors: [false] };
  const item = { id: "direct", prompt: "x", expect: { tool: "lookup_release", arguments: { releaseId: "REL-42" }, finalContains: "ready" } };
  const receipt = [{ type: "tool_called", name: "lookup_release", runId: "fixture-run-123" }];
  assert.equal(evaluateCase(item, wire, "ready", receipt, true, 0, false).verdict, "FAIL");
  assert.equal(evaluateCase(item, wire, "ready fixture-run-123", receipt, true, 0, false).verdict, "PASS");
});

test("indirect search accepts a constrained query variant", () => {
  const wire = { discovered: true, protocolVersion: null, calls: [{ name: "search_nodes", arguments: { query: "Orion release owner" } }], toolErrors: [false] };
  const item = { id: "indirect", prompt: "x", expect: { tool: "search_nodes", argumentsContains: { query: "Orion" }, finalContains: "Maya" } };
  assert.equal(evaluateCase(item, wire, "Maya owns Orion", [], false, 0, false).verdict, "PASS");
  assert.equal(evaluateCase(item, { ...wire, calls: [{ name: "search_nodes", arguments: { query: "Venus" } }] }, "Maya owns Orion", [], false, 0, false).verdict, "FAIL");
});
