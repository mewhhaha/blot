import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const excluded = new Set([
  // Standalone experiments remain outside the ordinary regression suite.
  "experiments/generated-code/benchmark.test.ts",
  "experiments/owned-regions/wasm_region.test.ts",
]);

const tests = [];
await discover(".");
tests.sort();

const result = spawnSync(
  process.execPath,
  [
    "--import",
    "./src/node/polyfills.mjs",
    "--import",
    "./src/node/deno_test_compat.mjs",
    "--import",
    "tsx",
    "--test",
    ...tests,
  ],
  { stdio: "inherit" },
);
if (result.error !== undefined) throw result.error;
if (result.status === null) {
  throw new Error("Node regression tests were terminated");
}
process.exitCode = result.status;

async function discover(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      await discover(path);
      continue;
    }
    if (!entry.name.endsWith(".test.ts")) continue;
    const normalized = relative(".", path);
    if (normalized.startsWith("src/node/")) continue;
    if (excluded.has(normalized)) continue;
    tests.push(normalized);
  }
}
