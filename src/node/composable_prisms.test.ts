import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examplePath = "examples/composable_prisms.blot";
const libraryPath = "examples/lib/prism.blot";

test("composable prisms preserve types and both executions", async () => {
  const compiler = await Compiler.create();
  try {
    const checked = await compiler.check(examplePath);
    assert.equal(checked.effects, "");
    assert.match(checked.type, /matched_age = #None \| #Some Int/);
    assert.match(checked.type, /matched_name = #None \| #Some Text/);
    assert.match(checked.type, /incremented = #System Text \| #User/);

    const evaluated = await compiler.evaluate(examplePath);
    assert.deepEqual(evaluated.writes, []);
    const evaluatorExpected = await readFile(
      "examples/expected/composable_prisms.txt",
      "utf8",
    );
    assert.equal(evaluated.display, evaluatorExpected.trim());

    const wasmExpected = await readFile(
      "examples/expected/composable_prisms.wasm.txt",
      "utf8",
    );
    assert.equal(
      await runArtifact(await compiler.compile(examplePath)),
      wasmExpected.trim(),
    );

    for (const path of [libraryPath, examplePath]) {
      const source = await readFile(path, "utf8");
      const formatted = await formatSource(source);
      assert.equal(formatted.ok, true);
      if (!formatted.ok) throw new Error(`${path} failed to format`);
      assert.equal(formatted.source, source);
    }
  } finally {
    compiler.destroy();
  }
});

test("prism composition rejects non-adjacent focuses", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check("src/node/fixtures/prism_composition_mismatch.blot"),
      /BLOT_TYPE_ERROR/,
    );
  } finally {
    compiler.destroy();
  }
});
