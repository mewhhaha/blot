import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { Compiler, type CompilerArtifact } from "../../src/compiler/session.ts";

const samples = 9;
const warmupCalls = 10_000;
const measuredCalls = 250_000;
const baselinePath = resolve("experiments/predicate-refinements/baseline.blot");
const predicatePath = resolve(
  "experiments/predicate-refinements/predicate.blot",
);
const typeBaselinePath = resolve(
  "experiments/predicate-refinements/type-baseline.blot",
);
const typePredicatePath = resolve(
  "experiments/predicate-refinements/type-predicate.blot",
);

const checkTimes = {
  baseline: [] as number[],
  predicate: [] as number[],
  typeBaseline: [] as number[],
  typePredicate: [] as number[],
};

for (let sample = 0; sample < samples; sample += 1) {
  let order: readonly (readonly [keyof typeof checkTimes, string])[] = [
    ["baseline", baselinePath],
    ["predicate", predicatePath],
    ["typeBaseline", typeBaselinePath],
    ["typePredicate", typePredicatePath],
  ];
  if (sample % 2 !== 0) {
    order = [
      ["typePredicate", typePredicatePath],
      ["typeBaseline", typeBaselinePath],
      ["predicate", predicatePath],
      ["baseline", baselinePath],
    ];
  }
  for (const [name, path] of order) {
    const compiler = await Compiler.create();
    const started = performance.now();
    await compiler.check(path);
    checkTimes[name].push(performance.now() - started);
    compiler.destroy();
  }
}

const directory = await mkdtemp(join(tmpdir(), "blot-predicate-refinement-"));
const resultPath = join(directory, "program.blot");
try {
  const baselineSource = await readFile(baselinePath, "utf8");
  const predicateSource = await readFile(predicatePath, "utf8");
  await writeFile(resultPath, baselineSource);
  const baselineCompiler = await Compiler.create();
  const baseline = await compile(baselineCompiler, resultPath);
  baselineCompiler.destroy();
  await writeFile(resultPath, predicateSource);
  const predicateCompiler = await Compiler.create();
  const predicate = await compile(predicateCompiler, resultPath);
  predicateCompiler.destroy();
  const wasmIdentical = equalBytes(
    baseline.artifact.wasm,
    predicate.artifact.wasm,
  );
  const hirOperationsIdentical = JSON.stringify(baseline.operations) ===
    JSON.stringify(predicate.operations);
  if (!wasmIdentical || !hirOperationsIdentical) {
    throw new Error(
      `Equivalent programs diverged: Wasm identical=${wasmIdentical}, ` +
        `HIR operation histogram identical=${hirOperationsIdentical}, ` +
        `baseline bytes=${baseline.artifact.wasm.byteLength}, ` +
        `predicate bytes=${predicate.artifact.wasm.byteLength}, ` +
        `baseline SHA=${sha256(baseline.artifact.wasm)}, ` +
        `predicate SHA=${sha256(predicate.artifact.wasm)}.`,
    );
  }
  const typeBaselineSource = await readFile(typeBaselinePath, "utf8");
  const typePredicateSource = await readFile(typePredicatePath, "utf8");
  await writeFile(resultPath, typeBaselineSource);
  const typeBaselineCompiler = await Compiler.create();
  const typeBaseline = await compile(typeBaselineCompiler, resultPath);
  typeBaselineCompiler.destroy();
  await writeFile(resultPath, typePredicateSource);
  const typePredicateCompiler = await Compiler.create();
  const typePredicate = await compile(typePredicateCompiler, resultPath);
  typePredicateCompiler.destroy();
  const typeWasmIdentical = equalBytes(
    typeBaseline.artifact.wasm,
    typePredicate.artifact.wasm,
  );
  const typeHirOperationsIdentical = JSON.stringify(typeBaseline.operations) ===
    JSON.stringify(typePredicate.operations);
  if (!typeWasmIdentical || !typeHirOperationsIdentical) {
    throw new Error(
      `Type-predicate assertion did not erase: Wasm identical=${typeWasmIdentical}, ` +
        `HIR operation histogram identical=${typeHirOperationsIdentical}.`,
    );
  }
  const result = {
    theory: {
      baseline: "canonical range 0..255",
      experiment: "refine (Int, fn value => value >= 0 && value <= 255)",
      expected:
        "compile-time-only normalization; zero Runtime HIR or Wasm overhead",
    },
    compile_time: {
      samples,
      baseline_median_ms: median(checkTimes.baseline),
      predicate_median_ms: median(checkTimes.predicate),
      predicate_over_baseline: median(checkTimes.predicate) /
        median(checkTimes.baseline),
      baseline_samples_ms: checkTimes.baseline,
      predicate_samples_ms: checkTimes.predicate,
    },
    resulting_code: {
      baseline_build_ms: baseline.buildMs,
      predicate_build_ms: predicate.buildMs,
      baseline_wasm_bytes: baseline.artifact.wasm.byteLength,
      predicate_wasm_bytes: predicate.artifact.wasm.byteLength,
      baseline_sha256: sha256(baseline.artifact.wasm),
      predicate_sha256: sha256(predicate.artifact.wasm),
      wasm_identical: wasmIdentical,
      runtime_hir_operations_identical: hirOperationsIdentical,
      runtime_hir_operation_histogram: baseline.operations,
      baseline_median_ns_per_call: baseline.runMedianNs,
      predicate_median_ns_per_call: predicate.runMedianNs,
      observed: baseline.observed.toString(),
    },
    advanced_type_predicates: {
      theory:
        "reflection, alpha equality, quantifier instantiation, and @type.satisfies erase before Runtime HIR",
      compile_time: {
        samples,
        baseline_median_ms: median(checkTimes.typeBaseline),
        predicate_median_ms: median(checkTimes.typePredicate),
        predicate_over_baseline: median(checkTimes.typePredicate) /
          median(checkTimes.typeBaseline),
        baseline_samples_ms: checkTimes.typeBaseline,
        predicate_samples_ms: checkTimes.typePredicate,
      },
      resulting_code: {
        baseline_build_ms: typeBaseline.buildMs,
        predicate_build_ms: typePredicate.buildMs,
        baseline_wasm_bytes: typeBaseline.artifact.wasm.byteLength,
        predicate_wasm_bytes: typePredicate.artifact.wasm.byteLength,
        baseline_sha256: sha256(typeBaseline.artifact.wasm),
        predicate_sha256: sha256(typePredicate.artifact.wasm),
        wasm_identical: typeWasmIdentical,
        runtime_hir_operations_identical: typeHirOperationsIdentical,
        runtime_hir_operation_histogram: typeBaseline.operations,
        baseline_median_ns_per_call: typeBaseline.runMedianNs,
        predicate_median_ns_per_call: typePredicate.runMedianNs,
        observed: typeBaseline.observed.toString(),
      },
    },
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function compile(compiler: Compiler, path: string) {
  const started = performance.now();
  const hir = await compiler.prepare(path);
  const artifact = await compiler.compile(path);
  const buildMs = performance.now() - started;
  const operations = operationHistogram(hir);
  const run = await instantiate(artifact);
  for (let index = 0; index < warmupCalls; index += 1) run();
  const times: number[] = [];
  let observed = 0n;
  for (let sample = 0; sample < samples; sample += 1) {
    const before = performance.now();
    for (let index = 0; index < measuredCalls; index += 1) {
      observed = run();
    }
    times.push((performance.now() - before) * 1_000_000 / measuredCalls);
  }
  if (observed !== 120n) {
    throw new Error(`${path} returned ${observed}; expected 120`);
  }
  return {
    artifact,
    buildMs,
    observed,
    operations,
    runMedianNs: median(times),
  };
}

async function instantiate(
  artifact: CompilerArtifact,
): Promise<() => bigint> {
  const instantiated = await WebAssembly.instantiate(
    Uint8Array.from(artifact.wasm),
  );
  const exported = instantiated.instance.exports["blot:default"];
  if (typeof exported !== "function") {
    throw new Error("The benchmark artifact omitted `blot:default`.");
  }
  return (): bigint => {
    const value: unknown = exported();
    if (typeof value !== "bigint") {
      throw new Error("The benchmark export did not return an i64.");
    }
    return value;
  };
}

function operationHistogram(hir: Awaited<ReturnType<Compiler["prepare"]>>) {
  const counts = new Map<string, number>();
  for (const fn of hir.functions) {
    for (const block of fn.blocks) {
      for (const operation of block.operations) {
        const before = counts.get(operation.kind);
        if (before === undefined) counts.set(operation.kind, 1);
        else counts.set(operation.kind, before + 1);
      }
    }
  }
  return Object.fromEntries(
    [...counts].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
