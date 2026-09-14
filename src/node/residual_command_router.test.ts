import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const path = "examples/residual_command_router.blot";
const expectedType =
  "{ .default = { .created = Text; .renamed = Text; .deleted = Text; .health = Text } }";

test("residual router composes exact remaining variants in both executions", async () => {
  const compiler = await Compiler.create();
  try {
    for (
      const sourcePath of [
        "examples/lib/residual_router.blot",
        path,
        "src/node/fixtures/residual_router_reintroduces_handled.blot",
        "src/node/fixtures/residual_router_incomplete_final.blot",
        "src/node/fixtures/residual_router_empty_difference.blot",
      ]
    ) {
      const source = await readFile(sourcePath, "utf8");
      const formatted = await formatSource(source);
      assert.equal(formatted.ok, true);
      if (!formatted.ok) throw new Error(`${sourcePath} failed to format`);
      assert.equal(formatted.source, source);
    }

    assert.deepEqual(await compiler.check(path), {
      type: expectedType,
      effects: "",
    });

    const evaluated = await compiler.evaluate(path);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile("examples/expected/residual_command_router.txt", "utf8"))
        .trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(path)),
      (await readFile(
        "examples/expected/residual_command_router.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("residual router rejects widened residuals, incomplete finals, and empty differences", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () =>
        compiler.check(
          "src/node/fixtures/residual_router_reintroduces_handled.blot",
        ),
      /BLOT_TYPE_ERROR: #A does not flow into #B/,
    );
    await assert.rejects(
      () =>
        compiler.check(
          "src/node/fixtures/residual_router_incomplete_final.blot",
        ),
      /BLOT_TYPE_ERROR: #B \| #C does not flow into #C/,
    );
    await assert.rejects(
      () =>
        compiler.check(
          "src/node/fixtures/residual_router_empty_difference.blot",
        ),
      /BLOT_EMPTY_TYPE/,
    );
  } finally {
    compiler.destroy();
  }
});
