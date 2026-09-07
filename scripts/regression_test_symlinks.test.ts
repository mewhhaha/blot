import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverRegressionTests } from "./regression_test_discovery.mjs";

test("regression discovery ignores symlinked test files outside its root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-discovery-links-"));
  const root = join(directory, "root");
  try {
    await mkdir(root);
    const external = join(directory, "external.test.ts");
    await writeFile(external, "throw new Error('must not execute');\n");
    await symlink(external, join(root, "external.test.ts"), "file");
    await writeFile(join(root, "real.test.ts"), "");
    assert.deepEqual(await discoverRegressionTests(root), ["real.test.ts"]);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("regression discovery ignores broken, cyclic, and directory test links", async () => {
  const root = await mkdtemp(join(tmpdir(), "blot-discovery-nonfiles-"));
  try {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "real.test.ts"), "");
    await symlink("missing.test.ts", join(root, "broken.test.ts"), "file");
    await symlink("cycle.test.ts", join(root, "cycle.test.ts"), "file");
    await symlink(join(root, "nested"), join(root, "folder.test.ts"), "dir");
    assert.deepEqual(await discoverRegressionTests(root), [
      "nested/real.test.ts",
    ]);
  } finally {
    await rm(root, { recursive: true });
  }
});
