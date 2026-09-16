import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { BlotError } from "../diagnostic.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examplePath = "examples/typed_record_edits.blot";
const libraryPath = "examples/lib/record_edit.blot";
const refinementMismatchPath =
  "src/node/fixtures/record_edit_refinement_mismatch.blot";
const crossSchemaPath = "src/node/fixtures/record_edit_cross_schema.blot";
const unknownFieldPath = "src/node/fixtures/record_edit_unknown_field.blot";
const guardedIncrementPath =
  "examples/pending/record_edit_guarded_increment.blot";

const principalType =
  "{ .default = { .updated = { .host = Text; .port = 1..65535; .limits = { .burst = 1..100; .window_seconds = 1..3600 }; .note = #None | #Some Text }; .unchanged = { .host = Text; .port = 1..65535; .limits = { .burst = 1..100; .window_seconds = 1..3600 }; .note = #None | #Some Text }; .overridden_port = 9443; .max_port = 65535; .profile = { .name = Text; .active = #True | #False } } }";

const interfaceType = principalType.replace("#True | #False", "#False | #True");

const blotPaths = [
  libraryPath,
  examplePath,
  refinementMismatchPath,
  crossSchemaPath,
  unknownFieldPath,
  guardedIncrementPath,
] as const;

test("typed record edits preserve schema-indexed field relationships", async () => {
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
      interfaceKey: JSON.stringify([interfaceType, ""]),
    });

    const evaluated = await compiler.evaluate(examplePath);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile("examples/expected/typed_record_edits.txt", "utf8"))
        .trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(examplePath)),
      (await readFile(
        "examples/expected/typed_record_edits.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("typed record edits reject invalid carriers and retain the pending range limitation", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check(refinementMismatchPath),
      /BLOT_TYPE_ERROR: 70000 does not flow into 1\.\.65535/,
    );
    await assert.rejects(
      () => compiler.check(crossSchemaPath),
      /BLOT_TYPE_ERROR: .* does not flow into .*\.name = Text/,
    );
    await assert.rejects(
      () => compiler.check(unknownFieldPath),
      (error: unknown) => {
        assert(error instanceof BlotError);
        assert.equal(error.diagnostic.code, "BLOT_NO_FIELD");
        const origin = error.origin;
        assert(origin !== null);
        assert(origin.path.endsWith(unknownFieldPath));
        const { start, end } = error.diagnostic.span;
        assert.match(origin.source.slice(start, end), /Edit\.field.*"missing"/);
        return true;
      },
    );
    await assert.rejects(
      () => compiler.check(guardedIncrementPath),
      /BLOT_TYPE_ERROR: Int does not flow into 1\.\.100/,
    );
  } finally {
    compiler.destroy();
  }
});
