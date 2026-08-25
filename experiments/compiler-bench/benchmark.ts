import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  decodeCompilerArtifactManifest,
  sha256,
  validateCompilerArtifact,
} from "../../src/compiler/artifact.ts";
import { COMPILER_HOST_ABI_VERSION } from "../../src/compiler/host_abi.ts";
import {
  type CheckedModule,
  Compiler,
  type CompilerAnalysis,
} from "../../src/compiler.ts";
import { load } from "../../src/load.ts";
import {
  type CompilerBenchmarkClass,
  type CompilerBenchmarkReport,
  type CompilerBenchmarkSample,
  type CompilerBenchmarkScenario,
  compilerBenchmarkSchema,
  medianAbsoluteDeviation,
  percentile,
} from "./schema.ts";
import { compilerObservation } from "./observation.ts";
import {
  benchmarkEnvironment,
  benchmarkInputsIdentity,
  hostInputsIdentity,
  workloadGraphIdentity,
} from "./provenance.ts";

const exec = promisify(execFile);
const benchmarkDirectory = dirname(fileURLToPath(import.meta.url));

interface Options {
  readonly path: string;
  readonly samples: number;
  readonly output: string | null;
}

interface MeasuredResult {
  readonly durationMilliseconds: number;
  readonly sourceBytes: number;
  readonly checked: CheckedModule;
  readonly analysis: CompilerAnalysis | null;
  readonly runtimeHirNodes?: number;
  readonly wasmBytes?: number;
}

interface ColdProcessResult {
  readonly observation: string;
  readonly hostRssBytes: number;
}

interface BenchmarkProvenance {
  readonly source: string;
  readonly sourceBytes: number;
  readonly commit: string;
  readonly hostInputsSha256: string;
  readonly benchmarkInputsSha256: string;
  readonly compilerArtifactSha256: string;
  readonly compilerManifestSha256: string;
  readonly compilerInputsSha256: string;
  readonly compilerPreludeSha256: string;
  readonly compilerSourceCommit: string;
  readonly compilerSourceTree: string;
  readonly compilerRustc: string;
  readonly graphIdentity: string;
  readonly versions: CompilerBenchmarkReport["versions"];
  readonly environment: CompilerBenchmarkReport["environment"];
}

function options(): Options {
  let path = "examples/minimal.blot";
  let samples = 9;
  let output: string | null = null;
  for (const argument of process.argv.slice(2)) {
    if (argument === "--") {
      continue;
    } else if (argument.startsWith("--samples=")) {
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
  return { path: resolve(path), samples, output };
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

async function benchmarkProvenance(path: string): Promise<BenchmarkProvenance> {
  const [
    loaded,
    compilerBytes,
    manifestBytes,
    preludeSnapshot,
    commit,
    hostInputsSha256,
    benchmarkInputsSha256,
    rust,
    deno,
  ] = await Promise.all([
    load(path, new Map()),
    readFile("generated/compiler/compiler.wasm"),
    readFile("generated/compiler/compiler-artifact.json"),
    readFile("generated/compiler/prelude.snapshot"),
    command("git", ["rev-parse", "HEAD"]),
    hostInputsIdentity(),
    benchmarkInputsIdentity(),
    command("rustc", ["--version"]),
    command("deno", ["--version"]),
  ]);
  if (commit === null || !/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new Error("compiler benchmark omitted its repository commit");
  }
  const manifest = decodeCompilerArtifactManifest(
    new TextDecoder().decode(manifestBytes),
  );
  const compilerPreludeSha256 = await sha256(preludeSnapshot);
  await validateCompilerArtifact(compilerBytes, manifest, {
    hostAbi: COMPILER_HOST_ABI_VERSION,
    preludeSha256: compilerPreludeSha256,
  });
  return {
    source: loaded.source,
    sourceBytes: Buffer.byteLength(loaded.source),
    commit,
    hostInputsSha256,
    benchmarkInputsSha256,
    compilerArtifactSha256: manifest.sha256,
    compilerManifestSha256: await sha256(manifestBytes),
    compilerInputsSha256: manifest.compilerInputsSha256,
    compilerPreludeSha256,
    compilerSourceCommit: manifest.sourceCommit,
    compilerSourceTree: manifest.sourceTree,
    compilerRustc: manifest.rustc,
    graphIdentity: workloadGraphIdentity(loaded),
    versions: {
      node: process.version,
      deno,
      v8: process.versions.v8,
      rust,
    },
    environment: benchmarkEnvironment(),
  };
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

function semanticEdit(source: string, index: number): string {
  const resultLine = source.lastIndexOf("\nreturn ");
  if (resultLine >= 0) {
    return `${source.slice(0, resultLine + 1)}let benchmark_private = ${
      index % 2
    }\n${source.slice(resultLine + 1)}`;
  }
  if (source.startsWith("return ")) {
    return `let benchmark_private = ${index % 2}\n${source}`;
  }
  throw new Error("compiler benchmark source has no top-level return line");
}

function benchmarkSample(result: MeasuredResult): CompilerBenchmarkSample {
  let hirNodes: number | null = null;
  if (result.runtimeHirNodes !== undefined) {
    hirNodes = result.runtimeHirNodes;
  }
  let wasmBytes: number | null = null;
  if (result.wasmBytes !== undefined) wasmBytes = result.wasmBytes;
  let checkedModules: readonly string[] | null = null;
  let invalidatedImporters: readonly string[] | null = null;
  let work: CompilerAnalysis["work"] = null;
  if (result.analysis !== null) {
    checkedModules = result.analysis.invalidation.checkedModules.slice();
    invalidatedImporters = result.analysis.invalidation.invalidatedImporters
      .slice();
    work = result.analysis.work;
  }
  return {
    durationMilliseconds: result.durationMilliseconds,
    sourceBytes: result.sourceBytes,
    runtimeHirNodes: hirNodes,
    wasmBytes,
    checkedModules,
    invalidatedImporters,
    hostRssBytes: process.memoryUsage().rss,
    work,
  };
}

function summarizedScenario(
  name: CompilerBenchmarkClass,
  measuredBoundary: string,
  setupOutsideClock: string,
  expected: string,
  samples: readonly CompilerBenchmarkSample[],
): CompilerBenchmarkScenario {
  const durations = samples.map((sample) => sample.durationMilliseconds);
  return {
    name,
    measuredBoundary,
    setupOutsideClock,
    observation: expected,
    samples,
    p50Milliseconds: percentile(durations, 0.5),
    madMilliseconds: medianAbsoluteDeviation(durations),
    p90Milliseconds: percentile(durations, 0.9),
    p95Milliseconds: percentile(durations, 0.95),
  };
}

async function coldProcessScenario(
  path: string,
  sourceBytes: number,
  sampleCount: number,
): Promise<CompilerBenchmarkScenario> {
  const samples: CompilerBenchmarkSample[] = [];
  let expected = "";
  for (let index = 0; index < sampleCount; index += 1) {
    const before = performance.now();
    const result = await exec(process.execPath, [
      "--import",
      "tsx",
      resolve(benchmarkDirectory, "cold_process.ts"),
      path,
    ]);
    const durationMilliseconds = performance.now() - before;
    const decoded = JSON.parse(result.stdout) as ColdProcessResult;
    if (index === 0) expected = decoded.observation;
    assert.equal(
      decoded.observation,
      expected,
      "cold process observation changed",
    );
    samples.push({
      durationMilliseconds,
      sourceBytes,
      runtimeHirNodes: null,
      wasmBytes: null,
      checkedModules: null,
      invalidatedImporters: null,
      hostRssBytes: decoded.hostRssBytes,
      work: null,
    });
  }
  return summarizedScenario(
    "cold-process",
    "fresh-process wall time through semantic result collection and child exit",
    "provenance was validated; source and compiler bundle already exist on disk",
    expected,
    samples,
  );
}

async function coldCompilerScenario(
  path: string,
  sourceBytes: number,
  sampleCount: number,
): Promise<CompilerBenchmarkScenario> {
  const samples: CompilerBenchmarkSample[] = [];
  let expected = "";
  for (let index = 0; index < sampleCount; index += 1) {
    const before = performance.now();
    const compiler = await Compiler.create();
    try {
      const checked = await compiler.check(path);
      const durationMilliseconds = performance.now() - before;
      const current = compilerObservation(checked);
      if (index === 0) expected = current;
      assert.equal(current, expected, "cold compiler observation changed");
      samples.push(benchmarkSample({
        durationMilliseconds,
        sourceBytes,
        checked,
        analysis: null,
      }));
    } finally {
      compiler.destroy();
    }
  }
  return summarizedScenario(
    "cold-compiler",
    "compiler bundle load, instantiation, graph load, and semantic check",
    "provenance and Baba parser runtime are warm; no compiler or source revision is resident",
    expected,
    samples,
  );
}

async function compilerScenario(
  name: Exclude<CompilerBenchmarkClass, "cold-process" | "cold-compiler">,
  measuredBoundary: string,
  setupOutsideClock: string,
  sampleCount: number,
  operation: (compiler: Compiler, index: number) => Promise<MeasuredResult>,
): Promise<CompilerBenchmarkScenario> {
  const compiler = await Compiler.create();
  const samples: CompilerBenchmarkSample[] = [];
  let expected = "";
  try {
    for (let index = 0; index < sampleCount; index += 1) {
      const result = await operation(compiler, index);
      const current = compilerObservation(result.checked);
      if (index === 0) expected = current;
      assert.equal(current, expected, `${name} observation changed`);
      samples.push(benchmarkSample(result));
    }
  } finally {
    compiler.destroy();
  }
  return summarizedScenario(
    name,
    measuredBoundary,
    setupOutsideClock,
    expected,
    samples,
  );
}

async function main(): Promise<void> {
  const selected = options();
  const initialProvenance = await benchmarkProvenance(selected.path);
  const source = initialProvenance.source;
  const sourceBytes = initialProvenance.sourceBytes;

  const scenarios: CompilerBenchmarkScenario[] = [];
  scenarios.push(
    await coldProcessScenario(selected.path, sourceBytes, selected.samples),
  );
  scenarios.push(
    await coldCompilerScenario(selected.path, sourceBytes, selected.samples),
  );
  scenarios.push(
    await compilerScenario(
      "warm-compiler",
      "load and check one source revision absent from the resident compiler",
      "compiler artifact and prelude are resident",
      selected.samples,
      async (compiler, index) => {
        if (index === 0) await compiler.check(selected.path);
        const path = `${selected.path}.benchmark-${index}.blot`;
        const before = performance.now();
        const checked = await compiler.checkSource(path, source);
        const durationMilliseconds = performance.now() - before;
        return { durationMilliseconds, sourceBytes, checked, analysis: null };
      },
    ),
  );
  scenarios.push(
    await compilerScenario(
      "resident-unchanged",
      "semantic check of the exact resident revision",
      "source graph was checked once before sampling",
      selected.samples,
      async (compiler, index) => {
        if (index === 0) await compiler.check(selected.path);
        const before = performance.now();
        const checked = await compiler.check(selected.path);
        const durationMilliseconds = performance.now() - before;
        return { durationMilliseconds, sourceBytes, checked, analysis: null };
      },
    ),
  );
  scenarios.push(
    await compilerScenario(
      "source-only-edit",
      "load and check an edit with an unchanged canonical AST",
      "compiler artifact and initial source graph are resident",
      selected.samples,
      async (compiler, index) => {
        if (index === 0) await compiler.check(selected.path);
        const edited =
          `${source}\n// compiler benchmark source edit ${index}\n`;
        const before = performance.now();
        const checked = await compiler.checkSource(selected.path, edited);
        const durationMilliseconds = performance.now() - before;
        return {
          durationMilliseconds,
          sourceBytes: Buffer.byteLength(edited),
          checked,
          analysis: null,
        };
      },
    ),
  );
  scenarios.push(
    await compilerScenario(
      "semantic-edit",
      "load and check a changed private declaration",
      "compiler artifact and initial source graph are resident",
      selected.samples,
      async (compiler, index) => {
        if (index === 0) await compiler.check(selected.path);
        const edited = semanticEdit(source, index);
        const before = performance.now();
        const checked = await compiler.checkSource(selected.path, edited);
        const durationMilliseconds = performance.now() - before;
        return {
          durationMilliseconds,
          sourceBytes: Buffer.byteLength(edited),
          checked,
          analysis: null,
        };
      },
    ),
  );
  scenarios.push(
    await compilerScenario(
      "semantic-analysis-edit",
      "load, check, and return analysis facts for a changed private declaration",
      "compiler artifact and initial source graph are resident",
      selected.samples,
      async (compiler, index) => {
        if (index === 0) await compiler.analyze(selected.path);
        const edited = semanticEdit(source, index);
        const before = performance.now();
        const analysis = await compiler.analyzeSource(selected.path, edited);
        const durationMilliseconds = performance.now() - before;
        const checked = { type: analysis.type, effects: analysis.effects };
        return {
          durationMilliseconds,
          sourceBytes: Buffer.byteLength(edited),
          checked,
          analysis,
        };
      },
    ),
  );
  scenarios.push(
    await compilerScenario(
      "prepare-after-check",
      "Runtime-HIR preparation for an already checked semantic revision",
      "semantic edit was loaded and checked",
      selected.samples,
      async (compiler, index) => {
        const edited = semanticEdit(source, index);
        const checked = await compiler.checkSource(selected.path, edited);
        const before = performance.now();
        const hir = await compiler.prepare(selected.path);
        const durationMilliseconds = performance.now() - before;
        return {
          durationMilliseconds,
          sourceBytes: Buffer.byteLength(edited),
          checked,
          analysis: null,
          runtimeHirNodes: runtimeHirNodes(hir),
        };
      },
    ),
  );
  scenarios.push(
    await compilerScenario(
      "emit-after-prepare",
      "Wasm emission for an already prepared semantic revision",
      "semantic edit was loaded, checked, and prepared",
      selected.samples,
      async (compiler, index) => {
        const edited = semanticEdit(source, index);
        const checked = await compiler.checkSource(selected.path, edited);
        await compiler.prepare(selected.path);
        const before = performance.now();
        const artifact = await compiler.compile(selected.path);
        const durationMilliseconds = performance.now() - before;
        return {
          durationMilliseconds,
          sourceBytes: Buffer.byteLength(edited),
          checked,
          analysis: null,
          wasmBytes: artifact.wasm.byteLength,
        };
      },
    ),
  );

  const finalProvenance = await benchmarkProvenance(selected.path);
  assert.deepEqual(
    finalProvenance,
    initialProvenance,
    "compiler benchmark inputs changed while sampling",
  );
  const report: CompilerBenchmarkReport = {
    schema: compilerBenchmarkSchema,
    commit: initialProvenance.commit,
    hostInputsSha256: initialProvenance.hostInputsSha256,
    benchmarkInputsSha256: initialProvenance.benchmarkInputsSha256,
    compilerArtifactSha256: initialProvenance.compilerArtifactSha256,
    compilerManifestSha256: initialProvenance.compilerManifestSha256,
    compilerInputsSha256: initialProvenance.compilerInputsSha256,
    compilerPreludeSha256: initialProvenance.compilerPreludeSha256,
    compilerSourceCommit: initialProvenance.compilerSourceCommit,
    compilerSourceTree: initialProvenance.compilerSourceTree,
    compilerRustc: initialProvenance.compilerRustc,
    versions: initialProvenance.versions,
    environment: initialProvenance.environment,
    graphIdentity: initialProvenance.graphIdentity,
    sourcePath: selected.path,
    sourceBytes,
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
