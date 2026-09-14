import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examplePath = "examples/typed_traversals.blot";
const libraryPath = "examples/lib/traversal.blot";
const compositionMismatchPath =
  "src/node/fixtures/traversal_composition_mismatch.blot";
const changeMismatchPath = "src/node/fixtures/traversal_change_mismatch.blot";

const principalType =
  '{ .default = { .before = [Text]; .after = [Text]; .empty_labels = [Text]; .first_url = "/ready"; .waves = Int } }';

test("typed traversals preserve types and both executions", async () => {
  const compiler = await Compiler.create();
  try {
    assert.deepEqual(await compiler.check(examplePath), {
      type: principalType,
      effects: "",
    });

    const evaluated = await compiler.evaluate(examplePath);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile("examples/expected/typed_traversals.txt", "utf8")).trim(),
    );

    assert.equal(
      await runArtifact(await compiler.compile(examplePath)),
      (await readFile("examples/expected/typed_traversals.wasm.txt", "utf8")).trim(),
    );

    for (const path of [
      libraryPath,
      examplePath,
      compositionMismatchPath,
      changeMismatchPath,
    ]) {
      const source = await readFile(path, "utf8");
      const formatted = await formatSource(source);
      assert.equal(formatted.ok, true);
      if (!formatted.ok) throw new Error(`${path} failed to format`);
      assert.equal(formatted.source, source);
    }
  } finally {
    compiler.destroy();
  }
});

test("typed traversal boundaries reject invalid composition and updates", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check(compositionMismatchPath),
      /BLOT_TYPE_ERROR: \[\{ \.label = Text \}\] does not flow into \{ \.label = Text \}/,
    );
    await assert.rejects(
      () => compiler.check(changeMismatchPath),
      /BLOT_TYPE_ERROR: 1 does not flow into Text/,
    );
  } finally {
    compiler.destroy();
  }
});
