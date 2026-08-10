import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
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

test("comment-only revisions reuse the compiled artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-node-cache-"));
  const path = join(directory, "minimal.blot");
  const source = await readFile(resolve("examples/minimal.blot"), "utf8");
  const compiler = await Compiler.create();
  try {
    await writeFile(path, source);
    const first = await compiler.compile(path);
    await writeFile(path, `${source}\n// unchanged semantics\n`);
    const second = await compiler.compile(path);
    assert.equal(second.artifactSource, "revision-cache");
    assert.deepEqual(second.wasm, first.wasm);
    assert.deepEqual(second.manifestBytes, first.manifestBytes);
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});
