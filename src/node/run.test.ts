import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { runArtifact } from "./run.ts";

test("run copies and releases an indirect structured result", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(resolve("examples/conditions.blot"));
    const expected =
      '{ .0 = "one"; .1 = "three"; .2 = "second"; .3 = "small"; .4 = "large" }';
    assert.equal(await runArtifact(artifact), expected);
    assert.equal(await runArtifact(artifact), expected);
  } finally {
    compiler.destroy();
  }
});

test("run renders arrays and variants from canonical memory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-node-run-"));
  const path = join(directory, "structured.blot");
  const compiler = await Compiler.create();
  try {
    await writeFile(path, "return ([1, 2, 3], #Some 7)\n");
    const artifact = await compiler.compile(path);
    assert.equal(
      await runArtifact(artifact),
      "{ .0 = [1, 2, 3]; .1 = #Some 7 }",
    );
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});
