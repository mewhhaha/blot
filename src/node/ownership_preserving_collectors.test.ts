import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const path = "examples/ownership_preserving_collectors.blot";
const libraryPath = "examples/lib/owned_collector.blot";
const droppedBufferPath =
  "src/node/fixtures/owned_collector_drops_buffer.blot";
const inputMismatchPath =
  "src/node/fixtures/owned_collector_input_mismatch.blot";
const refinementMismatchPath =
  "src/node/fixtures/owned_collector_refinement_mismatch.blot";
const stopPayloadPath =
  "src/node/fixtures/owned_collector_stop_payload_pathology.blot";

const expectedType =
  "{ .default = { .lifted = #Exhausted [0..100] | #Stopped [0..100]; .complete = #Exhausted [0..100] | #Stopped [0..100]; .immediate = #Exhausted [0..100] | #Stopped [0..100]; .empty = #Exhausted [0..100] | #Stopped [0..100] } }";

const blotSources = [
  libraryPath,
  path,
  droppedBufferPath,
  inputMismatchPath,
  refinementMismatchPath,
  stopPayloadPath,
] as const;

test("owned collectors preserve typed buffers and both executions", async () => {
  const compiler = await Compiler.create();
  try {
    for (const sourcePath of blotSources) {
      const source = await readFile(sourcePath, "utf8");
      const formatted = await formatSource(source);
      assert.equal(formatted.ok, true, `${sourcePath} failed to format`);
      if (!formatted.ok) throw new Error(`${sourcePath} failed to format`);
      assert.equal(formatted.source, source, `${sourcePath} is not canonical`);
    }

    const checked = await compiler.check(path);
    assert.deepEqual({ type: checked.type, effects: checked.effects }, {
      type: expectedType,
      effects: "",
    });

    const evaluated = await compiler.evaluate(path);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile(
        "examples/expected/ownership_preserving_collectors.txt",
        "utf8",
      )).trim(),
    );

    assert.equal(
      await runArtifact(await compiler.compile(path)),
      (await readFile(
        "examples/expected/ownership_preserving_collectors.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("owned collectors reject carrier drift and preserve the ownership pathology reproduction", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check(droppedBufferPath),
      /BLOT_HIGHER_ORDER_OWNERSHIP_CONTRACT: This callback does not return each consumed authority/,
    );
    await assert.rejects(
      () => compiler.check(inputMismatchPath),
      /BLOT_TYPE_ERROR: Text does not flow into #Sample 0\.\.100 \| #End Text/,
    );
    await assert.rejects(
      () => compiler.check(refinementMismatchPath),
      /BLOT_TYPE_ERROR: 101 does not flow into 0\.\.100/,
    );
    await assert.rejects(
      () => compiler.check(stopPayloadPath),
      /BLOT_HIGHER_ORDER_OWNERSHIP_CONTRACT: This callback does not return each consumed authority/,
    );
  } finally {
    compiler.destroy();
  }
});
