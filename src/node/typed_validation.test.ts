import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const type =
  "{ .default = { .good = { .ok = #True | #False; .errors = [Text]; .port = Int; .replicas = Int; .timeout_ms = Int }; .bad = { .ok = #True | #False; .errors = [Text]; .port = Int; .replicas = Int; .timeout_ms = Int }; .boundary = { .ok = #True | #False; .errors = [Text]; .port = Int; .replicas = Int; .timeout_ms = Int }; .good_capacity = Int; .bad_capacity = Int } }";

test("typed validation accumulates independent errors and preserves refinements", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "examples/typed_validation.blot";
    const source = await readFile(path, "utf8");
    const formatted = await formatSource(source);
    assert.equal(formatted.ok, true);
    if (!formatted.ok) throw new Error("typed validation failed to format");
    assert.equal(formatted.source, source);

    const checkedInterface1 = await compiler.check(path);
    assert.deepEqual({
      type: checkedInterface1.type,
      effects: checkedInterface1.effects,
    }, { type, effects: "" });

    const evaluated = await compiler.evaluate(path);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile("examples/expected/typed_validation.txt", "utf8")).trim(),
    );

    assert.equal(
      await runArtifact(await compiler.compile(path)),
      (await readFile("examples/expected/typed_validation.wasm.txt", "utf8"))
        .trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("typed validation refinements cannot be bypassed", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () =>
        compiler.check(
          "src/node/fixtures/validation_refinement_bypass.blot",
        ),
      /BLOT_TYPE_ERROR/,
    );
  } finally {
    compiler.destroy();
  }
});
