import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const example = "examples/composable_reducers.blot";
const library = "examples/lib/reducer.blot";
const mismatchFixture = "src/node/fixtures/reducer_projection_mismatch.blot";

test("composable reducers preserve types and both executions", async () => {
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
      type:
        "{ .default = { .full = { .revenue_cents = Int; .unit_count = Int; .line_count = Int; .average_unit_cents = #None | #Some Int }; .empty = { .revenue_cents = Int; .unit_count = Int; .line_count = Int; .average_unit_cents = #None | #Some Int }; .single = { .revenue_cents = Int; .unit_count = Int; .line_count = Int; .average_unit_cents = #None | #Some Int } } }",
      effects: "",
    });

    const evaluated = await compiler.evaluate(example);
    const expected = await readFile(
      "examples/expected/composable_reducers.txt",
      "utf8",
    );
    const expectedWasm = await readFile(
      "examples/expected/composable_reducers.wasm.txt",
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

test(
  "composable reducers reject incompatible projections and public inputs",
  async () => {
    const compiler = await Compiler.create();
    try {
      await assert.rejects(
        () => compiler.check(mismatchFixture),
        /BLOT_TYPE_ERROR: Text does not flow into Int/,
      );

      const source = await readFile(example, "utf8");
      await assert.rejects(
        () =>
          compiler.checkSource(
            example,
            source.replace(
              ".quantity = 4; .unit_cents = 175;",
              '.quantity = "oops"; .unit_cents = 175;',
            ),
          ),
        /BLOT_TYPE_ERROR: "oops" does not flow into Int/,
      );
    } finally {
      compiler.destroy();
    }
  },
);
