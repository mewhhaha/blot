import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Compiler } from "../compiler/session.ts";
import { runArtifact } from "./run.ts";

const examples = new URL("../../examples/", import.meta.url);

for (
  const name of [
    "control_transformers",
    "row_preserving_wrapper",
    "region_round_trip",
  ]
) {
  test(`composition: ${name} matches both executions`, async () => {
    const compiler = await Compiler.create();
    try {
      const path = fileURLToPath(new URL(`${name}.blot`, examples));
      const expected = (await readFile(
        new URL(`expected/${name}.txt`, examples),
        "utf8",
      )).trim();
      const evaluated = await compiler.evaluate(path);
      assert.deepEqual(evaluated.writes, []);
      assert.equal(evaluated.display, expected);
      assert.equal(await runArtifact(await compiler.compile(path)), expected);
    } finally {
      compiler.destroy();
    }
  });
}
