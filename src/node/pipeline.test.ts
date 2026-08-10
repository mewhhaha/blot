import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { Compiler } from "../compiler.ts";

test("Baba Wasm -> Node -> gpupaper Wasm compiles Blot", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(resolve("examples/minimal.blot"));
    assert.equal(WebAssembly.validate(artifact.wasm), true);
    assert.ok(artifact.manifestBytes.byteLength > 0);
  } finally {
    compiler.destroy();
  }
});
