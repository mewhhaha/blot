import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BlotError } from "../diagnostic.ts";
import { runtimeHirSchema } from "./protocol.ts";
import { CompilerTargetRefusal } from "./policy.ts";
import { Compiler } from "./session.ts";
import { CompilerWasm } from "./wasm.ts";

test("Rust compiler host exposes check, prepare, compile", async () => {
  const compiler = await Compiler.create();
  try {
    const checked = await compiler.check("examples/minimal.blot");
    assert.equal(checked.type, "42");

    const runtime = await compiler.prepare("examples/minimal.blot");
    assert.equal(runtime.schemaVersion, runtimeHirSchema);

    const artifact = await compiler.compile("examples/minimal.blot");
    const wasm = Uint8Array.from(artifact.wasm).buffer;
    assert.equal(WebAssembly.validate(wasm), true);
    assert.equal(artifact.artifactSource, "compiled");
  } finally {
    compiler.destroy();
  }
});

test("inferred multi-subject Boolean matrix rejects its missing combination", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      compiler.checkSource(
        join(tmpdir(), "blot-inferred-incomplete-matrix.blot"),
        'open import "blot:prelude"\n' +
          "let choose = fn (first, second) => case first, second of\n" +
          "  #True, _ => 1\n" +
          "  _, #True => 2\n" +
          "return choose\n",
      ),
      (error: unknown) => {
        assert(error instanceof BlotError);
        assert.match(error.diagnostic.message, /do not cover every value/);
        return true;
      },
    );
  } finally {
    compiler.destroy();
  }
});

test("typed multi-subject Boolean matrix rejects its missing combination", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      compiler.checkSource(
        join(tmpdir(), "blot-typed-incomplete-matrix.blot"),
        'open import "blot:prelude"\n' +
          "let choose :: (Bool, Bool) -> Int\n" +
          "let choose = fn (first, second) => case first, second of\n" +
          "  #True, _ => 1\n" +
          "  _, #True => 2\n" +
          "return choose (False, False)\n",
      ),
      (error: unknown) => {
        assert(error instanceof BlotError);
        assert.match(error.diagnostic.message, /do not cover every value/);
        return true;
      },
    );
  } finally {
    compiler.destroy();
  }
});

test("present optional integer arm returns its bound runtime value", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(
      "examples/dynamic_optional_field.blot",
    );
    const instantiated = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm) as BufferSource,
    );
    const dynamicOffset = instantiated.instance.exports[
      "blot:dynamic_offset"
    ];
    assert.equal(typeof dynamicOffset, "function");
    if (typeof dynamicOffset !== "function") {
      throw new Error(
        "dynamic optional field artifact omitted blot:dynamic_offset",
      );
    }
    assert.equal((dynamicOffset as (offset: bigint) => bigint)(41n), 42n);
  } finally {
    compiler.destroy();
  }
});

test("nested runtime closure preserves its unit argument", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(
      "examples/residual_unit_closure.blot",
    );
    const instantiated = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm) as BufferSource,
    );
    const capturedUnit = instantiated.instance.exports["blot:captured_unit"];
    assert.equal(typeof capturedUnit, "function");
    if (typeof capturedUnit !== "function") {
      throw new Error("residual closure artifact omitted blot:captured_unit");
    }
    assert.equal((capturedUnit as (value: bigint) => bigint)(41n), 41n);
  } finally {
    compiler.destroy();
  }
});

test("nested runtime closure accepts a representation-free empty array", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(
      "examples/residual_empty_array_closure.blot",
    );
    const instantiated = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm) as BufferSource,
    );
    const capturedEmptyChildren =
      instantiated.instance.exports["blot:captured_empty_children"];
    assert.equal(typeof capturedEmptyChildren, "function");
    if (typeof capturedEmptyChildren !== "function") {
      throw new Error(
        "residual closure artifact omitted blot:captured_empty_children",
      );
    }
    assert.equal(
      (capturedEmptyChildren as (value: bigint) => bigint)(42n),
      42n,
    );
  } finally {
    compiler.destroy();
  }
});

test("runtime fold residualizes a recursive step with a concrete argument", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(
      "examples/residual_runtime_fold_projection.blot",
    );
    const instantiated = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm) as BufferSource,
    );
    const foldedProjectValue =
      instantiated.instance.exports["blot:folded_project_value"];
    assert.equal(typeof foldedProjectValue, "function");
    if (typeof foldedProjectValue !== "function") {
      throw new Error(
        "runtime fold artifact omitted blot:folded_project_value",
      );
    }
    assert.equal((foldedProjectValue as (value: bigint) => bigint)(41n), 12n);
  } finally {
    compiler.destroy();
  }
});

test("static Boolean argument crosses residual iteration", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(
      "examples/lib/residual_boolean_argument.blot",
    );
    const observations: Array<readonly [bigint, number]> = [];
    const instantiated = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm) as BufferSource,
      {
        "blot:host/Host": {
          observe(value: bigint, done: number) {
            observations.push([value, done]);
          },
          value() {
            return 41n;
          },
        },
      },
    );
    const run = instantiated.instance.exports["blot:default"];
    assert.equal(typeof run, "function");
    if (typeof run !== "function") {
      throw new Error("residual Boolean artifact omitted blot:default");
    }

    run();

    assert.deepEqual(observations, [[41n, 0]]);
  } finally {
    compiler.destroy();
  }
});

test("failed discovery keeps candidates out of semantic and artifact state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-inspection-isolation-"));
  const path = join(directory, "main.blot");
  const candidate = join(directory, "candidate.blot");
  await writeFile(path, "return 1\n");
  await writeFile(candidate, "return 2\n");
  const compiler = await Compiler.create();
  try {
    await compiler.analyze(path);
    const stable = await compiler.analyze(path);
    const compiled = await compiler.compile(path);
    assert.equal(compiled.artifactSource, "compiled");
    const developmentRequest = {
      entryPath: path,
      entryUnit: "game",
      units: new Map([["game", path]]),
    };
    const development = await compiler.compileDevelopment(developmentRequest);
    const developmentUnit = development.units[0];
    if (developmentUnit === undefined) {
      throw new Error(`development compilation omitted ${path}`);
    }
    assert.equal(developmentUnit.artifactSource, "compiled");

    await assert.rejects(
      compiler.setOverlay(
        path,
        'const candidate = import "./candidate.blot"\n' +
          'const missing = import "./missing.blot"\n' +
          "return (candidate, missing)\n",
      ),
      /missing\.blot/,
    );

    const afterFailure = await compiler.analyze(path);
    assert.equal(afterFailure.type, "1");
    assert.deepEqual(afterFailure.invalidation, stable.invalidation);

    const repeated = await compiler.compile(path);
    assert.equal(repeated.artifactSource, "revision-cache");
    assert.deepEqual(repeated.wasm, compiled.wasm);
    assert.deepEqual(repeated.manifestBytes, compiled.manifestBytes);

    const repeatedDevelopment = await compiler.compileDevelopment(
      developmentRequest,
    );
    const repeatedUnit = repeatedDevelopment.units[0];
    if (repeatedUnit === undefined) {
      throw new Error(`repeated development compilation omitted ${path}`);
    }
    assert.equal(repeatedUnit.artifactSource, "unit-cache");
    assert.equal("wasm" in repeatedUnit, false);
    assert.equal("manifestBytes" in repeatedUnit, false);
    assert.equal(
      repeatedUnit.implementationDigest,
      developmentUnit.implementationDigest,
    );
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});

test("failed discovery removes candidate inspection modules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-inspection-rollback-"));
  const path = join(directory, "main.blot");
  await writeFile(
    path,
    'const missing = import "./missing.blot"\nreturn missing\n',
  );
  const added: Array<{ readonly handle: number; readonly path: string }> = [];
  const removed: Array<{ readonly handle: number; readonly path: string }> = [];
  const addModule = CompilerWasm.prototype.addCompilerSessionModule;
  const removeModule = CompilerWasm.prototype.removeCompilerSessionModule;
  CompilerWasm.prototype.addCompilerSessionModule = function (
    handle,
    modulePath,
    source,
  ) {
    added.push({ handle, path: modulePath });
    return addModule.call(this, handle, modulePath, source);
  };
  CompilerWasm.prototype.removeCompilerSessionModule = function (
    handle,
    modulePath,
  ) {
    removed.push({ handle, path: modulePath });
    return removeModule.call(this, handle, modulePath);
  };
  let compiler: Compiler | undefined;
  try {
    compiler = await Compiler.create();
    await assert.rejects(compiler.check(path), /missing\.blot/);

    const candidate = added.find((entry) => entry.path === path);
    assert.notEqual(candidate, undefined);
    assert.deepEqual(
      removed.filter((entry) => entry.path === path),
      [candidate],
    );
  } finally {
    compiler?.destroy();
    CompilerWasm.prototype.addCompilerSessionModule = addModule;
    CompilerWasm.prototype.removeCompilerSessionModule = removeModule;
    await rm(directory, { recursive: true });
  }
});

test("development cache hits expose identities without sharing caller arrays", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-development-cache-"));
  const path = join(directory, "main.blot");
  await writeFile(
    path,
    `open import "blot:prelude"
const Source = @effect.host { .value = Unit -> Int; }
use value <- Source.value ()
return value
`,
  );
  const compiler = await Compiler.create();
  try {
    const request = {
      entryPath: path,
      entryUnit: "game",
      units: new Map([["game", path]]),
    };
    const initial = await compiler.compileDevelopment(request);
    const initialUnit = initial.units[0];
    if (initialUnit === undefined) {
      throw new Error(`development compilation omitted ${path}`);
    }
    assert.equal(initialUnit.artifactSource, "compiled");
    if (initialUnit.artifactSource !== "compiled") {
      throw new Error("initial development compilation reused an artifact");
    }
    const implementationDigest = initialUnit.implementationDigest;
    const interfaceDigest = initialUnit.interfaceDigest;
    const wasmDigest = initialUnit.wasmDigest;
    const capabilities = initialUnit.capabilities.slice();
    initialUnit.wasm.fill(0);
    initialUnit.manifestBytes.fill(0);
    Reflect.set(initialUnit.capabilities, 0, "poisoned");

    const repeated = await compiler.compileDevelopment(request);
    const repeatedUnit = repeated.units[0];
    if (repeatedUnit === undefined) {
      throw new Error(`repeated development compilation omitted ${path}`);
    }
    assert.equal(repeatedUnit.artifactSource, "unit-cache");
    assert.equal("wasm" in repeatedUnit, false);
    assert.equal("manifestBytes" in repeatedUnit, false);
    assert.deepEqual(repeatedUnit.capabilities, capabilities);
    assert.equal(repeatedUnit.interfaceDigest, interfaceDigest);
    assert.equal(repeatedUnit.implementationDigest, implementationDigest);
    assert.equal(repeatedUnit.wasmDigest, wasmDigest);
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});

test("development artifact caches stay isolated by program root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-development-roots-"));
  const firstPath = join(directory, "first.blot");
  const secondPath = join(directory, "second.blot");
  await writeFile(firstPath, "return 1\n");
  await writeFile(secondPath, "return 2\n");
  const compiler = await Compiler.create();
  try {
    const firstRequest = {
      entryPath: firstPath,
      entryUnit: "game",
      units: new Map([["game", firstPath]]),
    };
    const first = await compiler.compileDevelopment(firstRequest);
    await compiler.compileDevelopment({
      entryPath: secondPath,
      entryUnit: "game",
      units: new Map([["game", secondPath]]),
    });
    const repeated = await compiler.compileDevelopment(firstRequest);
    const firstUnit = first.units[0];
    const repeatedUnit = repeated.units[0];
    if (firstUnit === undefined || repeatedUnit === undefined) {
      throw new Error("development compilation omitted the first program");
    }

    assert.equal(repeatedUnit.artifactSource, "unit-cache");
    assert.equal("wasm" in repeatedUnit, false);
    assert.equal("manifestBytes" in repeatedUnit, false);
    assert.equal(repeatedUnit.wasmDigest, firstUnit.wasmDigest);
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});

test("an abandoned low-level preparation recompiles before cache commit", async () => {
  const rust = await CompilerWasm.load(
    await readFile("generated/compiler/compiler.wasm"),
  );
  const handle = rust.createCompilerSession();
  const path = "transaction-retry.blot";
  try {
    rust.installCompilerSessionTrustedModuleSnapshot(
      handle,
      "snapshot:prelude",
      await readFile("generated/compiler/prelude.snapshot"),
    );
    const added = rust.addCompilerSessionModule(handle, path, "return 1\n");
    assert.equal(added.ok, true);
    rust.configureCompilerSessionModule(handle, path, {
      imports: {},
      includes: {},
    });
    const units = new Map([["game", path]]);
    const abandoned = rust.compileCompilerSessionDevelopmentProgram(
      handle,
      path,
      "game",
      units,
    );
    const retry = rust.compileCompilerSessionDevelopmentProgram(
      handle,
      path,
      "game",
      units,
    );
    if (!abandoned.ok || !retry.ok) {
      throw new Error("low-level development preparation failed");
    }
    assert.deepEqual(
      abandoned.units.map((unit) => unit.artifactSource),
      ["compiled"],
    );
    assert.deepEqual(
      retry.units.map((unit) => unit.artifactSource),
      ["compiled"],
    );
    assert.throws(
      () =>
        rust.commitCompilerSessionDevelopmentProgram(
          handle,
          abandoned.transactionId,
        ),
      /rejected development transaction/,
    );
    rust.commitCompilerSessionDevelopmentProgram(handle, retry.transactionId);

    const committed = rust.compileCompilerSessionDevelopmentProgram(
      handle,
      path,
      "game",
      units,
    );
    if (!committed.ok) {
      throw new Error("committed low-level development preparation failed");
    }
    assert.deepEqual(
      committed.units.map((unit) => unit.artifactSource),
      ["unit-cache"],
    );
    rust.commitCompilerSessionDevelopmentProgram(
      handle,
      committed.transactionId,
    );
  } finally {
    rust.destroyCompilerSession(handle);
  }
});

test("host effect ownership reaches Runtime HIR and Core Wasm ABI 2", async () => {
  const compiler = await Compiler.create();
  try {
    const runtime = await compiler.prepare(
      "examples/lib/host_owned_handle.blot",
    );
    assert.deepEqual(
      runtime.capabilities.map((capability) => ({
        name: capability.name,
        operations: capability.operations.map((operation) => ({
          name: operation.name,
          ownership: operation.ownership,
        })),
      })),
      [{
        name: "Jobs",
        operations: [
          {
            name: "acquire",
            ownership: { input: "unrestricted", result: "linear" },
          },
          {
            name: "release",
            ownership: { input: "linear", result: "unrestricted" },
          },
        ],
      }],
    );

    const artifact = await compiler.compile(
      "examples/lib/host_owned_handle.blot",
    );
    const manifest = JSON.parse(
      new TextDecoder().decode(artifact.manifestBytes),
    );
    assert.equal(manifest.abi.major, 2);
    assert.deepEqual(
      manifest.imports.map((imported: { ownership: unknown }) =>
        imported.ownership
      ),
      [
        { input: "unrestricted", result: "linear" },
        { input: "linear", result: "unrestricted" },
      ],
    );

    const module = await WebAssembly.compile(
      Uint8Array.from(artifact.wasm) as BufferSource,
    );
    const abiSections = WebAssembly.Module.customSections(module, "blot:abi");
    assert.equal(abiSections.length, 1);
    assert.deepEqual(
      new Uint8Array(abiSections[0]),
      artifact.manifestBytes,
    );
    let released: bigint | undefined;
    const instance = await WebAssembly.instantiate(module, {
      "blot:host/Jobs": {
        acquire(value: bigint): bigint {
          return value;
        },
        release(value: bigint): void {
          released = value;
        },
      },
    });
    const abiMajor = instance.exports["blot:abi-major"];
    assert(abiMajor instanceof WebAssembly.Global);
    assert.equal(abiMajor.value, 2);
    const run = instance.exports["blot:default"];
    assert.equal(typeof run, "function");
    assert.equal((run as () => bigint)(), 42n);
    assert.equal(released, 41n);
  } finally {
    compiler.destroy();
  }
});

test("runtime SIMD arrays execute through private Store memory", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(
      "examples/lib/simd_store_runtime.blot",
    );
    const instantiated = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm) as BufferSource,
      {
        "blot:host/Source": {
          lane: () => 7n,
        },
      },
    );
    const run = instantiated.instance.exports["blot:default"];
    assert.equal(typeof run, "function");
    assert.equal((run as () => bigint)(), 7n);
  } finally {
    compiler.destroy();
  }
});

test("residual float and integer SIMD examples execute", async () => {
  const compiler = await Compiler.create();
  try {
    for (
      const [path, input, expected] of [
        ["examples/simd.blot", 1n, 3162n],
        ["examples/simd_integer.blot", 5n, 131327n],
      ] as const
    ) {
      const artifact = await compiler.compile(path);
      const instantiated = await WebAssembly.instantiate(
        Uint8Array.from(artifact.wasm) as BufferSource,
      );
      const run = instantiated.instance.exports["blot:default"];
      assert.equal(typeof run, "function");
      assert.equal((run as (input: bigint) => bigint)(input), expected);
    }
  } finally {
    compiler.destroy();
  }
});

test("unsupported lowering remains a target refusal after checking", async () => {
  const compiler = await Compiler.create();
  try {
    await compiler.check("examples/lib/region_vault.blot");
    await assert.rejects(
      compiler.compile("examples/lib/region_vault.blot"),
      (error: unknown) => {
        assert(error instanceof CompilerTargetRefusal);
        assert.equal(error.code, "BLOT_UNSUPPORTED_LOWERING");
        return true;
      },
    );
  } finally {
    compiler.destroy();
  }
});

test("Array builders and Map update helpers evaluate through the prelude", async () => {
  const compiler = await Compiler.create();
  try {
    const evaluated = await compiler.evaluate(
      "examples/lib/array_builder_and_map_updates.blot",
    );
    assert.equal(evaluated.display, "(3, #Some 11, #Some 20)");
  } finally {
    compiler.destroy();
  }
});

test("Shape.update preserves fields outside the updater's visible row", async () => {
  const compiler = await Compiler.create();
  try {
    const evaluated = await compiler.evaluate(
      "examples/lib/shape_update.blot",
    );
    assert.equal(evaluated.display, "3");
  } finally {
    compiler.destroy();
  }
});

test("Unicode-scalar Text operations agree in evaluation and emitted Wasm", async () => {
  const compiler = await Compiler.create();
  try {
    const evaluated = await compiler.evaluate(
      "examples/lib/text_processing_eval.blot",
    );
    assert.equal(
      evaluated.display,
      '("α,beta,γ", 3, #Some "α", #Some 2, "α,B,γ", #True, #True)',
    );

    const runtime = await compiler.prepare(
      "examples/lib/text_processing.blot",
    );
    const operations = runtime.functions.flatMap((function_) =>
      function_.blocks.flatMap((block) => block.operations)
    );
    assert.ok(
      operations.some((operation) => operation.kind === "text.length"),
    );
    assert.ok(
      operations.some((operation) => operation.kind === "text.find-from"),
    );
    assert.ok(operations.some((operation) => operation.kind === "text.slice"));

    const artifact = await compiler.compile(
      "examples/lib/text_processing.blot",
    );
    assert.equal(
      WebAssembly.validate(Uint8Array.from(artifact.wasm).buffer),
      true,
    );

    const scalarArtifact = await compiler.compile(
      "examples/lib/text_scalar_runtime.blot",
    );
    const instance = await WebAssembly.instantiate(
      Uint8Array.from(scalarArtifact.wasm) as BufferSource,
    );
    const memory = instance.instance.exports.memory as WebAssembly.Memory;
    const realloc = instance.instance.exports.cabi_realloc as (
      oldPointer: number,
      oldSize: number,
      alignment: number,
      newSize: number,
    ) => number;
    const run = instance.instance.exports["blot:default"] as (
      pointer: number,
      length: number,
    ) => bigint;
    const input = new TextEncoder().encode("🙂αβ");
    const pointer = realloc(0, 0, 1, input.byteLength);
    new Uint8Array(memory.buffer, pointer, input.byteLength).set(input);
    assert.equal(run(pointer, input.byteLength), 5n);
  } finally {
    compiler.destroy();
  }
});

test("reuse assertion tags publish only discharged Store updates", async () => {
  const compiler = await Compiler.create();
  try {
    const runtime = await compiler.prepare(
      "examples/lib/reuse_clear_first.blot",
    );
    assert.equal(runtime.functions[0]?.reuse, "checked");

    const quicksort = await compiler.prepare(
      "examples/lib/reuse_quicksort.blot",
    );
    const writingFunctions = quicksort.functions.filter((function_) =>
      function_.blocks.some((block) =>
        block.operations.some((operation) => operation.kind === "store.write")
      )
    );
    assert.ok(writingFunctions.length >= 1);
    for (const function_ of writingFunctions) {
      assert.equal(function_.reuse, "checked");
      for (
        const operation of function_.blocks.flatMap((block) => block.operations)
      ) {
        if (
          operation.kind === "store.write" || operation.kind === "store.grow"
        ) {
          assert.equal(operation.update, "owned-reuse");
        }
      }
    }
    const operations = quicksort.functions.flatMap((function_) =>
      function_.blocks.flatMap((block) => block.operations)
    );
    assert.ok(
      operations.some((operation) => operation.kind === "call.direct"),
      "runtime quicksort lost its direct recursive call",
    );
    assert.ok(
      quicksort.functions.some((function_) =>
        function_.blocks.some((block) =>
          block.terminator.kind === "branch" &&
          block.terminator.target === function_.entryBlock
        )
      ),
      "runtime quicksort lost its tail-recursive back-edge",
    );
    for (const operation of operations) {
      if (operation.kind === "store.write" || operation.kind === "store.grow") {
        assert.equal(operation.update, "owned-reuse");
      }
    }

    const artifact = await compiler.compile(
      "examples/lib/reuse_quicksort.blot",
    );
    const module = await WebAssembly.compile(
      Uint8Array.from(artifact.wasm) as BufferSource,
    );
    const importedFunctions = WebAssembly.Module.imports(module).map((entry) =>
      `${entry.module}.${entry.name}`
    );
    assert.deepEqual(importedFunctions, ["blot:host/Source.value"]);

    const instantiate = async (direction: bigint): Promise<() => bigint> => {
      const instance = await WebAssembly.instantiate(module, {
        "blot:host/Source": {
          value(input: bigint) {
            if (input === 0n) return 4n;
            return direction;
          },
        },
      });
      const run = instance.exports["blot:default"];
      assert.equal(typeof run, "function");
      return run as () => bigint;
    };
    assert.equal((await instantiate(1n))(), 204n);
    assert.equal((await instantiate(-1n))(), 120n);
  } finally {
    compiler.destroy();
  }
});

test("destroyed Rust compiler host refuses new work", async () => {
  const compiler = await Compiler.create();
  compiler.destroy();
  await assert.rejects(
    compiler.check("examples/minimal.blot"),
    /Compiler session has been destroyed/,
  );
});

test("canonical syntax snapshots expose parser bypass and node reuse", async () => {
  const compiler = await Compiler.create();
  const path = join(tmpdir(), "blot-canonical-syntax-snapshot.blot");
  const source = "const first = 1\nconst second = 2\nreturn first\n";
  try {
    const initial = await compiler.syntaxSnapshot(path, source);
    assert.equal(initial.parserExecuted, true);
    assert.equal(initial.cst.name, "program");

    const unchanged = await compiler.syntaxSnapshot(path, source);
    assert.equal(unchanged.parserExecuted, false);
    assert.equal(unchanged.portableAstDigest, initial.portableAstDigest);
    assert.ok(unchanged.reuse.length > 0);

    const edited = await compiler.syntaxSnapshot(
      path,
      source.replace("second = 2", "second = 3 + 4"),
    );
    assert.equal(edited.parserExecuted, true);
    assert.ok(edited.reuse.length > 0);
  } finally {
    compiler.destroy();
  }
});

test("releasing a workspace root removes its resident semantic revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-release-root-"));
  const path = join(directory, "root.blot");
  const compiler = await Compiler.create();
  try {
    await writeFile(path, "return 1\n");
    assert.notEqual((await compiler.analyze(path)).work, null);
    assert.equal((await compiler.analyze(path)).work, null);

    await compiler.releaseRoot(path);

    assert.notEqual((await compiler.analyze(path)).work, null);
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "resident checker reuses a closed nullary leaf across root edits",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "blot-resident-leaf-"));
    const library = join(directory, "library.blot");
    const root = join(directory, "root.blot");
    const source = (x: number, other: string, value: number): string =>
      `const api = import "./library.blot"\n` +
      `return api.project { .x = ${x}; .${other} = ${value}; }\n`;
    const compiler = await Compiler.create();
    try {
      await writeFile(
        library,
        "const project = fn value => value.x\nreturn { .project = project; }\n",
      );
      await writeFile(root, source(1, "y", 2));
      assert.equal((await compiler.check(root)).type, "1");

      await writeFile(root, source(3, "z", 4));
      assert.equal((await compiler.check(root)).type, "3");

      await writeFile(
        library,
        "const project = fn value => value.z\nreturn { .project = project; }\n",
      );
      assert.equal((await compiler.check(root)).type, "4");
    } finally {
      compiler.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "resident checker never reuses a parameterized leaf check",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "blot-resident-param-"));
    const library = join(directory, "library.blot");
    const root = join(directory, "root.blot");
    const compiler = await Compiler.create();
    try {
      await writeFile(
        library,
        "module with input\nlet hidden = input.base\nreturn { .answer = 42; }\n",
      );
      await writeFile(
        root,
        'const library = import "./library.blot" with { .base = 1; }\n' +
          "return library.answer\n",
      );
      assert.equal((await compiler.check(root)).type, "42");

      await writeFile(
        root,
        'const library = import "./library.blot" with { .name = 1; }\n' +
          "return library.answer\n",
      );
      await assert.rejects(
        compiler.check(root),
        /does not flow into \{ \.base = ⊤ \}/,
      );
    } finally {
      compiler.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
