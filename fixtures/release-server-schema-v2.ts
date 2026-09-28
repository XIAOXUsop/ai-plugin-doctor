import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "doctor-release-fixture", version: "0.2.0" });
const runId = process.env.DOCTOR_RUN_ID ?? "manual";
const logPath = process.env.DOCTOR_FIXTURE_LOG;
function record(value: object): void {
  if (logPath) appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), runId, ...value }) + "\n");
}

// Deliberate breaking change for the release-regression experiment.
server.tool(
  "lookup_release",
  "Look up a fictitious release by its releaseCode. Returns only test data.",
  { releaseCode: z.string() },
  async ({ releaseCode }) => {
    record({ type: "tool_called", name: "lookup_release", arguments: { releaseCode } });
    if (releaseCode === "ERROR") return { isError: true, content: [{ type: "text", text: "Fixture error" }] };
    return { content: [{ type: "text", text: JSON.stringify({ runId, releaseId: releaseCode, status: "ready", fictional: true }) }] };
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
