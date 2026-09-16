import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examplePath = "examples/zoomable_state_actions.blot";
const libraryPath = "examples/lib/state_action.blot";
const wrongFocusPath = "src/node/fixtures/state_action_wrong_focus.blot";
const invalidRefinementPath =
  "src/node/fixtures/state_action_invalid_refinement.blot";
const sequenceMismatchPath =
  "src/node/fixtures/state_action_sequence_mismatch.blot";
const chainedProjectionPath =
  "src/node/fixtures/state_action_chained_tuple_projection.blot";

const principalType =
  "{ .default = { .state = { .profile = { .name = Text; .quota = 1..100 }; .metrics = { .requests = Int } }; .previous_name = Text; .previous_quota = 1..100; .new_request_count = Int; .untouched = { .state = { .profile = { .name = Text; .quota = 1..100 }; .metrics = { .requests = Int } }; .value = Text }; .mapped = { .state = { .profile = { .name = Text; .quota = 1..100 }; .metrics = { .requests = Int } }; .value = Text } } }";

const formattedPaths = [
  libraryPath,
  examplePath,
  wrongFocusPath,
  invalidRefinementPath,
  sequenceMismatchPath,
] as const;

test("zoomable state actions preserve local state carriers in both executions", async () => {
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
      (await readFile("examples/expected/zoomable_state_actions.txt", "utf8"))
        .trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(examplePath)),
      (await readFile(
        "examples/expected/zoomable_state_actions.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("zoomable state actions reject mismatched focus, state, and refinement carriers", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check(wrongFocusPath),
      /BLOT_TYPE_ERROR: \{ \.requests = Int \} does not flow into \{ \.name = Text \}/,
    );
    await assert.rejects(
      () => compiler.check(sequenceMismatchPath),
      /BLOT_TYPE_ERROR: \{ \.count = Int \} does not flow into \{ \.name = Text \}/,
    );
    await assert.rejects(
      () => compiler.check(invalidRefinementPath),
      /BLOT_TYPE_ERROR: 0 does not flow into 1\.\.100/,
    );
    await assert.rejects(
      () => compiler.check(chainedProjectionPath),
      /GPU_FRONTEND_SYNTAX_ERROR/,
    );
  } finally {
    compiler.destroy();
  }
});
