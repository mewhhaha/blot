import {
  assertEquals,
  assertNotStrictEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { join } from "@std/path";
import { refreshProgram } from "./compiler/frontend.ts";
import { load, LoadError, loadSource, refreshLoadedModules } from "./load.ts";
import { PACKAGE_FORMAT_VERSION } from "./package_format.ts";

Deno.test("refreshing loaded modules rebinds an edited dependency without reparsing its importer", async () => {
  const directory = await Deno.makeTempDir();
  const dependencyPath = join(directory, "dependency.blot");
  const entryPath = join(directory, "entry.blot");
  await Deno.writeTextFile(
    dependencyPath,
    `return 1
`,
  );
  await Deno.writeTextFile(
    entryPath,
    `return import "./dependency.blot"
`,
  );

  const firstEntry = await load(entryPath);
  const firstDependency = firstEntry.dependencies.get("./dependency.blot");
  if (firstDependency === undefined) {
    throw new Error(`loaded ${entryPath} omitted ${dependencyPath}`);
  }

  await Deno.writeTextFile(
    dependencyPath,
    `return 2
`,
  );
  await refreshLoadedModules();
  const secondEntry = await load(entryPath);
  const secondDependency = secondEntry.dependencies.get("./dependency.blot");
  if (secondDependency === undefined) {
    throw new Error(`reloaded ${entryPath} omitted ${dependencyPath}`);
  }

  assertNotStrictEquals(secondEntry, firstEntry);
  assertNotStrictEquals(secondDependency, firstDependency);
  assertStrictEquals(secondEntry.module, firstEntry.module);
  assertEquals(
    secondDependency.source,
    `return 2
`,
  );
});

Deno.test("refreshing loaded modules rebinds an edited include without reparsing its importer", async () => {
  const directory = await Deno.makeTempDir();
  const includedPath = join(directory, "message.txt");
  const dependencyPath = join(directory, "dependency.blot");
  const entryPath = join(directory, "entry.blot");
  await Deno.writeTextFile(includedPath, "first");
  await Deno.writeTextFile(
    dependencyPath,
    `const raw = fn source => source.text
const message = @include "./message.txt" raw
return message
`,
  );
  await Deno.writeTextFile(
    entryPath,
    `return import "./dependency.blot"
`,
  );

  const firstEntry = await load(entryPath);
  const firstDependency = firstEntry.dependencies.get("./dependency.blot");
  if (firstDependency === undefined) {
    throw new Error(`loaded ${entryPath} omitted ${dependencyPath}`);
  }

  await Deno.writeTextFile(includedPath, "second");
  await refreshLoadedModules();
  const secondEntry = await load(entryPath);
  const secondDependency = secondEntry.dependencies.get("./dependency.blot");
  if (secondDependency === undefined) {
    throw new Error(`reloaded ${entryPath} omitted ${dependencyPath}`);
  }

  assertNotStrictEquals(secondEntry, firstEntry);
  assertNotStrictEquals(secondDependency, firstDependency);
  assertStrictEquals(secondEntry.module, firstEntry.module);
  const secondIncluded = secondDependency.includedFiles.get("./message.txt");
  if (secondIncluded === undefined) {
    throw new Error(`reloaded ${dependencyPath} omitted ${includedPath}`);
  }
  assertEquals(secondIncluded.source, "second");
});

Deno.test("loading reports a missing included file at the include site", async () => {
  const directory = await Deno.makeTempDir();
  const entryPath = join(directory, "entry.blot");
  await Deno.writeTextFile(
    entryPath,
    `const raw = fn source => source.text
return @include "./missing.txt" raw
`,
  );

  const failure = await assertRejects(() => load(entryPath), LoadError);
  assertEquals(failure.diagnostics[0]?.code, "BLOT_INCLUDE_NOT_FOUND");
});

Deno.test("compiler dependency parity compares complete specifiers rather than joined text", async () => {
  for (const kind of ["imports", "includes"] as const) {
    let operation = "import";
    if (kind === "includes") operation = "@include";
    const source = `const a = ${operation} "a"\nreturn ${operation} "b"\n`;
    await assertRejects(
      () =>
        loadSource("/parity.blot", source, new Map(), () => ({
          imports: [],
          includes: [],
          [kind]: [{ specifier: "a\0b", span: { start: 0, end: 1 } }],
          moduleHandle: "test-inspection",
          portableAstDigest: "test-digest",
        })),
      Error,
      `${kind} differ between tooling syntax`,
    );
  }
});

Deno.test("refreshProgram re-resolves the process-wide package graph", async () => {
  const directory = await Deno.makeTempDir();
  const packageRoot = join(directory, "node_modules", "answer");
  const root = join(directory, "entry.blot");
  const manifest = join(packageRoot, "blot.json");
  const describe = (source: string): string =>
    JSON.stringify({
      schema: "blot-package",
      version: PACKAGE_FORMAT_VERSION,
      exports: { ".": { source } },
    });
  try {
    await Deno.mkdir(packageRoot, { recursive: true });
    await Deno.writeTextFile(root, 'return import "answer"\n');
    await Deno.writeTextFile(join(packageRoot, "first.blot"), "return 1\n");
    await Deno.writeTextFile(join(packageRoot, "second.blot"), "return 2\n");
    await Deno.writeTextFile(manifest, describe("./first.blot"));
    const first = await refreshProgram(root);
    await Deno.writeTextFile(manifest, describe("./second.blot"));
    const second = await refreshProgram(root);
    assertStrictEquals(second.module, first.module);
    assertEquals(second.dependencies.get("answer")?.source, "return 2\n");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
