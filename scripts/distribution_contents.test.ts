// scripts/distribution_contents.test.ts
//
// Proves the shipped artifacts contain the editor runtime: the LSP worker
// hosts, the worker entries, the formatting engine, and the generated
// Wasm/snapshot inputs.
//
// The JSR side runs `deno publish --dry-run` and pins its file list, so a
// publish-config regression fails here instead of at release time. The npm
// side pins package.json's file globs and the bundler's asset list
// statically; the dynamic npm proof (pack the tarball, install it
// isolated, run the built CLI) lives in scripts/package_contents.test.ts.

import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl } from "@std/path";

const REQUIRED_JSR_PATHS: readonly string[] = [
  "src/cli.ts",
  "src/lsp.ts",
  "src/lsp/server.ts",
  "src/deno/lsp_worker_host.ts",
  "src/lsp/workers/loop.ts",
  "src/lsp/workers/protocol.ts",
  "src/lsp/workers/service_executor.ts",
  "src/lsp/workers/syntax_jobs.ts",
  "src/lsp/workers/syntax_worker.ts",
  "src/lsp/workers/semantic_worker.ts",
  "src/lsp/workers/syntax_worker_node.ts",
  "src/lsp/workers/semantic_worker_node.ts",
  "src/tooling/formatter.ts",
  "generated/wasm/parser.plan",
  "generated/wasm/parser.wasm",
  "generated/compiler/compiler.wasm",
  "generated/compiler/compiler-artifact.json",
  "generated/compiler/prelude.snapshot",
];

const REQUIRED_NPM_FILE_GLOBS: readonly string[] = [
  "dist/**/*.js",
  "dist/**/*.d.ts",
  "dist/generated/wasm/parser.plan",
  "dist/generated/wasm/parser.wasm",
  "dist/generated/compiler/compiler.wasm",
  "dist/generated/compiler/compiler-artifact.json",
  "dist/generated/compiler/prelude.snapshot",
];

const REQUIRED_BUNDLER_ASSETS: readonly string[] = [
  "wasm/abi.json",
  "wasm/manifest.json",
  "wasm/parser.plan",
  "wasm/parser.wasm",
  "compiler/compiler.wasm",
  "compiler/compiler-artifact.json",
  "compiler/prelude.snapshot",
];

Deno.test("the JSR distribution ships the editor runtime", async () => {
  const repository = dirname(dirname(fromFileUrl(import.meta.url)));
  const child = new Deno.Command(Deno.execPath(), {
    args: ["publish", "--dry-run", "--allow-dirty"],
    cwd: repository,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const output = await child.output();
  if (output.code !== 0) {
    throw new Error(
      `deno publish --dry-run failed: ${
        new TextDecoder().decode(output.stderr).slice(0, 2000)
      }`,
    );
  }
  const combined = new TextDecoder().decode(output.stdout) +
    new TextDecoder().decode(output.stderr);
  const published = new Set<string>();
  for (const line of combined.split("\n")) {
    const match = /file:\/\/(\S+?)(?:\s+\(|$)/.exec(line.trim());
    if (match === null) continue;
    const path = match[1];
    if (!path.startsWith(`${repository}/`)) continue;
    published.add(path.slice(repository.length + 1));
  }
  assert(published.size > 0, "the dry run listed no files");
  const missing = REQUIRED_JSR_PATHS.filter((path) => !published.has(path));
  assertEquals(missing, []);
  for (const path of published) {
    assert(
      !path.endsWith(".test.ts"),
      `the JSR distribution ships a test file: ${path}`,
    );
    assert(
      !path.startsWith("src/node/"),
      `the JSR distribution ships Node-only sources: ${path}`,
    );
  }
});

Deno.test("the npm manifest and bundler cover the editor runtime", async () => {
  const repository = dirname(dirname(fromFileUrl(import.meta.url)));
  const manifest = JSON.parse(
    await Deno.readTextFile(`${repository}/package.json`),
  ) as { files?: readonly string[] };
  const files = manifest.files;
  if (files === undefined) throw new Error("package.json has no files list");
  const missingGlobs = REQUIRED_NPM_FILE_GLOBS.filter((glob) =>
    !files.includes(glob)
  );
  assertEquals(missingGlobs, []);
  const bundler = await Deno.readTextFile(
    `${repository}/scripts/build_node_package.mjs`,
  );
  const missingAssets = REQUIRED_BUNDLER_ASSETS.filter((asset) =>
    !bundler.includes(`"${asset}"`)
  );
  assertEquals(missingAssets, []);
  assert(
    bundler.includes('collectTypeScriptSources(join(repository, "src"))'),
    "the bundler must compile every src module, including worker hosts",
  );
});
