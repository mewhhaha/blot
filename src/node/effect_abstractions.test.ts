import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examples = [
  {
    name: "nonempty_effect_stream",
    type:
      "{ .default = { .sum = Int; .text = Text; .first = 1..9223372036854775807; .singleton_text = Text; .singleton_first = 1..9223372036854775807 } }",
    wasm:
      '{ .first = 10; .singleton_first = 7; .singleton_text = "7"; .sum = 42; .text = "10, 20, 12" }',
  },
  {
    name: "typed_effect_pipeline",
    type: "Text",
    wasm: '"$10 + $20 + $12"',
  },
  {
    name: "schema_effects",
    type: "{ .default = { .development = Text; .production = Text } }",
    wasm:
      '{ .development = "localhost:8080"; .production = "example.com:443" }',
  },
  {
    name: "linear_transaction",
    type:
      "{ .default = { .committed = #Committed Text | #RolledBack Text; .rolled_back = #Committed Text | #RolledBack Text } }",
    wasm:
      '{ .committed = #Committed "order-42"; .rolled_back = #RolledBack "order-42" }',
  },
];

for (const example of examples) {
  test(`${example.name} preserves its inferred types and both executions`, async () => {
    const compiler = await Compiler.create();
    try {
      const path = `examples/${example.name}.blot`;
      const source = await readFile(path, "utf8");
      const formatted = await formatSource(source);
      assert.equal(formatted.ok, true);
      if (!formatted.ok) throw new Error("accepted example failed to format");
      assert.equal(formatted.source, source);
      assert.deepEqual(await compiler.check(path), {
        type: example.type,
        effects: "",
      });
      const evaluated = await compiler.evaluate(path);
      assert.deepEqual(evaluated.writes, []);
      const expected = await readFile(
        `examples/expected/${example.name}.txt`,
        "utf8",
      );
      assert.equal(evaluated.display, expected.trim());
      assert.equal(
        await runArtifact(await compiler.compile(path)),
        example.wasm,
      );
    } finally {
      compiler.destroy();
    }
  });
}

test("the first handler skips a trapping tail of a nonempty stream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-nonempty-first-"));
  const compiler = await Compiler.create();
  try {
    const source = await readFile(
      "examples/nonempty_effect_stream.blot",
      "utf8",
    );
    const path = join(directory, "first.blot");
    await writeFile(
      path,
      source.slice(0, source.lastIndexOf("\nreturn {")) + `
let interrupted :: Unit -> Positive ~ { Numbers }
let interrupted = fn () => do:
  use Numbers.emit 5
  return @panic "the first handler resumed the tail"
return @handle (Numbers, interrupted, first)
`,
    );
    assert.equal((await compiler.evaluate(path)).display, "5");
    assert.equal(await runArtifact(await compiler.compile(path)), "5");
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});

for (
  const [name, example, before, after, diagnostic] of [
    [
      "nonpositive emission",
      "nonempty_effect_stream",
      "Numbers.emit 10",
      "Numbers.emit 0",
      "BLOT_TYPE_ERROR",
    ],
    [
      "missing final element",
      "nonempty_effect_stream",
      "return 12",
      "return ()",
      "BLOT_TYPE_ERROR",
    ],
    [
      "invalid configuration port",
      "schema_effects",
      ".port = 8080",
      ".port = 0",
      "BLOT_TYPE_ERROR",
    ],
    [
      "duplicate transaction commit",
      "linear_transaction",
      "#Commit => Transaction.commit (!pending)",
      "#Commit => do:\n        use Transaction.commit (!pending)\n        return Transaction.commit (!pending)",
      "BLOT_LINEAR_CONSUMED_TWICE",
    ],
    [
      "abandoned transaction",
      "linear_transaction",
      "#Commit => Transaction.commit (!pending)",
      '#Commit => #Committed "abandoned"',
      "BLOT_LINEAR_BRANCH_DISAGREEMENT",
    ],
  ]
) {
  test(`effect abstractions reject ${name}`, async () => {
    const compiler = await Compiler.create();
    try {
      const source = await readFile(`examples/${example}.blot`, "utf8");
      await assert.rejects(
        () =>
          compiler.checkSource(
            `/tmp/blot-effect-abstractions-${example}.blot`,
            source.replace(before, after),
          ),
        new RegExp(diagnostic),
      );
    } finally {
      compiler.destroy();
    }
  });
}
