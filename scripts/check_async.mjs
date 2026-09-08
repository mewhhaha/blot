import { spawnSync } from "node:child_process";

// This gate executes the compiler-produced Wasm; unsupported cases fail.
const result = spawnSync(process.execPath, [
  "--import",
  "tsx",
  "--test",
  "--test-timeout=30000",
  "src/node/suspension.test.ts",
], {
  cwd: new URL("..", import.meta.url),
  stdio: "inherit",
  timeout: 60_000,
  killSignal: "SIGKILL",
});
if (result.error !== undefined) throw result.error;
if (result.signal !== null) {
  throw new Error(`async acceptance terminated by ${result.signal}`);
}
if (result.status === null) {
  throw new Error("async acceptance returned no status");
}
process.exitCode = result.status;
