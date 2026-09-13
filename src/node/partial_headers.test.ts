import assert from "node:assert/strict";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { runArtifact } from "./run.ts";

test("partial function headers infer each omitted component independently", async () => {
  const compiler = await Compiler.create();
  try {
    for (
      const header of [
        "fn (a :: Int, b) => b",
        "fn (a, b :: Int) => a",
        "fn (a, b) -> Int => a",
        "fn (a :: Int, b) -> Int => a",
        "fn a -> Int => a",
        "fn (a :: Int) => a",
      ]
    ) {
      let calls = '(choose (42, "text"), choose (42, True))';
      let expectedType = '{ .0 = "text"; .1 = #True }';
      let expected = '("text", #True)';
      let wasmExpected = '{ .0 = "text"; .1 = true }';
      if (header.includes("b :: Int")) {
        calls = '(choose ("text", 42), choose (True, 42))';
      }
      if (header.includes("-> Int")) {
        expectedType = "{ .0 = Int; .1 = Int }";
        expected = "(42, 42)";
        wasmExpected = "{ .0 = 42; .1 = 42 }";
      }
      if (header === "fn a -> Int => a" || header === "fn (a :: Int) => a") {
        calls = "(choose 42, choose 42)";
        expectedType = "{ .0 = Int; .1 = Int }";
        expected = "(42, 42)";
        wasmExpected = "{ .0 = 42; .1 = 42 }";
      }
      const path = "/tmp/blot-partial-headers.blot";
      const checked = await compiler.checkSource(
        path,
        `open import "blot:prelude"
const choose = ${header}
return ${calls}
`,
      );
      assert.equal(checked.type, expectedType, header);
      assert.equal(checked.effects, "", header);
      assert.equal((await compiler.evaluate(path)).display, expected, header);
      assert.equal(
        await runArtifact(await compiler.compile(path)),
        wasmExpected,
        header,
      );
    }
    for (
      const source of [
        'const f = fn (a :: Int, b) => b\nreturn f ("wrong", 42)',
        'const f = fn (a, b) -> Int => a\nreturn f ("wrong", 42)',
        "const f = fn (a :: Int, b) -> Text => a\nreturn f (42, True)",
        "const E = @effect { .ask = Unit -> Int; }\nconst f = fn (a, b) -> Int => do:\n  use answer <- E.ask ()\n  return answer\nreturn 0",
      ]
    ) {
      await assert.rejects(
        compiler.checkSource(
          "/tmp/blot-partial-header-mismatch.blot",
          `open import "blot:prelude"\n${source}\n`,
        ),
        /BLOT_TYPE_ERROR/,
      );
    }
  } finally {
    compiler.destroy();
  }
});

test("omitting the header result infers performed effects without sharing result holes", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "/tmp/blot-partial-header-effects.blot";
    const checked = await compiler.checkSource(
      path,
      `open import "blot:prelude"
const Read = @effect { .value = Int -> Int; }
const choose = fn (a :: Int, b) => do:
  use value <- Read.value a
  return (value, b)
return @handle (Read, fn () => (choose (1, "text"), choose (2, True)), {
  .value = fn (value, ?resume) => resume (value + 40)
})
`,
    );
    assert.equal(checked.effects, "");
    assert.equal(
      (await compiler.evaluate(path)).display,
      '((41, "text"), (42, #True))',
    );
    assert.equal(
      await runArtifact(await compiler.compile(path)),
      '{ .0 = { .0 = 41; .1 = "text" }; .1 = { .0 = 42; .1 = true } }',
    );
  } finally {
    compiler.destroy();
  }
});
