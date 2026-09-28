import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "doctor-release-fixture", version: "0.1.0" });
const runId = process.env.DOCTOR_RUN_ID ?? "manual";
const logPath = process.env.DOCTOR_FIXTURE_LOG;
function record(value: unknown): void {
  if (logPath) appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), runId, ...value as object }) + "\n");
}

server.tool(
  "lookup_release",
  "Look up a fictitious release by ID. Returns only test data.",
  { releaseId: z.string() },
  async ({ releaseId }) => {
    record({ type: "tool_called", name: "lookup_release", arguments: { releaseId } });
    if (releaseId === "ERROR") return { isError: true, content: [{ type: "text", text: "Fixture error" }] };
    return { content: [{ type: "text", text: JSON.stringify({ runId, releaseId, status: "ready", fictional: true }) }] };
  },
);

server.tool(
  "delete_release",
  "Simulate deletion of a fictitious release. Never deletes external data.",
  { releaseId: z.string() },
  async ({ releaseId }) => {
    record({ type: "tool_called", name: "delete_release", arguments: { releaseId } });
    return { content: [{ type: "text", text: JSON.stringify({ runId, releaseId, simulated: true }) }] };
  },
);

await server.connect(new StdioServerTransport());
