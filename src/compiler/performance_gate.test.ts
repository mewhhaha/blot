import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Compiler } from "./session.ts";

test("unchanged and source-only revisions perform no semantic work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-no-work-gate-"));
  const path = join(directory, "root.blot");
  const compiler = await Compiler.create();
  try {
    await writeFile(path, "return 42\n");
    await compiler.analyze(path);

    const unchanged = await compiler.analyze(path);
    assert.deepEqual(unchanged.invalidation.checkedModules, []);
    assert.deepEqual(unchanged.invalidation.invalidatedImporters, []);

    const sourceOnly = await compiler.analyzeSource(
      path,
      "return 42\n// source-only edit\n",
    );
    assert.deepEqual(sourceOnly.invalidation.checkedModules, []);
    assert.deepEqual(sourceOnly.invalidation.invalidatedImporters, []);
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});

test("a private leaf edit stops at one check in a 500-module chain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-chain-gate-"));
  const moduleCount = 500;
  const paths = Array.from(
    { length: moduleCount },
    (_, index) => join(directory, `module-${index}.blot`),
  );
  const compiler = await Compiler.create();
  try {
    await Promise.all(paths.map((path, index) => {
      if (index === moduleCount - 1) {
        return writeFile(path, "let private = 1\nreturn 42\n");
      }
      return writeFile(
        path,
        `const child = import "./module-${index + 1}.blot"\nreturn child\n`,
      );
    }));
    await compiler.analyze(paths[0]);

    await writeFile(
      paths[moduleCount - 1],
      "let private = 2\nreturn 42\n",
    );
    const changed = await compiler.analyze(paths[0]);
    assert.deepEqual(changed.invalidation.checkedModules, [
      paths[moduleCount - 1],
    ]);
    assert.deepEqual(changed.invalidation.invalidatedImporters, []);
    assert.deepEqual(changed.invalidation.boundaryUnchanged, [
      paths[moduleCount - 1],
    ]);
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});
