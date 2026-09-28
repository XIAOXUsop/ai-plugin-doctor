import assert from "node:assert/strict";
import test from "node:test";
import { redact } from "./redact.js";

test("redaction keeps usage counts while hiding credentials and URL keys", () => {
  assert.deepEqual(redact({ usage: { input_tokens: 123, output_tokens: 45 }, accessToken: "secret", url: "https://example.test/mcp?k=secret" }), {
    usage: { input_tokens: 123, output_tokens: 45 }, accessToken: "[REDACTED]", url: "https://example.test/mcp?k=[REDACTED]",
  });
});
