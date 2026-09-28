import assert from "node:assert/strict";
import test from "node:test";
import { isExpectedAuthReply } from "./auth.js";

test("live auth accepts the requested OK reply, not an arbitrary model response", () => {
  assert.equal(isExpectedAuthReply("OK\n"), true);
  assert.equal(isExpectedAuthReply("The request failed"), false);
  assert.equal(isExpectedAuthReply(""), false);
});
