import assert from "node:assert/strict";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { runArtifact } from "./run.ts";

const expected =
  '{ .after = "London / west"; .before = "London"; .name = "Ada"; .postal = 90210; .revision = 7 }';

test("typed lenses compose and execute through emitted Wasm", async () => {
  const compiler = await Compiler.create();
  try {
    assert.deepEqual(await compiler.check("examples/typed_lenses.blot"), {
      type:
        "{ .default = { .before = Text; .after = Text; .postal = Int; .name = Text; .revision = Int } }",
      effects: "",
    });
    const artifact = await compiler.compile("examples/typed_lenses.blot");
    assert.equal(await runArtifact(artifact), expected);
  } finally {
    compiler.destroy();
  }
});

test("typed lenses reject non-adjacent composition", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check("src/node/fixtures/lens_composition_mismatch.blot"),
      /BLOT_TYPE_ERROR/,
    );
  } finally {
    compiler.destroy();
  }
});
