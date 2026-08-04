import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { buildPackage } from "./package.ts";
import {
  decodeModuleCapsule,
  PACKAGE_FORMAT_VERSION,
  PackageArtifactError,
  readPackageManifest,
} from "./package_format.ts";
import { load } from "./load.ts";
import { evaluateFile } from "./run.ts";
import { buildGpupaperBatch } from "./backend/gpupaper.ts";
import { RustMiddleCompiler } from "./backend/rust_middle.ts";

Deno.test("a built package loads its bundled module graph after source removal", async () => {
  const directory = await packageFixture();
  const packageRoot = join(directory, "node_modules", "@example", "answer");
  const manifestPath = join(packageRoot, "blot.json");
  const entryPath = join(directory, "entry.blot");

  const firstBuild = await buildPackage(manifestPath);
  const firstCapsule = await Deno.readTextFile(
    join(packageRoot, "dist", "mod.blotc"),
  );
  const secondBuild = await buildPackage(manifestPath);
  const secondCapsule = await Deno.readTextFile(
    join(packageRoot, "dist", "mod.blotc"),
  );
  assertEquals(firstBuild[0]?.modules, 2);
  assertEquals(secondBuild[0]?.modules, 2);
  assertEquals(secondCapsule, firstCapsule);
  const decodedCapsule = await decodeModuleCapsule(
    firstCapsule,
    join(packageRoot, "dist", "mod.blotc"),
  );
  assertEquals(
    decodedCapsule.modules.some((module) => "source" in module),
    false,
  );

  await Deno.remove(join(packageRoot, "src"), { recursive: true });
  const loaded = await load(entryPath);
  const dependency = loaded.dependencies.get("@example/answer");
  if (dependency === undefined) {
    throw new Error(`${entryPath} omitted @example/answer`);
  }
  assertEquals(dependency.storage.tag, "capsule");
  assertEquals(
    await evaluateFile(entryPath, { write: () => {} }),
    { tag: "int", value: 41n },
  );
  const compiled = await buildGpupaperBatch([entryPath]);
  assertEquals(compiled[0]?.status, "built");
  await assertRustCompiles(entryPath);
});

Deno.test("a corrupt package capsule falls back to its declared source", async () => {
  const directory = await packageFixture();
  const packageRoot = join(directory, "node_modules", "@example", "answer");
  const manifestPath = join(packageRoot, "blot.json");
  const entryPath = join(directory, "entry.blot");
  await buildPackage(manifestPath);

  const capsulePath = join(packageRoot, "dist", "mod.blotc");
  const capsule = await Deno.readTextFile(capsulePath);
  await Deno.writeTextFile(capsulePath, capsule.replace("sha256:", "sha256:x"));

  const loaded = await load(entryPath);
  const dependency = loaded.dependencies.get("@example/answer");
  if (dependency === undefined) {
    throw new Error(`${entryPath} omitted @example/answer`);
  }
  assertEquals(dependency.storage.tag, "source");
  assertEquals(
    await evaluateFile(entryPath, { write: () => {} }),
    { tag: "int", value: 41n },
  );
  await assertRustCompiles(entryPath);
});

Deno.test("a package capsule keeps registry dependencies as shared external edges", async () => {
  const directory = await Deno.makeTempDir();
  const nodeModules = join(directory, "node_modules", "@example");
  const baseRoot = join(nodeModules, "base");
  const derivedRoot = join(nodeModules, "derived");
  await Deno.mkdir(join(baseRoot, "src"), { recursive: true });
  await Deno.mkdir(join(derivedRoot, "src"), { recursive: true });
  await Deno.writeTextFile(
    join(baseRoot, "blot.json"),
    JSON.stringify({
      schema: "blot-package",
      version: PACKAGE_FORMAT_VERSION,
      exports: { ".": { source: "./src/mod.blot" } },
    }),
  );
  await Deno.writeTextFile(join(baseRoot, "src", "mod.blot"), "return 41;");
  await Deno.writeTextFile(
    join(derivedRoot, "blot.json"),
    JSON.stringify({
      schema: "blot-package",
      version: PACKAGE_FORMAT_VERSION,
      exports: {
        ".": { source: "./src/mod.blot", built: "./dist/mod.blotc" },
      },
    }),
  );
  await Deno.writeTextFile(
    join(derivedRoot, "src", "mod.blot"),
    'const base = @import "@example/base"; return base ();',
  );
  const entryPath = join(directory, "entry.blot");
  await Deno.writeTextFile(
    entryPath,
    'const derived = @import "@example/derived"; return derived ();',
  );

  const built = await buildPackage(join(derivedRoot, "blot.json"));
  assertEquals(built[0]?.modules, 1);
  const capsulePath = join(derivedRoot, "dist", "mod.blotc");
  const capsule = await decodeModuleCapsule(
    await Deno.readTextFile(capsulePath),
    capsulePath,
  );
  assertEquals(capsule.modules[0]?.imports, [{
    kind: "external",
    specifier: "@example/base",
  }]);

  await Deno.remove(join(derivedRoot, "src"), { recursive: true });
  assertEquals(
    await evaluateFile(entryPath, { write: () => {} }),
    { tag: "int", value: 41n },
  );
  await assertRustCompiles(entryPath);
});

Deno.test("a relative capsule import compiles without a package manifest lookup", async () => {
  const directory = await packageFixture();
  const packageRoot = join(directory, "node_modules", "@example", "answer");
  await buildPackage(join(packageRoot, "blot.json"));
  await Deno.remove(join(packageRoot, "src"), { recursive: true });
  const entryPath = join(directory, "direct-entry.blot");
  await Deno.writeTextFile(
    entryPath,
    'const answer = @import "./node_modules/@example/answer/dist/mod.blotc"; return (answer ()).answer;',
  );

  assertEquals(
    await evaluateFile(entryPath, { write: () => {} }),
    { tag: "int", value: 41n },
  );
  await assertRustCompiles(entryPath);
});

Deno.test("a package subpath selects its matching manifest export", async () => {
  const directory = await Deno.makeTempDir();
  const packageRoot = join(directory, "node_modules", "@example", "library");
  await Deno.mkdir(join(packageRoot, "src"), { recursive: true });
  await Deno.writeTextFile(
    join(packageRoot, "blot.json"),
    JSON.stringify({
      schema: "blot-package",
      version: PACKAGE_FORMAT_VERSION,
      exports: { "./answer": { source: "./src/answer.blot" } },
    }),
  );
  await Deno.writeTextFile(
    join(packageRoot, "src", "answer.blot"),
    "return 41;",
  );
  const entryPath = join(directory, "entry.blot");
  await Deno.writeTextFile(
    entryPath,
    'const answer = @import "@example/library/answer"; return answer ();',
  );

  assertEquals(
    await evaluateFile(entryPath, { write: () => {} }),
    { tag: "int", value: 41n },
  );
  await assertRustCompiles(entryPath);
});

Deno.test("an explicit capsule import has no source fallback", async () => {
  const directory = await packageFixture();
  const packageRoot = join(directory, "node_modules", "@example", "answer");
  const manifestPath = join(packageRoot, "blot.json");
  await buildPackage(manifestPath);
  const capsulePath = join(packageRoot, "dist", "mod.blotc");
  const capsule = await Deno.readTextFile(capsulePath);
  const changed = capsule.replace("sha256:", "sha256:x");
  await Deno.writeTextFile(capsulePath, changed);
  const entryPath = join(directory, "direct-entry.blot");
  await Deno.writeTextFile(
    entryPath,
    'const answer = @import "./node_modules/@example/answer/dist/mod.blotc"; return (answer ()).answer;',
  );

  const failure = await assertRejects(
    () => load(entryPath),
    PackageArtifactError,
  );
  assertStringIncludes(failure.message, "content hash");
});

Deno.test("package exports cannot escape their package directory", async () => {
  const directory = await Deno.makeTempDir();
  const manifestPath = join(directory, "blot.json");
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      schema: "blot-package",
      version: PACKAGE_FORMAT_VERSION,
      exports: { ".": { source: "../outside.blot" } },
    }),
  );

  const failure = await assertRejects(
    () => readPackageManifest(manifestPath),
    PackageArtifactError,
  );
  assertStringIncludes(failure.message, "escapes its package");
});

async function packageFixture(): Promise<string> {
  const directory = await Deno.makeTempDir();
  const packageRoot = join(directory, "node_modules", "@example", "answer");
  await Deno.mkdir(join(packageRoot, "src"), { recursive: true });
  await Deno.writeTextFile(
    join(packageRoot, "blot.json"),
    JSON.stringify({
      schema: "blot-package",
      version: PACKAGE_FORMAT_VERSION,
      exports: {
        ".": { source: "./src/mod.blot", built: "./dist/mod.blotc" },
      },
    }),
  );
  await Deno.writeTextFile(
    join(packageRoot, "src", "mod.blot"),
    "const as_raw = fn source => source.text;\n" +
      'const message = @include "./message.txt" as_raw;\n' +
      'const dependency = @import "./answer.blot";\n' +
      "return { .answer = dependency (); .message = message; };",
  );
  await Deno.writeTextFile(
    join(packageRoot, "src", "answer.blot"),
    "return 41;",
  );
  await Deno.writeTextFile(join(packageRoot, "src", "message.txt"), "");
  await Deno.writeTextFile(
    join(directory, "entry.blot"),
    'const answer = @import "@example/answer"; return (answer ()).answer;',
  );
  return directory;
}

async function assertRustCompiles(path: string): Promise<void> {
  const compiler = await RustMiddleCompiler.create();
  try {
    const artifact = await compiler.compile(path);
    assertEquals([...artifact.wasm.slice(0, 4)], [0, 97, 115, 109]);
  } finally {
    compiler.destroy();
  }
}
