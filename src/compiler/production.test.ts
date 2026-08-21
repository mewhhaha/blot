import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { BlotError } from "../diagnostic.ts";
import { CompilerTargetRefusal } from "./backend.ts";
import { ProductionCompiler } from "./production.ts";
import { Compiler } from "./session.ts";

const compilerWasm = new URL(
  "../../generated/compiler/compiler.wasm",
  import.meta.url,
);

test("production compiler exposes the resident high-level phase contract", async () => {
  const compiler = await ProductionCompiler.create({
    wasm: await readFile(compilerWasm),
  });
  try {
    const path = resolve("examples/minimal.blot");
    const checked = await compiler.check(path);
    assert.equal(checked.type, "42..42");

    const runtime = await compiler.prepare(path);
    assert.equal(runtime.schemaVersion, 2);

    const artifact = await compiler.compile(path);
    const wasm = Uint8Array.from(artifact.wasm).buffer;
    assert.equal(WebAssembly.validate(wasm), true);
    assert.equal(artifact.artifactSource, "compiled");
    const cached = await compiler.compile(path);
    assert.equal(cached.artifactSource, "revision-cache");
    assert.deepEqual(cached.wasm, artifact.wasm);
  } finally {
    compiler.destroy();
  }
});

test("development and production checkers agree on collect's closed array", async () => {
  const path = resolve("examples/collect_principal_type.blot");
  const development = await Compiler.create();
  const production = await ProductionCompiler.create({
    wasm: await readFile(compilerWasm),
  });
  try {
    const expected = await development.check(path);
    const actual = await production.check(path);
    assert.equal(expected.type, "[Int]");
    assert.equal(actual.type, expected.type);
  } finally {
    development.destroy();
    production.destroy();
  }
});

test("production compiler transports located source diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-production-error-"));
  const path = join(directory, "error.blot");
  await writeFile(path, "return missing\n");
  const compiler = await ProductionCompiler.create({
    wasm: await readFile(compilerWasm),
  });
  try {
    await assert.rejects(
      compiler.check(path),
      (error: unknown) => {
        assert(error instanceof BlotError);
        assert.equal(error.diagnostic.code, "BLOT_UNBOUND");
        assert.equal(error.origin?.path, path);
        assert.equal(error.origin?.source, "return missing\n");
        return true;
      },
    );
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});

test("production compiler preserves target refusals as target failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-production-target-"));
  const path = join(directory, "effectful-fields.blot");
  await writeFile(
    path,
    "module with init\n\n" +
      "value <- init.read ()\n" +
      "return { .first = value; .second = value; }\n",
  );
  const compiler = await ProductionCompiler.create({
    wasm: await readFile(compilerWasm),
  });
  try {
    await assert.rejects(
      compiler.compile(path),
      (error: unknown) => {
        assert(error instanceof CompilerTargetRefusal);
        assert.match(error.message, /cannot be replayed/);
        return true;
      },
    );
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});

test("destroyed production compiler refuses new work", async () => {
  const compiler = await ProductionCompiler.create({
    wasm: await readFile(compilerWasm),
  });
  compiler.destroy();
  await assert.rejects(
    compiler.check("examples/minimal.blot"),
    /Compiler session has been destroyed/,
  );
});
