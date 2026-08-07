import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { basename, dirname, fromFileUrl, join } from "@std/path";
import { evaluateFile } from "./src/run.ts";
import { show } from "./src/comptime/value.ts";
import {
  build,
  buildLoaded,
  buildSource,
  compile,
  type CompileArtifacts,
} from "./src/backend/build.ts";
import { callWasm } from "./src/backend/runner.ts";
import { CompiledProgram } from "./src/backend/program.ts";
import {
  type AbiEntry,
  type AbiShape,
  decodeAbi,
  encodeAbi,
} from "./src/backend/abi.ts";
import { buildRuntimeHir, type ClosedProgram } from "./src/backend/close.ts";
import {
  type BlotValue,
  Compiler,
  RuntimeExecutionError,
} from "./src/compiler.ts";
import { checkFile, checkSource } from "./src/check/mod.ts";
import { load } from "./src/load.ts";
import { parse } from "./src/syntax/parse.ts";
import { buildPortableModuleGraph } from "./src/syntax/portable.ts";

const compilerWasm = fromFileUrl(
  new URL("./generated/rust-middle/compiler.wasm", import.meta.url),
);

const preludeSnapshot = fromFileUrl(
  new URL("./generated/rust-middle/prelude.snapshot", import.meta.url),
);

const ROOT = fromFileUrl(new URL(".", import.meta.url));

const EXAMPLES = join(ROOT, "examples");

const INTERPRETER = {
  write: (_line: string): void => {},
};

const EXAMPLE_FILES = [
  "minimal.blot",
  "arithmetic.blot",
  "collections.blot",
  "conditions.blot",
  "compiled.blot",
  "effects.blot",
  "handlers.blot",
  "linear.blot",
  "module.blot",
  "narrowing.blot",
  "proved.blot",
  "returning.blot",
  "shadowed_effects.blot",
  "storage.blot",
  "tour.blot",
  "walker.blot",
];

Deno.test("the checked-in compiler artifact contains a current prelude snapshot", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const source = 'open @import "blot:prelude" ()\nreturn 42\n';
    const result = await compiler.compileSource(
      "embedded-prelude.blot",
      source,
    );
    assertEquals(result.abi.exports[0]?.sourceName, "main");
  } finally {
    compiler.destroy();
  }
});

Deno.test("the checked-in prelude snapshot decodes as a portable module graph", async () => {
  const bytes = await Deno.readFile(preludeSnapshot);
  const text = new TextDecoder().decode(bytes);
  const parsed = JSON.parse(text);
  if (
    typeof parsed !== "object" || parsed === null ||
    !("modules" in parsed) || !("root" in parsed)
  ) {
    throw new Error("prelude snapshot is not a portable module graph");
  }
  const root = (parsed as { root?: unknown }).root;
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("prelude snapshot has no root identifier");
  }
  const modules = (parsed as { modules?: unknown }).modules;
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new Error("prelude snapshot has no modules");
  }
});

Deno.test("the checked-in compiler artifact is self-contained after creation", async () => {
  const artifact = await Deno.readFile(compilerWasm);
  const compiler = await Compiler.create({ compilerWasm: artifact });
  try {
    const renamed = `${preludeSnapshot}.hidden-${crypto.randomUUID()}`;
    await Deno.rename(preludeSnapshot, renamed);
    try {
      const source = 'open @import "blot:prelude" ()\nreturn 42\n';
      const result = await compiler.compileSource(
        "self-contained-prelude.blot",
        source,
      );
      assertEquals(result.abi.exports[0]?.sourceName, "main");
    } finally {
      await Deno.rename(renamed, preludeSnapshot);
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler emits a scalar module without filesystem access", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "memory.blot",
      "return 42\n",
    );
    assertEquals(artifact.abi.exports.length, 1);
    assertEquals(artifact.abi.exports[0]?.sourceName, "main");
    const instance = await WebAssembly.instantiate(artifact.wasm, {});
    assertEquals(
      (instance.exports[artifact.abi.exports[0]!.wasmName] as () => number)(),
      42,
    );
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler executes an effectful module through the ABI manifest", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "clock.blot",
      `const Clock = @effect.host { .now = Unit -> Int; }
result <- Clock.now ()
return result
`,
    );
    assertEquals(
      artifact.abi.imports.map((entry) => entry.sourceName),
      ["Clock.now"],
    );
    assertEquals(
      artifact.abi.exports.map((entry) => entry.sourceName),
      ["main"],
    );
    const program = await CompiledProgram.create(artifact, {
      Clock: { now: () => 37 },
    });
    assertEquals(program.call("main"), 37n);
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler accepts a nested host interface object", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "host-interface.blot",
      `module host
return host
`,
    );
    assertEquals(artifact.abi.imports.length, 0);
    const program = await CompiledProgram.create(artifact);
    assertEquals(program.call("main", { answer: 42 }), { answer: 42n });
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler reuses one compiler instance", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const first = await compiler.compileSource("one.blot", "return 1\n");
    const second = await compiler.compileSource("two.blot", "return 2\n");
    const one = await WebAssembly.instantiate(first.wasm, {});
    const two = await WebAssembly.instantiate(second.wasm, {});
    assertEquals((one.exports.main as () => number)(), 1);
    assertEquals((two.exports.main as () => number)(), 2);
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler reports source diagnostics", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    await assertRejects(
      () => compiler.compileSource("bad.blot", "return missing\n"),
      Error,
      "BLOT_UNBOUND",
    );
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler resolves imported source through its host", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const files = new Map([
      [
        "/workspace/main.blot",
        `const lib = @import "./lib.blot"
return lib ()
`,
      ],
      ["/workspace/lib.blot", "return 42\n"],
    ]);
    const artifact = await compiler.compileSource(
      "/workspace/main.blot",
      files.get("/workspace/main.blot")!,
      {
        readTextFile: (path) => {
          const found = files.get(path);
          if (found === undefined) throw new Deno.errors.NotFound();
          return found;
        },
      },
    );
    const instance = await WebAssembly.instantiate(artifact.wasm, {});
    assertEquals((instance.exports.main as () => number)(), 42);
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler resolves included files through its host", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const files = new Map([
      ["/workspace/data.json", '{"answer": 42}'],
    ]);
    const source = `open @import "blot:prelude" ()
const data = @include "./data.json" as_const_json
return data.answer
`;
    const artifact = await compiler.compileSource(
      "/workspace/main.blot",
      source,
      {
        readTextFile: (path) => {
          const found = files.get(path);
          if (found === undefined) throw new Deno.errors.NotFound();
          return found;
        },
      },
    );
    const instance = await WebAssembly.instantiate(artifact.wasm, {});
    assertEquals((instance.exports.main as () => number)(), 42);
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler prefers package capsules without reading source", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const packageSource = "return 42\n";
    const packageModule = await parse(packageSource);
    if (!packageModule.ok) throw new Error("package source did not parse");
    const graph = buildPortableModuleGraph({
      root: "/workspace/pkg/src/mod.blot",
      modules: new Map([
        ["/workspace/pkg/src/mod.blot", {
          module: packageModule.module,
          imports: new Map(),
          includes: [],
        }],
      ]),
    });
    const capsule = JSON.stringify({
      schema: "blot-module-capsule",
      version: 1,
      codec: "json",
      payload: btoa(JSON.stringify({
        schema: "blot-module-graph",
        version: 1,
        root: graph.root,
        modules: graph.modules,
      })),
    });
    const files = new Map([
      [
        "/workspace/node_modules/pkg/blot.json",
        JSON.stringify({
          schema: "blot-package",
          version: 3,
          exports: {
            ".": { source: "./src/mod.blot", built: "./dist/mod.blotc" },
          },
        }),
      ],
      ["/workspace/node_modules/pkg/dist/mod.blotc", capsule],
    ]);
    const source = `const pkg = @import "pkg"
return pkg ()
`;
    const artifact = await compiler.compileSource(
      "/workspace/main.blot",
      source,
      {
        readTextFile: (path) => {
          if (path.endsWith("/src/mod.blot")) {
            throw new Error("package source should not be read");
          }
          const found = files.get(path);
          if (found === undefined) throw new Deno.errors.NotFound();
          return found;
        },
      },
    );
    const instance = await WebAssembly.instantiate(artifact.wasm, {});
    assertEquals((instance.exports.main as () => number)(), 42);
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler falls back when a package capsule is corrupt", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const files = new Map([
      [
        "/workspace/node_modules/pkg/blot.json",
        JSON.stringify({
          schema: "blot-package",
          version: 3,
          exports: {
            ".": { source: "./src/mod.blot", built: "./dist/mod.blotc" },
          },
        }),
      ],
      ["/workspace/node_modules/pkg/dist/mod.blotc", "corrupt"],
      ["/workspace/node_modules/pkg/src/mod.blot", "return 42\n"],
    ]);
    const source = `const pkg = @import "pkg"
return pkg ()
`;
    const artifact = await compiler.compileSource(
      "/workspace/main.blot",
      source,
      {
        readTextFile: (path) => {
          const found = files.get(path);
          if (found === undefined) throw new Deno.errors.NotFound();
          return found;
        },
      },
    );
    const instance = await WebAssembly.instantiate(artifact.wasm, {});
    assertEquals((instance.exports.main as () => number)(), 42);
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler handles string results", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "text.blot",
      'return "hello"\n',
    );
    const program = await CompiledProgram.create(artifact);
    assertEquals(program.call("main"), "hello");
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler handles array results", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "array.blot",
      "return [1, 2, 3]\n",
    );
    const program = await CompiledProgram.create(artifact);
    assertEquals(program.call("main"), [1n, 2n, 3n]);
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler handles nested records", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "record.blot",
      'return { .name = "box"; .point = { .x = 20; .y = 22; }; }\n',
    );
    const program = await CompiledProgram.create(artifact);
    assertEquals(program.call("main"), {
      name: "box",
      point: { x: 20n, y: 22n },
    });
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler accepts record arguments", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "record-arg.blot",
      `module point
return point.x + point.y
`,
    );
    const program = await CompiledProgram.create(artifact);
    assertEquals(program.call("main", { x: 20, y: 22 }), 42n);
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler accepts nested record arguments", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "nested-record-arg.blot",
      `module state
return state.point.x + state.point.y
`,
    );
    const program = await CompiledProgram.create(artifact);
    assertEquals(program.call("main", { point: { x: 20, y: 22 } }), 42n);
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler handles variant results", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "variant.blot",
      "return #Some 42\n",
    );
    const program = await CompiledProgram.create(artifact);
    assertEquals(program.call("main"), { tag: "Some", value: 42n });
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler accepts variant arguments", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "variant-arg.blot",
      `module value
return case value of
  #Some n => n
  #None => 0
`,
    );
    const program = await CompiledProgram.create(artifact);
    assertEquals(program.call("main", { tag: "Some", value: 42 }), 42n);
    assertEquals(program.call("main", { tag: "None" }), 0n);
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler rejects malformed public values", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "variant-arg.blot",
      `module value
return case value of
  #Some n => n
  #None => 0
`,
    );
    const program = await CompiledProgram.create(artifact);
    assertRejects(
      () => program.call("main", { tag: "Some" } as unknown as BlotValue),
      Error,
      "expects a payload",
    );
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler exposes host effect arguments and results", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "host-record.blot",
      `const Lookup = @effect.host { .find = { .key = Str; } -> #None | #Some { .value = Int; }; }
result <- Lookup.find { .key = "answer"; }
return result
`,
    );
    const program = await CompiledProgram.create(artifact, {
      Lookup: {
        find: (argument) => {
          assertEquals(argument, { key: "answer" });
          return { tag: "Some", value: { value: 42 } };
        },
      },
    });
    assertEquals(program.call("main"), {
      tag: "Some",
      value: { value: 42n },
    });
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler supports import callbacks returning strings", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "host-string.blot",
      `const Lookup = @effect.host { .find = Str -> Str; }
result <- Lookup.find "answer"
return result
`,
    );
    const program = await CompiledProgram.create(artifact, {
      Lookup: { find: (key) => key === "answer" ? "forty-two" : "missing" },
    });
    assertEquals(program.call("main"), "forty-two");
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler releases result scratch storage between calls", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "scratch-result.blot",
      `module n
let values = []
for i in Iter.range (0, n):
  values := @array.push values i
return values
`,
    );
    const program = await CompiledProgram.create(artifact);
    const memory = program.instance.exports.memory as WebAssembly.Memory;
    const initialPages = memory.buffer.byteLength / 65536;
    assertEquals(program.call("main", 4), [0n, 1n, 2n, 3n]);
    const afterOne = memory.buffer.byteLength / 65536;
    for (let iteration = 0; iteration < 64; iteration += 1) {
      assertEquals(program.call("main", 4), [0n, 1n, 2n, 3n]);
    }
    const afterMany = memory.buffer.byteLength / 65536;
    assertEquals(afterMany, afterOne);
    assertEquals(afterMany >= initialPages, true);
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler supports nested re-entry", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "reentry.blot",
      `module n
const Reenter = @effect.host { .call = Int -> Int; }
if n <= 0:
  return 1
value <- Reenter.call (n - 1)
return value + 1
`,
    );
    let program: CompiledProgram;
    program = await CompiledProgram.create(artifact, {
      Reenter: {
        call: (n) => program.call("main", n) as bigint,
      },
    });
    assertEquals(program.call("main", 4), 5n);
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler handles imported helpers after specialization", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const files = new Map([
      [
        "/workspace/main.blot",
        `open @import "blot:prelude" ()
const lib = @import "./lib.blot"
let helper = lib ()
return helper.double 21
`,
      ],
      [
        "/workspace/lib.blot",
        `open @import "blot:prelude" ()
let double = fn n => n * 2
return { .double = double; }
`,
      ],
    ]);
    const artifact = await compiler.compileSource(
      "/workspace/main.blot",
      files.get("/workspace/main.blot")!,
      {
        readTextFile: (path) => {
          const found = files.get(path);
          if (found === undefined) throw new Deno.errors.NotFound();
          return found;
        },
      },
    );
    const instance = await WebAssembly.instantiate(artifact.wasm, {});
    assertEquals((instance.exports.main as () => number)(), 42);
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler rejects unsupported higher-order boundaries", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    await assertRejects(
      () =>
        compiler.compileSource(
          "higher-order.blot",
          "return fn x => x\n",
        ),
      Error,
      "BLOT_UNSUPPORTED_ABI",
    );
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler exposes multiple returned fields as exports", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "exports.blot",
      `return { .answer = 42; .twice = fn n => n * 2; }
`,
    );
    assertEquals(
      artifact.abi.exports.map((entry) => entry.sourceName).sort(),
      ["answer", "twice"],
    );
    const program = await CompiledProgram.create(artifact);
    assertEquals(program.call("answer"), 42n);
    assertEquals(program.call("twice", 21), 42n);
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler exposes a parameterized module record as exports", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "parameterized-exports.blot",
      `module initial
let add = fn n => n + initial
return { .initial = initial; .add = add; }
`,
    );
    const program = await CompiledProgram.create(artifact);
    assertEquals(program.call("initial", 20), 20n);
    assertEquals(program.call("add", 20, 22), 42n);
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler rejects a callable result closing over an owned capture", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    await assertRejects(
      () =>
        compiler.compileSource(
          "owned-export.blot",
          `let !token = 41
let use = fn () => token + 1
return { .use = use; }
`,
        ),
      Error,
      "BLOT_LINEAR_RESULT_ESCAPES",
    );
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler emits the same ABI in the custom section", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "custom-section.blot",
      `return { .answer = 42; .twice = fn n => n * 2; }
`,
    );
    const module = new WebAssembly.Module(artifact.wasm);
    const sections = WebAssembly.Module.customSections(module, "blot:abi");
    assertEquals(sections.length, 1);
    const embedded = new Uint8Array(sections[0]);
    assertEquals(embedded, encodeAbi(artifact.abi));
    assertEquals(decodeAbi(embedded), artifact.abi);
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler accepts an already-created compiler instance", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "instance.blot",
      "return 42\n",
    );
    const second = await compiler.compileSource(
      "instance-2.blot",
      "return 43\n",
    );
    const one = await WebAssembly.instantiate(artifact.wasm, {});
    const two = await WebAssembly.instantiate(second.wasm, {});
    assertEquals((one.exports.main as () => number)(), 42);
    assertEquals((two.exports.main as () => number)(), 43);
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler rejects use after destruction", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  compiler.destroy();
  await assertRejects(
    () => compiler.compileSource("destroyed.blot", "return 42\n"),
    Error,
    "destroyed",
  );
});

Deno.test("the public compiler exposes panic text as a runtime error", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "panic.blot",
      `return @panic "boom"
`,
    );
    const program = await CompiledProgram.create(artifact);
    const error = assertRejects(
      () => Promise.resolve(program.call("main")),
      RuntimeExecutionError,
    );
    assertStringIncludes((await error).message, "boom");
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler refuses a runtime integer literal outside i64", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    await assertRejects(
      () =>
        compiler.compileSource(
          "too-wide.blot",
          "return 9223372036854775808\n",
        ),
      Error,
      "BLOT_RUNTIME_INTEGER_RANGE",
    );
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler keeps compile-time integers arbitrary precision", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "wide-comptime.blot",
      `open @import "blot:prelude" ()
const Big = 9223372036854775808
return refines (Big, Big)
`,
    );
    const program = await CompiledProgram.create(artifact);
    assertEquals(program.call("main"), { tag: "True" });
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler rejects U64 at a runtime boundary", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    await assertRejects(
      () =>
        compiler.compileSource(
          "u64-boundary.blot",
          `open @import "blot:prelude" ()
sig word = U64
let word = 0
return word
`,
        ),
      Error,
      "BLOT_UNREPRESENTABLE_INTEGER",
    );
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler exposes type-selected compile-time functions at runtime", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "type-dispatch.blot",
      `open @import "blot:prelude" ()
const choose = fn T => case refines (T, Str) of
  #True => fn value => Text.length value
  #False => fn value => value + 1
const selected = choose Str
return selected "blot"
`,
    );
    const program = await CompiledProgram.create(artifact);
    assertEquals(program.call("main"), 4n);
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler exposes selected recursive functions at runtime", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compileSource(
      "selected-recursive.blot",
      `open @import "blot:prelude" ()
const recursive = fn n => case n > 0 of
  #True => selected (n - 1) + 1
  #False => 0
const selected = rec recursive
return selected 5
`,
    );
    const program = await CompiledProgram.create(artifact);
    assertEquals(program.call("main"), 5n);
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler can compile a file path", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const artifact = await compiler.compile(join(EXAMPLES, "minimal.blot"));
    const instance = await WebAssembly.instantiate(artifact.wasm, {});
    assertEquals((instance.exports.main as () => number)(), 42);
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler compiles examples through the same compiler artifact", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    for (const name of EXAMPLE_FILES) {
      const artifact = await compiler.compile(join(EXAMPLES, name));
      if (artifact.wasm.byteLength === 0) {
        throw new Error(`${name} produced empty Wasm`);
      }
      if (artifact.abi.exports.length === 0) {
        throw new Error(`${name} produced no exports`);
      }
    }
  } finally {
    compiler.destroy();
  }
});

Deno.test("the public compiler works with custom file hosts", async () => {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    const files = new Map([
      ["/workspace/main.blot", "return 42\n"],
    ]);
    const artifact = await compiler.compile("/workspace/main.blot", {
      readTextFile: (path) => {
        const found = files.get(path);
        if (found === undefined) throw new Deno.errors.NotFound();
        return found;
      },
    });
    const instance = await WebAssembly.instantiate(artifact.wasm, {});
    assertEquals((instance.exports.main as () => number)(), 42);
  } finally {
    compiler.destroy();
  }
});

Deno.test("buildSource compiles a scalar module", async () => {
  const artifact = await buildSource("scalar.blot", "return 42\n");
  const instance = await WebAssembly.instantiate(artifact.wasm, {});
  assertEquals((instance.exports.main as () => number)(), 42);
});

Deno.test("buildSource emits the ABI custom section", async () => {
  const artifact = await buildSource("abi.blot", "return 42\n");
  const module = new WebAssembly.Module(artifact.wasm);
  const sections = WebAssembly.Module.customSections(module, "blot:abi");
  assertEquals(sections.length, 1);
  assertEquals(
    decodeAbi(new Uint8Array(sections[0])),
    artifact.abi,
  );
});

Deno.test("buildSource rejects an unknown name", async () => {
  await assertRejects(
    () => buildSource("unknown.blot", "return missing\n"),
    BlotError,
    "BLOT_UNBOUND",
  );
});

Deno.test("buildSource rejects an unhandled source effect", async () => {
  await assertRejects(
    () =>
      buildSource(
        "effect.blot",
        `const Clock = @effect { .now = Unit -> Int; }
result <- Clock.now ()
return result
`,
      ),
    BlotError,
    "BLOT_UNHANDLED_EFFECT",
  );
});

Deno.test("buildSource accepts a host effect boundary", async () => {
  const artifact = await buildSource(
    "host-effect.blot",
    `const Clock = @effect.host { .now = Unit -> Int; }
result <- Clock.now ()
return result
`,
  );
  assertEquals(
    artifact.abi.imports.map((entry) => entry.sourceName),
    ["Clock.now"],
  );
});

Deno.test("buildSource rejects an owned result", async () => {
  await assertRejects(
    () =>
      buildSource(
        "owned-result.blot",
        `let !token = 41
return token
`,
      ),
    BlotError,
    "BLOT_LINEAR_RESULT_ESCAPES",
  );
});

Deno.test("buildSource supports an imported module", async () => {
  const directory = await Deno.makeTempDir();
  const main = join(directory, "main.blot");
  const lib = join(directory, "lib.blot");
  await Deno.writeTextFile(lib, "return 42\n");
  await Deno.writeTextFile(
    main,
    `const lib = @import "./lib.blot"
return lib ()
`,
  );
  const artifact = await build(main);
  const instance = await WebAssembly.instantiate(artifact.wasm, {});
  assertEquals((instance.exports.main as () => number)(), 42);
});

Deno.test("buildSource supports includes", async () => {
  const directory = await Deno.makeTempDir();
  const main = join(directory, "main.blot");
  const data = join(directory, "data.json");
  await Deno.writeTextFile(data, '{"answer": 42}');
  const source = `open @import "blot:prelude" ()
const value = @include "./data.json" as_const_json
return value.answer
`;
  const artifact = await buildSource(main, source);
  const instance = await WebAssembly.instantiate(artifact.wasm, {});
  assertEquals((instance.exports.main as () => number)(), 42);
});

Deno.test("buildLoaded compiles a preloaded graph without rereading source", async () => {
  const directory = await Deno.makeTempDir();
  const main = join(directory, "main.blot");
  await Deno.writeTextFile(main, "return 42\n");
  const loaded = await load(main);
  const original = await Deno.readTextFile(main);
  await Deno.writeTextFile(main, "return 0\n");
  try {
    const artifact = await buildLoaded(loaded);
    const instance = await WebAssembly.instantiate(artifact.wasm, {});
    assertEquals((instance.exports.main as () => number)(), 42);
  } finally {
    await Deno.writeTextFile(main, original);
  }
});

Deno.test("compile returns a closed program", async () => {
  const program = await compile(join(EXAMPLES, "minimal.blot"));
  assertEquals(program.functions.length > 0, true);
  assertEquals(program.abi.exports.length > 0, true);
});

Deno.test("compile accepts a preloaded module graph", async () => {
  const loaded = await load(join(EXAMPLES, "minimal.blot"));
  const program = await compile(loaded);
  assertEquals(program.functions.length > 0, true);
});

Deno.test("compileSource accepts source without writing it", async () => {
  const program = await compile({
    path: "source.blot",
    source: "return 42\n",
  });
  assertEquals(program.functions.length > 0, true);
});

Deno.test("compile records a canonical ABI", async () => {
  const program = await compile(join(EXAMPLES, "minimal.blot"));
  assertEquals(program.abi.version, 1);
  assertEquals(program.abi.exports.length, 1);
});

Deno.test("buildRuntimeHir lowers one checked example", async () => {
  const path = join(EXAMPLES, "minimal.blot");
  const checked = await checkFile(path);
  const hir = buildRuntimeHir(checked);
  assertEquals(hir.functions.length > 0, true);
});

Deno.test("buildRuntimeHir lowers a source revision", async () => {
  const checked = await checkSource("revision.blot", "return 42\n");
  const hir = buildRuntimeHir(checked);
  assertEquals(hir.functions.length > 0, true);
});

Deno.test("every executable example closes to Runtime HIR", async () => {
  for (const entry of await collectExamples()) {
    const checked = await checkFile(entry);
    const hir = buildRuntimeHir(checked);
    if (hir.functions.length === 0) {
      throw new Error(`${entry} closed to no functions`);
    }
  }
});

Deno.test("a scalar closure specializes to an exported function", async () => {
  const source = `module n
return n + 1
`;
  const program = await compile({ path: "scalar-function.blot", source });
  assertEquals(
    program.abi.exports.map((entry) => entry.sourceName),
    ["main"],
  );
});

Deno.test("a returned record exports its callable fields", async () => {
  const source = `let twice = fn n => n * 2
return { .answer = 42; .twice = twice; }
`;
  const program = await compile({ path: "record-exports.blot", source });
  assertEquals(
    program.abi.exports.map((entry) => entry.sourceName).sort(),
    ["answer", "twice"],
  );
});

Deno.test("a module parameter is threaded to exported fields", async () => {
  const source = `module initial
let add = fn n => n + initial
return { .initial = initial; .add = add; }
`;
  const program = await compile({ path: "parameterized-record.blot", source });
  assertEquals(program.abi.exports.length, 2);
});

Deno.test("a host effect becomes a Wasm import", async () => {
  const source = `const Clock = @effect.host { .now = Unit -> Int; }
result <- Clock.now ()
return result
`;
  const program = await compile({ path: "host-import.blot", source });
  assertEquals(
    program.abi.imports.map((entry) => entry.sourceName),
    ["Clock.now"],
  );
});

Deno.test("a handled source effect does not reach the ABI", async () => {
  const source = `const Ask = @effect { .ask = Unit -> Int; }
let work = fn () =>
  result <- Ask.ask ()
  return result
let handler = { .ask = fn (_, ?resume) => resume 42; }
return @handle (Ask, work, handler)
`;
  const program = await compile({ path: "handled-source.blot", source });
  assertEquals(program.abi.imports.length, 0);
});

Deno.test("a handler transformer pipeline preserves inner-to-outer order", async () => {
  const source = `open @import "blot:prelude" ()
const First = @effect { .get = Unit -> Int; }
const Second = @effect { .add = Int -> Int; }
let program = fn () =>
  value <- First.get ()
  result <- Second.add value
  return result
let first = { .get = fn (_, ?resume) => resume 20; }
let second = { .add = fn (value, ?resume) => resume (value + 22); }
let handled = program
  |> @handle (First, first)
  |> @handle (Second, second)
result <- handled
return result
`;
  const artifact = await buildSource("handler-pipeline.blot", source);
  const instance = await WebAssembly.instantiate(artifact.wasm, {});
  assertEquals((instance.exports.main as () => number)(), 42);
});

Deno.test("an array result has a canonical ABI shape", async () => {
  const source = "return [1, 2, 3]\n";
  const program = await compile({ path: "array-result.blot", source });
  const result = program.abi.exports[0]?.result;
  assertEquals(result?.kind, "array");
});

Deno.test("a record result preserves source field names", async () => {
  const source = "return { .x = 20; .y = 22; }\n";
  const program = await compile({ path: "record-result.blot", source });
  const result = program.abi.exports[0]?.result;
  assertEquals(result?.kind, "record");
  if (result?.kind === "record") {
    assertEquals(result.fields.map((field) => field.name).sort(), ["x", "y"]);
  }
});

Deno.test("a variant result preserves constructor names", async () => {
  const source = "return #Some 42\n";
  const program = await compile({ path: "variant-result.blot", source });
  const result = program.abi.exports[0]?.result;
  assertEquals(result?.kind, "variant");
  if (result?.kind === "variant") {
    assertEquals(result.cases.map((entry) => entry.name), ["Some"]);
  }
});

Deno.test("a sealed result keeps the seal name", async () => {
  const source = `open @import "blot:prelude" ()
const Meter = seal ("Meter", I64)
return seal ("Meter", 42)
`;
  const program = await compile({ path: "sealed-result.blot", source });
  const result = program.abi.exports[0]?.result;
  assertEquals(result?.kind, "seal");
  if (result?.kind === "seal") assertEquals(result.name, "Meter");
});

Deno.test("the ABI refuses an unsupported function value", async () => {
  await assertRejects(
    () =>
      compile({ path: "function-result.blot", source: "return fn x => x\n" }),
    BlotError,
    "BLOT_UNSUPPORTED_ABI",
  );
});

Deno.test("the ABI refuses recursive internal values", async () => {
  const source = `open @import "blot:prelude" ()
const List = #Nil | #Cons (Int, List)
let make = rec (fn n => case n <= 0 of
  #True => #Nil
  #False => #Cons (n, make (n - 1)))
return make 3
`;
  await assertRejects(
    () => compile({ path: "recursive-abi.blot", source }),
    BlotError,
    "BLOT_UNSUPPORTED_ABI",
  );
});

Deno.test("the ABI accepts a scalar derived from a recursive value", async () => {
  const source = `open @import "blot:prelude" ()
const List = #Nil | #Cons (Int, List)
let make = rec (fn n => case n <= 0 of
  #True => #Nil
  #False => #Cons (n, make (n - 1)))
let sum = rec (fn list => case list of
  #Nil => 0
  #Cons (head, tail) => head + sum tail)
return sum (make 3)
`;
  const artifact = await buildSource("recursive-scalar.blot", source);
  const instance = await WebAssembly.instantiate(artifact.wasm, {});
  assertEquals((instance.exports.main as () => number)(), 6);
});

Deno.test("a recursive value closes to private indirection", async () => {
  const source = `open @import "blot:prelude" ()
const List = #Nil | #Cons (Int, List)
let make = rec (fn n => case n <= 0 of
  #True => #Nil
  #False => #Cons (n, make (n - 1)))
return case make 2 of
  #Nil => 0
  #Cons (head, _) => head
`;
  const checked = await checkSource("recursive-private.blot", source);
  const hir = buildRuntimeHir(checked);
  assertEquals(
    hir.types.some((type) => type.tag === "indirect"),
    true,
  );
});

Deno.test("recursive value construction is linear in node count", async () => {
  const source = `open @import "blot:prelude" ()
const List = #Nil | #Cons (Int, List)
let make = rec (fn n => case n <= 0 of
  #True => #Nil
  #False => #Cons (n, make (n - 1)))
let length = rec (fn list => case list of
  #Nil => 0
  #Cons (_, tail) => 1 + length tail)
return length (make 128)
`;
  const checked = await checkSource("recursive-scale.blot", source);
  const hir = buildRuntimeHir(checked);
  const indirections =
    hir.functions.flatMap((fn) => fn.body).filter((operation) =>
      operation.op === "indirect.make"
    ).length;
  assertEquals(indirections <= 3, true);
});

Deno.test("a direct tail recursion becomes a structured loop", async () => {
  const source = `open @import "blot:prelude" ()
let loop = rec (fn n => case n > 0 of
  #True => loop (n - 1)
  #False => 42)
return loop 100
`;
  const checked = await checkSource("tail-loop.blot", source);
  const hir = buildRuntimeHir(checked);
  assertEquals(
    hir.functions.some((fn) =>
      fn.body.some((operation) => operation.op === "loop.backedge")
    ),
    true,
  );
});

Deno.test("a recursive product reconstruction can still tail-loop", async () => {
  const source = `open @import "blot:prelude" ()
let loop = rec (fn state => case state.0 > 0 of
  #True => loop (state.0 - 1, state.1 + 1)
  #False => state.1)
return loop (100, 0)
`;
  const checked = await checkSource("tail-product.blot", source);
  const hir = buildRuntimeHir(checked);
  assertEquals(
    hir.functions.some((fn) =>
      fn.body.some((operation) => operation.op === "loop.backedge")
    ),
    true,
  );
});

Deno.test("generated direct tail loops keep one backedge", async () => {
  for (const size of [1, 4, 16, 64]) {
    const source = `open @import "blot:prelude" ()
let loop = rec (fn n => case n > 0 of
  #True => loop (n - 1)
  #False => 42)
return loop ${size}
`;
    const checked = await checkSource(`tail-${size}.blot`, source);
    const hir = buildRuntimeHir(checked);
    const backedges = hir.functions.flatMap((fn) =>
      fn.body
    ).filter((operation) => operation.op === "loop.backedge").length;
    assertEquals(backedges, 1);
  }
});

Deno.test("constant boolean branches are simplified before structuring", async () => {
  const source = `open @import "blot:prelude" ()
let result = case 1 < 2 of
  #True => 42
  #False => 0
return result
`;
  const checked = await checkSource("constant-branch.blot", source);
  const hir = buildRuntimeHir(checked);
  assertEquals(
    hir.functions.some((fn) =>
      fn.body.some((operation) => operation.op === "branch")
    ),
    false,
  );
});

Deno.test("known constructor cases are simplified before structuring", async () => {
  const source = `let value = #Some 42
return case value of
  #Some inner => inner
  #None => 0
`;
  const checked = await checkSource("constant-case.blot", source);
  const hir = buildRuntimeHir(checked);
  assertEquals(
    hir.functions.some((fn) =>
      fn.body.some((operation) => operation.op === "switch")
    ),
    false,
  );
});

Deno.test("non-tail recursion remains a call", async () => {
  const source = `open @import "blot:prelude" ()
let count = rec (fn n => case n > 0 of
  #True => 1 + count (n - 1)
  #False => 0)
return count 4
`;
  const checked = await checkSource("non-tail.blot", source);
  const hir = buildRuntimeHir(checked);
  assertEquals(
    hir.functions.some((fn) =>
      fn.body.some((operation) => operation.op === "loop.backedge")
    ),
    false,
  );
});

Deno.test("an opaque runtime function choice remains a closed-program frontier", async () => {
  const source = `open @import "blot:prelude" ()
let choose = fn flag => case flag > 0 of
  #True => fn record => record.x + flag
  #False => fn record => record.x - flag
let selected = choose 1
return selected { .x = 41; .extra = 0; }
`;
  const artifact = await buildSource("opaque-choice.blot", source);
  const instance = await WebAssembly.instantiate(artifact.wasm, {});
  assertEquals((instance.exports.main as () => number)(), 42);
});

Deno.test("finite known function choices defunctionalize through a runtime branch", async () => {
  const source = `open @import "blot:prelude" ()
module flag
let selected = case flag > 0 of
  #True => fn record => record.x + flag
  #False => fn record => record.x - flag
let left = selected { .x = 41; .left = 0; }
let right = selected { .x = 41; .right = 0; }
return left + right
`;
  const artifact = await buildSource("dynamic-choice.blot", source);
  const program = await CompiledProgram.create(artifact);
  assertEquals(program.call("main", 1), 84n);
  assertEquals(program.call("main", -1), 84n);
});

Deno.test("branch-local captures survive finite function defunctionalization", async () => {
  const source = `open @import "blot:prelude" ()
module flag
let selected = case flag > 0 of
  #True =>
    let offset = flag + 1
    return fn record => record.x + offset
  #False =>
    let offset = flag - 1
    return fn record => record.x - offset
return selected { .x = 40; }
`;
  const artifact = await buildSource("dynamic-captures.blot", source);
  const program = await CompiledProgram.create(artifact);
  assertEquals(program.call("main", 1), 42n);
  assertEquals(program.call("main", -1), 42n);
});

Deno.test("nested finite function choices normalize to one runtime dispatch", async () => {
  const source = `open @import "blot:prelude" ()
module flag
let selected = case flag > 1 of
  #True => fn record => record.x + 2
  #False => case flag > 0 of
    #True => fn record => record.x + 1
    #False => fn record => record.x
return selected { .x = 40; }
`;
  const artifact = await buildSource("nested-choice.blot", source);
  const program = await CompiledProgram.create(artifact);
  assertEquals(program.call("main", 2), 42n);
  assertEquals(program.call("main", 1), 41n);
  assertEquals(program.call("main", 0), 40n);
});

Deno.test("a known higher-order branch may still specialize per record width", async () => {
  const source = `open @import "blot:prelude" ()
module flag
let selected = case flag > 0 of
  #True => fn record => record.x
  #False => fn record => record.x
let left = selected { .x = 20; .left = 0; }
let right = selected { .x = 22; .right = 0; }
return left + right
`;
  const artifact = await buildSource("known-choice-widths.blot", source);
  const program = await CompiledProgram.create(artifact);
  assertEquals(program.call("main", 1), 42n);
  assertEquals(program.call("main", 0), 42n);
});

Deno.test("a dynamic function choice is refused at ABI 1", async () => {
  const source = `open @import "blot:prelude" ()
module flag
return case flag > 0 of
  #True => fn record => record.x
  #False => fn record => record.x
`;
  await assertRejects(
    () => buildSource("dynamic-function-abi.blot", source),
    BlotError,
    "BLOT_UNSUPPORTED_ABI",
  );
});

Deno.test("a handler may resume non-tail before doing more work", async () => {
  const source = `open @import "blot:prelude" ()
const Ask = @effect { .ask = Unit -> Int; }
let work = fn () =>
  value <- Ask.ask ()
  return value + 1
let handler = {
  .ask = fn (_, ?resume) =>
    result <- resume 40
    return result + 1
  ;
}
return @handle (Ask, work, handler)
`;
  const artifact = await buildSource("non-tail-resume.blot", source);
  const instance = await WebAssembly.instantiate(artifact.wasm, {});
  assertEquals((instance.exports.main as () => number)(), 42);
});

Deno.test("a handler may abort before the continuation", async () => {
  const source = `open @import "blot:prelude" ()
const Ask = @effect { .ask = Unit -> Int; }
let work = fn () =>
  value <- Ask.ask ()
  return value + 1
let handler = {
  .ask = fn (_, ?resume) => 42;
}
return @handle (Ask, work, handler)
`;
  const artifact = await buildSource("abort-handler.blot", source);
  const instance = await WebAssembly.instantiate(artifact.wasm, {});
  assertEquals((instance.exports.main as () => number)(), 42);
});

Deno.test("a handler may cancel an owned continuation", async () => {
  const source = `open @import "blot:prelude" ()
const Ask = @effect { .ask = Unit -> Int; }
let !token = 41
let work = fn () =>
  value <- Ask.ask ()
  return value + token
let handler = {
  .ask = fn (_, !resume) =>
    <- Continuation.cancel resume
    return 42
  ;
}
return @handle (Ask, work, handler)
`;
  const artifact = await buildSource("cancel-handler.blot", source);
  const instance = await WebAssembly.instantiate(artifact.wasm, {});
  assertEquals((instance.exports.main as () => number)(), 42);
});

Deno.test("an owned array append may reuse its Store", async () => {
  const source = `open @import "blot:prelude" ()
let build = fn !values => @array.push values 42
let !values = [1, 2, 3]
let result = build (!values)
return @array.len result
`;
  const checked = await checkSource("owned-push.blot", source);
  const hir = buildRuntimeHir(checked);
  assertEquals(
    hir.functions.some((fn) =>
      fn.body.some((operation) =>
        operation.op === "store.push" && operation.reuse === true
      )
    ),
    true,
  );
});

Deno.test("an owned array replacement may reuse its Store", async () => {
  const source = `open @import "blot:prelude" ()
let replace = fn !values => @array.set values 0 42
let !values = [1, 2, 3]
let result = replace (!values)
return @array.get result 0
`;
  const checked = await checkSource("owned-set.blot", source);
  const hir = buildRuntimeHir(checked);
  assertEquals(
    hir.functions.some((fn) =>
      fn.body.some((operation) =>
        operation.op === "store.set" && operation.reuse === true
      )
    ),
    true,
  );
});

Deno.test("an ordinary shared array append stays persistent", async () => {
  const source = `open @import "blot:prelude" ()
let values = [1, 2, 3]
let result = @array.push values 42
return @array.len result
`;
  const checked = await checkSource("shared-push.blot", source);
  const hir = buildRuntimeHir(checked);
  assertEquals(
    hir.functions.some((fn) =>
      fn.body.some((operation) =>
        operation.op === "store.push" && operation.reuse === true
      )
    ),
    false,
  );
});

Deno.test("the Rust compiler and TypeScript compiler agree on one scalar artifact", async () => {
  const source = `open @import "blot:prelude" ()
return 40 + 2
`;
  const ts = await buildSource("agreement.blot", source);
  const rust = await rustCompileSource("agreement.blot", source);
  assertEquals(rust.abi, ts.abi);
  const tsInstance = await WebAssembly.instantiate(ts.wasm, {});
  const rustInstance = await WebAssembly.instantiate(rust.wasm, {});
  assertEquals((tsInstance.exports.main as () => number)(), 42);
  assertEquals((rustInstance.exports.main as () => number)(), 42);
});

Deno.test("the Rust compiler emits every executable example", async () => {
  for (const entry of await collectExamples()) {
    const source = await Deno.readTextFile(entry);
    const artifact = await rustCompileSource(entry, source);
    if (artifact.wasm.length === 0) throw new Error(`${entry} emitted no Wasm`);
  }
});

Deno.test("the Rust compiler executes the handler pipeline example", async () => {
  const path = join(EXAMPLES, "composed_handlers.blot");
  const source = await Deno.readTextFile(path);
  const artifact = await rustCompileSource(path, source);
  const instance = await WebAssembly.instantiate(artifact.wasm, {});
  const main = artifact.abi.exports.find((entry) =>
    entry.sourceName === "main"
  );
  if (main === undefined) throw new Error("handler pipeline emitted no main");
  const result = (instance.exports[main.wasmName] as () => number)();
  assertEquals(result, 42);
});

Deno.test("the Rust compiler rejects removed value-if syntax", async () => {
  await assertRejects(
    () =>
      rustCompileSource(
        "removed-value-if.blot",
        `open @import "blot:prelude" ()
let value = if True:
  return 1
else:
  return 2
return value
`,
      ),
    Error,
    "BLOT_VALUE_IF_REMOVED",
  );
});

Deno.test("the Rust compiler rejects removed try syntax", async () => {
  await assertRejects(
    () =>
      rustCompileSource(
        "removed-try.blot",
        `let program = fn () => 1
let handler = {}
let value = try program with
  @handle (Effect, handler)
return value
`,
      ),
    Error,
    "BLOT_TRY_REMOVED",
  );
});

async function collectExamples(): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of Deno.readDir(EXAMPLES)) {
    if (entry.isFile && entry.name.endsWith(".blot")) {
      paths.push(join(EXAMPLES, entry.name));
    }
  }
  return paths.sort();
}

async function rustCompileSource(
  path: string,
  source: string,
): Promise<CompileArtifacts> {
  const compiler = await Compiler.create({ compilerWasm });
  try {
    return await compiler.compileSource(path, source);
  } finally {
    compiler.destroy();
  }
}
