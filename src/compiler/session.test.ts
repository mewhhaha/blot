import assert from "node:assert/strict";
import test from "node:test";
import { Compiler } from "./session.ts";

test("development compiler follows check, prepare, compile", async () => {
  const compiler = await Compiler.create();
  try {
    const checked = await compiler.check("examples/minimal.blot");
    assert.equal(checked.type, "42");

    const runtime = await compiler.prepare("examples/minimal.blot");
    assert.equal(runtime.schemaVersion, 2);

    const artifact = await compiler.compile("examples/minimal.blot");
    const wasm = Uint8Array.from(artifact.wasm).buffer;
    assert.equal(WebAssembly.validate(wasm), true);
    assert.equal(artifact.artifactSource, "compiled");
  } finally {
    compiler.destroy();
  }
});

test("destroyed development compiler refuses new work", async () => {
  const compiler = await Compiler.create();
  compiler.destroy();
  await assert.rejects(
    compiler.check("examples/minimal.blot"),
    /Compiler session has been destroyed/,
  );
});
