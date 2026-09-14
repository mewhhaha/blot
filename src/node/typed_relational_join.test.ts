import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const path = "examples/typed_relational_join.blot";
const expectedType =
  "{ .default = { .customers = [{ .customer = Text; .order_count = Int; .total = Int }]; .products = [{ .product = Text; .line_count = Int; .quantity = Int }]; .orders = [{ .order = Int; .customer_count = Int }]; .empty_right_counts = [Int]; .empty_left = [⊥] } }";

const sourcePaths = [
  "examples/lib/relational_join.blot",
  path,
  "src/node/fixtures/relational_join_key_mismatch.blot",
  "src/node/fixtures/relational_join_input_mismatch.blot",
] as const;

test("typed relational group join preserves key domains in both executions", async () => {
  const compiler = await Compiler.create();
  try {
    for (const sourcePath of sourcePaths) {
      const source = await readFile(sourcePath, "utf8");
      const formatted = await formatSource(source);
      assert.equal(formatted.ok, true);
      if (!formatted.ok) throw new Error(`${sourcePath} failed to format`);
      assert.equal(formatted.source, source);
    }

    const checkedInterface1 = await compiler.check(path);
    assert.deepEqual({
      type: checkedInterface1.type,
      effects: checkedInterface1.effects,
    }, {
      type: expectedType,
      effects: "",
    });

    const evaluated = await compiler.evaluate(path);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile("examples/expected/typed_relational_join.txt", "utf8"))
        .trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(path)),
      (await readFile(
        "examples/expected/typed_relational_join.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("typed relational join rejects mismatched key and row domains", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () =>
        compiler.check(
          "src/node/fixtures/relational_join_key_mismatch.blot",
        ),
      /BLOT_TYPE_ERROR: #ProductId Int does not flow into #CustomerId Int/,
    );
    await assert.rejects(
      () =>
        compiler.check(
          "src/node/fixtures/relational_join_input_mismatch.blot",
        ),
      /BLOT_TYPE_ERROR: \{ \.name = "compiler" \} does not flow into \{ \.customer_id = #CustomerId Int \}/,
    );
  } finally {
    compiler.destroy();
  }
});
