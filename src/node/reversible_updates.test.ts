import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const path = "examples/reversible_updates.blot";
const expectedType =
  "{ .default = { .changed = { .name = Text; .quota = 1..100 }; .restored = { .name = Text; .quota = 1..100 }; .committed = #Committed { .name = Text; .quota = 1..100 } | #RolledBack { .state = { .name = Text; .quota = 1..100 }; .error = #QuotaTooHigh 1..100 }; .rolled_back = #Committed { .name = Text; .quota = 1..100 } | #RolledBack { .state = { .name = Text; .quota = 1..100 }; .error = #QuotaTooHigh 1..100 } } }";

const blotSources = [
  "examples/lib/reversible_update.blot",
  path,
  "src/node/fixtures/reversible_wrong_undo.blot",
  "src/node/fixtures/reversible_invalid_input.blot",
  "src/node/fixtures/reversible_state_mismatch.blot",
  "src/node/fixtures/reversible_association_mismatch.blot",
];

test("reversible updates preserve typed undo evidence in both executions", async () => {
  for (const sourcePath of blotSources) {
    const source = await readFile(sourcePath, "utf8");
    const formatted = await formatSource(source);
    assert.equal(formatted.ok, true);
    if (!formatted.ok) throw new Error(`${sourcePath} failed to format`);
    assert.equal(formatted.source, source, `${sourcePath} is not canonical`);
  }

  const compiler = await Compiler.create();
  try {
    const checkedInterface1 = await compiler.check(path);
    assert.deepEqual({
      type: checkedInterface1.type,
      effects: checkedInterface1.effects,
    }, {
      type: expectedType,
      effects: "",
    });

    const evaluated = await compiler.evaluate(path);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile("examples/expected/reversible_updates.txt", "utf8"))
        .trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(path)),
      (
        await readFile("examples/expected/reversible_updates.wasm.txt", "utf8")
      ).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("reversible updates reject mismatched evidence, states, and refined inputs", async () => {
  const compiler = await Compiler.create();
  try {
    for (
      const fixture of [
        "src/node/fixtures/reversible_wrong_undo.blot",
        "src/node/fixtures/reversible_invalid_input.blot",
        "src/node/fixtures/reversible_state_mismatch.blot",
        "src/node/fixtures/reversible_association_mismatch.blot",
      ]
    ) {
      await assert.rejects(() => compiler.check(fixture), /BLOT_TYPE_ERROR/);
    }
  } finally {
    compiler.destroy();
  }
});
