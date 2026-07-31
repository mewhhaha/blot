import { buildSurfaceModule, CpuCompiler, EvaluationProfile } from "gpufuck";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  runLowering,
  runLoweringExport,
  validateLowering,
} from "./src/backend/compile.ts";
import { lowerModule } from "./src/backend/lower.ts";
import { checkFile } from "./src/check/mod.ts";
import { BlotError } from "./src/diagnostic.ts";
import { load } from "./src/load.ts";

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

Deno.test("runtime integer overflow traps in emitted WebAssembly", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "overflow.blot");
  await Deno.writeTextFile(
    path,
    [
      'open {} = (@import "blot:prelude") ();',
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
      'open {} = (@import "blot:prelude") ();',
      "sig increment = Int -> Int;",
      "let increment = value => value + 1;",
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

Deno.test("a concrete record signature specializes an exported projection", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "record-export.blot");
  await Deno.writeTextFile(
    path,
    [
      'open {} = (@import "blot:prelude") ();',
      "const Point = { .x = Int; .y = Int; };",
      "sig project = Point -> Int;",
      "let project = point => point.x;",
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
      'open {} = (@import "blot:prelude") ();',
      "let get_x = v => v.x;",
      "sig at = Int -> Int;",
      "let at = n => get_x { .x = n; .y = 0; };",
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

// The catalog's rejection: `blot check` accepts it, and lowering names both
// shapes at the projection that sees them.
Deno.test("examples/rejected/semantics/shape_disagreement.blot names both shapes", async () => {
  const path = join(
    "examples/rejected/semantics",
    "shape_disagreement.blot",
  );
  await checkFile(path);
  const error = await assertRejects(
    () => validateLowering(path),
    BlotError,
  );
  assertEquals(error.diagnostic.code, "BLOT_SHAPE_DISAGREEMENT");
  assertStringIncludes(error.diagnostic.message, "{ .x; .y; }");
  assertStringIncludes(error.diagnostic.message, "{ .x; .z; }");
  const source = await Deno.readTextFile(path);
  assertEquals(
    source.slice(error.diagnostic.span.start, error.diagnostic.span.end),
    "v.x",
  );
});

// Width subtyping accepts this; Core records are invariant, so there is no one
// nominal for both call sites. The union `.x .y .z` would be a record the
// program never writes, so lowering names both shapes instead of picking one.
Deno.test("two shapes at one generalized projection are refused, not merged", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "two-shapes.blot");
  await Deno.writeTextFile(
    path,
    [
      'open {} = (@import "blot:prelude") ();',
      "let get_x = v => v.x;",
      "sig at = Int -> Int;",
      "let at = n => get_x { .x = n; .y = 0; } + get_x { .x = 1; .z = n; };",
      "return { .at = at; };",
    ].join("\n"),
  );

  const error = await assertRejects(
    () => validateLowering(path),
    BlotError,
  );
  assertEquals(error.diagnostic.code, "BLOT_SHAPE_DISAGREEMENT");
  assertStringIncludes(error.diagnostic.message, "{ .x; .y; }");
  assertStringIncludes(error.diagnostic.message, "{ .x; .z; }");
});

// Narrower and wider are still two records: a `{ .x; }` is really built at one
// call site and a `{ .x; .y; }` at the other, and taking the widest would read
// a field the first value does not have.
Deno.test("subset shapes at one generalized projection are refused too", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "subset-shapes.blot");
  await Deno.writeTextFile(
    path,
    [
      'open {} = (@import "blot:prelude") ();',
      "let get_x = v => v.x;",
      "sig at = Int -> Int;",
      "let at = n => get_x { .x = n; } + get_x { .x = 1; .y = n; };",
      "return { .at = at; };",
    ].join("\n"),
  );

  const error = await assertRejects(
    () => validateLowering(path),
    BlotError,
  );
  assertEquals(error.diagnostic.code, "BLOT_SHAPE_DISAGREEMENT");
  assertStringIncludes(error.diagnostic.message, "{ .x; }");
  assertStringIncludes(error.diagnostic.message, "{ .x; .y; }");
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
      'open {} = (@import "blot:prelude") ();',
      "let get_x = v => v.x;",
      "let twice = v => get_x v + get_x v;",
      "sig at = Int -> Int;",
      "let at = n => twice { .x = n; .y = 0; };",
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

// A `let`-bound function that destructures rather than projects reads the same
// fact through the pattern, so it has to follow the copies too.
Deno.test("a generalized destructuring takes its shape from the call site", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "flowed-pattern.blot");
  await Deno.writeTextFile(
    path,
    [
      'open {} = (@import "blot:prelude") ();',
      "let get_x = v => do let { .x = a; } = v; in a end;",
      "sig at = Int -> Int;",
      "let at = n => get_x { .x = n; .y = 0; };",
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

Deno.test("text primitives are self-contained in emitted WebAssembly", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "text-intrinsics.blot");
  await Deno.writeTextFile(
    path,
    [
      'open {} = (@import "blot:prelude") ();',
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

Deno.test("host effects publish structural first-order imports", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "structural-host.blot");
  await Deno.writeTextFile(
    path,
    [
      'open {} = (@import "blot:prelude") ();',
      "const Pair = { .left = Int; .right = Int; };",
      "const Exchange = @effect.host { .swap = Pair -> Pair; };",
      "return Exchange.swap { .left = 20; .right = 22; };",
    ].join("\n"),
  );

  const manifest = await validateLowering(path);
  const imported = manifest.imports[0];
  assertEquals(imported?.module, "blot:host/Exchange");
  assertEquals(imported?.name, "swap");
  assertEquals(imported?.function.parameters[0]?.kind, "record");
  assertEquals(imported?.function.result.kind, "record");
});

Deno.test("module-result spreads preserve last-wins export staging", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "spread.blot");
  await Deno.writeTextFile(
    path,
    [
      'open {} = (@import "blot:prelude") ();',
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
      'open {} = (@import "blot:prelude") ();',
      "const Source = @effect.host { .read = Unit -> Int; };",
      "let base = { .a = Source.read (); .b = 2; };",
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
