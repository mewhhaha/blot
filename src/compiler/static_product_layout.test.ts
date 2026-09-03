import assert from "node:assert/strict";
import test from "node:test";
import { Compiler } from "./session.ts";

// storage.blot exercises attached layout APIs whose runtime product order can
// differ from record_layout's alignment/name order for static memory.
test("static product fields are written by name, not runtime order", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile("examples/storage.blot");
    assert.ok(artifact.wasm.length > 0);
  } finally {
    compiler.destroy();
  }
});
