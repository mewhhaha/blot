import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

test("effect-row middleware preserves callback effects and both executions", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "examples/effect_row_middleware.blot";
    const source = await readFile(path, "utf8");
    const formatted = await formatSource(source);
    assert.equal(formatted.ok, true);
    if (!formatted.ok) throw new Error("effect-row middleware failed to format");
    assert.equal(formatted.source, source);

    const expected = (await readFile(
      "examples/expected/effect_row_middleware.txt",
      "utf8",
    )).trim();
    const evaluated = await compiler.evaluate(path);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(evaluated.display, expected);

    const expectedWasm = (await readFile(
      "examples/expected/effect_row_middleware.wasm.txt",
      "utf8",
    )).trim();
    assert.equal(await runArtifact(await compiler.compile(path)), expectedWasm);
  } finally {
    compiler.destroy();
  }
});

test("effect-row middleware cannot hide effects performed by its callback", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check("src/node/fixtures/effect_middleware_dropped_fetch.blot"),
      /BLOT_TYPE_ERROR/,
    );
  } finally {
    compiler.destroy();
  }
});
