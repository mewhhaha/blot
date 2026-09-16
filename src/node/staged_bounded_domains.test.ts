import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { BlotError } from "../diagnostic.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examplePath = "examples/staged_bounded_domains.blot";
const libraryPath = "examples/lib/bounded_int_domain.blot";
const wrongNarrowingPath =
  "src/node/fixtures/bounded_domain_wrong_narrowing.blot";
const outOfRangePath = "src/node/fixtures/bounded_domain_out_of_range.blot";
const wrongInputPath = "src/node/fixtures/bounded_domain_wrong_input.blot";

const stableBoundsPath =
  "src/node/fixtures/bounded_domain_comptime_bounds.blot";
const runtimeBoundPath = "src/node/fixtures/bounded_domain_runtime_bound.blot";
const comparatorPath =
  "src/node/fixtures/bounded_domain_unrecognized_comparator.blot";

const blotPaths = [
  libraryPath,
  examplePath,
  wrongNarrowingPath,
  outOfRangePath,
  wrongInputPath,
  stableBoundsPath,
  runtimeBoundPath,
  comparatorPath,
] as const;

function isTypeError(error: unknown): boolean {
  assert(error instanceof BlotError);
  assert.equal(error.diagnostic.code, "BLOT_TYPE_ERROR");
  return true;
}

test("staged bounded domains derive one checked runtime boundary", async () => {
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
      {
        type:
          "{ .default = { .admitted_lower = #None | #Some 5..25; .admitted_middle = #None | #Some 5..25; .rejected_lower = #None | #Some 5..25; .rejected_upper = #None | #Some 5..25; .clamped_lower = 5..25; .clamped_upper = 25; .widened = Text; .priority = 5; .temperature = -40; .percent_boundary = #True | #False; .percent_over = #True | #False } }",
        effects: "",
      },
    );

    const evaluated = await compiler.evaluate(examplePath);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile(
        "examples/expected/staged_bounded_domains.txt",
        "utf8",
      )).trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(examplePath)),
      (await readFile(
        "examples/expected/staged_bounded_domains.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("staged bounded domains reject invalid carriers and narrowing", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check(wrongNarrowingPath),
      isTypeError,
    );
    await assert.rejects(
      () => compiler.check(outOfRangePath),
      isTypeError,
    );
    await assert.rejects(
      () => compiler.check(wrongInputPath),
      isTypeError,
    );
  } finally {
    compiler.destroy();
  }
});

test("stable compile-time bounds narrow both operand orders without trusting runtime values", async () => {
  const compiler = await Compiler.create();
  try {
    const checked = await compiler.check(stableBoundsPath);
    assert.deepEqual(
      { type: checked.type, effects: checked.effects },
      {
        type:
          "{ .default = { .lower = #None | #Some 5..25; .upper = #None | #Some 5..25; .below = #None | #Some 5..25; .above = #None | #Some 5..25; .mirrored = #None | #Some 5..25; .mirrored_below = #None | #Some 5..25; .mirrored_above = #None | #Some 5..25 } }",
        effects: "",
      },
    );
    assert.equal(
      (await compiler.evaluate(stableBoundsPath)).display,
      "{ .default = { .lower = #Some 5; .upper = #Some 25; .below = #None; .above = #None; .mirrored = #Some 17; .mirrored_below = #None; .mirrored_above = #None; }; }",
    );
    assert.equal(
      await runArtifact(await compiler.compile(stableBoundsPath)),
      "{ .above = #None; .below = #None; .lower = #Some 5; .mirrored = #Some 17; .mirrored_above = #None; .mirrored_below = #None; .upper = #Some 25 }",
    );
    for (const path of [runtimeBoundPath, comparatorPath]) {
      await assert.rejects(() => compiler.check(path), isTypeError);
      await assert.rejects(() => compiler.compile(path), isTypeError);
    }
  } finally {
    compiler.destroy();
  }
});
