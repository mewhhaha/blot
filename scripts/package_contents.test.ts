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
const nodeExecutable = "node";
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
      "dist/src/node/cli.js",
      "dist/src/host.js",
      "dist/src/host.d.ts",
      "dist/src/compiler.js",
      "dist/src/compiler.d.ts",
      "dist/src/lsp.js",
      "dist/src/lsp/server.js",
      "dist/src/deno/lsp_worker_host.js",
      "dist/src/node/lsp_worker_host.js",
      "dist/src/lsp/workers/loop.js",
      "dist/src/lsp/workers/protocol.js",
      "dist/src/lsp/workers/service_executor.js",
      "dist/src/lsp/workers/syntax_jobs.js",
      "dist/src/lsp/workers/syntax_worker.js",
      "dist/src/lsp/workers/semantic_worker.js",
      "dist/src/lsp/workers/syntax_worker_node.js",
      "dist/src/lsp/workers/semantic_worker_node.js",
      "dist/src/tooling/formatter.js",
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

  await context.test("installed CLI runs without a TypeScript loader", async () => {
    const help = await exec("pnpm", ["exec", "blot", "--help"], {
      cwd: consumer,
      env: consumerEnvironment,
    });
    assert.match(help.stdout, /pack\|explain/);
    const entry = join(consumer, "main.blot");
    await writeFile(entry, "return 42\n");
    const result = await exec("pnpm", ["exec", "blot", "run", entry], {
      cwd: consumer,
      env: consumerEnvironment,
    });
    assert.equal(result.stdout.trim(), "42");
  });

  await context.test("built CLI advertises format and lsp", async () => {
    const help = await exec("pnpm", ["exec", "blot", "--help"], {
      cwd: consumer,
      env: consumerEnvironment,
    });
    assert.match(help.stdout, /blot format \[--check\] <file\.blot>\.\.\./);
    assert.match(help.stdout, /blot lsp/);
  });

  await context.test("built format matches Deno-engine bytes", async () => {
    const fixture = "const  pair  =  (1,   2)\nlet   x=1\nreturn (x,   pair)\n";
    const builtPath = join(consumer, "format-built.blot");
    await writeFile(builtPath, fixture);
    await exec("pnpm", ["exec", "blot", "format", builtPath], {
      cwd: consumer,
      env: consumerEnvironment,
    });
    const oraclePath = join(temporaryDirectory, "format-oracle.blot");
    await writeFile(oraclePath, fixture);
    await exec(
      "deno",
      [
        "run",
        "--allow-read",
        "--allow-write",
        join(repository, "src", "cli.ts"),
        "fmt",
        oraclePath,
      ],
      { cwd: repository },
    );
    assert.equal(
      await readFile(builtPath, "utf8"),
      await readFile(oraclePath, "utf8"),
    );
  });

  await context.test("built lsp answers initialize over stdio", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn("pnpm", ["exec", "blot", "lsp"], {
      cwd: consumer,
      env: consumerEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    if (child.stdout === null) throw new Error("built lsp has no stdout");
    if (child.stdin === null) throw new Error("built lsp has no stdin");
    if (child.stderr === null) throw new Error("built lsp has no stderr");
    const stdin = child.stdin;
    child.stdout.on("data", (chunk) => {
      chunks.push(chunk as Buffer);
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += (chunk as Buffer).toString("utf8");
    });
    const frame = (message: unknown): Buffer => {
      const body = Buffer.from(JSON.stringify(message), "utf8");
      return Buffer.concat([
        Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "utf8"),
        body,
      ]);
    };
    stdin.write(
      frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    );
    stdin.write(
      frame({ jsonrpc: "2.0", id: 2, method: "shutdown", params: null }),
    );
    stdin.write(frame({ jsonrpc: "2.0", method: "exit", params: null }));
    stdin.end();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 60_000);
    try {
      const code = await new Promise((resolveChild, rejectChild) => {
        child.on("error", rejectChild);
        child.on("close", resolveChild);
      });
      assert.equal(code, 0);
      assert.equal(stderr, "");
      const messages = decodeStdioFrames(Buffer.concat(chunks));
      assert.equal(messages.length, 2);
      const initialize = messages[0] as {
        readonly id: number;
        readonly result: {
          readonly capabilities: Record<string, unknown>;
        };
      };
      assert.equal(initialize.id, 1);
      assert.equal(
        initialize.result.capabilities["documentFormattingProvider"],
        true,
      );
      assert.deepEqual(messages[1], { jsonrpc: "2.0", id: 2, result: null });
    } finally {
      clearTimeout(timer);
    }
  });

  await context.test("built worker entries resolve and boot", async () => {
    // The program runs from a file, not --eval: worker threads inherit the
    // parent execArgv, and --input-type=module plus a file entry is
    // rejected. A file keeps the boot path identical to real embedders.
    const installed = "file://" +
      join(consumer, "node_modules", "@mewhhaha", "blot");
    const program = [
      `import { statSync } from "node:fs";`,
      `import assert from "node:assert/strict";`,
      `import { entryUrlFor, createNodeLspWorkerHost } from ${
        JSON.stringify(installed + "/dist/src/node/lsp_worker_host.js")
      };`,
      `import { entryUrlFor as denoEntryUrlFor } from ${
        JSON.stringify(installed + "/dist/src/deno/lsp_worker_host.js")
      };`,
      `import { LSP_WORKER_PROTOCOL_VERSION, lspWorkerResult } from ${
        JSON.stringify(installed + "/dist/src/lsp/workers/protocol.js")
      };`,
      `import { runCpuProbe } from ${
        JSON.stringify(installed + "/dist/src/lsp/workers/syntax_jobs.js")
      };`,
      `for (const entry of [entryUrlFor("syntax"), entryUrlFor("semantic"), denoEntryUrlFor("syntax"), denoEntryUrlFor("semantic")]) {`,
      `  assert.equal(entry.pathname.endsWith(".js"), true, "worker entry is not emitted JavaScript: " + entry.pathname);`,
      `  assert.equal(statSync(entry).isFile(), true, "worker entry is missing: " + entry.pathname);`,
      `}`,
      `const host = createNodeLspWorkerHost("syntax");`,
      `await host.start();`,
      `try {`,
      `  const received = await new Promise((resolveResult, rejectResult) => {`,
      `    const timer = setTimeout(() => rejectResult(new Error("worker result timed out")), 30000);`,
      `    const stop = host.onResult((value) => { clearTimeout(timer); stop(); resolveResult(value); });`,
      `    host.send({ protocol: LSP_WORKER_PROTOCOL_VERSION, job: 1, kind: "cpu/probe", iterations: 50000, seed: 7 });`,
      `  });`,
      `  const result = lspWorkerResult(received);`,
      `  assert.equal(result.ok, true);`,
      `  if (!result.ok) throw new Error("worker probe failed");`,
      `  assert.equal(result.job, 1);`,
      `  assert.deepEqual(result.value, runCpuProbe(50000, 7));`,
      `} finally {`,
      `  await host.terminate();`,
      `}`,
    ].join("\n");
    const programPath = join(consumer, "worker-boot.mjs");
    await writeFile(programPath, program);
    await exec(
      nodeExecutable,
      [programPath],
      { cwd: consumer, env: consumerEnvironment, timeout: 120_000 },
    );
  });

  await context.test(
    "declarations resolve without repository development types",
    async () => {
      const source = [
        'import { Compiler, DevelopmentProject, DevelopmentRuntime, buildPackage, instantiateArtifact, parse } from "@mewhhaha/blot";',
        'import type { HostedModule, HostCapabilities } from "@mewhhaha/blot";',
        "const hostFactory: typeof instantiateArtifact = instantiateArtifact;",
        "const hosted: HostedModule | undefined = undefined;",
        "const capabilities: HostCapabilities = new Map();",
        "void hostFactory; void hosted; void capabilities;",
        'import type { BuiltPackageExport, DevelopmentActivation, DevelopmentBuild, DevelopmentEdge, DevelopmentMemoryCheckpoint, DevelopmentMemoryProfile } from "@mewhhaha/blot";',
        'import { Compiler as CompilerEntry } from "@mewhhaha/blot/compiler";',
        'import type { CompilerHost } from "@mewhhaha/blot/compiler";',
        'const parsed: Awaited<ReturnType<typeof parse>> = await parse("return 42\\n");',
        "const compiler: CompilerHost = await Compiler.create();",
        "const runtime = new DevelopmentRuntime();",
        "const projectClass: typeof DevelopmentProject = DevelopmentProject;",
        "const build: DevelopmentBuild | undefined = undefined;",
        "const activation: DevelopmentActivation | undefined = undefined;",
        "const edge: DevelopmentEdge | undefined = undefined;",
        "const checkpoint: DevelopmentMemoryCheckpoint | undefined = undefined;",
        "const profile: DevelopmentMemoryProfile | undefined = undefined;",
        "const compilerEntry: typeof Compiler = CompilerEntry;",
        "const built: readonly BuiltPackageExport[] =",
        '  await buildPackage("./blot.json");',
        "compiler.destroy();",
        "void parsed;",
        "void runtime;",
        "void projectClass;",
        "void build;",
        "void activation;",
        "void edge;",
        "void checkpoint;",
        "void profile;",
        "void compilerEntry;",
        "void built;",
      ].join("\n");
      const consumerSource = join(consumer, "consumer.mts");
      await writeFile(consumerSource, source);
      await exec(
        nodeExecutable,
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
      nodeExecutable,
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
      nodeExecutable,
      ["--input-type=module", "--eval", program],
      { cwd: consumer, env: consumerEnvironment },
    );
  });
});

function decodeStdioFrames(bytes: Buffer): unknown[] {
  const messages: unknown[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const rest = bytes.toString("utf8", offset);
    const boundary = rest.indexOf("\r\n\r\n");
    if (boundary < 0) throw new Error("stdout carried non-frame bytes");
    const header = rest.slice(0, boundary);
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
    if (!Number.isInteger(length)) {
      throw new Error(`invalid Content-Length: ${header}`);
    }
    const bodyStart = offset + Buffer.byteLength(rest.slice(0, boundary + 4));
    const bodyEnd = bodyStart + length;
    messages.push(JSON.parse(bytes.toString("utf8", bodyStart, bodyEnd)));
    offset = bodyEnd;
  }
  return messages;
}
