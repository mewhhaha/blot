import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const example = "examples/composable_parser.blot";
const library = "examples/lib/parser.blot";
const mismatchFixture = "src/node/fixtures/parser_result_mismatch.blot";

test("composable parsers agree in evaluator and emitted Wasm", async () => {
  const compiler = await Compiler.create();
  try {
    for (const path of [library, example]) {
      const source = await readFile(path, "utf8");
      const formatted = await formatSource(source);
      assert.equal(formatted.ok, true);
      if (!formatted.ok) throw new Error(`${path} failed to format`);
      assert.equal(formatted.source, source);
    }

    const checked = await compiler.check(example);
    assert.equal(checked.effects, "");
    assert.match(checked.type, /\.health =/);
    assert.match(checked.type, /#Health/);
    assert.match(checked.type, /#User/);
    assert.match(checked.type, /#Asset/);
    assert.match(checked.type, /\.offset = Int/);

    const evaluated = await compiler.evaluate(example);
    const expected = await readFile(
      "examples/expected/composable_parser.txt",
      "utf8",
    );
    const expectedWasm = await readFile(
      "examples/expected/composable_parser.wasm.txt",
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

test("parser result types remain connected through map", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check(mismatchFixture),
      /BLOT_TYPE_ERROR/,
    );
  } finally {
    compiler.destroy();
  }
});
