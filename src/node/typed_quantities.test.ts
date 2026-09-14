import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { runArtifact } from "./run.ts";

test("typed quantities preserve units through both executions", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "examples/typed_quantities.blot";
    const evaluated = await compiler.evaluate(path);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile("examples/expected/typed_quantities.txt", "utf8")).trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(path)),
      (await readFile("examples/expected/typed_quantities.wasm.txt", "utf8"))
        .trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("typed quantities reject cross-dimension arithmetic", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.compile("src/node/fixtures/quantity_unit_mismatch.blot"),
      /BLOT_TYPE_ERROR/,
    );
  } finally {
    compiler.destroy();
  }
});
