import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examplePath = "examples/dimensional_quantities.blot";
const libraryPath = "examples/lib/dimensional_quantity.blot";
const addMismatchPath =
  "src/node/fixtures/dimensional_quantity_add_mismatch.blot";
const resultMismatchPath =
  "src/node/fixtures/dimensional_quantity_result_mismatch.blot";
const inputMismatchPath =
  "src/node/fixtures/dimensional_quantity_input_mismatch.blot";
const phantomPath =
  "src/node/fixtures/dimensional_quantity_phantom_erasure.blot";

const expectedType =
  '{ .default = { .total = Int; .rate = Int; .recovered = Int; .area = Int; .ratio = Int; .zero_divisor = #RejectedZero | #Unexpected; .unicode_label = "m·s⁻¹" } }';

const blotPaths = [
  libraryPath,
  examplePath,
  addMismatchPath,
  resultMismatchPath,
  inputMismatchPath,
  phantomPath,
] as const;

test("dimensional quantities derive product dimensions in both executions", async () => {
  const compiler = await Compiler.create();
  try {
    for (const path of blotPaths) {
      const source = await readFile(path, "utf8");
      const formatted = await formatSource(source);
      assert.equal(formatted.ok, true);
      if (!formatted.ok) throw new Error(`${path} failed to format`);
      assert.equal(formatted.source, source);
    }

    const checked = await compiler.check(examplePath);
    assert.deepEqual(
      { type: checked.type, effects: checked.effects },
      { type: expectedType, effects: "" },
    );

    const evaluated = await compiler.evaluate(examplePath);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile(
        "examples/expected/dimensional_quantities.txt",
        "utf8",
      )).trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(examplePath)),
      (await readFile(
        "examples/expected/dimensional_quantities.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("dimensional quantities reject incompatible dimension relationships", async () => {
  const compiler = await Compiler.create();
  try {
    for (
      const fixture of [
        addMismatchPath,
        resultMismatchPath,
        inputMismatchPath,
      ]
    ) {
      await assert.rejects(() => compiler.check(fixture), /BLOT_TYPE_ERROR/);
    }
  } finally {
    compiler.destroy();
  }
});

test("structural phantom parameters erase when absent from the carrier", async () => {
  const compiler = await Compiler.create();
  try {
    const checked = await compiler.check(phantomPath);
    assert.deepEqual(
      { type: checked.type, effects: checked.effects },
      { type: "{ .default = Int }", effects: "" },
    );
    const evaluated = await compiler.evaluate(phantomPath);
    assert.equal(evaluated.display, "{ .default = 4; }");
  } finally {
    compiler.destroy();
  }
});
