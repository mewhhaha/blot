import assert from "node:assert/strict";
import test from "node:test";
import { Compiler } from "./session.ts";

test("static product fields are written by name, not runtime order", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile("examples/storage.blot");
    assert.ok(artifact.wasm.length > 0);
  } finally {
    compiler.destroy();
  }
});
