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

test("Node hosts the Rust/Wasm compiler artifact", async () => {
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

test("runtime-neutral semantic revisions recompile for exact source origins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-node-semantic-cache-"));
  const path = join(directory, "minimal.blot");
  const compiler = await Compiler.create();
  try {
    await writeFile(path, "const hidden = 1\nreturn 42\n");
    await compiler.compile(path);
    await writeFile(path, "const hidden = 100\nreturn 42\n");
    const second = await compiler.compile(path);
    assert.equal(second.artifactSource, "compiled");

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
    await writeFile(path, "return 42\n");
    const first = await compiler.compile(path);
    await writeFile(path, "return 43\n");
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

test("mutating an owned literal does not change its pooled peer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-pooled-store-"));
  const path = join(directory, "pooled-store.blot");
  const compiler = await Compiler.create();
  try {
    await writeFile(
      path,
      `open import "blot:prelude"
const original :: Int -> Int
const original = fn ignored => Array.expect_get ((&[10, 20, 30]), 0)
const changed :: Int -> Int
const changed = fn replacement => do:
  let values :: [Int]
  let values = [10, 20, 30]
  let updated = @array.set values 0 replacement
  return Array.expect_get ((&updated), 0)
return { .original = original; .changed = changed; }
`,
    );
    const artifact = await compiler.compile(path);
    const instantiated = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm),
    );
    const changed = exportedFunction(instantiated.instance, "blot:changed");
    const original = exportedFunction(instantiated.instance, "blot:original");
    assert.equal(changed(99n), 99n);
    assert.equal(original(0n), 10n);
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
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
      "return {\n  .default = 42;\n  .other = 7;\n}\n",
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

test("a deferred runtime argument is omitted when the callee never demands it", async () => {
  const compiler = await Compiler.create();
  try {
    const path = resolve("examples/deferred_runtime.blot");
    const hir = await compiler.prepare(path);
    const deferredOperations = hir.functions.flatMap((function_) =>
      function_.blocks.flatMap((block) => block.operations)
    );
    assert.equal(
      deferredOperations.some((operation) =>
        /defer|suspend|thunk/.test(operation.kind)
      ),
      false,
    );
    assert.equal(
      deferredOperations.filter((operation) =>
        operation.kind === "scalar" && operation.operator === "divide"
      ).length,
      2,
    );
    const runHir = hir.functions.find((function_) =>
      function_.name === "blot$residual$default"
    );
    assert.notEqual(runHir, undefined);
    if (runHir === undefined) {
      throw new Error("deferred example has no default HIR");
    }
    assert.equal(
      runHir.blocks[runHir.entryBlock]?.terminator.kind,
      "conditional",
    );

    const artifact = await compiler.compile(path);
    const instantiated = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm),
    );
    const memory = exportedMemory(instantiated.instance);
    const pagesBefore = memory.buffer.byteLength;
    const run = exportedFunction(instantiated.instance, "blot:default");
    assert.equal(run(0n), 42n);
    assert.equal(run(7n), 12n);
    const both = exportedFunction(instantiated.instance, "blot:both");
    assert.equal(both(0n), 1n);
    assert.equal(both(7n), 8n);
    const choice = exportedFunction(instantiated.instance, "blot:choice");
    assert.equal(choice(0n, 0n), 42n);
    assert.equal(choice(1n, 7n), 12n);
    const helper = exportedFunction(instantiated.instance, "blot:helper");
    assert.equal(helper(0n), 1n);
    assert.equal(helper(7n), 8n);
    for (let index = 0; index < 10_000; index += 1) {
      run(BigInt(index % 8));
      choice(BigInt(index % 2), BigInt((index % 7) + 1));
    }
    assert.equal(memory.buffer.byteLength, pagesBefore);
  } finally {
    compiler.destroy();
  }
});

test("a deferred effect runs only on a demanding runtime path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-node-deferred-effect-"));
  const path = join(directory, "deferred-effect.blot");
  const compiler = await Compiler.create();
  try {
    await writeFile(
      path,
      `module with init

open import "blot:prelude"

let choose :: Bool -> Int ~> Int
let choose = fn condition => fn ~fallback => case condition of
  #True => fallback
  #False => 42

let run :: Int -> Int
let run = fn flag => do:
  use value <- choose (flag != 0) (init.read ())
  return value

return { .default = run; }
`,
    );
    const artifact = await compiler.compile(path);
    let reads = 0;
    const instantiated = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm),
      {
        "blot:host/Init": {
          read(): bigint {
            reads += 1;
            return 99n;
          },
        },
      },
    );
    const run = exportedFunction(instantiated.instance, "blot:default");
    assert.equal(run(0n), 42n);
    assert.equal(reads, 0);
    assert.equal(run(1n), 99n);
    assert.equal(reads, 1);
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
        ownership: { input: "unrestricted", result: "unrestricted" },
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

test("a module may directly return an effectful computation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-node-host-result-"));
  const path = join(directory, "host-result.blot");
  const compiler = await Compiler.create();
  try {
    await writeFile(
      path,
      'module with init\n\nopen import "blot:prelude"\n\nreturn init.read () + 1\n',
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
        ownership: { input: "unrestricted", result: "unrestricted" },
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

test("effectful top-level work is never replayed across runtime fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-node-module-instance-"));
  const path = join(directory, "effectful-fields.blot");
  const compiler = await Compiler.create();
  try {
    await writeFile(
      path,
      "module with init\n\nuse value <- init.read ()\nreturn { .first = value; .second = value; }\n",
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
      'module with init\n\nopen import "blot:prelude"\n\nuse value <- init.read ()\nuse init.observe (F64.of_int value)\nreturn ()\n',
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

test("agent-style recursion remains dynamic runtime control flow and compiles", async () => {
  const compiler = await Compiler.create();
  try {
    const path = resolve("case-studies/agent/main.blot");
    const hir = await compiler.prepare(path);
    const function_ = hir.functions[0];
    assert.notEqual(function_, undefined);
    if (function_ === undefined) throw new Error("agent HIR has no function");
    const blocks = hir.functions.flatMap((candidate) => candidate.blocks);
    const hasConditional = blocks.some((block) =>
      block.terminator.kind === "conditional"
    );
    const hasBackEdge = blocks.some((block) => {
      if (block.terminator.kind !== "branch") return false;
      return block.terminator.target <= block.id;
    });
    const hasDirectRecursion = hir.functions.some((candidate) =>
      candidate.blocks.some((block) =>
        block.operations.some((operation) =>
          operation.kind === "call.direct" &&
          operation.function === candidate.id
        )
      )
    );
    assert.equal(hasConditional, true);
    assert.equal(hasBackEdge || hasDirectRecursion, true);

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

test("owned radix sorts preserve signed order and stable equal-key order", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(
      resolve("examples/lib/owned_radix_sorts.blot"),
    );
    const manifest = decodeManifest(artifact.manifestBytes);
    assert.deepEqual(manifest.imports, []);
    const instantiated = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm),
      {},
    );
    for (
      const [name, expected] of [
        ["first", -9223372036854775808n],
        ["last", 9223372036854775807n],
        ["stable_ids", 20401030n],
      ] as const
    ) {
      const exported = requiredRuntimeExport(manifest, name);
      assert.deepEqual(exported.function.parameters, [
        { kind: "signed-integer-64" },
      ]);
      assert.equal(exported.function.result.kind, "signed-integer-64");
      if (exported.name === null) {
        throw new Error(`runtime export ${name} has no Wasm name`);
      }
      assert.equal(
        exportedFunction(instantiated.instance, exported.name)(-1n),
        expected,
      );
    }
  } finally {
    compiler.destroy();
  }
});

test("owned merge sort preserves equal-key order in emitted Wasm", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(
      resolve("examples/lib/owned_merge_sort.blot"),
    );
    const manifest = decodeManifest(artifact.manifestBytes);
    assert.deepEqual(manifest.imports, []);
    const exported = requiredRuntimeExport(manifest, "stable_ids");
    assert.deepEqual(exported.function, {
      parameters: [{ kind: "signed-integer-64" }],
      result: { kind: "signed-integer-64" },
    });
    if (exported.name === null) {
      throw new Error("runtime export stable_ids has no Wasm name");
    }
    const instantiated = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm),
      {},
    );
    assert.equal(
      exportedFunction(instantiated.instance, exported.name)(-1n),
      20401030n,
    );
    const emptyLength = requiredRuntimeExport(manifest, "empty_length");
    if (emptyLength.name === null) {
      throw new Error("runtime export empty_length has no Wasm name");
    }
    assert.equal(
      exportedFunction(instantiated.instance, emptyLength.name)(32n),
      0n,
    );
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
): (...arguments_: readonly (bigint | number)[]) => unknown {
  const exported = instance.exports[name];
  if (typeof exported !== "function") {
    throw new Error(`missing WebAssembly function export ${name}`);
  }
  return exported as (...arguments_: readonly (bigint | number)[]) => unknown;
}

function exportedMemory(instance: WebAssembly.Instance): WebAssembly.Memory {
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error("missing WebAssembly memory export");
  }
  return memory;
}
