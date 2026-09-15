import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const example = "examples/opaque_reducer_summaries.blot";
const library = "examples/lib/opaque_reducer.blot";
const inputMismatch = "src/node/fixtures/opaque_reducer_input_mismatch.blot";
const projectionMismatch =
  "src/node/fixtures/opaque_reducer_projection_mismatch.blot";
const stateEscape = "src/node/fixtures/opaque_reducer_state_escape.blot";
const forwardedOwner = "src/node/fixtures/opaque_reducer_forwarded_owner.blot";
const specializationPressure =
  "src/node/fixtures/opaque_reducer_specialization_pressure.blot";

const sourceFiles = [
  library,
  example,
  inputMismatch,
  projectionMismatch,
  stateEscape,
  forwardedOwner,
  specializationPressure,
];

test("opaque reducers hide accumulator state and preserve both executions", async () => {
  const compiler = await Compiler.create();
  try {
    for (const path of sourceFiles) {
      const source = await readFile(path, "utf8");
      const formatted = await formatSource(source);
      assert.equal(formatted.ok, true);
      if (!formatted.ok) throw new Error(`${path} failed to format`);
      assert.equal(formatted.source, source);
    }

    const checked = await compiler.check(example);
    assert.deepEqual({ type: checked.type, effects: checked.effects }, {
      type:
        "{ .default = { .full = { .total_ms = Int; .sample_count = Int; .average_ms = #None | #Some Int; .server_errors = Int; .has_server_error = #True | #False }; .empty = { .total_ms = Int; .sample_count = Int; .average_ms = #None | #Some Int; .server_errors = Int; .has_server_error = #True | #False }; .boundary = { .total_ms = Int; .sample_count = Int; .average_ms = #None | #Some Int; .server_errors = Int; .has_server_error = #True | #False } } }",
      effects: "",
    });

    const evaluated = await compiler.evaluate(example);
    const expected = await readFile(
      "examples/expected/opaque_reducer_summaries.txt",
      "utf8",
    );
    const expectedWasm = await readFile(
      "examples/expected/opaque_reducer_summaries.wasm.txt",
      "utf8",
    );
    assert.deepEqual(evaluated.writes, []);
    assert.equal(evaluated.display, expected.trim());
    assert.equal(
      await runArtifact(await compiler.compile(example)),
      expectedWasm.trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("opaque reducers reject incompatible carriers and private-state assumptions", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check(inputMismatch),
      /BLOT_TYPE_ERROR: Int does not flow into Text/,
    );
    await assert.rejects(
      () => compiler.check(projectionMismatch),
      /BLOT_TYPE_ERROR: Text does not flow into Int/,
    );
    await assert.rejects(
      () => compiler.check(stateEscape),
      /BLOT_TYPE_ERROR: .* does not flow into Int/,
    );
  } finally {
    compiler.destroy();
  }
});

test("opaque reducer pressure cases remain explicit", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check(forwardedOwner),
      /BLOT_LINEAR_ARGUMENT_NOT_OWNED: The called function does not promise to consume this owned argument/,
    );
    await compiler.check(specializationPressure);
  } finally {
    compiler.destroy();
  }

  const lint = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/node/cli.ts",
      "lint",
      "--check",
      specializationPressure,
      library,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(lint.status, 1);
  assert.match(
    `${lint.stdout}${lint.stderr}`,
    /BLOT_LINT_SPECIALIZATION_COUNT: `make` has 3 compiler-confirmed runtime representations/,
  );
});
