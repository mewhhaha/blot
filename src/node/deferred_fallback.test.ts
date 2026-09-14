import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const example = "examples/deferred_fallback.blot";
const library = "examples/lib/deferred_fallback.blot";
const expectedType =
  '{ .default = { .cached = #Ok { .name = "Ada"; .source_score = 1 }; .stored = #Ok { .name = "Grace"; .source_score = 42 }; .missing = #Error { .primary = #CacheMiss "missing"; .fallback = #StoreMiss "missing" }; .replaced = #Error #StoreMiss "missing"; .cached_remote = #Ok { .name = Text; .source_score = Int } | #Error { .primary = #CacheMiss Text; .fallback = #StoreMiss Text }; .missing_remote = #Ok { .name = Text; .source_score = Int } | #Error { .primary = #CacheMiss Text; .fallback = #StoreMiss Text } } }';

const typeErrorFixtures = [
  "src/node/fixtures/deferred_fallback_error_shape.blot",
  "src/node/fixtures/deferred_fallback_strict_arrow.blot",
] as const;
const runtimeEscapeFixture =
  "src/node/fixtures/deferred_fallback_runtime_escape.blot";

test("deferred fallback preserves typed errors and skips unused work", async () => {
  const compiler = await Compiler.create();
  try {
    for (const path of [library, example]) {
      const source = await readFile(path, "utf8");
      const formatted = await formatSource(source);
      assert.equal(formatted.ok, true);
      if (!formatted.ok) throw new Error(`${path} failed to format`);
      assert.equal(formatted.source, source);
    }

    const checkedInterface1 = await compiler.check(example);
    assert.deepEqual({
      type: checkedInterface1.type,
      effects: checkedInterface1.effects,
    }, {
      type: expectedType,
      effects: "",
    });

    const evaluated = await compiler.evaluate(example);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile("examples/expected/deferred_fallback.txt", "utf8"))
        .trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(example)),
      (
        await readFile("examples/expected/deferred_fallback.wasm.txt", "utf8")
      ).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("deferred fallback keeps its arrow and error contracts", async () => {
  const compiler = await Compiler.create();
  try {
    for (const fixture of typeErrorFixtures) {
      await assert.rejects(() => compiler.check(fixture), /BLOT_TYPE_ERROR/);
    }

    const checkedInterface2 = await compiler.check(runtimeEscapeFixture);
    assert.deepEqual({
      type: checkedInterface2.type,
      effects: checkedInterface2.effects,
    }, {
      type:
        "{ .default = #Ok ⊤ | #Error ⊤ ~> #Ok ⊤ | #Error ⊤ -> #Ok ⊥ | #Error { .primary = ⊥; .fallback = ⊥ } }",
      effects: "",
    });
    await assert.rejects(
      () => compiler.compile(runtimeEscapeFixture),
      {
        name: "CompilerTargetRefusal",
        message: /deferred function crosses the public runtime ABI/,
      },
    );
  } finally {
    compiler.destroy();
  }
});
