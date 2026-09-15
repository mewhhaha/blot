import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const path = "examples/typed_journals.blot";
const expectedType =
  "{ .api = { .entries = [#Placed { .service = Text; .zone = Text } | #Capacity { .service = Text; .replicas = 1..16 }]; .value = Text }; .combined = { .entries = [#Placed { .service = Text; .zone = Text } | #Capacity { .service = Text; .replicas = 1..16 }]; .value = { .api = Text; .worker = Text } }; .rendered = { .entries = [Text]; .value = { .name = Text; .zone = Text; .port = 1..65535; .replicas = 1..16 } }; .empty = { .entries = [#Placed { .service = Text; .zone = Text } | #Capacity { .service = Text; .replicas = 1..16 }]; .value = Text } }";
const blotSources = [
  "examples/lib/journal.blot",
  path,
  "src/node/fixtures/journal_value_mismatch.blot",
  "src/node/fixtures/journal_mapper_mismatch.blot",
  "src/node/fixtures/journal_invalid_refinement.blot",
  "src/node/fixtures/journal_entry_join.blot",
] as const;

test("typed journals compose event vocabularies and match both executions", async () => {
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
      (await readFile("examples/expected/typed_journals.txt", "utf8")).trim(),
    );

    assert.equal(
      await runArtifact(await compiler.compile(path)),
      (await readFile("examples/expected/typed_journals.wasm.txt", "utf8"))
        .trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("typed journals reject value, mapper, and refinement mismatches", async () => {
  const compiler = await Compiler.create();
  try {
    for (
      const fixture of [
        "src/node/fixtures/journal_value_mismatch.blot",
        "src/node/fixtures/journal_mapper_mismatch.blot",
        "src/node/fixtures/journal_invalid_refinement.blot",
      ]
    ) {
      await assert.rejects(() => compiler.check(fixture), /BLOT_TYPE_ERROR/);
    }
  } finally {
    compiler.destroy();
  }
});

test("covariant journal entry variables join to a structural union", async () => {
  const compiler = await Compiler.create();
  try {
    const checked = await compiler.check(
      "src/node/fixtures/journal_entry_join.blot",
    );
    assert.deepEqual({ type: checked.type, effects: checked.effects }, {
      type: "{ .entries = [#First Int | #Second Text]; .value = Int }",
      effects: "",
    });
  } finally {
    compiler.destroy();
  }
});
