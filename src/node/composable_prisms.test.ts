import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examplePath = "examples/composable_prisms.blot";
const libraryPath = "examples/lib/prism.blot";
const mismatchPath = "src/node/fixtures/prism_composition_mismatch.blot";

const principalType =
  "{ .default = { .matched_age = #None | #Some Int; .matched_name = #None | #Some Text; .wrong_user_case = #None | #Some Int; .system_miss = #None | #Some Int; .incremented = #User #Registered Text | #AgeChanged Int | #Deleted | #System Text; .unchanged = #User #Registered Text | #AgeChanged Int | #Deleted | #System Text; .reviewed = #User #Registered Text | #AgeChanged Int | #Deleted | #System Text } }";

test("composable prisms preserve types and both executions", async () => {
  const compiler = await Compiler.create();
  try {
    assert.deepEqual(await compiler.check(examplePath), {
      type: principalType,
      effects: "",
    });

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

    for (const path of [libraryPath, examplePath, mismatchPath]) {
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
      () => compiler.check(mismatchPath),
      /BLOT_TYPE_ERROR: Text does not flow into Int/,
    );
  } finally {
    compiler.destroy();
  }
});
