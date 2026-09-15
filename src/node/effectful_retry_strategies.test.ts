import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const path = "examples/effectful_retry_strategies.blot";
const blotSources = [
  "examples/lib/retry_strategy.blot",
  path,
  "src/node/fixtures/retry_strategy_error_mismatch.blot",
  "src/node/fixtures/retry_strategy_state_mismatch.blot",
  "src/node/fixtures/retry_strategy_dropped_effect.blot",
] as const;

test("typed retry strategies preserve callback effects and both executions", async () => {
  const compiler = await Compiler.create();
  try {
    for (const sourcePath of blotSources) {
      const source = await readFile(sourcePath, "utf8");
      const formatted = await formatSource(source);
      assert.equal(formatted.ok, true, `${sourcePath} failed to format`);
      if (!formatted.ok) throw new Error(`${sourcePath} failed to format`);
      assert.equal(formatted.source, source, `${sourcePath} is not canonical`);
    }

    const checked = await compiler.check(path);
    assert.equal(checked.effects, "");

    const evaluated = await compiler.evaluate(path);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile(
        "examples/expected/effectful_retry_strategies.txt",
        "utf8",
      )).trim(),
    );

    assert.equal(
      await runArtifact(await compiler.compile(path)),
      (await readFile(
        "examples/expected/effectful_retry_strategies.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("typed retry strategies reject carrier mismatches and hidden callback effects", async () => {
  const compiler = await Compiler.create();
  try {
    for (
      const fixture of [
        "src/node/fixtures/retry_strategy_error_mismatch.blot",
        "src/node/fixtures/retry_strategy_state_mismatch.blot",
        "src/node/fixtures/retry_strategy_dropped_effect.blot",
      ]
    ) {
      await assert.rejects(() => compiler.check(fixture), /BLOT_TYPE_ERROR/);
    }
  } finally {
    compiler.destroy();
  }
});
