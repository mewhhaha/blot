import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Compiler, CompilerTargetRefusal } from "../compiler.ts";
import { runArtifact } from "./run.ts";

interface ManifestType {
  readonly kind: string;
  readonly element?: ManifestType;
  readonly cases?: readonly {
    readonly name: string;
    readonly payload?: ManifestType;
  }[];
}

interface ManifestFunction {
  readonly parameters: readonly ManifestType[];
  readonly result: ManifestType;
}

interface ManifestExport {
  readonly sourceName: string;
  readonly name: string | null;
  readonly phase: "runtime" | "comptime";
  readonly function: ManifestFunction | null;
  readonly effects: readonly string[];
}

interface ManifestImport {
  readonly capability: string;
  readonly operation: string;
  readonly module: string;
  readonly name: string;
  readonly function: ManifestFunction;
}

interface Manifest {
  readonly exports: readonly ManifestExport[];
  readonly imports: readonly ManifestImport[];
}

test("Baba Wasm -> Node -> gpupaper Wasm compiles Blot", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(resolve("examples/minimal.blot"));
    assert.equal(WebAssembly.validate(Uint8Array.from(artifact.wasm)), true);
    assert.ok(artifact.manifestBytes.byteLength > 0);
  } finally {
    compiler.destroy();
  }
});

test("run executes and formats a default scalar export", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(resolve("examples/minimal.blot"));
    assert.equal(await runArtifact(artifact), "42");
  } finally {
    compiler.destroy();
  }
});

test("run refuses to fabricate required host operations", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(resolve("examples/granted.blot"));
    await assert.rejects(
      runArtifact(artifact),
      /run cannot supply host operations: Init\.print/,
    );
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

test("runtime-neutral semantic revisions reuse the compiled artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-node-semantic-cache-"));
  const path = join(directory, "minimal.blot");
  const compiler = await Compiler.create();
  try {
    await writeFile(path, "const hidden = 1\nexport 42\n");
    const first = await compiler.compile(path);
    await writeFile(path, "const hidden = 100\nexport 42\n");
    const second = await compiler.compile(path);
    assert.equal(second.artifactSource, "revision-cache");
    assert.deepEqual(second.wasm, first.wasm);
    assert.deepEqual(second.manifestBytes, first.manifestBytes);

    const fresh = await Compiler.create();
    try {
      const rebuilt = await fresh.compile(path);
      assert.equal(rebuilt.artifactSource, "compiled");
      assert.deepEqual(second.wasm, rebuilt.wasm);
      assert.deepEqual(second.manifestBytes, rebuilt.manifestBytes);
    } finally {
      fresh.destroy();
    }
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});

test("runtime-changing semantic revisions recompile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-node-semantic-miss-"));
  const path = join(directory, "minimal.blot");
  const compiler = await Compiler.create();
  try {
    await writeFile(path, "export 42\n");
    const first = await compiler.compile(path);
    await writeFile(path, "export 43\n");
    const second = await compiler.compile(path);
    assert.equal(second.artifactSource, "compiled");
    assert.notDeepEqual(second.wasm, first.wasm);
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});

test("multiple named runtime exports survive Runtime HIR and ABI lowering", async () => {
  const compiler = await Compiler.create();
  try {
    const path = resolve("examples/arithmetic.blot");
    const expectedNames = [
      "sum",
      "nested",
      "negated",
      "compared",
      "equal",
      "piped",
      "branch",
    ];
    const hir = await compiler.prepare(path);
    const runtimeHirNames = hir.exports
      .filter((exported) => exported.phase === "runtime")
      .map((exported) => exported.sourceName);
    assert.deepEqual(runtimeHirNames, expectedNames);

    const artifact = await compiler.compile(path);
    const manifest = decodeManifest(artifact.manifestBytes);
    const runtimeAbiNames = manifest.exports
      .filter((exported) => exported.phase === "runtime")
      .map((exported) => exported.sourceName);
    assert.deepEqual(runtimeAbiNames, expectedNames);
    assert.deepEqual(
      blotFunctionExports(artifact.wasm),
      expectedNames.map(
        (name) => `blot:${name}`,
      ),
    );
  } finally {
    compiler.destroy();
  }
});

test("array exports preserve the complete closed Option ABI", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(
      resolve("examples/polymorphic_collections.blot"),
    );
    const manifest = decodeManifest(artifact.manifestBytes);
    assert.deepEqual(
      requiredRuntimeExport(manifest, "lengths").function.result,
      {
        kind: "array",
        element: { kind: "signed-integer-64" },
      },
    );
    assert.deepEqual(
      requiredRuntimeExport(manifest, "map_previous").function.result,
      {
        kind: "variant",
        cases: [
          { name: "None" },
          { name: "Some", payload: { kind: "text" } },
        ],
      },
    );
    assert.equal(WebAssembly.validate(Uint8Array.from(artifact.wasm)), true);
  } finally {
    compiler.destroy();
  }
});

test("a named .default field is projected as blot:default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-node-default-"));
  const path = join(directory, "default-field.blot");
  const compiler = await Compiler.create();
  try {
    await writeFile(
      path,
      "export {\n  .default = 42;\n  .other = 7;\n}\n",
    );
    const artifact = await compiler.compile(path);
    const manifest = decodeManifest(artifact.manifestBytes);
    assert.deepEqual(
      manifest.exports.map((exported) => [exported.sourceName, exported.name]),
      [
        ["default", "blot:default"],
        ["other", "blot:other"],
      ],
    );
    const instantiated = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm),
    );
    assert.equal(
      exportedFunction(instantiated.instance, "blot:default")(),
      42n,
    );
    assert.equal(exportedFunction(instantiated.instance, "blot:other")(), 7n);
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});

test("module grants keep Unit return typing through canonical text imports", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(resolve("examples/granted.blot"));
    const manifest = decodeManifest(artifact.manifestBytes);
    assert.deepEqual(manifest.imports, [
      {
        capability: "Init",
        operation: "print",
        module: "blot:host/Init",
        name: "print",
        function: {
          parameters: [{ kind: "text" }],
          result: { kind: "unit" },
        },
      },
    ]);
    const exported = requiredRuntimeExport(manifest, "default");
    assert.deepEqual(exported.function.result, { kind: "signed-integer-64" });
    assert.deepEqual(exported.effects, ["Init"]);
    assert.deepEqual(artifact.capabilities, ["Init"]);

    const writes: string[] = [];
    const active: { instance?: WebAssembly.Instance } = {};
    const instantiated = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm),
      {
        "blot:host/Init": {
          print(pointer: number, length: number): void {
            if (active.instance === undefined) {
              throw new Error(
                "host print called before instantiation completed",
              );
            }
            const memory = exportedMemory(active.instance);
            const bytes = new Uint8Array(memory.buffer, pointer, length);
            writes.push(new TextDecoder().decode(bytes));
          },
        },
      },
    );
    active.instance = instantiated.instance;
    assert.equal(
      exportedFunction(instantiated.instance, "blot:default")(),
      42n,
    );
    assert.deepEqual(writes, ["compiled", "linked"]);
  } finally {
    compiler.destroy();
  }
});

test("module grants preserve dynamic non-Unit host results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-node-host-result-"));
  const path = join(directory, "host-result.blot");
  const compiler = await Compiler.create();
  try {
    await writeFile(
      path,
      'module with init\n\nopen import "blot:prelude"\n\nvalue <- init.read ()\nexport value + 1\n',
    );
    const artifact = await compiler.compile(path);
    const manifest = decodeManifest(artifact.manifestBytes);
    assert.deepEqual(manifest.imports, [
      {
        capability: "Init",
        operation: "read",
        module: "blot:host/Init",
        name: "read",
        function: {
          parameters: [{ kind: "unit" }],
          result: { kind: "signed-integer-64" },
        },
      },
    ]);

    let hostValue = 41n;
    const instantiated = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm),
      {
        "blot:host/Init": {
          read(): bigint {
            return hostValue;
          },
        },
      },
    );
    const run = exportedFunction(instantiated.instance, "blot:default");
    assert.equal(run(), 42n);
    hostValue = -2n;
    assert.equal(run(), -1n);
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});

test("effectful top-level work is never replayed across runtime exports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-node-module-instance-"));
  const path = join(directory, "effectful-exports.blot");
  const compiler = await Compiler.create();
  try {
    await writeFile(
      path,
      "module with init\n\nvalue <- init.read ()\nexport { .first = value; .second = value; }\n",
    );
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

test("handled top-level effects do not trigger the host replay refusal", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(
      resolve("examples/composed_handlers.blot"),
    );
    const manifest = decodeManifest(artifact.manifestBytes);
    assert.deepEqual(
      manifest.exports.map((exported) => exported.sourceName),
      ["named", "discarded"],
    );
  } finally {
    compiler.destroy();
  }
});

test("dynamic signed i64 to f64 conversion matches WebAssembly edge rounding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-node-i64-f64-"));
  const path = join(directory, "i64-f64.blot");
  const compiler = await Compiler.create();
  try {
    await writeFile(
      path,
      'module with init\n\nopen import "blot:prelude"\n\nvalue <- init.read ()\n<- init.observe (Float.of_int value)\nexport ()\n',
    );
    const artifact = await compiler.compile(path);
    const manifest = decodeManifest(artifact.manifestBytes);
    assert.deepEqual(
      manifest.imports.map((imported) => imported.function),
      [
        {
          parameters: [{ kind: "unit" }],
          result: { kind: "signed-integer-64" },
        },
        {
          parameters: [{ kind: "float-64" }],
          result: { kind: "unit" },
        },
      ],
    );

    let hostValue = 0n;
    const observed: number[] = [];
    const instantiated = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm),
      {
        "blot:host/Init": {
          read(): bigint {
            return hostValue;
          },
          observe(value: number): void {
            observed.push(value);
          },
        },
      },
    );
    const run = exportedFunction(instantiated.instance, "blot:default");
    const cases = [
      -9223372036854775808n,
      -9007199254740993n,
      -4294967297n,
      -2147483649n,
      -1n,
      0n,
      1n,
      2147483647n,
      2147483648n,
      4294967295n,
      9007199254740993n,
      9223372036854775807n,
    ];
    for (const value of cases) {
      hostValue = value;
      run();
      assert.equal(observed.pop(), Number(value), `conversion of ${value}`);
    }
    assert.deepEqual(observed, []);
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});

test("agent-style recursion lowers to a dynamic back-edge and compiles", async () => {
  const compiler = await Compiler.create();
  try {
    const path = resolve("case-studies/agent/main.blot");
    const hir = await compiler.prepare(path);
    const function_ = hir.functions[0];
    assert.notEqual(function_, undefined);
    if (function_ === undefined) throw new Error("agent HIR has no function");
    const hasConditional = function_.blocks.some((block) =>
      block.terminator.kind === "conditional"
    );
    const hasBackEdge = function_.blocks.some((block) => {
      if (block.terminator.kind !== "branch") return false;
      return block.terminator.target <= block.id;
    });
    assert.equal(hasConditional, true);
    assert.equal(hasBackEdge, true);

    const artifact = await compiler.compile(path);
    const exported = requiredRuntimeExport(
      decodeManifest(artifact.manifestBytes),
      "default",
    );
    assert.deepEqual(exported.function.result, { kind: "signed-integer-64" });
    assert.equal(WebAssembly.validate(Uint8Array.from(artifact.wasm)), true);
  } finally {
    compiler.destroy();
  }
});

function decodeManifest(bytes: Uint8Array): Manifest {
  return JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
}

function requiredRuntimeExport(
  manifest: Manifest,
  sourceName: string,
): ManifestExport & { readonly function: ManifestFunction } {
  const exported = manifest.exports.find((candidate) =>
    candidate.sourceName === sourceName && candidate.phase === "runtime"
  );
  if (exported === undefined || exported.function === null) {
    throw new Error(`missing runtime export ${sourceName}`);
  }
  return exported as ManifestExport & { readonly function: ManifestFunction };
}

function blotFunctionExports(wasm: Uint8Array): string[] {
  const module = new WebAssembly.Module(wasm as BufferSource);
  return WebAssembly.Module.exports(module)
    .filter((exported) =>
      exported.kind === "function" && exported.name.startsWith("blot:")
    )
    .map((exported) => exported.name);
}

function exportedFunction(
  instance: WebAssembly.Instance,
  name: string,
): (...arguments_: readonly number[]) => unknown {
  const exported = instance.exports[name];
  if (typeof exported !== "function") {
    throw new Error(`missing WebAssembly function export ${name}`);
  }
  return exported as (...arguments_: readonly number[]) => unknown;
}

function exportedMemory(instance: WebAssembly.Instance): WebAssembly.Memory {
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error("missing WebAssembly memory export");
  }
  return memory;
}
