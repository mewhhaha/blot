import { execFile } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const exec = promisify(execFile);
const repository = fileURLToPath(new URL("../", import.meta.url));
const output = join(repository, "dist");
const stagedPackage = await mkdtemp(join(repository, ".blot-package-"));
const typescriptCompiler = fileURLToPath(
  new URL("./bin/tsc", import.meta.resolve("typescript/package.json")),
);
let published = false;

try {
  const entryPoints = [
    join(repository, "mod.ts"),
    ...await collectTypeScriptSources(join(repository, "src")),
    ...await collectTypeScriptSources(join(repository, "generated", "wasm")),
  ];
  await build({
    bundle: true,
    entryPoints,
    format: "esm",
    logLevel: "silent",
    outbase: repository,
    outdir: stagedPackage,
    packages: "external",
    platform: "node",
    plugins: [{
      name: "javascript-relative-imports",
      setup(build) {
        build.onResolve({ filter: /^\..*\.ts$/ }, ({ path }) => ({
          external: true,
          path: `${path.slice(0, -3)}.js`,
        }));
      },
    }],
    target: "node22",
  });
  await exec(process.execPath, [
    typescriptCompiler,
    "--allowImportingTsExtensions",
    "--declaration",
    "--emitDeclarationOnly",
    "--module",
    "Preserve",
    "--moduleResolution",
    "Bundler",
    "--noCheck",
    "--outDir",
    stagedPackage,
    "--rewriteRelativeImportExtensions",
    "--rootDir",
    repository,
    "--skipLibCheck",
    "--target",
    "ES2022",
    ...entryPoints,
  ], { cwd: repository });
  await rewriteDeclarationImports(stagedPackage);

  await cp(
    join(repository, "src", "prelude"),
    join(stagedPackage, "src", "prelude"),
    { recursive: true },
  );
  const generatedAssets = [
    "wasm/abi.json",
    "wasm/manifest.json",
    "wasm/parser.plan",
    "wasm/parser.wasm",
    "compiler/compiler.wasm",
    "compiler/compiler-artifact.json",
    "compiler/prelude.snapshot",
  ];
  for (const asset of generatedAssets) {
    const destination = join(stagedPackage, "generated", asset);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(repository, "generated", asset), destination);
  }

  await rm(output, { recursive: true, force: true });
  await rename(stagedPackage, output);
  published = true;
} finally {
  if (!published) await rm(stagedPackage, { recursive: true, force: true });
}

async function collectTypeScriptSources(directory) {
  const sources = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...await collectTypeScriptSources(path));
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      continue;
    }
    sources.push(path);
  }
  return sources;
}

async function rewriteDeclarationImports(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await rewriteDeclarationImports(path);
      continue;
    }
    if (!entry.name.endsWith(".d.ts")) continue;
    const declarationSource = await readFile(path, "utf8");
    const rewritten = declarationSource.replace(
      /(["'])(\.\.?\/[^"']+)\.ts\1/g,
      "$1$2.js$1",
    );
    if (rewritten !== declarationSource) await writeFile(path, rewritten);
  }
}
