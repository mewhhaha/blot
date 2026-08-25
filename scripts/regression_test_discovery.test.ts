import { assertEquals } from "@std/assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRegressionTests } from "./regression_test_discovery.mjs";

Deno.test("regression discovery stays inside the repository under test", async () => {
  const root = await mkdtemp(join(tmpdir(), "blot-regression-discovery-"));
  try {
    await Promise.all([
      mkdir(join(root, "src", "node"), { recursive: true }),
      mkdir(join(root, "src", "syntax"), { recursive: true }),
      mkdir(join(root, "scripts"), { recursive: true }),
      mkdir(join(root, ".agent", "worktree"), { recursive: true }),
      mkdir(join(root, "dist", "generated"), { recursive: true }),
      mkdir(join(root, "auxiliary", "src"), { recursive: true }),
      mkdir(join(root, "node_modules", "dependency"), { recursive: true }),
      mkdir(join(root, "compiler", "target", "debug"), { recursive: true }),
      mkdir(join(root, "experiments", "generated-code"), { recursive: true }),
      mkdir(join(root, "experiments", "owned-regions"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, "examples.test.ts"), ""),
      writeFile(join(root, "src", "syntax", "layout.test.ts"), ""),
      writeFile(join(root, "src", "node", "pipeline.test.ts"), ""),
      writeFile(join(root, "scripts", "package_contents.test.ts"), ""),
      writeFile(join(root, ".agent", "worktree", "nested.test.ts"), ""),
      writeFile(join(root, "dist", "generated", "nested.test.ts"), ""),
      writeFile(join(root, "auxiliary", ".git"), "gitdir: elsewhere\n"),
      writeFile(join(root, "auxiliary", "src", "nested.test.ts"), ""),
      writeFile(
        join(root, "compiler", "target", "debug", "nested.test.ts"),
        "",
      ),
      writeFile(
        join(root, "node_modules", "dependency", "nested.test.ts"),
        "",
      ),
      writeFile(
        join(root, "experiments", "generated-code", "benchmark.test.ts"),
        "",
      ),
      writeFile(
        join(root, "experiments", "owned-regions", "wasm_region.test.ts"),
        "",
      ),
    ]);

    assertEquals(await discoverRegressionTests(root), [
      "examples.test.ts",
      "src/syntax/layout.test.ts",
    ]);
  } finally {
    await rm(root, { recursive: true });
  }
});
