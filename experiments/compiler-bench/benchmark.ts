import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Compiler, type CompilerAnalysis } from "../../src/compiler.ts";
import {
  type CompilerBenchmarkReport,
  type CompilerBenchmarkSample,
  type CompilerBenchmarkScenario,
  compilerBenchmarkSchema,
  percentile,
} from "./schema.ts";

const exec = promisify(execFile);

interface Options {
  readonly path: string;
  readonly samples: number;
  readonly output: string | null;
}

function options(): Options {
  let path = "examples/minimal.blot";
  let samples = 9;
  let output: string | null = null;
  for (const argument of process.argv.slice(2)) {
    if (argument.startsWith("--samples=")) {
      samples = Number(argument.slice("--samples=".length));
    } else if (argument.startsWith("--output=")) {
      output = argument.slice("--output=".length);
    } else {
      path = argument;
    }
  }
  if (!Number.isSafeInteger(samples) || samples < 1) {
    throw new Error("--samples must be a positive integer");
  }
  return { path, samples, output };
}

async function command(
  name: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    return (await exec(name, [...args])).stdout.trim();
  } catch {
    return null;
  }
}

function observation(analysis: CompilerAnalysis): string {
  return JSON.stringify({ type: analysis.type, effects: analysis.effects });
}

function runtimeHirNodes(
  module: Awaited<ReturnType<Compiler["prepare"]>>,
): number {
  return module.functions.reduce(
    (total, function_) =>
      total + function_.blocks.reduce(
        (blockTotal, block) => blockTotal + block.operations.length + 1,
        0,
      ),
    0,
  );
}

async function validateFreshObservation(
  path: string,
  expected: string,
): Promise<void> {
  const compiler = await Compiler.create();
  try {
    assert.equal(observation(await compiler.analyze(path)), expected);
  } finally {
    compiler.destroy();
  }
}

async function scenario(
  name: string,
  path: string,
  sourceBytes: number,
  sampleCount: number,
  operation: (compiler: Compiler) => Promise<{
    readonly analysis: CompilerAnalysis;
    readonly astBytes?: number;
    readonly runtimeHirNodes?: number;
    readonly wasmBytes?: number;
  }>,
): Promise<CompilerBenchmarkScenario> {
  const compiler = await Compiler.create();
  const samples: CompilerBenchmarkSample[] = [];
  let expected = "";
  try {
    for (let index = 0; index < sampleCount; index += 1) {
      const before = performance.now();
      const result = await operation(compiler);
      const durationMilliseconds = performance.now() - before;
      const current = observation(result.analysis);
      if (index === 0) {
        expected = current;
        await validateFreshObservation(path, expected);
      } else {
        assert.equal(current, expected, `${name} changed its observation`);
      }
      let astBytes: number | null = null;
      if (result.astBytes !== undefined) astBytes = result.astBytes;
      let hirNodes: number | null = null;
      if (result.runtimeHirNodes !== undefined) {
        hirNodes = result.runtimeHirNodes;
      }
      let wasmBytes: number | null = null;
      if (result.wasmBytes !== undefined) wasmBytes = result.wasmBytes;
      let modulesTransported = 0;
      if (index === 0) modulesTransported = 1;
      let modulesChecked = 1;
      if (result.analysis.work === null) modulesChecked = 0;
      samples.push({
        durationMilliseconds,
        sourceBytes,
        astBytes,
        runtimeHirNodes: hirNodes,
        wasmBytes,
        modulesLoaded: 1,
        modulesTransported,
        modulesChecked,
        importersInvalidated: 0,
        guestMemoryPagesBefore: null,
        guestMemoryPagesAfter: null,
        hostRssBytes: process.memoryUsage().rss,
        work: result.analysis.work,
      });
    }
  } finally {
    compiler.destroy();
  }
  const durations = samples.map((sample) => sample.durationMilliseconds);
  return {
    name,
    observation: expected,
    samples,
    p50Milliseconds: percentile(durations, 0.5),
    p90Milliseconds: percentile(durations, 0.9),
    p95Milliseconds: percentile(durations, 0.95),
  };
}

async function main(): Promise<void> {
  const selected = options();
  const source = await readFile(selected.path, "utf8");
  let compilerArtifactSha256 = "unavailable";
  try {
    const compilerBytes = await readFile("generated/compiler/compiler.wasm");
    compilerArtifactSha256 = createHash("sha256").update(compilerBytes).digest(
      "hex",
    );
  } catch {
    // Compiler.create reports the actionable artifact error.
  }
  const scenarios = await Promise.all([
    scenario(
      "warm-compiler-uncached-root",
      selected.path,
      Buffer.byteLength(source),
      selected.samples,
      async (compiler) => ({
        analysis: await compiler.analyze(selected.path),
      }),
    ),
    scenario(
      "resident-unchanged",
      selected.path,
      Buffer.byteLength(source),
      selected.samples,
      async (compiler) => ({
        analysis: await compiler.analyze(selected.path),
      }),
    ),
    scenario(
      "prepare-after-check",
      selected.path,
      Buffer.byteLength(source),
      selected.samples,
      async (compiler) => {
        const analysis = await compiler.analyze(selected.path);
        return {
          analysis,
          runtimeHirNodes: runtimeHirNodes(
            await compiler.prepare(selected.path),
          ),
        };
      },
    ),
    scenario(
      "compile-after-prepare",
      selected.path,
      Buffer.byteLength(source),
      selected.samples,
      async (compiler) => {
        const analysis = await compiler.analyze(selected.path);
        await compiler.prepare(selected.path);
        const artifact = await compiler.compile(selected.path);
        return { analysis, wasmBytes: artifact.wasm.byteLength };
      },
    ),
  ]);
  const commit = await command("git", ["rev-parse", "HEAD"]);
  const rust = await command("rustc", ["--version"]);
  const deno = await command("deno", ["--version"]);
  let commitIdentity = "unknown";
  if (commit !== null) commitIdentity = commit;
  const report: CompilerBenchmarkReport = {
    schema: compilerBenchmarkSchema,
    commit: commitIdentity,
    compilerArtifactSha256,
    versions: {
      node: process.version,
      deno,
      v8: process.versions.v8,
      rust,
    },
    graphIdentity: createHash("sha256").update(source).digest("hex"),
    sampleCount: selected.samples,
    scenarios,
  };
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (selected.output === null) {
    process.stdout.write(encoded);
  } else {
    await writeFile(selected.output, encoded);
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});
