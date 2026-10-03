import { fileURLToPath } from "node:url";

/** Development and compiled entry points share the helpers produced by build. */
export function nativeHelperPath(name: "job-runner.exe" | "safe-file.exe", moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL(`${moduleUrl.endsWith(".ts") ? "../../dist/native/" : "../../native/"}${name}`, moduleUrl));
}
