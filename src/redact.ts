import { homedir } from "node:os";

const secretKey = /authorization|token|secret|password|api[_-]?key|credential/i;
const usageCounterKey = /^(?:input_tokens|output_tokens|cached_input_tokens|cache_creation_input_tokens|cache_read_input_tokens|cache_write_input_tokens|reasoning_output_tokens|ephemeral_1h_input_tokens|ephemeral_5m_input_tokens)$/i;
const home = homedir();
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, secretKey.test(key) && !usageCounterKey.test(key) ? "[REDACTED]" : redact(val)]));
  }
  if (typeof value === "string") {
    let safe = home ? value.replaceAll(home, "~") : value;
    safe = safe.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
    safe = safe.replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|k)=)[^&#\s"']+/gi, "$1[REDACTED]");
    return safe;
  }
  return value;
}
export function redactLine(line: string): string {
  try { return JSON.stringify(redact(JSON.parse(line))); } catch { return String(redact(line)); }
}
