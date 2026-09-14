import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { scalarExport } from "../../test_support/guest_abi.ts";
import { runArtifact } from "./run.ts";

test("deep rebinding preserves immutable values in both executions", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "examples/deep_rebinding.blot";
    const expected =
      (await readFile("examples/expected/deep_rebinding.txt", "utf8")).trim();
    assert.equal((await compiler.evaluate(path)).display, expected);
    assert.equal(await runArtifact(await compiler.compile(path)), expected);
  } finally {
    compiler.destroy();
  }
});

test("deep rebinding handles runtime arrays, guarded indices, and large folds", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(
      "examples/lib/deep_rebinding_runtime.blot",
    );
    const { instance } = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm),
    );
    const mixed = scalarExport(instance, "blot:mixed");
    assert.equal(mixed(3n), 24n);
    assert.equal(mixed(42n), 63n);
    const guarded = scalarExport(instance, "blot:guarded");
    assert.equal(guarded(1n, 7n), 47n);
    assert.equal(guarded(-1n, 7n), 60n);
    assert.equal(guarded(3n, 7n), 60n);
    assert.equal(scalarExport(instance, "blot:counted")(20000n), 20007n);
  } finally {
    compiler.destroy();
  }
});
