import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const path = "examples/typed_subtyping_witnesses.blot";
const libraryPath = "examples/lib/subtyping_witness.blot";
const expectedType =
  "{ .default = { .endpoint = Text; .route = Text; .degraded = Text; .ready = Text } }";

test("subtyping witnesses compose safe static views in both executions", async () => {
  const compiler = await Compiler.create();
  try {
    for (
      const sourcePath of [
        libraryPath,
        path,
        "src/node/fixtures/subtyping_witness_wrong_direction.blot",
        "src/node/fixtures/subtyping_witness_bad_compose.blot",
        "src/node/fixtures/subtyping_witness_invalid_refinement.blot",
      ]
    ) {
      const source = await readFile(sourcePath, "utf8");
      const formatted = await formatSource(source);
      assert.equal(formatted.ok, true);
      if (!formatted.ok) throw new Error("accepted example failed to format");
      assert.equal(formatted.source, source);
    }

    const checked = await compiler.check(path);
    assert.deepEqual(
      { type: checked.type, effects: checked.effects },
      { type: expectedType, effects: "" },
    );

    const evaluated = await compiler.evaluate(path);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile(
        "examples/expected/typed_subtyping_witnesses.txt",
        "utf8",
      )).trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(path)),
      (await readFile(
        "examples/expected/typed_subtyping_witnesses.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("subtyping witnesses reject unsafe directions, composition, and refinements", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () =>
        compiler.check(
          "src/node/fixtures/subtyping_witness_wrong_direction.blot",
        ),
      /BLOT_TYPE_ERROR/,
    );
    await assert.rejects(
      () =>
        compiler.check("src/node/fixtures/subtyping_witness_bad_compose.blot"),
      /BLOT_TYPE_ERROR/,
    );
    await assert.rejects(
      () =>
        compiler.check(
          "src/node/fixtures/subtyping_witness_invalid_refinement.blot",
        ),
      /BLOT_TYPE_ERROR/,
    );
  } finally {
    compiler.destroy();
  }
});
