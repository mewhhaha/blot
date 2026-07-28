// blot's command line.
//
// `check` and `eval` both stay off WebGPU: parsing has baba's CPU path and the
// evaluator is plain TypeScript. Only `just parity` needs an adapter.

import { BlotError, locate, render } from "./diagnostic.ts";
import { parse } from "./syntax/parse.ts";
import { show } from "./comptime/value.ts";
import { evaluateFile as run } from "./run.ts";
import { LoadError } from "./load.ts";
import { checkFile } from "./check/mod.ts";

const [command, ...rest] = Deno.args;

if (command === undefined || rest.length === 0) {
  console.error("usage: blot <check|eval|build|ast|ownership> <file.blot>...");
  Deno.exit(2);
}

let failures = 0;

for (const path of rest) {
  try {
    if (command === "check") await check(path);
    else if (command === "ownership") await ownership(path);
    else if (command === "build") await buildFile(path);
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

Deno.exit(failures === 0 ? 0 : 1);

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
 * Nothing applies them yet: rewriting a rebuild into an in-place write needs a
 * Core to rewrite. Printing them keeps the analysis testable on its own rather
 * than deferred until something can act on it.
 */
async function ownership(path: string): Promise<void> {
  const checked = await checkFile(path);
  const source = await Deno.readTextFile(path);
  console.log(`${path}:`);
  if (checked.ownership.linear.length > 0) {
    console.log(
      `  linear, consumed exactly once: ${checked.ownership.linear.join(", ")}`,
    );
  }
  const uses = [...checked.ownership.lastUses]
    .sort((left, right) => left[1].start - right[1].start);
  for (const [name, span] of uses) {
    const { line, column } = locate(source, span.start);
    console.log(`  last use of \`${name}\` at ${line}:${column}`);
  }
}

/** Lowers to gpufuck's Core, compiles on the GPU, and writes the Wasm binary. */
async function buildFile(path: string): Promise<void> {
  const { build } = await import("./backend/compile.ts");
  const built = await build(path);
  const output = path.replace(/\.blot$/, ".wasm");
  await Deno.writeFile(output, built.wasm);
  const { runWasm } = await import("./backend/run.ts");
  const ran = await runWasm(built.wasm);
  const render = (value: unknown): string =>
    JSON.stringify(
      value,
      (_key, member) => typeof member === "bigint" ? `${member}n` : member,
    );
  console.log(
    `${output}: ${built.wasm.byteLength} bytes, wasm returns ${
      render(ran.value)
    }, gpu evaluator ${render(built.value)}`,
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
    console.error(`${path}: ${error.message}`);
    return;
  }
  if (error instanceof Error && error.message === "check failed") return;
  if (error instanceof Error && error.message === "parse failed") return;
  console.error(
    `${path}: ${error instanceof Error ? error.message : String(error)}`,
  );
}
