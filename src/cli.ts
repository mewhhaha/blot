// blot's command line.
//
// `build` runs the checked-in Rust compiler Wasm over Baba-generated parser
// tables. WebGPU belongs only to explicit conformance tools such as `just
// parity` and `just wasm`.

import { resolve } from "@std/path";
import { BlotError, locate, render } from "./diagnostic.ts";
import { parse } from "./syntax/parse.ts";
import { show } from "./comptime/value.ts";
import { evaluateFile as run } from "./run.ts";
import { loadedSource, LoadError } from "./load.ts";
import { checkFile, type OwnedBinding } from "./check/mod.ts";
import type { NamePattern } from "./linear/check.ts";
import { testFile, type TestOutcome } from "./test.ts";
import { buildPackage } from "./package.ts";
import { Compiler } from "./compiler.ts";
import { formatSource } from "./tooling/formatter.ts";
import { runLanguageServer } from "./lsp.ts";

const [command, ...rest] = Deno.args;

if (command === undefined) {
  printUsage();
  Deno.exit(2);
}

if (command === "lsp") {
  if (rest.length > 0) {
    printUsage();
    Deno.exit(2);
  }
  await runLanguageServer();
  Deno.exit(0);
}

if (rest.length === 0) {
  printUsage();
  Deno.exit(2);
}

let failures = 0;
let tests = 0;
let failedTests = 0;
let compiler: Promise<Compiler> | undefined;

if (command === "build") {
  failures += await buildFiles(rest);
} else if (command === "package") {
  failures += await buildPackages(rest);
} else if (command === "fmt") {
  failures += await formatFiles(rest);
} else {
  for (const path of rest) {
    try {
      if (command === "check") await check(path);
      else if (command === "test") {
        const outcomes = await testFile(path);
        tests += outcomes.length;
        failedTests += reportTestOutcomes(outcomes);
      } else if (command === "ownership") await ownership(path);
      else if (command === "eval") await evaluateFile(path);
      else if (command === "ast") await dumpAst(path);
      else {
        console.error(`unknown command \`${command}\``);
        Deno.exit(2);
      }
    } catch (error) {
      failures += 1;
      report(path, error);
    }
  }
}

if (command === "test") {
  if (tests === 0 && failures === 0) {
    console.error("no tests found");
    failures += 1;
  }
  console.log(`${tests - failedTests} passed; ${failedTests} failed`);
}

let exitCode = 0;
if (failures > 0 || failedTests > 0) exitCode = 1;
Deno.exit(exitCode);

type BuiltFileArtifact = {
  readonly wasm: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly capabilities: readonly string[];
};

function printUsage(): void {
  console.error(
    "usage: blot <check|test|eval|ast|ownership|fmt> <path>...",
  );
  console.error(
    "       check, build, and package answer from the production Rust compiler;",
  );
  console.error(
    "       eval and ownership answer from the TypeScript conformance oracle.",
  );
  console.error("       blot fmt [--check] <file.blot>...");
  console.error("       blot build <file.blot>...");
  console.error("       blot package <blot.json>...");
  console.error("       blot lsp");
}

async function formatFiles(arguments_: readonly string[]): Promise<number> {
  const checkOnly = arguments_.includes("--check");
  const paths = arguments_.filter((argument) => argument !== "--check");
  if (paths.length === 0) {
    console.error("blot fmt requires at least one .blot file");
    return 1;
  }
  let failures = 0;
  for (const path of paths) {
    const source = await Deno.readTextFile(path);
    const formatted = await formatSource(source);
    if (!formatted.ok) {
      failures += 1;
      for (const diagnostic of formatted.diagnostics) {
        console.error(render(path, source, diagnostic));
      }
      continue;
    }
    if (formatted.source === source) continue;
    if (checkOnly) {
      failures += 1;
      console.error(`${path}: needs formatting`);
      continue;
    }
    await Deno.writeTextFile(path, formatted.source);
    console.log(path);
  }
  return failures;
}

function reportTestOutcomes(outcomes: readonly TestOutcome[]): number {
  let failures = 0;
  for (const outcome of outcomes) {
    if (outcome.status === "passed") {
      console.log(`PASS ${outcome.path}:${outcome.name}`);
      continue;
    }
    failures += 1;
    console.error(
      `FAIL ${outcome.path}:${outcome.name}: ${outcome.diagnostic.message}`,
    );
  }
  return failures;
}

async function check(path: string): Promise<void> {
  if (compiler === undefined) compiler = Compiler.create();
  const checked = await (await compiler).check(path);
  console.log(`${path}: ${checked.type}${checked.effects}`);
}

async function evaluateFile(path: string): Promise<void> {
  const value = await run(path, { write: (line) => console.log(line) });
  console.log(show(value));
}

/**
 * The ownership facts the backend will consume.
 *
 * A proved linear consumption at `@array.set` or `@array.push` becomes an owned
 * backend Store update. Traversal-order last uses are still printed but do not
 * license reuse by themselves, because branch traversal order is not a
 * per-path deadness proof.
 *
 * They are printed per contributing module, because the backend inlines an
 * imported module into its importer and a dependency's spans index the
 * dependency's source.
 */
async function ownership(path: string): Promise<void> {
  const checked = await checkFile(path);
  // A fact carries the path the loader resolved, so the argument has to be
  // resolved the same way before the two can be compared.
  const entry = resolve(path);
  const byPath = new Map<string, [NamePattern, OwnedBinding][]>();
  for (const fact of checked.ownership) {
    const existing = byPath.get(fact[1].path);
    if (existing === undefined) byPath.set(fact[1].path, [fact]);
    else existing.push(fact);
  }
  // The file asked about comes first; the rest are what it pulled in.
  const paths = [...byPath.keys()].sort((left, right) => {
    if (left === entry) return -1;
    if (right === entry) return 1;
    return left.localeCompare(right);
  });
  for (const contributor of paths) {
    const facts = byPath.get(contributor);
    if (facts === undefined) throw new Error("a grouped path lost its facts");
    let source = loadedSource(contributor);
    if (source === undefined) source = await Deno.readTextFile(contributor);
    console.log(`${contributor}:`);
    const spent = facts
      .filter(([, fact]) => fact.spent)
      .map(([pattern]) => pattern.name);
    if (spent.length > 0) {
      console.log(`  linear, consumed exactly once: ${spent.join(", ")}`);
    }
    const uses = facts.flatMap(([pattern, fact]) => {
      if (fact.lastUse === null) return [];
      return [{ name: pattern.name, at: fact.lastUse }];
    });
    uses.sort((left, right) => left.at.start - right.at.start);
    for (const use of uses) {
      const { line, column } = locate(source, use.at.start);
      console.log(`  last use of \`${use.name}\` at ${line}:${column}`);
    }
  }
}

async function buildPackages(paths: readonly string[]): Promise<number> {
  let failures = 0;
  for (const path of paths) {
    try {
      for (const built of await buildPackage(path)) {
        console.log(
          `${built.name}: ${built.built}, ${built.bytes} bytes, ${built.modules} modules`,
        );
      }
    } catch (error) {
      failures += 1;
      report(path, error);
    }
  }
  return failures;
}

async function buildFiles(
  paths: readonly string[],
): Promise<number> {
  const backend = await import("./backend/build.ts");
  const outcomes = await backend.buildBatch(paths);
  let failures = 0;
  for (const outcome of outcomes) {
    if (outcome.status === "failed") {
      failures += 1;
      report(outcome.path, outcome.cause);
      continue;
    }
    await writeBuiltFile(outcome.path, outcome);
  }
  return failures;
}

async function writeBuiltFile(
  path: string,
  built: BuiltFileArtifact,
): Promise<void> {
  const output = path.replace(/\.blot$/, ".wasm");
  const manifest = `${output}.json`;
  await Deno.writeFile(output, built.wasm);
  await Deno.writeFile(manifest, built.manifestBytes);
  const imports = built.capabilities.length === 0
    ? ""
    : `, imports { ${built.capabilities.join(", ")} }`;
  console.log(
    `${output}: ${built.wasm.byteLength} bytes${imports}, manifest ${manifest}`,
  );
}

async function dumpAst(path: string): Promise<void> {
  const source = await Deno.readTextFile(path);
  const result = await parse(source);
  if (!result.ok) {
    for (const diagnostic of result.diagnostics) {
      console.error(render(path, source, diagnostic));
    }
    throw new Error("parse failed");
  }
  console.log(
    JSON.stringify(
      result.module,
      (_key, value) => typeof value === "bigint" ? `${value}n` : value,
      2,
    ),
  );
}

function report(path: string, error: unknown): void {
  if (error instanceof LoadError) {
    console.error(error.message);
    return;
  }
  if (error instanceof BlotError) {
    if (error.origin === null) {
      console.error(`${path}: ${error.message}`);
      return;
    }
    console.error(
      render(error.origin.path, error.origin.source, error.diagnostic),
    );
    return;
  }
  if (error instanceof Error && error.message === "check failed") return;
  if (error instanceof Error && error.message === "parse failed") return;
  console.error(
    `${path}: ${error instanceof Error ? error.message : String(error)}`,
  );
}
