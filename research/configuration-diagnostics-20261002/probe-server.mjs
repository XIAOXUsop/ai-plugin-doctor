// A synthetic, read-only MCP server used solely for CLI configuration research.
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
if (process.env.DOCTOR_RESEARCH_CAPTURE_PATH) writeFileSync(process.env.DOCTOR_RESEARCH_CAPTURE_PATH, JSON.stringify({ simpleResolved: process.env.FROM_SIMPLE === 'SYNTHETIC_CANARY_ONLY', cursorResolved: process.env.FROM_CURSOR === 'SYNTHETIC_CANARY_ONLY', cursorLiteral: process.env.FROM_CURSOR === '${env:DOCTOR_RESEARCH_TEST_TOKEN}' }, null, 2));
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (!('id' in request)) return;
  let result;
  switch (request.method) {
    case 'initialize': result = { protocolVersion: request.params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'doctor-configuration-research', version: '1.0.0' } }; break;
    case 'tools/list': result = { tools: [] }; break;
    case 'resources/list': result = { resources: [] }; break;
    case 'prompts/list': result = { prompts: [] }; break;
    case 'ping': result = {}; break;
    default: process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Synthetic research server has no such method.' } }) + '\n'); return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
input.on('close', () => process.exit(0));
