import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Compiler } from "../compiler/session.ts";
import { instantiateArtifact } from "../host.ts";
import { runArtifact } from "./run.ts";

const examples = new URL("../../examples/", import.meta.url);

for (
  const name of [
    "control_transformers",
    "nested_case_joins",
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

test("nested cases widen payloads and multi-constructor sums for runtime arguments", async () => {
  const compiler = await Compiler.create();
  const hosted = await instantiateArtifact(
    await compiler.compile("examples/lib/nested_case_joins.blot"),
  );
  try {
    for (
      const [input, expected] of [[0n, 120n], [1n, 212n], [2n, 332n], [
        9n,
        339n,
      ]]
    ) {
      assert.equal(hosted.call("observe", [input]), expected);
    }
    assert.deepEqual(hosted.call("nested", [0n]), {
      kind: "variant",
      name: "Wrapped",
      payload: { kind: "variant", name: "None" },
    });
    assert.deepEqual(hosted.call("nested", [1n]), {
      kind: "variant",
      name: "Wrapped",
      payload: { kind: "variant", name: "Some", payload: 1n },
    });
    assert.deepEqual(hosted.call("widened", [2n]), {
      kind: "variant",
      name: "Right",
      payload: 2n,
    });
  } finally {
    await hosted.close();
    compiler.destroy();
  }
});
