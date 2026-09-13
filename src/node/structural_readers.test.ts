import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

test("structural readers compose capabilities and preserve both executions", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "examples/structural_readers.blot";
    const source = await readFile(path, "utf8");
    const formatted = await formatSource(source);
    assert.equal(formatted.ok, true);
    if (!formatted.ok) throw new Error("structural reader example failed to format");
    assert.equal(formatted.source, source);

    const checked = await compiler.check(path);
    assert.equal(checked.effects, "");

    const evaluated = await compiler.evaluate(path);
    assert.deepEqual(evaluated.writes, []);
    const expected = (
      await readFile("examples/expected/structural_readers.txt", "utf8")
    ).trim();
    assert.equal(evaluated.display, expected);

    const expectedWasm = (
      await readFile("examples/expected/structural_readers.wasm.txt", "utf8")
    ).trim();
    assert.equal(
      await runArtifact(await compiler.compile(path)),
      expectedWasm,
    );
  } finally {
    compiler.destroy();
  }
});

for (
  const name of ["reader_missing_capability", "reader_refined_capability"]
) {
  test(`structural readers reject ${name}`, async () => {
    const compiler = await Compiler.create();
    try {
      await assert.rejects(
        () => compiler.check(`src/node/fixtures/${name}.blot`),
        /BLOT_TYPE_ERROR/,
      );
    } finally {
      compiler.destroy();
    }
  });
}
