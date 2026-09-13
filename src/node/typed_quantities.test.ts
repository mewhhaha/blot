import assert from "node:assert/strict";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { runArtifact } from "./run.ts";

const expected =
  '{ .distance = 1550; .distance_unit = "m"; .centimeters = 155000; .centimeters_unit = "cm"; .elapsed = 90; .elapsed_unit = "s"; }';

test("typed quantities execute through the emitted Wasm compiler", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile("examples/typed_quantities.blot");
    assert.equal(await runArtifact(artifact), expected);
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
