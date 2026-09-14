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
    const checkedInterface1 = await compiler.check(examplePath);
    assert.deepEqual({
      type: checkedInterface1.type,
      effects: checkedInterface1.effects,
    }, {
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
      (await readFile("examples/expected/typed_traversals.wasm.txt", "utf8"))
        .trim(),
    );

    for (
      const path of [
        libraryPath,
        examplePath,
        compositionMismatchPath,
        changeMismatchPath,
      ]
    ) {
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

test("polymorphic each keeps its element relationship without an annotation", async () => {
  const compiler = await Compiler.create();
  const path = "examples/traversal-polymorphic-probe.blot";
  try {
    await compiler.checkSource(
      path,
      `open import "blot:prelude"
const T = import "./lib/traversal.blot"
return T.over (T.each, ["a"], fn value => value <> "!")
`,
    );
    assert.equal((await compiler.evaluate(path)).display, '["a!"]');
    assert.equal(await runArtifact(await compiler.compile(path)), '["a!"]');
    await assert.rejects(
      () =>
        compiler.checkSource(
          path,
          `open import "blot:prelude"
const T = import "./lib/traversal.blot"
const texts :: T.Traversal ([Text], Text)
const texts = T.each
return T.over (texts, ["a"], fn _ => 1)
`,
        ),
      /BLOT_TYPE_ERROR/,
    );
  } finally {
    compiler.destroy();
  }
});

test("a shared nested-array record supports a reconstructing traversal setter", async () => {
  const compiler = await Compiler.create();
  const path = "examples/traversal-record-probe.blot";
  try {
    await compiler.checkSource(
      path,
      `open import "blot:prelude"
const T = import "./lib/traversal.blot"
const Config = { .items = [[Int]]; .revision = Int; }
const items :: T.Traversal (Config, [[Int]])
const items = T.one (
  fn config => config.items,
  fn (config, values) => { ...config; .items = values; }
)
let initial :: Config
let initial = { .items = freeze [[1, 2], [3]]; .revision = 7; }
return T.over (items, initial, fn _ => [[9]])
`,
    );
    assert.equal(
      (await compiler.evaluate(path)).display,
      "{ .items = [[9]]; .revision = 7; }",
    );
    assert.equal(
      await runArtifact(await compiler.compile(path)),
      "{ .items = [[9]]; .revision = 7 }",
    );
  } finally {
    compiler.destroy();
  }
});
