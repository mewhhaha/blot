import { lstat, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const excludedRegressionTests = new Set([
  // Distribution checks pack and install the project under a dedicated Node baseline.
  "scripts/package_contents.test.ts",
  // Standalone experiments remain outside the ordinary regression suite.
  "experiments/generated-code/benchmark.test.ts",
  "experiments/owned-regions/wasm_region.test.ts",
]);

export async function discoverRegressionTests(root) {
  const tests = [];
  await discover(root, root, tests);
  tests.sort();
  return tests;
}

async function discover(root, directory, tests) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name.startsWith(".") ||
        entry.name === "dist" ||
        entry.name === "node_modules" ||
        entry.name === "target"
      ) {
        continue;
      }
      if (await isAuxiliaryRepository(path)) continue;
      await discover(root, path, tests);
      continue;
    }
    if (!entry.name.endsWith(".test.ts")) continue;
    const normalized = relative(root, path).split(sep).join("/");
    if (normalized.startsWith("src/node/")) continue;
    if (excludedRegressionTests.has(normalized)) continue;
    tests.push(normalized);
  }
}

async function isAuxiliaryRepository(directory) {
  try {
    await lstat(join(directory, ".git"));
    return true;
  } catch (error) {
    if (error instanceof Error && error.code === "ENOENT") return false;
    throw error;
  }
}
