// blot's command line.
//
// `check` and `eval` both stay off WebGPU: parsing has baba's CPU path and the
// evaluator is plain TypeScript. Only `just parity` needs an adapter.

import { resolve } from "@std/path";
import { BlotError, locate, render } from "./diagnostic.ts";
import { parse } from "./syntax/parse.ts";
import { show } from "./comptime/value.ts";
import { evaluateFile as run } from "./run.ts";
import { LoadError } from "./load.ts";
import { checkFile, type OwnedBinding } from "./check/mod.ts";
import type { NamePattern } from "./linear/check.ts";
import { testFile, type TestOutcome } from "./test.ts";

const [command, ...rest] = Deno.args;

if (command === "serve") {
  await serveCompiler(rest);
  Deno.exit(0);
}

if (command === undefined || rest.length === 0) {
  printUsage();
  Deno.exit(2);
}

let paths: readonly string[] = rest;
let buildMode: BuildMode = "direct";
let serviceUrl: string | undefined;
if (command === "build") {
  const buildArguments = parseBuildArguments(rest);
  paths = buildArguments.paths;
  buildMode = buildArguments.mode;
  serviceUrl = buildArguments.serviceUrl;
  if (paths.length === 0) {
    printUsage();
    Deno.exit(2);
  }
}

let failures = 0;
let tests = 0;
let failedTests = 0;

for (const path of paths) {
  try {
    if (command === "check") await check(path);
    else if (command === "test") {
      const outcomes = await testFile(path);
      tests += outcomes.length;
      failedTests += reportTestOutcomes(outcomes);
    } else if (command === "ownership") await ownership(path);
    else if (command === "build") {
      await buildFile(path, { mode: buildMode, serviceUrl });
    } else if (command === "eval") await evaluateFile(path);
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

type BuildMode = "direct" | "service";

interface BuildOptions {
  readonly mode: BuildMode;
  readonly serviceUrl: string | undefined;
}

interface BuildArguments extends BuildOptions {
  readonly paths: readonly string[];
}

function parseBuildArguments(arguments_: readonly string[]): BuildArguments {
  let mode: BuildMode = "direct";
  let serviceUrl: string | undefined;
  const paths: string[] = [];
  for (const argument of arguments_) {
    if (argument === "--mode=direct") {
      mode = "direct";
      continue;
    }
    if (argument === "--mode=service") {
      mode = "service";
      continue;
    }
    if (argument.startsWith("--service-url=")) {
      serviceUrl = argument.slice("--service-url=".length);
      if (serviceUrl.length === 0) {
        throw new Error("--service-url requires an HTTP URL");
      }
      continue;
    }
    if (argument.startsWith("--")) {
      throw new Error(`unknown build option ${JSON.stringify(argument)}`);
    }
    paths.push(argument);
  }
  if (serviceUrl !== undefined && mode !== "service") {
    throw new Error("--service-url requires --mode=service");
  }
  return { mode, paths, serviceUrl };
}

async function serveCompiler(arguments_: readonly string[]): Promise<void> {
  let port = 4765;
  for (const argument of arguments_) {
    if (!argument.startsWith("--port=")) {
      throw new Error(`unknown serve option ${JSON.stringify(argument)}`);
    }
    port = Number(argument.slice("--port=".length));
  }
  const { startCompilerServer } = await import("./compiler_service.ts");
  const server = await startCompilerServer({ port });
  console.log(`Blot compiler service listening at ${server.url}`);
  await server.finished;
}

function printUsage(): void {
  console.error("usage: blot <check|test|eval|ast|ownership> <file.blot>...");
  console.error("       blot build [--mode=direct|service] <file.blot>...");
  console.error("       blot serve [--port=4765]");
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
  const source = await Deno.readTextFile(path);
  const parsed = await parse(source);
  if (!parsed.ok) {
    for (const diagnostic of parsed.diagnostics) {
      console.error(render(path, source, diagnostic));
    }
    throw new Error("check failed");
  }
  const checked = await checkFile(path);
  const row = checked.effects === "" ? "" : ` ~ ${checked.effects}`;
  console.log(`${path}: ${checked.type}${row}`);
}

async function evaluateFile(path: string): Promise<void> {
  const value = await run(path, { write: (line) => console.log(line) });
  console.log(show(value));
}

/**
 * The ownership facts the backend will consume.
 *
 * Nothing applies them yet, and the obstacle is not blot's. gpufuck's
 * Functional Surface has exactly six store forms — `store-empty`, `store-new`,
 * `store-length`, `store-read`, `store-write` and `store-grow`, at
 * `../gpufuck/src/functional/surface_contract.ts:32` — and none of them writes
 * in place: `store-write` allocates a fresh store and copies the source into it
 * before applying the update. So a binding proved dead at its last use has no
 * instruction for that fact to select, and rewriting a rebuild into a mutation
 * is not something blot can do alone. `docs/roadmap.md` states what the target
 * would have to offer. Printing the facts keeps the analysis testable on its
 * own rather than deferred until something can act on it.
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
    const source = await Deno.readTextFile(contributor);
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

/** Lowers to gpufuck's Core, compiles on the GPU, and writes the Wasm binary. */
async function buildFile(path: string, options: BuildOptions): Promise<void> {
  let built: {
    readonly wasm: Uint8Array;
    readonly manifestBytes: Uint8Array;
    readonly capabilities: readonly string[];
  };
  if (options.mode === "service") {
    const { buildWithCompilerService } = await import("./compiler_service.ts");
    built = await buildWithCompilerService(path, options.serviceUrl);
  } else {
    const backend = await import("./backend/compile.ts");
    built = await backend.build(path);
  }
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
