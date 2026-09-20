import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examplePath = "examples/typed_transducers.blot";
const libraryPath = "examples/lib/transducer.blot";
const compositionMismatchPath =
  "src/node/fixtures/transducer_composition_mismatch.blot";
const reducerMismatchPath =
  "src/node/fixtures/transducer_reducer_mismatch.blot";
const refinedInputPath = "src/node/fixtures/transducer_refined_input.blot";
const genericRunPath = "examples/pending/transducer_generic_run.blot";

const principalType =
  "{ .default = { .mixed = { .count = Int; .total_excess = Int }; .all_filtered = { .count = Int; .total_excess = Int }; .empty = { .count = Int; .total_excess = Int }; .identity_count = 2 } }";

const formattedPaths = [
  libraryPath,
  examplePath,
  compositionMismatchPath,
  reducerMismatchPath,
  refinedInputPath,
  genericRunPath,
] as const;

test("typed transducers compose input transformations independently of reducer state", async () => {
  const compiler = await Compiler.create();
  try {
    for (const path of formattedPaths) {
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
      (await readFile("examples/expected/typed_transducers.txt", "utf8"))
        .trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(examplePath)),
      (await readFile(
        "examples/expected/typed_transducers.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("typed transducer boundaries reject incompatible stages, reducers, and refinements", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check(compositionMismatchPath),
      /BLOT_TYPE_ERROR: #Middle Int does not flow into #Other Int/,
    );
    await assert.rejects(
      () => compiler.check(reducerMismatchPath),
      /BLOT_TYPE_ERROR: #Alert Int does not flow into Text/,
    );
    await assert.rejects(
      () => compiler.check(refinedInputPath),
      /BLOT_TYPE_ERROR: 101 does not flow into 0\.\.100/,
    );
    await assert.rejects(
      () => compiler.check(genericRunPath),
      /BLOT_LINEAR_ARGUMENT_NOT_OWNED: The called function does not promise to consume this owned argument/,
    );
  } finally {
    compiler.destroy();
  }
});

test("a concretely specialized transducer preserves an owned array accumulator", async () => {
  const compiler = await Compiler.create();
  const path = "examples/transducer-owned-state-probe.blot";
  try {
    await compiler.checkSource(
      path,
      `open import "blot:prelude"
const R = import "./lib/reducer.blot"
const T = import "./lib/transducer.blot"
const collect: R.Reducer (Int, [Int], [Int])
const collect = {
  .initial = @satisfies [] [Int];
  .step = fn (state, value) => @array.push state value;
  .finish = fn state => state;
}
const twice: T.Transducer (Int, Int)
const twice = T.map (fn value => value * 2)
return R.run (twice collect, [1, 2, 3])
`,
    );
    assert.equal((await compiler.evaluate(path)).display, "[2, 4, 6]");
    assert.equal(await runArtifact(await compiler.compile(path)), "[2, 4, 6]");
  } finally {
    compiler.destroy();
  }
});
