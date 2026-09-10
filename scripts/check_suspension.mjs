import { spawnSync } from "node:child_process";

// Exercise emitted frames, borrowed-state rejection, cleanup, and split units.
const result = spawnSync(process.execPath, [
  "--import",
  "tsx",
  "--test",
  "--test-isolation=none",
  "--test-timeout=30000",
  "src/node/suspension.test.ts",
  "src/node/borrow_liveness.test.ts",
  "src/node/suspension_memory.test.ts",
  "src/node/callbacks.test.ts",
  "src/node/resources.test.ts",
  "src/node/development_async.test.ts",
  "src/node/development_links.test.ts",
], {
  cwd: new URL("..", import.meta.url),
  stdio: "inherit",
  timeout: 120_000,
  killSignal: "SIGKILL",
});
if (result.error !== undefined) throw result.error;
if (result.signal !== null) {
  throw new Error(`suspension checks terminated by ${result.signal}`);
}
if (result.status === null) {
  throw new Error("suspension checks returned no status");
}
process.exitCode = result.status;
