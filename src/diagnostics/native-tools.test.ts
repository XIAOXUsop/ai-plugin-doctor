import { test } from "node:test";
import { strict as assert } from "node:assert";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { nativeHelperPath } from "./native-tools.js";

test("source and compiled diagnostic entry points resolve the same protected helper", () => {
  for (const name of ["job-runner.exe", "safe-file.exe"] as const) {
    const source = pathToFileURL(resolve("src/diagnostics/native-tools.ts")).href;
    const compiled = pathToFileURL(resolve("dist/src/diagnostics/native-tools.js")).href;
    assert.equal(nativeHelperPath(name, source), resolve("dist/native", name));
    assert.equal(nativeHelperPath(name, compiled), nativeHelperPath(name, source));
  }
});
