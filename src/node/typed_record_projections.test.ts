import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examplePath = "examples/typed_record_projections.blot";
const libraryPath = "examples/lib/record_projection.blot";
const refinementMismatchPath =
  "src/node/fixtures/record_projection_refinement_mismatch.blot";
const missingFieldPath =
  "src/node/fixtures/record_projection_missing_field.blot";
const unknownNamePath = "src/node/fixtures/record_projection_unknown_name.blot";

const principalType =
  '{ .default = { .before = { .host = Text; .port = 1..65535 }; .after = { .host = Text; .port = 1..65535 }; .capacity = { .replicas = 1..32 }; .owner = "Ada"; .identity = { .name = Text; .locale = Text }; .empty = {  }; .unchanged_owner = "Ada" } }';

const blotPaths = [
  libraryPath,
  examplePath,
  refinementMismatchPath,
  missingFieldPath,
  unknownNamePath,
] as const;

test("typed record projections preserve selected types in both executions", async () => {
  const compiler = await Compiler.create();
  try {
    for (const path of blotPaths) {
      const source = await readFile(path, "utf8");
      const formatted = await formatSource(source);
      assert.equal(formatted.ok, true);
      if (!formatted.ok) throw new Error(`${path} failed to format`);
      assert.equal(formatted.source, source);
    }

    assert.deepEqual(await compiler.check(examplePath), {
      type: principalType,
      effects: "",
      interfaceKey: JSON.stringify([principalType, ""]),
    });

    const evaluated = await compiler.evaluate(examplePath);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile(
        "examples/expected/typed_record_projections.txt",
        "utf8",
      )).trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(examplePath)),
      (await readFile(
        "examples/expected/typed_record_projections.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("typed record projections reject invalid selected shapes", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check(refinementMismatchPath),
      /BLOT_TYPE_ERROR: 70000 does not flow into 1\.\.65535/,
    );
    await assert.rejects(
      () => compiler.check(missingFieldPath),
      /BLOT_TYPE_ERROR: .* does not flow into \{ \.port = Int \}/,
    );
    await assert.rejects(
      () => compiler.check(unknownNamePath),
      /BLOT_NO_FIELD: No field `missing`/,
    );
  } finally {
    compiler.destroy();
  }
});
