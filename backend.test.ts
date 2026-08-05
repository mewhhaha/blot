import {
  buildSurfaceModule,
  compileModuleToWasm,
  CompilerPerformanceTrace,
  CpuCompiler,
  EvaluationProfile,
} from "gpufuck";
import {
  assert,
  assertEquals,
  assertNotStrictEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  build,
  prepareGpupaperHir,
  runLowering,
  runLoweringExport,
  validateLowering,
} from "./src/backend/compile.ts";
import { buildBatch } from "./src/backend/build.ts";
import { lowerModule } from "./src/backend/lower.ts";
import { checkFile } from "./src/check/mod.ts";
import { BlotError } from "./src/diagnostic.ts";
import { load, refreshLoadedModules } from "./src/load.ts";

async function blotFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isFile && entry.name.endsWith(".blot")) found.push(entry.name);
  }
  return found.sort();
}

for (const name of await blotFiles("examples")) {
  Deno.test(`examples/${name} lowers to gpufuck Core`, async () => {
    await validateLowering(join("examples", name));
  });
}

Deno.test("imported structural folds residualize over runtime records", async () => {
  const directory = await Deno.makeTempDir();
  const library = join(directory, "components.blot");
  const root = join(directory, "root.blot");
  await Deno.writeTextFile(
    library,
    [
      'open @import "blot:prelude" ();',
      "const component = fn definition => do",
      "  let names = @shape.names definition.fields;",
      "  return {",
      "    .pack = fn value => fold (names, 0, (fn (sum, name) =>",
      "      @int.add sum (@shape.get value name)));",
      "  };",
      "end;",
      "return { .component = component; };",
    ].join("\n"),
  );
  await Deno.writeTextFile(
    root,
    [
      'open @import "blot:prelude" ();',
      'const Components = (@import "./components.blot") ();',
      "const Position = Components.component {",
      "  .fields = { .x = Int; .y = Int; };",
      "};",
      "const Source = @effect.host { .x = Int -> Int; };",
      "x <- Source.x 0;",
      "sig packed = Int;",
      "let packed = Position.pack { .x = x; .y = 2; };",
      "return packed;",
    ].join("\n"),
  );

  const hir = await prepareGpupaperHir(root);
  assertEquals(hir.capabilities.map((capability) => capability.name), [
    "Source",
  ]);
  const [outcome] = await buildBatch([root]);
  if (outcome.status !== "built") throw outcome.cause;
  assertEquals(outcome.capabilities, ["Source"]);
  const compiled = await WebAssembly.compile(outcome.wasm as BufferSource);
  const instance = await WebAssembly.instantiate(compiled, {
    "blot:host/Source": {
      x(value: bigint) {
        assertEquals(value, 0n);
        return 40n;
      },
    },
  });
  const run = instance.exports["blot:default"];
  if (!(run instanceof Function)) {
    throw new Error("gpupaper omitted the default staged export");
  }
  assertEquals(run(), 42n);
});

Deno.test("static shape updates residualize over runtime records", async () => {
  const directory = await Deno.makeTempDir();
  const root = join(directory, "root.blot");
  await Deno.writeTextFile(
    root,
    [
      'open @import "blot:prelude" ();',
      "const Source = @effect.host { .x = Int -> Int; };",
      "x <- Source.x 0;",
      "let original = { .x = x; .y = 1; };",
      'let replaced = @shape.set original "y" (x + 2);',
      'let trimmed = @shape.remove replaced "x";',
      "return trimmed.y;",
    ].join("\n"),
  );

  const [outcome] = await buildBatch([root]);
  if (outcome.status !== "built") throw outcome.cause;
  const compiled = await WebAssembly.compile(outcome.wasm as BufferSource);
  const instance = await WebAssembly.instantiate(compiled, {
    "blot:host/Source": {
      x(value: bigint) {
        assertEquals(value, 0n);
        return 40n;
      },
    },
  });
  const run = instance.exports["blot:default"];
  if (!(run instanceof Function)) {
    throw new Error("gpupaper omitted the default staged export");
  }
  assertEquals(run(), 42n);
});

Deno.test("runtime booleans survive local function results", async () => {
  const directory = await Deno.makeTempDir();
  const root = join(directory, "root.blot");
  await Deno.writeTextFile(
    root,
    [
      'open @import "blot:prelude" ();',
      "const Source = @effect.host { .value = Int -> Int; };",
      "let positive = fn () => do",
      "  value <- Source.value 0;",
      "  return value > 0;",
      "end;",
      "present <- positive ();",
      "return if present then 42 else 0 end;",
    ].join("\n"),
  );

  const [outcome] = await buildBatch([root]);
  if (outcome.status !== "built") throw outcome.cause;
  const compiled = await WebAssembly.compile(outcome.wasm as BufferSource);
  const instance = await WebAssembly.instantiate(compiled, {
    "blot:host/Source": {
      value(input: bigint) {
        assertEquals(input, 0n);
        return 1n;
      },
    },
  });
  const run = instance.exports["blot:default"];
  if (!(run instanceof Function)) {
    throw new Error("gpupaper omitted the default staged export");
  }
  assertEquals(run(), 42n);
});

Deno.test("conditional shadows can destructure runtime join values", async () => {
  const directory = await Deno.makeTempDir();
  const root = join(directory, "root.blot");
  await Deno.writeTextFile(
    root,
    [
      'open @import "blot:prelude" ();',
      "const Source = @effect.host { .value = Int -> Int; };",
      "candidate <- Source.value 0;",
      "let result = 0;",
      "if candidate > 0 then",
      "  current <- Source.value candidate;",
      "  if current > 0 then current := current - 1; end;",
      "  result := current;",
      "end;",
      "return result;",
    ].join("\n"),
  );

  const [outcome] = await buildBatch([root]);
  if (outcome.status !== "built") throw outcome.cause;
  assertEquals(outcome.capabilities, ["Source"]);
});

Deno.test("sealed runtime scalars erase to their checked representation", async () => {
  const directory = await Deno.makeTempDir();
  const root = join(directory, "root.blot");
  await Deno.writeTextFile(
    root,
    [
      'open @import "blot:prelude" ();',
      "const Source = @effect.host { .value = Int -> Int; };",
      'const Entity = seal ("test.Entity", Int);',
      "value <- Source.value 0;",
      'let entity = seal ("test.Entity", value);',
      "return unseal entity;",
    ].join("\n"),
  );

  const [outcome] = await buildBatch([root]);
  if (outcome.status !== "built") throw outcome.cause;
  const compiled = await WebAssembly.compile(outcome.wasm as BufferSource);
  const instance = await WebAssembly.instantiate(compiled, {
    "blot:host/Source": { value: () => 42n },
  });
  const run = instance.exports["blot:default"];
  if (!(run instanceof Function)) {
    throw new Error("gpupaper omitted the default staged export");
  }
  assertEquals(run(), 42n);
});

Deno.test("staged scalar exports retain their checked values in gpupaper HIR", async () => {
  const hir = await prepareGpupaperHir("examples/breaking.blot");
  const exported = hir.exports.find((candidate) =>
    candidate.phase === "runtime" && candidate.sourceName === "iterations"
  );
  if (exported === undefined || exported.phase !== "runtime") {
    throw new Error("gpupaper HIR omitted iterations");
  }
  const operation = hir.functions[exported.function].blocks[0].operations[0];
  assertEquals(operation.kind, "constant");
  if (operation.kind !== "constant") return;
  assertEquals(operation.value, 5n);
});

Deno.test("gpupaper HIR cache follows loaded revision identity", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "revision.blot");
  await Deno.writeTextFile(path, "return 41;");

  const first = await prepareGpupaperHir(path);
  const repeated = await prepareGpupaperHir(path);
  assertStrictEquals(repeated, first);
  assertThrows(
    () => (first.exports as unknown[]).push({}),
    TypeError,
  );

  await Deno.writeTextFile(path, "return 42;");
  await refreshLoadedModules();
  const edited = await prepareGpupaperHir(path);
  assertNotStrictEquals(edited, first);
  const exported = edited.exports[0];
  if (exported === undefined || exported.phase !== "runtime") {
    throw new Error("edited gpupaper HIR omitted its runtime export");
  }
  const operation = edited.functions[exported.function].blocks[0].operations[0];
  assertEquals(operation.kind, "constant");
  if (operation.kind === "constant") assertEquals(operation.value, 42n);
});

Deno.test("gpupaper HIR cache invalidates a transitive importer", async () => {
  const directory = await Deno.makeTempDir();
  const dependency = join(directory, "dependency.blot");
  const root = join(directory, "root.blot");
  await Deno.writeTextFile(dependency, "return 40;");
  await Deno.writeTextFile(
    root,
    'return (@import "./dependency.blot") ();',
  );

  const first = await prepareGpupaperHir(root);
  await Deno.writeTextFile(dependency, "return 42;");
  await refreshLoadedModules();
  const edited = await prepareGpupaperHir(root);
  assertNotStrictEquals(edited, first);
  const exported = edited.exports[0];
  if (exported === undefined || exported.phase !== "runtime") {
    throw new Error("edited importer HIR omitted its runtime export");
  }
  const operation = edited.functions[exported.function].blocks[0].operations[0];
  assertEquals(operation.kind, "constant");
  if (operation.kind === "constant") assertEquals(operation.value, 42n);
});

Deno.test("gpupaper HIR refuses a function crossing the staged boundary", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "function-result.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "return fn value => value;",
    ].join("\n"),
  );

  await assertRejects(
    () => prepareGpupaperHir(path),
    BlotError,
    "BLOT_EXPORT_NOT_FIRST_ORDER",
  );
});

for (const name of ["handler_aborts.blot", "handlers.blot"]) {
  Deno.test(`examples/${name} lowers its handler before staging`, async () => {
    const path = join("examples", name);
    const loaded = await load(path);
    const checked = await checkFile(path);
    const lowered = lowerModule(loaded.module, checked, checked.values);
    const module = buildSurfaceModule(
      lowered.definitions,
      lowered.types,
      lowered.entry,
      loaded.source.length,
      {
        evaluationProfile: EvaluationProfile.StrictEager,
        hostCapabilities: lowered.capabilities,
        hostDefinitions: lowered.hostDefinitions,
      },
    );
    const compilation = await new CpuCompiler().compileModule(module);
    if (!compilation.ok) {
      const [diagnostic] = compilation.diagnostics;
      throw new Error(
        `gpufuck rejected the handler lowering: ${diagnostic.code}: ${diagnostic.message}`,
      );
    }
    compilation.module.destroy();
  });
}

Deno.test("an effect can carry its specialized handler into inferred reflection", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "handler-combinator.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "const capability = fn () => do",
      "  const Raw = @effect { .read = Unit -> Int; };",
      "  const handle = fn selected => fn computation => @handle (",
      "    Raw,",
      "    computation,",
      "    { .read = fn ((), ?resume) => resume selected; }",
      "  );",
      "  const Access = Raw <+ { .handler = handle; };",
      "  return { .read = Access; };",
      "end;",
      "const Component = capability ();",
      "const system = fn () => do value <- Component.read.read (); return value; end;",
      "const reflected = case @type.reflect (@type.of system) of",
      "  #Arrow arrow => case Array.get (arrow.effects, 0) of",
      "    #Some effect => effect,",
      '    #None => @fail "missing effect"',
      "  end,",
      '  _ => @fail "system is not a function"',
      "end;",
      "return (@type.members reflected).handler 42 system;",
    ].join("\n"),
  );

  assertEquals(await runLoweringExport(path, "default"), {
    kind: "signed-integer-64",
    value: 42n,
  });
});

Deno.test("return control lowers without synthetic variant declarations", async () => {
  const path = join("examples", "returning.blot");
  const loaded = await load(path);
  const checked = await checkFile(path);
  const lowered = lowerModule(loaded.module, checked, checked.values);

  assertEquals(
    lowered.types.some((type) =>
      type.constructors.some((constructor) =>
        /^(?:Function|Conditional)Return\$/.test(constructor.name)
      )
    ),
    false,
  );
});

Deno.test("loop control lowers without synthetic variant declarations", async () => {
  const path = join("examples", "breaking.blot");
  const loaded = await load(path);
  const checked = await checkFile(path);
  const lowered = lowerModule(loaded.module, checked, checked.values);

  assertEquals(
    lowered.types.some((type) =>
      type.constructors.some((constructor) =>
        /^Loop(?:Body)?(?:Return|Continue|Break)\$/.test(constructor.name)
      )
    ),
    false,
  );
});

// A `const` is compile time and a `let` is not, so a hoisted compile-time
// closure has no frame to find a `let` in. The refusal has to say that: the
// captured name is in scope at the source level, and reporting it as unbound
// sends the reader looking for a declaration that is right there.
Deno.test("a `const` refuses to capture a `let`", async () => {
  const path = join("examples/rejected/semantics", "const_captures_let.blot");
  const loaded = await load(path);
  const checked = await checkFile(path);
  const error = assertThrows(
    () => lowerModule(loaded.module, checked, checked.values),
    BlotError,
  );
  assertEquals(error.diagnostic.code, "BLOT_CONST_CAPTURES_RUNTIME");
  assertEquals(
    loaded.source.slice(error.diagnostic.span.start, error.diagnostic.span.end),
    "helper",
  );
});

Deno.test("runtime integers cross WebAssembly as signed i64", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "wide.blot");
  await Deno.writeTextFile(path, "return 2147483648;");

  assertEquals(await runLowering(path), {
    kind: "signed-integer-64",
    value: 2147483648n,
  });
});

Deno.test("a dependency may have source spans beyond the end of its importer", async () => {
  const directory = await Deno.makeTempDir();
  const dependencyPath = join(directory, "dependency.blot");
  const entryPath = join(directory, "entry.blot");
  await Deno.writeTextFile(
    dependencyPath,
    `// ${"padding ".repeat(700)}\nreturn 42;`,
  );
  await Deno.writeTextFile(
    entryPath,
    'return (@import "./dependency.blot") ();',
  );

  await validateLowering(entryPath);
});

Deno.test("runtime integer overflow traps in emitted WebAssembly", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "overflow.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "let maximum = 9223372036854775807;",
      "return maximum + 1;",
    ].join("\n"),
  );

  await assertRejects(
    () => runLowering(path),
    Error,
    "integer overflow",
  );
});

Deno.test("the manifest separates runtime and compile-time exports", async () => {
  const manifest = await validateLowering("examples/types.blot");
  const one = manifest.exports.find((exported) =>
    exported.sourceName === "one"
  );
  const method = manifest.exports.find((exported) =>
    exported.sourceName === "method"
  );

  assertEquals(one, {
    sourceName: "one",
    name: "blot:one",
    phase: "runtime",
    function: {
      parameters: [],
      result: { kind: "signed-integer-64" },
    },
    postReturn: null,
    effects: [],
    ownership: "owned",
  });
  assertEquals(method, {
    sourceName: "method",
    name: null,
    phase: "comptime",
    function: null,
    postReturn: null,
    effects: [],
    ownership: null,
  });
  assertEquals(JSON.stringify(manifest).includes("coreIndex"), false);
  assertEquals(JSON.stringify(manifest).includes("constructor"), false);
});

Deno.test("runtime fields are callable by their blot export names", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "exports.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "sig increment = Int -> Int;",
      "let increment = fn value => value + 1;",
      "return { .increment = increment; };",
    ].join("\n"),
  );

  assertEquals(
    await runLoweringExport(path, "increment", [{
      kind: "signed-integer-64",
      value: 41n,
    }]),
    {
      kind: "signed-integer-64",
      value: 42n,
    },
  );
});

Deno.test("a pinned pattern compares runtime scalar values", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "pinned-pattern.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "sig matches = Int -> Int -> Int;",
      "let matches = fn expected => fn actual => case actual of",
      "  #(expected) => 1,",
      "  _ => 0",
      "end;",
      "sig text_matches = Str -> Str -> Int;",
      "let text_matches = fn expected => fn actual => case actual of",
      "  #(expected) => 1,",
      "  _ => 0",
      "end;",
      "return { .matches = matches; .text_matches = text_matches; };",
    ].join("\n"),
  );

  assertEquals(
    await runLoweringExport(path, "matches", [{
      kind: "signed-integer-64",
      value: 7n,
    }, {
      kind: "signed-integer-64",
      value: 7n,
    }]),
    { kind: "signed-integer-64", value: 1n },
  );
  assertEquals(
    await runLoweringExport(path, "matches", [{
      kind: "signed-integer-64",
      value: 7n,
    }, {
      kind: "signed-integer-64",
      value: 8n,
    }]),
    { kind: "signed-integer-64", value: 0n },
  );
  assertEquals(
    await runLoweringExport(path, "text_matches", [{
      kind: "text",
      value: "same",
    }, {
      kind: "text",
      value: "same",
    }]),
    { kind: "signed-integer-64", value: 1n },
  );
});

Deno.test("a concrete record signature specializes an exported projection", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "record-export.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "const Point = { .x = Int; .y = Int; };",
      "sig project = Point -> Int;",
      "let project = fn point => point.x;",
      "return { .project = project; };",
    ].join("\n"),
  );

  const manifest = await validateLowering(path);
  const project = manifest.exports.find((exported) =>
    exported.sourceName === "project"
  );
  assertEquals(project?.function?.parameters.length, 1);
  assertEquals(project?.phase, "runtime");
});

// The body reads one field; the caller passes two. A `let`-bound projection is
// generalized, so the record never reaches the definition-site variable through
// the bound graph — only through the instantiation each call site made. Reading
// the copy is what gives the projection a nominal the construction site agrees
// with, and without it gpufuck sees `Shape0['a]` against `Shape2[I64, I64]`.
Deno.test("a generalized projection takes its shape from the call site", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "flowed-shape.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "let get_x = fn v => v.x;",
      "sig at = Int -> Int;",
      "let at = fn n => get_x { .x = n; .y = 0; };",
      "return { .at = at; };",
    ].join("\n"),
  );

  assertEquals(
    await runLoweringExport(path, "at", [{
      kind: "signed-integer-64",
      value: 41n,
    }]),
    { kind: "signed-integer-64", value: 41n },
  );
});

// Each call gets a closed nominal, so two source shapes never have to become
// one invented Core record.
Deno.test("a projection reached by two shapes specializes at each call", async () => {
  const path = join(
    "examples",
    "shape_specialization.blot",
  );
  await checkFile(path);
  await validateLowering(path);
});

// Width subtyping accepts this; Core records are invariant, so there is no one
// nominal for both call sites. The union `.x .y .z` would be a record the
// program never writes, so lowering names both shapes instead of picking one.
Deno.test("two shapes at one generalized projection are cloned", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "two-shapes.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "let get_x = fn v => v.x;",
      "sig at = Int -> Int;",
      "let at = fn n => get_x { .x = n; .y = 0; } + get_x { .x = 1; .z = n; };",
      "return { .at = at; };",
    ].join("\n"),
  );

  assertEquals(
    await runLoweringExport(path, "at", [{
      kind: "signed-integer-64",
      value: 41n,
    }]),
    { kind: "signed-integer-64", value: 42n },
  );
});

Deno.test("a structural function remains specializable through a record", async () => {
  const path = await fixture("aggregate-specialization.blot", [
    'open @import "blot:prelude" ();',
    "let project = fn record => record.x;",
    "let functions = { .project = project; };",
    "sig at = Int -> Int;",
    "let at = fn n =>",
    "  functions.project { .x = n; .y = 0; } +",
    "  functions.project { .x = n; .z = 0; };",
    "return { .at = at; };",
  ]);
  assertEquals(
    await runLoweringExport(path, "at", [{
      kind: "signed-integer-64",
      value: 21n,
    }]),
    { kind: "signed-integer-64", value: 42n },
  );
});

Deno.test("an immutable alias preserves structural call specialization", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "aliased-shapes.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "let get_x = fn value => value.x;",
      "let alias = get_x;",
      "sig at = Int -> Int;",
      "let at = fn n => alias { .x = n; .y = 0; } + alias { .x = 1; .z = n; };",
      "return { .at = at; };",
    ].join("\n"),
  );

  assertEquals(
    await runLoweringExport(path, "at", [{
      kind: "signed-integer-64",
      value: 41n,
    }]),
    { kind: "signed-integer-64", value: 42n },
  );
});

// Narrower and wider are still two records: a `{ .x; }` is really built at one
// call site and a `{ .x; .y; }` at the other, and taking the widest would read
// a field the first value does not have.
Deno.test("subset shapes at one generalized projection specialize too", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "subset-shapes.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "let get_x = fn v => v.x;",
      "sig at = Int -> Int;",
      "let at = fn n => get_x { .x = n; } + get_x { .x = 1; .y = n; };",
      "return { .at = at; };",
    ].join("\n"),
  );

  assertEquals(
    await runLoweringExport(path, "at", [{
      kind: "signed-integer-64",
      value: 41n,
    }]),
    { kind: "signed-integer-64", value: 42n },
  );
});

// The same generalized function, reached through a `let`-bound forwarder: the
// chain of instantiations is what the copies record, and the shape has to
// survive both of them.
Deno.test("a generalized projection keeps its shape through a forwarder", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "forwarded-shape.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "let get_x = fn v => v.x;",
      "let twice = fn v => get_x v + get_x v;",
      "sig at = Int -> Int;",
      "let at = fn n => twice { .x = n; .y = 0; };",
      "return { .at = at; };",
    ].join("\n"),
  );

  assertEquals(
    await runLoweringExport(path, "at", [{
      kind: "signed-integer-64",
      value: 21n,
    }]),
    { kind: "signed-integer-64", value: 42n },
  );
});

Deno.test("a generalized projection keeps its shape after escaping through identity", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "escaped-shape.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "let get_x = fn value => value.x;",
      "let identity = fn value => value;",
      "let escaped = identity get_x;",
      "sig at = Int -> Int;",
      "let at = fn n => escaped { .x = n; .y = 0; } +",
      "  escaped { .x = 0; .z = n; };",
      "return { .at = at; };",
    ].join("\n"),
  );

  assertEquals(
    await runLoweringExport(path, "at", [{
      kind: "signed-integer-64",
      value: 41n,
    }]),
    { kind: "signed-integer-64", value: 41n },
  );
});

Deno.test("a runtime function choice specializes once per concrete shape", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "runtime-function-choice.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "sig run = Int -> Int;",
      "let run = fn flag => do",
      "  let selected = if flag > 0 then fn value => value.x",
      "    else fn value => value.x end;",
      "  let left = selected { .x = 20; .y = 1; };",
      "  let right = selected { .x = 22; .z = 2; };",
      "  return left + right;",
      "end;",
      "return { .run = run; };",
    ].join("\n"),
  );

  for (const flag of [0n, 1n]) {
    assertEquals(
      await runLoweringExport(path, "run", [{
        kind: "signed-integer-64",
        value: flag,
      }]),
      { kind: "signed-integer-64", value: 42n },
    );
  }
});

// A `let`-bound function that destructures rather than projects reads the same
// fact through the pattern, so it has to follow the copies too.
Deno.test("a generalized destructuring takes its shape from the call site", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "flowed-pattern.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "let get_x = fn v => do let { .x = a; } = v; return a; end;",
      "sig at = Int -> Int;",
      "let at = fn n => get_x { .x = n; .y = 0; };",
      "return { .at = at; };",
    ].join("\n"),
  );

  assertEquals(
    await runLoweringExport(path, "at", [{
      kind: "signed-integer-64",
      value: 41n,
    }]),
    { kind: "signed-integer-64", value: 41n },
  );
});

Deno.test("a destructured parameter takes its shape from each call site", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "parameter-pattern-shapes.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "let get_x = fn { .x = value; } => value;",
      "sig at = Int -> Int;",
      "let at = fn n => get_x { .x = n; .y = 0; } +",
      "  get_x { .x = 0; .z = n; };",
      "return { .at = at; };",
    ].join("\n"),
  );

  assertEquals(
    await runLoweringExport(path, "at", [{
      kind: "signed-integer-64",
      value: 41n,
    }]),
    { kind: "signed-integer-64", value: 41n },
  );
});

Deno.test("call specialization preserves a lambda's lexical captures", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "lexical-specialization.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "let value = 1;",
      "let read = fn () => value;",
      "let value = 2;",
      "sig at = Unit -> Int;",
      "let at = fn _ => read ();",
      "return { .at = at; };",
    ].join("\n"),
  );

  assertEquals(
    await runLoweringExport(path, "at", [{ kind: "unit" }]),
    { kind: "signed-integer-64", value: 1n },
  );
});

Deno.test("structural specialization crosses an imported module", async () => {
  const directory = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(directory, "projection.blot"),
    "return { .get_x = fn value => value.x; };",
  );
  const path = join(directory, "root.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      'const projection = @import "./projection.blot" ();',
      "return projection.get_x { .x = 1; .y = 2; } +",
      "  projection.get_x { .x = 3; .z = 4; };",
    ].join("\n"),
  );

  await validateLowering(path);
});

Deno.test("Store values cross named exports as arrays", async () => {
  assertEquals(
    await runLoweringExport("examples/types.blot", "record_fields"),
    {
      kind: "array",
      values: [
        { kind: "text", value: "code" },
        { kind: "text", value: "label" },
      ],
    },
  );
});

Deno.test("indexed iteration carries a bounds proof into a dynamic loop", async () => {
  const path = await fixture("indexed-runtime.blot", [
    'open @import "blot:prelude" ();',
    "sig sum = [Int] -> Int;",
    "let sum = fn values => do",
    "  let total = 0;",
    "  for (index, _) in Iter.indexed values do",
    "    total := total + @array.get values index;",
    "  end;",
    "  return total;",
    "end;",
    "return { .sum = sum; };",
  ]);
  assertEquals(
    await runLoweringExport(path, "sum", [{
      kind: "array",
      values: [2n, 3n, 5n].map((value) => ({
        kind: "signed-integer-64" as const,
        value,
      })),
    }]),
    { kind: "signed-integer-64", value: 10n },
  );
});

/** Every Store update the lowering emitted, and which of them write in place. */
async function storeUpdates(
  path: string,
): Promise<readonly { readonly kind: string; readonly owned: boolean }[]> {
  const loaded = await load(path);
  const checked = await checkFile(path);
  const lowered = lowerModule(loaded.module, checked, checked.values);
  const pending: unknown[] = lowered.definitions.map((definition) =>
    definition.body
  );
  const updates: { readonly kind: string; readonly owned: boolean }[] = [];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    const expression = value as Record<string, unknown>;
    if (expression.kind === "store-write" || expression.kind === "store-grow") {
      updates.push({
        kind: expression.kind,
        owned: expression.owned === true,
      });
    }
    pending.push(...Object.values(expression));
  }
  return updates;
}

async function fixture(
  name: string,
  lines: readonly string[],
): Promise<string> {
  const path = join(await Deno.makeTempDir(), name);
  await Deno.writeTextFile(path, lines.join("\n"));
  return path;
}

Deno.test("linear array updates carry ownership into gpufuck Store operations", async () => {
  const updates = await storeUpdates(
    await fixture("owned-arrays.blot", [
      "let shared = [1, 2, 3];",
      "let copied = @array.set shared 0 4;",
      "let !set_source = [1, 2, 3];",
      "let replaced = @array.set set_source 0 4;",
      "let !push_source = [1, 2, 3];",
      "let appended = @array.push push_source 4;",
      "return @int.add (@int.add (@array.get copied 0) (@array.get replaced 0)) (@array.get appended 3);",
    ]),
  );

  assertEquals(
    updates.filter((update) => update.owned).map((update) => update.kind)
      .sort(),
    ["store-grow", "store-write"],
  );
  assert(
    updates.some((update) => update.kind === "store-write" && !update.owned),
    "shared array updates must remain persistent",
  );
});

// A recursive group's members call each other in an order the block never wrote
// down, so a read inside one is not the array's death just because the walk
// reached it last. Writing in place there would overwrite what `peek` still
// reads, and the program's value would depend on which member was declared
// first — a wrong answer out of a program that type checks, which is why this
// asserts what the lowering decided rather than that it compiled.
Deno.test("a recursive group member does not own a store its sibling reads", async () => {
  const updates = await storeUpdates(
    await fixture("group-shared-array.blot", [
      'open @import "blot:prelude" ();',
      "let !cells = [7, 2, 3];",
      "let peek = rec (fn n => case Array.get ((&cells), n) of",
      "  #Some value => value,",
      "  #None => 0",
      "end);",
      "let write = rec (fn n => @array.set cells 0 n);",
      "return @int.add (case Array.get (write 1, 0) of",
      "  #Some value => value,",
      "  #None => 0",
      "end) (peek 0);",
    ]),
  );
  assertEquals(updates.filter((update) => update.owned), []);
});

// The refusal is about the second read, not about `rec`. A group holding the
// only read of a linear array still updates it in place — and because the
// group's names are in scope throughout it, the member order does not change
// what is emitted.
for (
  const [order, members] of [
    ["a sibling declared before it", [
      "let start = rec (fn n => case Array.get (bump n, 0) of #Some value => value, #None => 0 end);",
      "let bump = rec (fn n => @array.set cells 0 n);",
    ]],
    ["a sibling declared after it", [
      "let bump = rec (fn n => @array.set cells 0 n);",
      "let start = rec (fn n => case Array.get (bump n, 0) of #Some value => value, #None => 0 end);",
    ]],
  ] as const
) {
  Deno.test(`a recursive group member owns the store it alone reads, called by ${order}`, async () => {
    const updates = await storeUpdates(
      await fixture("group-owned-array.blot", [
        'open @import "blot:prelude" ();',
        "let !cells = [7, 2, 3];",
        ...members,
        "return start 4;",
      ]),
    );
    assertEquals(
      updates.filter((update) => update.owned).map((update) => update.kind),
      ["store-write"],
    );
  });
}

Deno.test("text primitives are self-contained in emitted WebAssembly", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "text-intrinsics.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "return {",
      '  .length = @text.len "a😀";',
      "  .rendered = @text.of_int (-9223372036854775808);",
      '  .ordering = @text.cmp "a" "b";',
      '  .contains = @text.contains "GPU frontend" "front";',
      '  .missing = @text.contains "GPU frontend" "back";',
      "};",
    ].join("\n"),
  );

  assertEquals(await runLoweringExport(path, "length"), {
    kind: "signed-integer-64",
    value: 2n,
  });
  assertEquals(await runLoweringExport(path, "rendered"), {
    kind: "text",
    value: "-9223372036854775808",
  });
  const ordering = await runLoweringExport(path, "ordering");
  assertEquals(
    ordering,
    {
      kind: "constructor",
      name: "Sum0_Less",
      fields: [],
    },
  );
  assertEquals(await runLoweringExport(path, "contains"), {
    kind: "boolean",
    value: true,
  });
  assertEquals(await runLoweringExport(path, "missing"), {
    kind: "boolean",
    value: false,
  });
});

Deno.test("a generalized variant match resolves a wildcard's constructor set", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "generalized-variant.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "let is_some = fn option => case option of",
      "  #Some _ => True,",
      "  _ => False",
      "end;",
      "sig at = Int -> Bool;",
      "let at = fn value => if value > 0 then",
      "  is_some (Some value)",
      "else is_some None end;",
      "return { .at = at; };",
    ].join("\n"),
  );

  assertEquals(
    await runLoweringExport(path, "at", [{
      kind: "signed-integer-64",
      value: 1n,
    }]),
    { kind: "boolean", value: true },
  );
  assertEquals(
    await runLoweringExport(path, "at", [{
      kind: "signed-integer-64",
      value: 0n,
    }]),
    { kind: "boolean", value: false },
  );
});

Deno.test("host effects publish structural first-order imports", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "structural-host.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "const Pair = { .left = Int; .right = Int; };",
      "const Exchange = @effect.host { .swap = Pair -> Pair; };",
      "pair <- Exchange.swap { .left = 20; .right = 22; };",
      "return pair;",
    ].join("\n"),
  );

  const manifest = await validateLowering(path);
  const imported = manifest.imports[0];
  assertEquals(imported?.module, "blot:host/Exchange");
  assertEquals(imported?.name, "swap");
  assertEquals(imported?.function.parameters[0]?.kind, "record");
  assertEquals(imported?.function.result.kind, "record");
});

Deno.test("residual Wasm lowers integer control and structural host effects", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "residual-host-records.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "const Host = @effect.host {",
      "  .read = Unit -> { .kind = Int; .target = Int; };",
      "  .write = { .active = Bool; .kind = Int; .label = Str; } -> Unit;",
      "};",
      "const ready = 1;",
      "event <- Host.read ();",
      "_ <- case event.kind of",
      "  #(ready) => Host.write { .active = True; .kind = event.kind + 1; .label = @text.of_int event.target; },",
      '  _ => Host.write { .active = False; .kind = 0; .label = "idle"; }',
      "end;",
      "return ();",
    ].join("\n"),
  );

  const [outcome] = await buildBatch([path]);
  if (outcome.status === "failed") throw outcome.cause;
  assertEquals(WebAssembly.validate(Uint8Array.from(outcome.wasm)), true);
  assertEquals(outcome.capabilities, ["Host"]);
});

Deno.test("module-result spreads preserve last-wins export staging", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "spread.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "const base = { .a = 1; .kind = Int; };",
      "return { ...base; .a = 2; .b = 3; };",
    ].join("\n"),
  );

  const manifest = await validateLowering(path);
  assertEquals(
    manifest.exports.map((exported) => [
      exported.sourceName,
      exported.phase,
    ]),
    [
      ["a", "runtime"],
      ["kind", "comptime"],
      ["b", "runtime"],
    ],
  );
  assertEquals(await runLoweringExport(path, "a"), {
    kind: "signed-integer-64",
    value: 2n,
  });
  assertEquals(await runLoweringExport(path, "b"), {
    kind: "signed-integer-64",
    value: 3n,
  });
});

Deno.test("residual module-result spreads still declare every export", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "residual-spread.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "const Source = @effect.host { .read = Unit -> Int; };",
      "base <- { .a = Source.read (); .b = 2; };",
      "return { ...base; .a = 3; };",
    ].join("\n"),
  );

  const manifest = await validateLowering(path);
  assertEquals(
    manifest.exports.map((exported) => exported.sourceName),
    ["a", "b"],
  );
  assertEquals(
    manifest.imports.map((imported) => imported.capability),
    ["Source"],
  );
});

Deno.test("proved array reads reach gpufuck with their bounds checks removed", async () => {
  // blot emits the proved read anyway; removing the check is gpufuck's range
  // analysis, and the only way to know it recognises the Core blot emits is to
  // read the count back. A proof nothing downstream acts on is a diagnostic
  // wearing an optimization's clothes.
  const directory = await Deno.makeTempDir();
  const path = join(directory, "proved-read.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "sig at = Int -> Int;",
      "let at = fn value => do",
      "  let [only] = [value];",
      "  return only;",
      "end;",
      "return { .at = at; };",
    ].join("\n"),
  );

  const built = await build(path);
  assert(
    built.storeReads.total > 0,
    "the fixture must keep a Store read for this to measure anything",
  );
  assertEquals(built.storeReads.proven, built.storeReads.total);
});

Deno.test("a reachable @panic traps with the reason the program gave", async () => {
  // `@panic` is what a program says instead of an arm it cannot write, so the
  // arm it lives in is reachable by construction — it must survive lowering.
  // A host effect keeps the scrutinee out of the comptime evaluator's reach,
  // which is the only way this arm gets past specialization at all.
  const directory = await Deno.makeTempDir();
  const path = join(directory, "panic.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "const Source = @effect.host { .read = Unit -> Int; };",
      "sig pick = Int -> Int;",
      "let pick = fn n => case n of",
      "  0 => 100,",
      '  _ => @panic "pick expects zero"',
      "end;",
      "value <- Source.read ();",
      "return { .ok = pick value; };",
    ].join("\n"),
  );

  const manifest = await validateLowering(path);
  assertEquals(manifest.exports.map((exported) => exported.sourceName), ["ok"]);
});

Deno.test("an unused pure binding does not reach Core", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "unused-panic.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      'let unused = @panic "unused";',
      "return { .answer = 42; };",
    ].join("\n"),
  );

  assertEquals(await runLoweringExport(path, "answer"), {
    kind: "signed-integer-64",
    value: 42n,
  });
});

/**
 * The SIMD opcodes an artifact contains.
 *
 * Every SIMD instruction is the `0xfd` prefix and a LEB128 opcode, so this
 * reads the emitted code rather than any claim the compiler makes about it.
 * Custom sections can contain the same byte in metadata, including encoded
 * branch-hint offsets, so only section 10 can provide instruction evidence.
 */
function simdOpcodes(bytes: Uint8Array): Set<number> {
  const opcodes = new Set<number>();
  let sectionStart = 8;
  while (sectionStart < bytes.length) {
    const sectionId = bytes[sectionStart];
    let sectionSize = 0;
    let sectionSizeShift = 0;
    sectionStart += 1;
    while (true) {
      const sizeByte = bytes[sectionStart];
      sectionStart += 1;
      sectionSize |= (sizeByte & 0x7f) << sectionSizeShift;
      if ((sizeByte & 0x80) === 0) break;
      sectionSizeShift += 7;
    }
    const sectionEnd = sectionStart + sectionSize;
    if (sectionEnd > bytes.length) {
      throw new Error(
        `Wasm section ${sectionId} ends at ${sectionEnd}, past ${bytes.length}`,
      );
    }
    if (sectionId !== 10) {
      sectionStart = sectionEnd;
      continue;
    }
    for (let index = sectionStart; index < sectionEnd - 2; index += 1) {
      if (bytes[index] !== 0xfd) continue;
      let opcode = bytes[index + 1] & 0x7f;
      if ((bytes[index + 1] & 0x80) !== 0) {
        opcode |= (bytes[index + 2] & 0x7f) << 7;
      }
      opcodes.add(opcode);
    }
    return opcodes;
  }
  return opcodes;
}

Deno.test("four-lane operations become SIMD instructions", async () => {
  // The scalar bodies gpufuck ships are what the comptime evaluator agrees
  // with, so a program whose vectors all fold is proof of meaning and not of
  // instructions — `examples/vectors.blot` is exactly that program.
  // `examples/simd.blot` is the one that cannot fold: its lanes come out of a
  // block only the host can run, so the whole chain has to reach the artifact.
  // Compiling a file from the catalog rather than a string literal is the
  // point — the program these opcodes belong to is one a reader can run.
  const built = await build(join("examples", "simd.blot"));
  const opcodes = simdOpcodes(built.wasm);
  assert(opcodes.has(19), "expected f32x4.splat");
  assert(opcodes.has(228), "expected f32x4.add");
  assert(opcodes.has(229), "expected f32x4.sub");
  assert(opcodes.has(230), "expected f32x4.mul");
  assert(opcodes.has(231), "expected f32x4.div");
  assert(opcodes.has(65), "expected f32x4.eq");
  assert(opcodes.has(67), "expected f32x4.less");
  assert(opcodes.has(82), "expected v128.bitselect");
  assert(opcodes.has(13), "expected i8x16.shuffle");
  assert(opcodes.has(31), "expected f32x4.extract_lane");
});

Deno.test("integer vector operations become SIMD instructions", async () => {
  const path = await fixture("integer-simd.blot", [
    'open @import "blot:prelude" ();',
    "const Sample = @effect.host { .next = Int -> Int; };",
    "a <- Sample.next 0;",
    "b <- Sample.next 1;",
    "c <- Sample.next 2;",
    "d <- Sample.next 3;",
    "let values = Int32x4.of_wrapping (a, b, c, d);",
    "let shifted = Int32x4.shift_left values 1;",
    "let bounded = Int32x4.max_signed shifted (Int32x4.splat_wrapping (@int.neg 12));",
    "let negative = Int32x4.less_signed bounded (Int32x4.splat 0);",
    "const selected = 2;",
    "return @int.add (Int32x4.mask_bits negative) (Int32x4.lane values selected);",
  ]);
  const hir = await prepareGpupaperHir(path);
  const vectorOperators = hir.functions.flatMap((function_) =>
    function_.blocks.flatMap((block) =>
      block.operations.flatMap((operation) =>
        operation.kind === "vector" ? [operation.operator] : []
      )
    )
  );
  const [outcome] = await buildBatch([path]);
  if (outcome.status !== "built") throw outcome.cause;
  const opcodes = simdOpcodes(outcome.wasm);
  const found = [...opcodes].sort((left, right) => left - right).join(", ");
  assert(
    opcodes.has(17),
    `expected i32x4.splat, found ${found}; HIR ${vectorOperators.join(", ")}`,
  );
  assert(opcodes.has(171), `expected i32x4.shl, found ${found}`);
  assert(opcodes.has(184), `expected i32x4.max_s, found ${found}`);
  assert(opcodes.has(164), `expected i32x4.bitmask, found ${found}`);
  assert(opcodes.has(27), `expected i32x4.extract_lane, found ${found}`);
});

Deno.test("unlikely conditions become Wasm branch metadata", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "unlikely.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "const Source = @effect.host { .ready = Unit -> Bool; };",
      "ready <- Source.ready ();",
      "return if unlikely ready then 1 else 2 end;",
    ].join("\n"),
  );
  const built = await build(path);
  const module = new WebAssembly.Module(Uint8Array.from(built.wasm));
  const [section] = WebAssembly.Module.customSections(
    module,
    "metadata.code.branch_hint",
  );
  assert(section !== undefined, "branch metadata custom section is missing");

  const bytes = new Uint8Array(section);
  let offset = 0;
  const unsigned = () => {
    let value = 0;
    let shift = 0;
    while (true) {
      const byte = bytes[offset++];
      assert(byte !== undefined, "branch metadata ended inside an integer");
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
    }
  };
  const directions: number[] = [];
  const functionCount = unsigned();
  for (
    let functionIndex = 0;
    functionIndex < functionCount;
    functionIndex += 1
  ) {
    unsigned();
    const hintCount = unsigned();
    for (let hintIndex = 0; hintIndex < hintCount; hintIndex += 1) {
      unsigned();
      assertEquals(unsigned(), 1);
      directions.push(unsigned());
    }
  }
  assert(
    directions.includes(0),
    "the annotated condition was not marked likely false",
  );
});

Deno.test("a horizontal sum lowers to gpufuck's reduction", async () => {
  // The other half of `examples/simd.blot`, and the half no opcode can state:
  // a horizontal add has no instruction of its own, so `Vec4.sum` is proved by
  // what blot emitted rather than by what the bytes contain. `ReduceAdd` is
  // gpufuck's, and taking it is what keeps `dot` from becoming the four
  // extracts and three adds it would be if blot wrote the reduction itself.
  const path = join("examples", "simd.blot");
  const loaded = await load(path);
  const checked = await checkFile(path);
  const lowered = lowerModule(loaded.module, checked, checked.values);

  // gpufuck's own bodies are spliced in alongside blot's, and they name
  // `ReduceAdd` whether or not the program summed anything — so only the
  // definitions blot lowered from source can answer this.
  const printable = (_key: string, value: unknown) => {
    if (typeof value === "bigint") return String(value);
    return value;
  };
  const written = lowered.definitions.filter((definition) =>
    !definition.name.startsWith("$")
  );
  const reduced = written.filter((definition) =>
    JSON.stringify(definition, printable).includes('"$F32x4ReduceAdd"')
  );
  // `Vec4.sum` is an eta-expansion of the primitive, so it is no longer a
  // definition at all — it is emitted at the use site, which is what lets the
  // vector reaching it stay in a register. `dot` is a composition rather than
  // a wrapper, so it is still compiled once and called.
  assertEquals(reduced.map((definition) => definition.name.split("$")[0]), [
    "dot",
    "blot",
  ]);
});

Deno.test("Blot SIMD chains stay native through gpufuck let bindings", async () => {
  const path = join("examples", "simd.blot");
  const loaded = await load(path);
  const checked = await checkFile(path);
  const lowered = lowerModule(loaded.module, checked, checked.values);
  const encoded = buildSurfaceModule(
    lowered.definitions,
    lowered.types,
    lowered.entry,
    loaded.source.length,
    {
      evaluationProfile: EvaluationProfile.StrictEager,
      hostCapabilities: lowered.capabilities,
      hostDefinitions: lowered.hostDefinitions,
    },
  );
  const compilation = await new CpuCompiler().compileModule(encoded);
  assert(
    compilation.ok,
    compilation.ok ? undefined : compilation.diagnostics[0].message,
  );
  if (!compilation.ok) return;
  try {
    const trace = new CompilerPerformanceTrace();
    await compileModuleToWasm(compilation.module, {
      simd: "wasm-simd",
      trace,
    });
    const emission = trace.snapshot().find((event) =>
      event.stage === "wasm.emit"
    );
    assert(
      emission !== undefined,
      "gpufuck omitted its Wasm emission measurement",
    );
    const nativeCalls = emission.annotations.nativeF32x4CallSites;
    const nativeLets = emission.annotations.nativeF32x4LetBindings;
    assertEquals(nativeCalls, 0);
    assertEquals(nativeLets, 2);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("a prelude wrapper over a primitive is not a definition", async () => {
  // The prelude spells its operations as closures because a primitive is not a
  // value a record can hold. A closure that only passes its arguments along in
  // order is that primitive, and hoisting it into a definition costs a call —
  // and, for a vector, costs the register, because gpufuck decides what can
  // stay native from the shape of the Core it is handed.
  const path = join("examples", "simd.blot");
  const loaded = await load(path);
  const checked = await checkFile(path);
  const lowered = lowerModule(loaded.module, checked, checked.values);

  const names = lowered.definitions
    .filter((definition) => !definition.name.startsWith("$"))
    .map((definition) => definition.name.split("$")[0]);

  for (const wrapper of ["add", "mul", "sub", "splat", "of", "sum", "x"]) {
    assertEquals(
      names.includes(wrapper),
      false,
      `${wrapper} is an eta-expansion and should have been emitted inline`,
    );
  }
  // A composition still earns its definition: `dot` is a multiply and a sum,
  // not a pass-through.
  assertEquals(names.includes("dot"), true);
});

Deno.test("a program with no vectors carries none of their machinery", async () => {
  // The declarations and the scalar bodies are emitted only when a module used
  // them, so this is what keeps them out of every other artifact.
  const directory = await Deno.makeTempDir();
  const path = join(directory, "plain.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "const Source = @effect.host { .read = Unit -> Int; };",
      "value <- Source.read ();",
      "return value + 1;",
    ].join("\n"),
  );

  const built = await build(path);
  // The declarations and the scalar bodies are the thing being kept out, and
  // their names survive into the artifact as text — so this looks for them
  // rather than for instructions, which a scalar module would lack anyway and
  // which would therefore pass without testing the claim.
  const text = new TextDecoder("utf-8", { fatal: false })
    .decode(new Uint8Array(built.wasm));
  assertEquals(text.includes("$FunctionalF32x4"), false);
  assertEquals([...simdOpcodes(built.wasm)], []);
});

Deno.test("scalar floats cross the boundary while F32x4 remains private", async () => {
  // The domain switches that produce a boundary type used to end in a `text`
  // fallthrough, so a domain none of them named was published as `Text` and
  // the diagnostic arrived from inside gpufuck as a type mismatch. Both float
  // domains and the vector now say what they are. Scalars have canonical ABI
  // layouts; the private four-lane representation still does not.
  const directory = await Deno.makeTempDir();
  const write = async (name: string, result: string) => {
    const path = join(directory, `${name}.blot`);
    await Deno.writeTextFile(
      path,
      ['open @import "blot:prelude" ();', `return ${result};`].join(
        "\n",
      ),
    );
    return path;
  };

  const vector = await write("vector", "Vec4.splat (Float32.of_int 1)");
  const single = await write("single", "Float32.of_int 1");
  await assertRejects(
    () => validateLowering(vector),
    Error,
    "BLOT_VECTOR_AT_BOUNDARY",
  );
  const manifest = await validateLowering(single);
  assertEquals(manifest.exports[0]?.function?.result, { kind: "float-32" });
  const built = await build(single);
  const { instance } = await WebAssembly.instantiate(
    Uint8Array.from(built.wasm),
  );
  const exported = instance.exports["blot:default"];
  assert(typeof exported === "function");
  assertEquals(exported(), Math.fround(1));
});

/**
 * A tuple `case` compiled and run, as one integer per column.
 *
 * The emitted Wasm is the thing under test rather than the lowering's shape:
 * a mis-projected element or a reordered arm is a wrong *answer*, and only
 * running it says which answer came out.
 */
async function tupleCase(
  directory: string,
  name: string,
  lines: readonly string[],
): Promise<unknown> {
  const path = join(directory, `${name}.blot`);
  await Deno.writeTextFile(
    path,
    ['open @import "blot:prelude" ();', ...lines].join("\n"),
  );
  return await runLowering(path);
}

Deno.test("a tuple `case` reads each element from its own position", async () => {
  // Both columns hold an integer, so swapping them is a wrong answer and not a
  // type error. `9 - 4` is the whole assertion.
  const directory = await Deno.makeTempDir();
  assertEquals(
    await tupleCase(directory, "columns", [
      "let difference = fn pair => case pair of",
      "  (a, b) => a - b",
      "end;",
      "return difference (9, 4);",
    ]),
    { kind: "signed-integer-64", value: 5n },
  );
});

Deno.test("overlapping tuple arms fire in source order", async () => {
  // `(0, 0)` matches three of these arms. Only the first may run, and the
  // answers are far enough apart that the wrong one cannot be mistaken for
  // arithmetic.
  const directory = await Deno.makeTempDir();
  const quadrant = [
    "let quadrant = fn point => case point of",
    "  (0, 0) => 1,",
    "  (0, _) => 2,",
    "  (_, 0) => 3,",
    "  (x, y) => 4 + x * y",
    "end;",
  ];
  assertEquals(
    await tupleCase(directory, "origin", [
      ...quadrant,
      "return quadrant (0, 0);",
    ]),
    { kind: "signed-integer-64", value: 1n },
  );
  assertEquals(
    await tupleCase(directory, "vertical", [
      ...quadrant,
      "return quadrant (0, 7);",
    ]),
    { kind: "signed-integer-64", value: 2n },
  );
  assertEquals(
    await tupleCase(directory, "horizontal", [
      ...quadrant,
      "return quadrant (7, 0);",
    ]),
    { kind: "signed-integer-64", value: 3n },
  );
  assertEquals(
    await tupleCase(directory, "elsewhere", [
      ...quadrant,
      "return quadrant (2, 3);",
    ]),
    { kind: "signed-integer-64", value: 10n },
  );
});

Deno.test("a tuple `case` matches wider than a pair", async () => {
  // Three and four columns, with the answer built from the positions so that a
  // rotation of them is a different number.
  const directory = await Deno.makeTempDir();
  assertEquals(
    await tupleCase(directory, "three", [
      "let place = fn triple => case triple of",
      "  (a, b, c) => a * 100 + b * 10 + c",
      "end;",
      "return place (1, 2, 3);",
    ]),
    { kind: "signed-integer-64", value: 123n },
  );
  assertEquals(
    await tupleCase(directory, "four", [
      "let score = fn roll => case roll of",
      "  (1, 1, 1, 1) => 100,",
      "  (a, 2, c, d) => a + c + d,",
      "  (a, b, c, d) => a * 1000 + b * 100 + c * 10 + d",
      "end;",
      "return score (1, 1, 1, 1) + score (5, 2, 6, 7) * 10",
      "  + score (1, 3, 5, 7) * 100000;",
    ]),
    // `100 + 18 * 10 + 1357 * 100000`.
    { kind: "signed-integer-64", value: 135700280n },
  );
});

Deno.test("a tuple pattern nests, and a wildcard column tests nothing", async () => {
  const directory = await Deno.makeTempDir();
  const nested = [
    "let nested = fn value => case value of",
    "  ((#Some a, b), #None) => a * b,",
    "  ((#None, b), #Some c) => b + c,",
    "  (_, #Some c) => c,",
    "  _ => 0",
    "end;",
  ];
  assertEquals(
    await tupleCase(directory, "inner_left", [
      ...nested,
      "return nested ((Some 5, 6), None);",
    ]),
    { kind: "signed-integer-64", value: 30n },
  );
  assertEquals(
    await tupleCase(directory, "inner_right", [
      ...nested,
      "return nested ((None, 5), Some 6);",
    ]),
    { kind: "signed-integer-64", value: 11n },
  );
  // The first arm's inner `#Some` matched and its outer `#None` did not, so
  // this falls past both nested arms to the one whose first column is a
  // wildcard — the fall-through has to leave the whole arm, not just its
  // failing column.
  assertEquals(
    await tupleCase(directory, "inner_fallthrough", [
      ...nested,
      "return nested ((Some 5, 6), Some 7);",
    ]),
    { kind: "signed-integer-64", value: 7n },
  );
});

Deno.test("a tuple `case` matches booleans and text as themselves", async () => {
  // `#True` and `#False` are Core's own boolean and text has no constructor to
  // dispatch on, so neither column becomes a tagged value on the way in.
  const directory = await Deno.makeTempDir();
  assertEquals(
    await tupleCase(directory, "mixed", [
      "let label = fn value => case value of",
      '  (#True, "ready") => 1,',
      "  (#True, _) => 2,",
      '  (#False, "ready") => 3,',
      "  (_, _) => 4",
      "end;",
      'return label (True, "ready") + label (True, "busy") * 10',
      '  + label (False, "ready") * 100 + label (False, "busy") * 1000;',
    ]),
    { kind: "signed-integer-64", value: 4321n },
  );
});

Deno.test("an arm naming the whole tuple binds the scrutinee", async () => {
  const directory = await Deno.makeTempDir();
  assertEquals(
    await tupleCase(directory, "whole", [
      "let difference = fn pair => case pair of",
      "  (a, b) => a - b",
      "end;",
      "let rest = fn pair => case pair of",
      "  (0, y) => y,",
      "  whole => difference whole",
      "end;",
      "return rest (0, 8) + rest (9, 4) * 10;",
    ]),
    { kind: "signed-integer-64", value: 58n },
  );
});

Deno.test("a shape inside a tuple pattern specializes at each call site", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "shape_column.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "let total = fn pair => case pair of",
      "  ({ .x; }, #Some b) => x + b,",
      "  _ => 0",
      "end;",
      "sig at = Int -> Int;",
      "let at = fn value =>",
      "  total ({ .x = value; .y = 2; }, Some 3) +",
      "  total ({ .x = 0; .z = value; }, Some 5);",
      "return { .at = at; };",
    ].join("\n"),
  );

  assertEquals(
    await runLoweringExport(path, "at", [{
      kind: "signed-integer-64",
      value: 41n,
    }]),
    { kind: "signed-integer-64", value: 49n },
  );
});

// A recursive group has to survive lowering as one Core `let-rec-group`. Two
// separate `let-rec`s would put each name in scope only after the other's body
// was built, which is the arrangement the surface rule exists to replace.
Deno.test("a `let` recursive group reaches WebAssembly", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "mutual.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "let is_even = rec (fn n => if n == 0 then 1 else is_odd (n - 1) end);",
      "let is_odd = rec (fn n => if n == 0 then 0 else is_even (n - 1) end);",
      "return is_even 11;",
    ].join("\n"),
  );

  assertEquals(await runLowering(path), {
    kind: "signed-integer-64",
    value: 0n,
  });
});

// Each member's lambda captures the block it is written in, so the group has
// to stay a *local* binding. Lifting the members to top-level definitions
// would strand `step`.
Deno.test("a recursive group's members keep what they captured", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "captured.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "let total = fn step => do",
      "  let down = rec (fn n => if n < step then 0 else n + up (n - step) end);",
      "  let up = rec (fn n => down n);",
      "  return up 10;",
      "end;",
      "return total 3;",
    ].join("\n"),
  );

  assertEquals(await runLowering(path), {
    kind: "signed-integer-64",
    value: 21n,
  });
});

// A `const` group specializes instead of becoming a `let-rec-group`: each use
// hoists the compile-time closure it names, and the hoisted definitions find
// each other through the environment the checker evaluated them in.
Deno.test("a `const` recursive group reaches WebAssembly", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "mutual_const.blot");
  await Deno.writeTextFile(
    path,
    [
      'open @import "blot:prelude" ();',
      "const even = rec (fn n => if n == 0 then 1 else odd (n - 1) end);",
      "const odd = rec (fn n => if n == 0 then 0 else even (n - 1) end);",
      "let counted = fn n => even n;",
      "return counted 12;",
    ].join("\n"),
  );

  assertEquals(await runLowering(path), {
    kind: "signed-integer-64",
    value: 1n,
  });
});

Deno.test("examples/walker.blot walks its tree in WebAssembly", async () => {
  assertEquals(await runLowering("examples/walker.blot"), {
    kind: "constructor",
    name: "Shape2",
    fields: [
      { kind: "signed-integer-64", value: 45n },
      { kind: "boolean", value: true },
    ],
  });
});
