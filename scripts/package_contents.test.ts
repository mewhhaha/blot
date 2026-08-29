import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const repository = fileURLToPath(new URL("../", import.meta.url));

interface PackageReport {
  readonly files: readonly { readonly path: string }[];
}

interface RepositoryManifest {
  readonly packageManager?: string;
  readonly devDependencies?: {
    readonly typescript?: string;
  };
}

test("npm package is a runnable distribution", async (context) => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "blot-package-contents-"),
  );
  context.after(() => rm(temporaryDirectory, { recursive: true }));

  const tarball = join(temporaryDirectory, "blot.tgz");
  const { stdout } = await exec(
    "pnpm",
    ["--silent", "pack", "--out", tarball, "--json"],
    { cwd: repository },
  );
  const report = JSON.parse(stdout) as PackageReport;

  await context.test("contains both exported runtimes", () => {
    const paths = new Set(report.files.map((file) => file.path));
    const required = [
      "LICENSE",
      "dist/mod.js",
      "dist/mod.d.ts",
      "dist/src/compiler.js",
      "dist/src/compiler.d.ts",
      "dist/generated/wasm/parser.wasm",
      "dist/generated/wasm/parser.plan",
      "dist/generated/compiler/compiler.wasm",
      "dist/generated/compiler/compiler-artifact.json",
      "dist/generated/compiler/prelude.snapshot",
    ];
    for (const path of required) {
      assert(paths.has(path), `npm package is missing ${path}`);
    }
    for (const path of paths) {
      assert(
        !path.split("/").includes("target"),
        `npm package contains ${path}`,
      );
      assert(!path.endsWith(".test.ts"), `npm package contains ${path}`);
    }
  });

  const repositoryManifest = JSON.parse(
    await readFile(join(repository, "package.json"), "utf8"),
  ) as RepositoryManifest;
  if (repositoryManifest.packageManager === undefined) {
    throw new Error(`package ${repository} has no packageManager`);
  }
  const typescriptVersion = repositoryManifest.devDependencies?.typescript;
  if (typescriptVersion === undefined) {
    throw new Error(
      `package ${repository} has no TypeScript development dependency`,
    );
  }

  const consumer = join(temporaryDirectory, "consumer");
  await mkdir(consumer);
  const consumerEnvironment = { ...process.env };
  delete consumerEnvironment.NODE_OPTIONS;
  delete consumerEnvironment.NODE_PATH;
  await writeFile(
    join(consumer, "package.json"),
    `${
      JSON.stringify(
        {
          name: "blot-package-consumer",
          private: true,
          type: "module",
          packageManager: repositoryManifest.packageManager,
        },
        null,
        2,
      )
    }\n`,
  );
  await exec(
    "pnpm",
    ["add", tarball, `typescript@${typescriptVersion}`],
    { cwd: consumer, env: consumerEnvironment },
  );
  const installedPackages = await readdir(
    join(consumer, "node_modules", ".pnpm"),
  );
  const developmentOnlyPackage = installedPackages.find((name) =>
    name.startsWith("tsx@") || name.startsWith("@types+node@")
  );
  assert.equal(
    developmentOnlyPackage,
    undefined,
    `isolated consumer installed ${developmentOnlyPackage}`,
  );

  await context.test(
    "declarations resolve without repository development types",
    async () => {
      const source = [
        'import { Compiler, DevelopmentProject, DevelopmentRuntime, buildPackage, parse } from "@mewhhaha/blot";',
        'import type { BuiltPackageExport, DevelopmentBuild } from "@mewhhaha/blot";',
        'import { Compiler as CompilerEntry } from "@mewhhaha/blot/compiler";',
        'import type { CompilerHost } from "@mewhhaha/blot/compiler";',
        'const parsed: Awaited<ReturnType<typeof parse>> = await parse("return 42\\n");',
        "const compiler: CompilerHost = await Compiler.create();",
        "const runtime = new DevelopmentRuntime();",
        "const projectClass: typeof DevelopmentProject = DevelopmentProject;",
        "const build: DevelopmentBuild | undefined = undefined;",
        "const compilerEntry: typeof Compiler = CompilerEntry;",
        "const built: readonly BuiltPackageExport[] =",
        '  await buildPackage("./blot.json");',
        "compiler.destroy();",
        "void parsed;",
        "void runtime;",
        "void projectClass;",
        "void build;",
        "void compilerEntry;",
        "void built;",
      ].join("\n");
      const consumerSource = join(consumer, "consumer.mts");
      await writeFile(consumerSource, source);
      await exec(
        process.execPath,
        [
          join(consumer, "node_modules", "typescript", "bin", "tsc"),
          "--noEmit",
          "--strict",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--target",
          "ES2022",
          consumerSource,
        ],
        { cwd: consumer, env: consumerEnvironment },
      );
    },
  );

  await context.test("entry points run in plain Node", async () => {
    const program = [
      'import { Compiler, DevelopmentProject, DevelopmentRuntime, parse } from "@mewhhaha/blot";',
      'import { Compiler as CompilerEntry } from "@mewhhaha/blot/compiler";',
      'if (Compiler !== CompilerEntry) throw new Error("compiler exports differ");',
      'if (typeof DevelopmentProject !== "function") throw new Error("development project export is missing");',
      'if (typeof DevelopmentRuntime !== "function") throw new Error("development runtime export is missing");',
      'const parsed = await parse("return 42\\n");',
      'if (!parsed.ok) throw new Error("packed parser rejected minimal source");',
      "const compiler = await Compiler.create();",
      "try {",
      "  const checked = await compiler.checkSource(",
      '    "/tmp/blot-packed-minimal.blot",',
      '    "return 42\\n",',
      "  );",
      '  if (checked.type !== "42" || checked.effects !== "") {',
      "    throw new Error(`packed compiler returned ${checked.type} ${checked.effects}`);",
      "  }",
      "} finally {",
      "  compiler.destroy();",
      "}",
    ].join("\n");
    await exec(
      process.execPath,
      ["--input-type=module", "--eval", program],
      { cwd: consumer, env: consumerEnvironment },
    );
  });

  await context.test("Node APIs need no compatibility preload", async () => {
    const program = [
      'import { LanguageService, buildPackage } from "@mewhhaha/blot";',
      'import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";',
      'import { tmpdir } from "node:os";',
      'import { join } from "node:path";',
      'import { pathToFileURL } from "node:url";',
      'if ("Deno" in globalThis) throw new Error("plain Node unexpectedly exposes Deno");',
      'const directory = await mkdtemp(join(tmpdir(), "blot-packed-apis-"));',
      "try {",
      '  const sourceDirectory = join(directory, "src");',
      "  await mkdir(sourceDirectory);",
      '  await writeFile(join(sourceDirectory, "mod.blot"), "return 42\\n");',
      '  const manifest = join(directory, "blot.json");',
      "  await writeFile(manifest, JSON.stringify({",
      '    schema: "blot-package",',
      "    version: 4,",
      "    exports: {",
      '      ".": { source: "./src/mod.blot", built: "./dist/mod.blotc" },',
      "    },",
      "  }));",
      "  const built = await buildPackage(manifest);",
      "  if (built.length !== 1 || built[0].bytes === 0) {",
      '    throw new Error("packed package builder omitted its artifact");',
      "  }",
      '  const uri = pathToFileURL(join(directory, "editor.blot")).href;',
      '  const dependency = join(directory, "missing.blot");',
      '  await writeFile(dependency, "return 1\\n");',
      "  const service = new LanguageService();",
      "  try {",
      '    service.open(uri, "const missing = import \\"./missing.blot\\"\\nreturn missing\\n", 1);',
      "    await service.formatting(uri);",
      "    await rm(dependency);",
      "    const hints = await service.inlayHints(uri);",
      '    if (!Array.isArray(hints)) throw new Error("language service omitted hints");',
      "  } finally {",
      "    await service.destroy();",
      "  }",
      "} finally {",
      "  await rm(directory, { recursive: true });",
      "}",
    ].join("\n");
    await exec(
      process.execPath,
      ["--input-type=module", "--eval", program],
      { cwd: consumer, env: consumerEnvironment },
    );
  });
});
