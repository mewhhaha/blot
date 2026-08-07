import {
  assertEquals,
  assertNotStrictEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { apply, evaluationRuntime, run } from "../comptime/eval.ts";
import type { Value } from "../comptime/value.ts";
import { checkFile } from "../check/mod.ts";
import { BlotError } from "../diagnostic.ts";
import { evaluateFile } from "../run.ts";
import { Compiler } from "../compiler.ts";
import { prepareGpupaperHir } from "./compile.ts";
import { buildTypeScriptOracleBatch } from "./gpupaper.ts";
import { type BlotAbiManifest, buildBlotAbiManifest } from "./runtime/abi.ts";
import { decodeBlotAbiResult } from "./runtime/abi_decode.ts";
import {
  type BlotRuntimeModule,
  validateBlotRuntimeModule,
} from "./runtime/hir.ts";
import { compileBlotRuntimeModulesOnRustWasm } from "./runtime/target.ts";
import { prepareRustGpupaperHir, RustMiddleCompiler } from "./rust_middle.ts";

Deno.test("compiler is available from the public API", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile("examples/minimal.blot");
    assertEquals([...artifact.wasm.slice(0, 4)], [0, 97, 115, 109]);
  } finally {
    compiler.destroy();
  }
});

Deno.test("compiler check omits an empty effect row", async () => {
  const compiler = await Compiler.create();
  try {
    const checked = await compiler.check("examples/minimal.blot");
    assertEquals(checked.effects, "");
  } finally {
    compiler.destroy();
  }
});

Deno.test("Rust HIR matches the bounded TypeScript ABI oracle", async () => {
  const rust = validateBlotRuntimeModule(
    await prepareRustGpupaperHir("examples/minimal.blot"),
  );
  const typescript = validateBlotRuntimeModule(
    await prepareGpupaperHir("examples/minimal.blot"),
  );
  assertEquals(
    buildBlotAbiManifest(rust),
    buildBlotAbiManifest(typescript),
  );
});

Deno.test("full Rust checker preserves explicit Rank-N subsumption", async () => {
  const compiler = await RustMiddleCompiler.create();
  try {
    const checked = await compiler.check("examples/rank_n.blot");
    assertEquals(checked.type, "{ .number = Int; .text = Str }");
    await assertRejects(
      () =>
        compiler.check(
          "examples/rejected/semantics/rank_n_monomorphic.blot",
        ),
      BlotError,
    );
  } finally {
    compiler.destroy();
  }
});

Deno.test("full Rust compiler emits a callable ABI-tagged module", async () => {
  const compiler = await RustMiddleCompiler.create();
  try {
    const artifact = await compiler.compile("examples/minimal.blot");
    const module = await WebAssembly.compile(
      Uint8Array.from(artifact.wasm).buffer,
    );
    const sections = WebAssembly.Module.customSections(module, "blot:abi");
    assertEquals(sections.length, 1);
    assertEquals(new Uint8Array(sections[0]), artifact.manifestBytes);
    const instance = await WebAssembly.instantiate(module);
    const exported = instance.exports["blot:default"];
    if (!(exported instanceof Function)) {
      throw new Error("full Rust compiler omitted blot:default");
    }
    assertEquals(exported(), 42n);

    const repeated = await compiler.compile("examples/minimal.blot");
    assertEquals(repeated.artifactSource, "revision-cache");
  } finally {
    compiler.destroy();
  }
});

Deno.test("full Rust compiler exports first-order recursive functions", async () => {
  const compiler = await RustMiddleCompiler.create();
  try {
    const path = "experiments/generated-code/programs/tail_recursion.blot";
    const hir = validateBlotRuntimeModule(await compiler.prepare(path));
    assertEquals(directSelfCalls(hir), []);

    const artifact = await compiler.compile(path);
    const instance = await WebAssembly.instantiate(
      await WebAssembly.compile(Uint8Array.from(artifact.wasm).buffer),
    );
    const sumTo = instance.exports["blot:sum_to"];
    if (!(sumTo instanceof Function)) {
      throw new Error("recursive function artifact omitted blot:sum_to");
    }
    assertEquals(sumTo(0n), 0n);
    assertEquals(sumTo(10n), 55n);
    assertEquals(sumTo(1_024n), 524_800n);
  } finally {
    compiler.destroy();
  }
});

Deno.test("recursive algebraic values use a private indirect representation", async () => {
  const compiler = await RustMiddleCompiler.create();
  try {
    const path = "experiments/generated-code/programs/recursive_list.blot";
    const hir = validateBlotRuntimeModule(await compiler.prepare(path));
    assertEquals(
      hir.types.filter((type) => type.kind === "indirect").length,
      1,
    );

    const artifact = await compiler.compile(path);
    const instance = await WebAssembly.instantiate(
      await WebAssembly.compile(Uint8Array.from(artifact.wasm).buffer),
    );
    const recursiveList = instance.exports["blot:recursive_list"];
    if (!(recursiveList instanceof Function)) {
      throw new Error("recursive list artifact omitted blot:recursive_list");
    }
    assertEquals(recursiveList(0n), 0n);
    assertEquals(recursiveList(10n), 55n);
    assertEquals(recursiveList(1_024n), 524_800n);
  } finally {
    compiler.destroy();
  }
});

Deno.test("mutually recursive algebraic values close one graph", async () => {
  const compiler = await RustMiddleCompiler.create();
  try {
    const path =
      "experiments/generated-code/programs/mutual_recursive_values.blot";
    const hir = validateBlotRuntimeModule(await compiler.prepare(path));
    assertEquals(
      hir.types.filter((type) => type.kind === "indirect").length,
      2,
    );

    const artifact = await compiler.compile(path);
    const instance = await WebAssembly.instantiate(
      await WebAssembly.compile(Uint8Array.from(artifact.wasm).buffer),
    );
    const total = instance.exports["blot:mutual_recursive_values"];
    if (!(total instanceof Function)) {
      throw new Error(
        "mutual recursive value artifact omitted blot:mutual_recursive_values",
      );
    }
    assertEquals(total(0n), 0n);
    assertEquals(total(10n), 55n);
    assertEquals(total(1_024n), 524_800n);
  } finally {
    compiler.destroy();
  }
});

Deno.test("structured Runtime HIR preserves a nonlinear trapping loop", async () => {
  const compiler = await RustMiddleCompiler.create();
  try {
    const path = "experiments/generated-code/programs/loop_mix.blot";
    const hir = validateBlotRuntimeModule(await compiler.prepare(path));
    assertEquals(directSelfCalls(hir), []);

    const artifact = await compiler.compile(path);
    const instance = await WebAssembly.instantiate(
      await WebAssembly.compile(Uint8Array.from(artifact.wasm).buffer),
    );
    const loopMix = instance.exports["blot:mix"];
    if (!(loopMix instanceof Function)) {
      throw new Error("nonlinear loop artifact omitted blot:mix");
    }
    assertEquals(loopMix(16n), 860_117_411n);
    assertEquals(loopMix(64n), 1_948_565_355n);
    assertEquals(loopMix(256n), 817_426_032n);
    assertEquals(loopMix(1_024n), 1_993_385_803n);
    assertThrows(
      () => loopMix(9_223_372_036_854_775_807n),
      WebAssembly.RuntimeError,
    );
  } finally {
    compiler.destroy();
  }
});

Deno.test("full Rust compiler exports dynamic surface iteration", async () => {
  const compiler = await RustMiddleCompiler.create();
  try {
    const path = "experiments/generated-code/programs/surface_iteration.blot";
    const hir = validateBlotRuntimeModule(await compiler.prepare(path));
    assertEquals(directSelfCalls(hir), []);

    const artifact = await compiler.compile(path);
    const instance = await WebAssembly.instantiate(
      await WebAssembly.compile(Uint8Array.from(artifact.wasm).buffer),
    );
    const sumTo = instance.exports["blot:sum_to"];
    if (!(sumTo instanceof Function)) {
      throw new Error("surface iteration artifact omitted blot:sum_to");
    }
    assertEquals(sumTo(0n), 0n);
    assertEquals(sumTo(10n), 45n);
    assertEquals(sumTo(1_024n), 523_776n);
  } finally {
    compiler.destroy();
  }
});

Deno.test("full Rust compiler preserves a surface loop Store accumulator", async () => {
  const compiler = await RustMiddleCompiler.create();
  try {
    const artifact = await compiler.compile(
      "experiments/generated-code/programs/surface_array_construction.blot",
    );
    const instance = await WebAssembly.instantiate(
      await WebAssembly.compile(Uint8Array.from(artifact.wasm).buffer),
    );
    const construct = instance.exports["blot:construct"];
    if (!(construct instanceof Function)) {
      throw new Error("surface Store artifact omitted blot:construct");
    }
    assertEquals(construct(0n), 0n);
    assertEquals(construct(10n), 10n);
    assertEquals(construct(1_024n), 1_024n);
  } finally {
    compiler.destroy();
  }
});

Deno.test("full Rust compiler passes runtime captures to recursive functions", async () => {
  const compiler = await RustMiddleCompiler.create();
  try {
    const artifact = await compiler.compile(
      "experiments/generated-code/programs/captured_recursion.blot",
    );
    const instance = await WebAssembly.instantiate(
      await WebAssembly.compile(Uint8Array.from(artifact.wasm).buffer),
    );
    const countTo = instance.exports["blot:count_to"];
    if (!(countTo instanceof Function)) {
      throw new Error("captured recursion artifact omitted blot:count_to");
    }
    assertEquals(countTo(0n), 0n);
    assertEquals(countTo(10n), 45n);
    assertEquals(countTo(1_024n), 523_776n);
  } finally {
    compiler.destroy();
  }
});

Deno.test("full Rust compiler residualizes staged float arrays and else-if chains", async () => {
  const compiler = await RustMiddleCompiler.create();
  try {
    const artifact = await compiler.compile(
      "experiments/generated-code/programs/staged_float_table.blot",
    );
    const instance = await WebAssembly.instantiate(
      await WebAssembly.compile(Uint8Array.from(artifact.wasm).buffer),
    );
    const classify = instance.exports["blot:classify"];
    if (!(classify instanceof Function)) {
      throw new Error("staged float table artifact omitted blot:classify");
    }
    assertEquals(classify(0n), 10n);
    assertEquals(classify(1n), 21n);
    assertEquals(classify(2n), -30n);
    assertEquals(classify(9n), 0n);
  } finally {
    compiler.destroy();
  }
});

Deno.test("full Rust compiler preserves retained Store versions", async () => {
  const compiler = await RustMiddleCompiler.create();
  try {
    const artifact = await compiler.compile(
      "experiments/generated-code/programs/retained_updates.blot",
    );
    const instance = await WebAssembly.instantiate(
      await WebAssembly.compile(Uint8Array.from(artifact.wasm).buffer),
    );
    const retainedUpdates = instance.exports["blot:retained_updates"];
    if (!(retainedUpdates instanceof Function)) {
      throw new Error(
        "retained Store artifact omitted blot:retained_updates",
      );
    }
    assertEquals(retainedUpdates(1n), 0n);
    assertEquals(retainedUpdates(10n), 45n);
    assertEquals(retainedUpdates(64n), 2_016n);
  } finally {
    compiler.destroy();
  }
});

Deno.test("affine arena growth carries reuse permission and preserves traversal", async () => {
  const compiler = await RustMiddleCompiler.create();
  try {
    const path = "experiments/generated-code/programs/arena_list.blot";
    const hir = validateBlotRuntimeModule(await compiler.prepare(path));
    const updates = hir.functions.flatMap((fn) =>
      fn.blocks.flatMap((block) =>
        block.operations.flatMap((operation) =>
          operation.kind === "store.grow" ? [operation.update] : []
        )
      )
    ).sort();
    assertEquals(updates, ["owned-reuse", "persistent"]);
    assertEquals(directSelfCalls(hir), []);

    const artifact = await compiler.compile(path);
    const instance = await WebAssembly.instantiate(
      await WebAssembly.compile(Uint8Array.from(artifact.wasm).buffer),
    );
    const arenaList = instance.exports["blot:arena_list"];
    if (!(arenaList instanceof Function)) {
      throw new Error("arena list artifact omitted blot:arena_list");
    }
    assertEquals(arenaList(0n), 0n);
    assertEquals(arenaList(10n), 55n);
    assertEquals(arenaList(1_024n), 524_800n);
  } finally {
    compiler.destroy();
  }
});

Deno.test("total arena lookup guards the certified Store read", async () => {
  const compiler = await RustMiddleCompiler.create();
  const directory = await Deno.makeTempDir();
  const path = join(directory, "arena-lookup.blot");
  try {
    await Deno.writeTextFile(
      path,
      `open @import "blot:prelude" ()
sig lookup = Int -> Int
const lookup = fn address =>
  let values = [41]
  return case Arena.get ((&values), address) of
    #Some value => value
    #None => 0 - 1
return { .lookup = lookup; }
`,
    );
    const artifact = await compiler.compile(path);
    const instance = await WebAssembly.instantiate(
      await WebAssembly.compile(Uint8Array.from(artifact.wasm).buffer),
    );
    const lookup = instance.exports["blot:lookup"];
    if (!(lookup instanceof Function)) {
      throw new Error("arena lookup artifact omitted blot:lookup");
    }
    assertEquals(lookup(-1n), -1n);
    assertEquals(lookup(0n), 41n);
    assertEquals(lookup(1n), -1n);
  } finally {
    compiler.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("full Rust compiler preserves canonical variant names", async () => {
  const compiler = await RustMiddleCompiler.create();
  try {
    const artifact = await compiler.compile("examples/storage.blot");
    const manifest = JSON.parse(
      new TextDecoder().decode(artifact.manifestBytes),
    ) as BlotAbiManifest;
    const exportName = "blot:mode_at";
    const exported = manifest.exports.find((candidate) =>
      candidate.name === exportName
    );
    if (exported?.function === null || exported === undefined) {
      throw new Error("storage manifest omitted blot:mode_at");
    }
    const instance = await WebAssembly.instantiate(
      await WebAssembly.compile(Uint8Array.from(artifact.wasm).buffer),
    );
    const modeAt = instance.exports[exportName];
    if (!(modeAt instanceof Function)) {
      throw new Error("storage module omitted blot:mode_at");
    }
    const actual = decodeBlotAbiResult(
      exported.function.result,
      modeAt(),
      instance.exports.memory,
    );
    assertEquals(actual, { case: "Some", payload: 16n });
  } finally {
    compiler.destroy();
  }
});

Deno.test("full Rust compiler residualizes a text-returning host effect", async () => {
  const compiler = await RustMiddleCompiler.create();
  try {
    const artifact = await compiler.compile("case-studies/terminal/main.blot");
    for (
      const [input, expected] of [
        ["", ["What is your name?", "Hello, stranger."]],
        ["Ada", ["What is your name?", "Hello, Ada"]],
        ["Żółw 🦀", ["What is your name?", "Hello, Żółw 🦀"]],
      ] as const
    ) {
      assertEquals(await runTerminal(artifact.wasm, input), expected);
    }
    await assertRejects(
      () => runTerminalBytes(artifact.wasm, new Uint8Array([0xc0, 0xaf])),
      WebAssembly.RuntimeError,
    );
  } finally {
    compiler.destroy();
  }
});

Deno.test("generated host traces agree between the evaluator and emitted Wasm", async () => {
  const compiler = await RustMiddleCompiler.create();
  const directory = await Deno.makeTempDir();
  const path = join(directory, "generated-host-trace.blot");
  try {
    let seed = 0x7aace;
    const messages: string[] = [];
    for (let index = 0; index < 24; index += 1) {
      seed = generatedTraceSeed(seed);
      messages.push(`event-${index}-${seed % 1000}`);
    }
    await Deno.writeTextFile(
      path,
      `open @import "blot:prelude" ()
const Console = @effect.host { .write = Str -> Unit; }
${messages.map((message) => `_ <- Console.write "${message}"`).join("\n")}
return ()
`,
    );

    const direct: string[] = [];
    await evaluateFile(path, { write: (message) => direct.push(message) });
    const artifact = await compiler.compile(path);
    assertEquals(await runConsoleWrites(artifact.wasm), direct);
    assertEquals(direct, messages);
  } finally {
    compiler.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("full Rust compiler matches dynamic record effects", async () => {
  const compiler = await RustMiddleCompiler.create();
  const directory = await Deno.makeTempDir();
  const path = join(directory, "record-effects.blot");
  try {
    await Deno.writeTextFile(
      path,
      `open @import "blot:prelude" ()
const Host = @effect.host {
  .read = Unit -> { .target = Int; .label = Str; .kind = Int; };
  .write = { .label = Str; .active = Bool; .kind = Int; } -> Unit;
  }
const ready = 1
event <- Host.read ()
_ <- case event.kind of
  #(ready) => Host.write {
    .label = event.label;
    .active = True;
    .kind = event.target + 1;
    }
  _ => Host.write { .label = "idle"; .active = False; .kind = 0; }
return ()
`,
    );
    const rust = await compiler.compile(path);
    const [reference] = await buildTypeScriptOracleBatch([path]);
    if (reference.status === "failed") throw reference.cause;

    const unicode = new TextEncoder().encode("Żółw 🦀");
    const expected = [{ active: true, kind: -41n, label: "Żółw 🦀" }];
    assertEquals(
      await runDynamicRecordEffect(reference.wasm, 1n, -42n, unicode),
      expected,
    );
    assertEquals(
      await runDynamicRecordEffect(rust.wasm, 1n, -42n, unicode),
      expected,
    );

    await assertRejects(
      () =>
        runDynamicRecordEffect(
          rust.wasm,
          1n,
          0n,
          new Uint8Array([0xc0, 0xaf]),
        ),
      WebAssembly.RuntimeError,
    );
    await assertRejects(
      () =>
        runDynamicRecordEffect(
          rust.wasm,
          1n,
          9_223_372_036_854_775_807n,
          unicode,
        ),
      WebAssembly.RuntimeError,
    );
  } finally {
    compiler.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Rust middle matches dynamic integer SIMD", async () => {
  const compiler = await RustMiddleCompiler.create();
  const directory = await Deno.makeTempDir();
  const path = join(directory, "integer-simd.blot");
  try {
    await Deno.writeTextFile(
      path,
      `open @import "blot:prelude" ()
const Sample = @effect.host { .next = Int -> Int; }
a <- Sample.next 0
b <- Sample.next 1
c <- Sample.next 2
d <- Sample.next 3
let values = Int32x4.of_wrapping (a, b, c, d)
let shifted = Int32x4.shift_left values 1
let bounded = Int32x4.max_signed shifted (Int32x4.splat_wrapping (@int.neg 12))
let negative = Int32x4.less_signed bounded (Int32x4.splat 0)
const selected = 2
return @int.add (Int32x4.mask_bits negative) (Int32x4.lane values selected)
`,
    );
    const rustModule = validateBlotRuntimeModule(await compiler.prepare(path));
    const rustBatch = await compileBlotRuntimeModulesOnRustWasm([rustModule], {
      target: "wasm-simd128",
    });
    const [reference] = await buildTypeScriptOracleBatch([path]);
    if (reference.status === "failed") throw reference.cause;

    for (const wasm of [reference.wasm, rustBatch.artifacts[0].wasm]) {
      const module = await WebAssembly.compile(Uint8Array.from(wasm).buffer);
      const lanes = [5n, 7n, -8n, 9n];
      const instance = await WebAssembly.instantiate(module, {
        "blot:host/Sample": {
          next(index: bigint) {
            const lane = lanes[Number(index)];
            if (lane === undefined) {
              throw new Error(`sample requested absent lane ${index}`);
            }
            return lane;
          },
        },
      });
      const run = instance.exports["blot:default"];
      if (!(run instanceof Function)) {
        throw new Error("integer SIMD module omitted blot:default");
      }
      assertEquals(run(), -4n);
    }
  } finally {
    compiler.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("full Rust compiler traps every dynamic integer overflow family", async () => {
  const compiler = await RustMiddleCompiler.create();
  const directory = await Deno.makeTempDir();
  const path = join(directory, "integer-overflow.blot");
  const maximum = 9_223_372_036_854_775_807n;
  const minimum = -9_223_372_036_854_775_808n;
  const scenarios = [
    { expression: "pair.left + pair.right", left: maximum, right: 1n },
    { expression: "pair.left - pair.right", left: minimum, right: 1n },
    { expression: "pair.left * pair.right", left: maximum, right: 2n },
    { expression: "pair.left / pair.right", left: minimum, right: -1n },
    { expression: "pair.left % pair.right", left: 1n, right: 0n },
    { expression: "@int.neg pair.left", left: minimum, right: 0n },
  ];
  try {
    for (const scenario of scenarios) {
      await Deno.writeTextFile(
        path,
        `open @import "blot:prelude" ()
const Host = @effect.host {
  .read = Unit -> { .left = Int; .right = Int; };
  .write = Int -> Unit;
}
pair <- Host.read ()
_ <- Host.write (${scenario.expression})
return ()
`,
      );
      const artifact = await compiler.compile(path);
      await assertRejects(
        () =>
          runDynamicIntegerEffect(
            artifact.wasm,
            scenario.left,
            scenario.right,
          ),
        WebAssembly.RuntimeError,
      );
    }
  } finally {
    compiler.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("generated checked integer traces agree with emitted Wasm", async () => {
  const compiler = await RustMiddleCompiler.create();
  const directory = await Deno.makeTempDir();
  const path = join(directory, "generated-integer-traces.blot");
  const scenarios = [
    { operation: "add", expression: "pair.left + pair.right" },
    { operation: "subtract", expression: "pair.left - pair.right" },
    { operation: "multiply", expression: "pair.left * pair.right" },
    { operation: "divide", expression: "pair.left / pair.right" },
    { operation: "remainder", expression: "pair.left % pair.right" },
    { operation: "negate", expression: "@int.neg pair.left" },
  ] as const;
  try {
    for (const scenario of scenarios) {
      await Deno.writeTextFile(
        path,
        `open @import "blot:prelude" ()
const Host = @effect.host {
  .read = Unit -> { .left = Int; .right = Int; };
  .write = Int -> Unit;
}
pair <- Host.read ()
_ <- Host.write (${scenario.expression})
return ()
`,
      );
      const artifact = await compiler.compile(path);
      const module = await WebAssembly.compile(
        Uint8Array.from(artifact.wasm).buffer,
      );
      let seed = 0x1a64c0de;
      for (let example = 0; example < 24; example += 1) {
        const generated = generatedIntegerOperands(seed, example);
        seed = generated.seed;
        const expected = checkedIntegerResult(
          scenario.operation,
          generated.left,
          generated.right,
        );
        if (expected === null) {
          await assertRejects(
            () =>
              runDynamicIntegerModule(
                module,
                generated.left,
                generated.right,
              ),
            WebAssembly.RuntimeError,
          );
          continue;
        }
        assertEquals(
          await runDynamicIntegerModule(
            module,
            generated.left,
            generated.right,
          ),
          expected,
        );
      }
    }
  } finally {
    compiler.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("generated recursive divergence agrees with emitted Wasm", async () => {
  const compiler = await RustMiddleCompiler.create();
  const directory = await Deno.makeTempDir();
  const path = join(directory, "generated-divergence.blot");
  const stops = [0n, 1n, -1n, 17n, -23n, 1_024n];
  const declarations = stops.flatMap((stop, index) => [
    `sig spin_${index} = Int -> Int`,
    `let spin_${index} = rec (fn value => if value == ${stop}: value else: spin_${index} value)`,
  ]);
  const exports = stops.map((_, index) => `.spin_${index} = spin_${index};`);
  try {
    await Deno.writeTextFile(
      path,
      `open @import "blot:prelude" ()
${declarations.join("\n")}
return {
  ${exports.join("\n  ")}
}
`,
    );
    const checked = await checkFile(path);
    const surface = await evaluateFile(path, { write() {} });
    if (surface.tag !== "shape") {
      throw new Error("generated divergence module did not return a record");
    }
    const artifact = await compiler.compile(path);
    const wasmModule = await WebAssembly.compile(
      Uint8Array.from(artifact.wasm).buffer,
    );

    for (const [index, stop] of stops.entries()) {
      const name = `spin_${index}`;
      const fn = surface.fields.get(name);
      if (fn === undefined) {
        throw new Error(`generated divergence module omitted ${name}`);
      }
      const returned = evaluateGeneratedFunction(fn, stop, checked);
      assertEquals(returned, { tag: "int", value: stop });

      const divergent = stop + 1n;
      try {
        evaluateGeneratedFunction(fn, divergent, checked);
        throw new Error(`${name} unexpectedly returned for ${divergent}`);
      } catch (error) {
        if (error instanceof BlotError) {
          assertEquals(error.diagnostic.code, "BLOT_EVALUATION_LIMIT");
        } else if (!(error instanceof RangeError)) {
          throw error;
        }
      }
      assertEquals(
        await classifyWasmCall(wasmModule, `blot:${name}`, divergent),
        "diverged",
      );
    }
  } finally {
    compiler.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Rust middle reuses an unchanged resident revision", async () => {
  const compiler = await RustMiddleCompiler.create();
  const directory = await Deno.makeTempDir();
  const path = join(directory, "resident.blot");
  try {
    await Deno.writeTextFile(
      path,
      `return 41
`,
    );
    const first = await compiler.prepare(path);
    const repeated = await compiler.prepare(path);
    assertStrictEquals(repeated, first);

    await Deno.writeTextFile(
      path,
      `return 42
`,
    );
    const edited = await compiler.prepare(path);
    assertNotStrictEquals(edited, first);
    const operation = edited.functions[0].blocks[0].operations[0];
    assertEquals(operation.kind, "constant");
    if (operation.kind === "constant") assertEquals(operation.value, 42n);
  } finally {
    compiler.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Rust middle invalidates an include revision", async () => {
  const compiler = await RustMiddleCompiler.create();
  const directory = await Deno.makeTempDir();
  const path = join(directory, "including.blot");
  const included = join(directory, "message.txt");
  try {
    await Deno.writeTextFile(
      path,
      `const message = @include "./message.txt" (fn source => source.text)
return message
`,
    );
    await Deno.writeTextFile(included, "first");
    const first = await compiler.prepare(path);

    await Deno.writeTextFile(included, "second");
    const edited = await compiler.prepare(path);
    assertNotStrictEquals(edited, first);
    const operation = edited.functions[0].blocks[0].operations[0];
    assertEquals(operation.kind, "constant");
    if (operation.kind === "constant") {
      assertEquals(operation.value, "second");
    }
  } finally {
    compiler.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Rust middle checks an in-memory root revision", async () => {
  const compiler = await RustMiddleCompiler.create();
  const directory = await Deno.makeTempDir();
  const path = join(directory, "editor.blot");
  try {
    await Deno.writeTextFile(
      path,
      `return missing
`,
    );
    const checked = await compiler.checkSource(
      path,
      `return 42
`,
    );
    assertEquals(checked.type, "42..42");
    await assertRejects(() => compiler.check(path), BlotError, "BLOT_UNBOUND");
  } finally {
    compiler.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Rust middle invalidates importers after a dependency edit", async () => {
  const compiler = await RustMiddleCompiler.create();
  const directory = await Deno.makeTempDir();
  const path = join(directory, "entry.blot");
  const dependency = join(directory, "dependency.blot");
  try {
    await Deno.writeTextFile(
      path,
      `open @import "./dependency.blot" ()
return value
`,
    );
    await Deno.writeTextFile(
      dependency,
      `return { .value = 41; }
`,
    );
    const first = await compiler.prepare(path);

    await Deno.writeTextFile(
      dependency,
      `return { .value = 42; }
`,
    );
    const edited = await compiler.prepare(path);
    assertNotStrictEquals(edited, first);
    const operation = edited.functions[0].blocks[0].operations[0];
    assertEquals(operation.kind, "constant");
    if (operation.kind === "constant") assertEquals(operation.value, 42n);
  } finally {
    compiler.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Rust middle reports source diagnostics with their origin", async () => {
  const compiler = await RustMiddleCompiler.create();
  const directory = await Deno.makeTempDir();
  const path = join(directory, "rejected.blot");
  try {
    await Deno.writeTextFile(
      path,
      `return @int.add "no" 1
`,
    );
    await assertRejects(
      () => compiler.compile(path),
      BlotError,
      "BLOT_TYPE_ERROR",
    );
  } finally {
    compiler.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Rust middle preserves a dependency diagnostic origin", async () => {
  const compiler = await RustMiddleCompiler.create();
  const directory = await Deno.makeTempDir();
  const path = join(directory, "entry.blot");
  const dependency = join(directory, "dependency.blot");
  try {
    await Deno.writeTextFile(
      path,
      `open @import "./dependency.blot" ()
return 0
`,
    );
    await Deno.writeTextFile(
      dependency,
      `return @int.add "no" 1
`,
    );
    try {
      await compiler.compile(path);
      throw new Error("Rust middle accepted an invalid dependency");
    } catch (error) {
      if (!(error instanceof BlotError)) throw error;
      assertEquals(error.diagnostic.code, "BLOT_TYPE_ERROR");
      assertEquals(error.origin?.path, dependency);
    }
  } finally {
    compiler.destroy();
    await Deno.remove(directory, { recursive: true });
  }
});

function directSelfCalls(module: BlotRuntimeModule) {
  return module.functions.flatMap((fn) =>
    fn.blocks.flatMap((block) =>
      block.operations.filter((operation) =>
        operation.kind === "call.direct" && operation.function === fn.id
      )
    )
  );
}

async function runTerminal(
  wasm: Uint8Array,
  input: string,
): Promise<readonly string[]> {
  return await runTerminalBytes(wasm, new TextEncoder().encode(input));
}

function generatedTraceSeed(seed: number): number {
  let value = seed;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

async function runConsoleWrites(wasm: Uint8Array): Promise<readonly string[]> {
  const writes: string[] = [];
  const module = await WebAssembly.compile(Uint8Array.from(wasm).buffer);
  const runtime: { instance?: WebAssembly.Instance } = {};
  const instance = await WebAssembly.instantiate(module, {
    "blot:host/Console": {
      write(pointer: number, length: number) {
        const memory = runtime.instance?.exports.memory;
        if (!(memory instanceof WebAssembly.Memory)) {
          throw new Error("console module omitted canonical memory");
        }
        writes.push(new TextDecoder("utf-8", { fatal: true }).decode(
          new Uint8Array(memory.buffer, pointer, length),
        ));
      },
    },
  });
  runtime.instance = instance;
  const run = instance.exports["blot:default"];
  if (!(run instanceof Function)) {
    throw new Error("console module omitted blot:default");
  }
  run();
  return writes;
}

async function runTerminalBytes(
  wasm: Uint8Array,
  input: Uint8Array,
): Promise<readonly string[]> {
  const writes: string[] = [];
  const module = await WebAssembly.compile(Uint8Array.from(wasm).buffer);
  const instance = await WebAssembly.instantiate(module, {
    "blot:host/Terminal": {
      write(pointer: number, length: number) {
        const memory = instance.exports.memory;
        if (!(memory instanceof WebAssembly.Memory)) {
          throw new Error("terminal module omitted canonical memory");
        }
        writes.push(new TextDecoder("utf-8", { fatal: true }).decode(
          new Uint8Array(memory.buffer, pointer, length),
        ));
      },
      read_line(resultPointer: number) {
        const memory = instance.exports.memory;
        const realloc = instance.exports.cabi_realloc;
        if (
          !(memory instanceof WebAssembly.Memory) ||
          !(realloc instanceof Function)
        ) {
          throw new Error("terminal module omitted its canonical ABI shell");
        }
        const pointer = realloc(0, 0, 1, input.length) as number;
        new Uint8Array(memory.buffer, pointer, input.length).set(input);
        const view = new DataView(memory.buffer);
        view.setUint32(resultPointer, pointer, true);
        view.setUint32(resultPointer + 4, input.length, true);
      },
    },
  });
  const run = instance.exports["blot:default"];
  if (!(run instanceof Function)) {
    throw new Error("terminal module omitted blot:default");
  }
  run();
  return writes;
}

async function runDynamicRecordEffect(
  wasm: Uint8Array,
  kind: bigint,
  target: bigint,
  label: Uint8Array,
): Promise<
  readonly {
    readonly active: boolean;
    readonly kind: bigint;
    readonly label: string;
  }[]
> {
  const writes: Array<{ active: boolean; kind: bigint; label: string }> = [];
  const module = await WebAssembly.compile(Uint8Array.from(wasm).buffer);
  const runtime: { instance?: WebAssembly.Instance } = {};
  const instance = await WebAssembly.instantiate(module, {
    "blot:host/Host": {
      read(resultPointer: number) {
        const memory = runtime.instance?.exports.memory;
        const realloc = runtime.instance?.exports.cabi_realloc;
        if (
          !(memory instanceof WebAssembly.Memory) ||
          !(realloc instanceof Function)
        ) {
          throw new Error("record module omitted its canonical ABI shell");
        }
        const labelPointer = realloc(0, 0, 1, label.length) as number;
        new Uint8Array(memory.buffer, labelPointer, label.length).set(label);
        const view = new DataView(memory.buffer);
        view.setBigInt64(resultPointer, kind, true);
        view.setUint32(resultPointer + 8, labelPointer, true);
        view.setUint32(resultPointer + 12, label.length, true);
        view.setBigInt64(resultPointer + 16, target, true);
      },
      write(
        active: number,
        writtenKind: bigint,
        pointer: number,
        length: number,
      ) {
        const memory = runtime.instance?.exports.memory;
        if (!(memory instanceof WebAssembly.Memory)) {
          throw new Error("record module omitted canonical memory");
        }
        const writtenLabel = new TextDecoder("utf-8", { fatal: true }).decode(
          new Uint8Array(memory.buffer, pointer, length),
        );
        writes.push({
          active: active !== 0,
          kind: writtenKind,
          label: writtenLabel,
        });
      },
    },
  });
  runtime.instance = instance;
  const run = instance.exports["blot:default"];
  if (!(run instanceof Function)) {
    throw new Error("record module omitted blot:default");
  }
  run();
  return writes;
}

async function runDynamicIntegerEffect(
  wasm: Uint8Array,
  left: bigint,
  right: bigint,
): Promise<bigint> {
  const module = await WebAssembly.compile(Uint8Array.from(wasm).buffer);
  return await runDynamicIntegerModule(module, left, right);
}

async function runDynamicIntegerModule(
  module: WebAssembly.Module,
  left: bigint,
  right: bigint,
): Promise<bigint> {
  let written: bigint | undefined;
  const instance = await WebAssembly.instantiate(module, {
    "blot:host/Host": {
      read(resultPointer: number) {
        const memory = instance.exports.memory;
        if (!(memory instanceof WebAssembly.Memory)) {
          throw new Error("integer module omitted canonical memory");
        }
        const view = new DataView(memory.buffer);
        view.setBigInt64(resultPointer, left, true);
        view.setBigInt64(resultPointer + 8, right, true);
      },
      write(value: bigint) {
        written = value;
      },
    },
  });
  const run = instance.exports["blot:default"];
  if (!(run instanceof Function)) {
    throw new Error("integer module omitted blot:default");
  }
  run();
  if (written === undefined) {
    throw new Error("integer module did not publish its result");
  }
  return written;
}

function generatedIntegerOperands(
  seed: number,
  ordinal: number,
): { readonly seed: number; readonly left: bigint; readonly right: bigint } {
  const boundary = [
    -(1n << 63n),
    -(1n << 63n) + 1n,
    -2n,
    -1n,
    0n,
    1n,
    2n,
    (1n << 63n) - 2n,
    (1n << 63n) - 1n,
  ];
  seed = generatedTraceSeed(seed);
  let left = BigInt.asIntN(64, BigInt(seed) << 32n);
  if (ordinal % 3 !== 0) left = boundary[seed % boundary.length]!;
  seed = generatedTraceSeed(seed);
  left = BigInt.asIntN(64, left | BigInt(seed));
  seed = generatedTraceSeed(seed);
  let right = BigInt.asIntN(64, BigInt(seed) << 32n);
  if (ordinal % 4 !== 0) right = boundary[seed % boundary.length]!;
  seed = generatedTraceSeed(seed);
  right = BigInt.asIntN(64, right | BigInt(seed));
  return { seed, left, right };
}

function checkedIntegerResult(
  operation:
    | "add"
    | "subtract"
    | "multiply"
    | "divide"
    | "remainder"
    | "negate",
  left: bigint,
  right: bigint,
): bigint | null {
  const minimum = -(1n << 63n);
  const maximum = (1n << 63n) - 1n;
  if ((operation === "divide" || operation === "remainder") && right === 0n) {
    return null;
  }
  if (operation === "divide" && left === minimum && right === -1n) {
    return null;
  }
  let result: bigint;
  if (operation === "add") result = left + right;
  else if (operation === "subtract") result = left - right;
  else if (operation === "multiply") result = left * right;
  else if (operation === "divide") result = left / right;
  else if (operation === "remainder") result = left % right;
  else result = -left;
  if (result < minimum || result > maximum) return null;
  return result;
}

function evaluateGeneratedFunction(
  fn: Value,
  argument: bigint,
  checked: Awaited<ReturnType<typeof checkFile>>,
): Value {
  return run(
    apply(
      fn,
      { tag: "int", value: argument },
      { start: 0, end: 0 },
      evaluationRuntime(
        new Map(),
        "runtime",
        undefined,
        checked.recordAdaptations,
      ),
    ),
  );
}

async function classifyWasmCall(
  module: WebAssembly.Module,
  exportName: string,
  argument: bigint,
): Promise<"diverged" | "returned" | "trapped"> {
  const workerSource = `
let instance;
self.onmessage = async (event) => {
  if (event.data.kind === "initialize") {
    instance = await WebAssembly.instantiate(event.data.module, {});
    self.postMessage({ kind: "ready" });
    return;
  }
  try {
    const exported = instance.exports[event.data.exportName];
    if (!(exported instanceof Function)) throw new Error("missing export");
    exported(BigInt(event.data.argument));
    self.postMessage({ kind: "returned" });
  } catch (_error) {
    self.postMessage({ kind: "trapped" });
  }
};
`;
  const sourceUrl = URL.createObjectURL(
    new Blob([workerSource], { type: "application/javascript" }),
  );
  const worker = new Worker(sourceUrl, { type: "module" });
  URL.revokeObjectURL(sourceUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (event) => {
        if (event.data?.kind === "ready") resolve();
      };
      worker.onerror = (event) => {
        event.preventDefault();
        reject(event.error);
      };
      worker.postMessage({ kind: "initialize", module });
    });
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => resolve("diverged"), 250);
      worker.onmessage = (event) => {
        clearTimeout(timeout);
        if (event.data?.kind === "returned") resolve("returned");
        else if (event.data?.kind === "trapped") resolve("trapped");
        else reject(new Error("divergence worker returned an unknown result"));
      };
      worker.onerror = (event) => {
        clearTimeout(timeout);
        event.preventDefault();
        reject(event.error);
      };
      worker.postMessage({
        kind: "call",
        exportName,
        argument: argument.toString(),
      });
    });
  } finally {
    worker.terminate();
  }
}
