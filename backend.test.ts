import { buildSurfaceModule, CpuCompiler, EvaluationProfile } from "gpufuck";
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  runLowering,
  runLoweringExport,
  validateLowering,
} from "./src/backend/compile.ts";
import { lowerModule } from "./src/backend/lower.ts";
import { checkFile } from "./src/check/mod.ts";
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
    wasmName: "blot:one",
    phase: "runtime",
    abi: { kind: "signed-integer-64" },
    arity: 0,
    effects: [],
    ownership: "owned",
  });
  assertEquals(method, {
    sourceName: "method",
    wasmName: null,
    phase: "comptime",
    abi: null,
    arity: 0,
    effects: [],
    ownership: null,
  });
  assertEquals(
    manifest.constructors.find((constructor) =>
      constructor.sourceName === "Centimeter"
    ),
    {
      runtimeName: "Sealed0",
      kind: "sealed",
      sourceName: "Centimeter",
      payload: true,
    },
  );
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
  assertEquals(project?.arity, 1);
  assertEquals(project?.phase, "runtime");
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
  assertEquals(manifest.capabilities, ["Source"]);
});
