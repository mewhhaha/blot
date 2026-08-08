import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { prepareGpupaperHir } from "../../src/conformance/gpufuck/compile.ts";
import { Compiler } from "../../src/compiler/session.ts";
import { validateBlotRuntimeModule } from "../../src/runtime/hir.ts";
import { compileBlotRuntimeModulesOnRustWasm } from "../../src/conformance/gpufuck/runtime/target.ts";
import { checkFile } from "../../src/check/mod.ts";
import { load, type Loaded, refreshLoadedModules } from "../../src/load.ts";
import { buildPackage } from "../../src/package.ts";
import { PACKAGE_FORMAT_VERSION } from "../../src/package_format.ts";

type Backend = "typescript-gpupaper" | "full-rust-wasm";
type Boundary = "load" | "check" | "compile" | "resident-compile";
type Scenario = "source" | "capsule";

interface WorkerResult {
  readonly backend: Backend;
  readonly boundary: Boundary;
  readonly milliseconds: number;
  readonly instantiationMilliseconds?: number;
  readonly selectedStorage?: "source" | "capsule";
  readonly type?: string;
  readonly effects?: string;
  readonly abiSha256?: string;
  readonly wasmSha256?: string;
  readonly wasmBytes?: number;
  readonly observation?: string;
}

interface ScenarioPaths {
  readonly source: string;
  readonly capsule: string;
  readonly capsulePath: string;
  readonly preludeBytes: number;
  readonly capsuleBytes: number;
}

const workerIndex = Deno.args.indexOf("--worker");
if (workerIndex >= 0) {
  const backend = backendArgument(Deno.args[workerIndex + 1]);
  const boundary = boundaryArgument(Deno.args[workerIndex + 2]);
  const path = requiredArgument(
    Deno.args[workerIndex + 3],
    "worker entry path",
  );
  console.log(JSON.stringify(await runWorker(backend, boundary, path)));
} else {
  await runBenchmark();
}

async function runBenchmark(): Promise<void> {
  const coldSamples = 9;
  const residentRuns = 5;
  const residentSamples = 9;
  const directory = await Deno.makeTempDir({
    prefix: "blot-package-benchmark-",
  });
  try {
    const paths = await createScenarios(directory);
    const results: Record<string, unknown> = {};
    const compileObservations = new Map<Backend, WorkerResult>();
    for (
      const backend of [
        "typescript-gpupaper",
        "full-rust-wasm",
      ] as const
    ) {
      const boundaries: Boundary[] = ["check", "compile"];
      if (backend === "typescript-gpupaper") boundaries.unshift("load");
      for (const boundary of boundaries) {
        const measurements = await isolatedMeasurements(
          backend,
          boundary,
          paths,
          coldSamples,
        );
        requireScenarioParity(measurements);
        results[`${backend}_${boundary}`] = summarize(measurements);
        if (boundary === "compile") {
          const observation = measurements.source[0];
          if (observation === undefined) {
            throw new Error(`${backend} omitted its compile observation`);
          }
          compileObservations.set(backend, observation);
        }
      }
      const resident = await isolatedMeasurements(
        backend,
        "resident-compile",
        paths,
        residentRuns,
        residentSamples,
      );
      requireScenarioParity(resident);
      results[`${backend}_resident_compile`] = summarize(resident);
    }
    requireCompilerParity(compileObservations);
    const compileObservation = compileObservations.get("typescript-gpupaper");
    if (compileObservation === undefined) {
      throw new Error("benchmark omitted its compile observation");
    }
    console.log(JSON.stringify(
      {
        source: "examples/storage.blot with packaged src/prelude/prelude.blot",
        cold_samples: coldSamples,
        resident_runs: residentRuns,
        resident_samples_per_run: residentSamples,
        prelude_bytes: paths.preludeBytes,
        capsule_bytes: paths.capsuleBytes,
        parity: {
          normalized_abi_sha256: compileObservation.abiSha256,
          wasm_observation: compileObservation.observation,
        },
        results,
      },
      null,
      2,
    ));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

async function createScenarios(directory: string): Promise<ScenarioPaths> {
  const projectRoot = dirname(dirname(dirname(fromFileUrl(import.meta.url))));
  const prelude = await Deno.readTextFile(
    join(projectRoot, "src", "prelude", "prelude.blot"),
  );
  const storage = await Deno.readTextFile(
    join(projectRoot, "examples", "storage.blot"),
  );
  const entry = storage.replace(
    '"blot:prelude"',
    '"@benchmark/prelude"',
  );
  if (entry === storage) {
    throw new Error("storage benchmark source did not import blot:prelude");
  }

  const sourceRoot = join(directory, "source");
  const capsuleRoot = join(directory, "capsule");
  const sourceEntry = await writeScenario(sourceRoot, prelude, entry, false);
  const capsuleEntry = await writeScenario(capsuleRoot, prelude, entry, true);
  const capsulePackage = join(
    capsuleRoot,
    "node_modules",
    "@benchmark",
    "prelude",
  );
  const capsulePath = join(capsulePackage, "dist", "prelude.blotc");
  await Deno.remove(join(capsulePackage, "src"), { recursive: true });
  return {
    source: sourceEntry,
    capsule: capsuleEntry,
    capsulePath,
    preludeBytes: new TextEncoder().encode(prelude).byteLength,
    capsuleBytes: (await Deno.stat(capsulePath)).size,
  };
}

async function writeScenario(
  root: string,
  prelude: string,
  entry: string,
  built: boolean,
): Promise<string> {
  const packageRoot = join(root, "node_modules", "@benchmark", "prelude");
  await Deno.mkdir(join(packageRoot, "src"), { recursive: true });
  const exported: Record<string, string> = { source: "./src/prelude.blot" };
  if (built) exported.built = "./dist/prelude.blotc";
  const manifestPath = join(packageRoot, "blot.json");
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      schema: "blot-package",
      version: PACKAGE_FORMAT_VERSION,
      exports: { ".": exported },
    }),
  );
  await Deno.writeTextFile(join(packageRoot, "src", "prelude.blot"), prelude);
  const entryPath = join(root, "storage.blot");
  await Deno.writeTextFile(entryPath, entry);
  if (built) await buildPackage(manifestPath);
  return entryPath;
}

async function isolatedMeasurements(
  backend: Backend,
  boundary: Boundary,
  paths: ScenarioPaths,
  runs: number,
  residentSamples = 1,
): Promise<Record<Scenario, WorkerResult[]>> {
  const measurements: Record<Scenario, WorkerResult[]> = {
    source: [],
    capsule: [],
  };
  for (let run = 0; run < runs; run += 1) {
    const order: Scenario[] = ["source", "capsule"];
    if (run % 2 === 1) order.reverse();
    for (const scenario of order) {
      const path = paths[scenario];
      measurements[scenario].push(
        await invokeWorker(backend, boundary, path, residentSamples),
      );
    }
  }
  return measurements;
}

async function invokeWorker(
  backend: Backend,
  boundary: Boundary,
  path: string,
  residentSamples: number,
): Promise<WorkerResult> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--quiet",
      "--allow-read",
      fromFileUrl(import.meta.url),
      "--worker",
      backend,
      boundary,
      path,
      String(residentSamples),
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    throw new Error(
      `package benchmark worker failed for ${backend} ${boundary} ${path}: ${
        new TextDecoder().decode(output.stderr).trim()
      }`,
    );
  }
  return JSON.parse(new TextDecoder().decode(output.stdout)) as WorkerResult;
}

async function runWorker(
  backend: Backend,
  boundary: Boundary,
  path: string,
): Promise<WorkerResult> {
  const residentSamples = Number(Deno.args[workerIndex + 4]);
  if (!Number.isInteger(residentSamples) || residentSamples < 1) {
    throw new Error(`invalid resident sample count ${String(residentSamples)}`);
  }
  if (backend === "typescript-gpupaper") {
    return await runTypescriptWorker(boundary, path, residentSamples);
  }
  return await runRustWorker(boundary, path, residentSamples);
}

async function runTypescriptWorker(
  boundary: Boundary,
  path: string,
  residentSamples: number,
): Promise<WorkerResult> {
  if (boundary === "load") {
    const started = performance.now();
    const loaded = await load(path);
    const milliseconds = performance.now() - started;
    return {
      backend: "typescript-gpupaper",
      boundary,
      milliseconds,
      selectedStorage: packageStorage(loaded),
    };
  }
  if (boundary === "check") {
    const started = performance.now();
    const checked = await checkFile(path);
    return {
      backend: "typescript-gpupaper",
      boundary,
      milliseconds: performance.now() - started,
      type: checked.type,
      effects: checked.effects,
    };
  }
  if (boundary === "compile") {
    const started = performance.now();
    const artifact = await compileTypescript(path);
    return await artifactResult(
      "typescript-gpupaper",
      boundary,
      performance.now() - started,
      artifact,
    );
  }
  await compileTypescript(path);
  const measurements: number[] = [];
  let artifact: Awaited<ReturnType<typeof compileTypescript>> | undefined;
  for (let sample = 0; sample < residentSamples; sample += 1) {
    const started = performance.now();
    artifact = await compileTypescript(path);
    measurements.push(performance.now() - started);
  }
  if (artifact === undefined) {
    throw new Error("resident benchmark emitted nothing");
  }
  return await artifactResult(
    "typescript-gpupaper",
    boundary,
    medianValue(measurements),
    artifact,
  );
}

async function runRustWorker(
  boundary: Boundary,
  path: string,
  residentSamples: number,
): Promise<WorkerResult> {
  if (boundary === "load") {
    throw new Error("the full Rust compiler has no public load-only boundary");
  }
  const instantiationStarted = performance.now();
  const compiler = await Compiler.create();
  const instantiationMilliseconds = performance.now() - instantiationStarted;
  try {
    if (boundary === "check") {
      const started = performance.now();
      const checked = await compiler.check(path);
      return {
        backend: "full-rust-wasm",
        boundary,
        milliseconds: performance.now() - started,
        instantiationMilliseconds,
        type: checked.type,
        effects: checked.effects,
      };
    }
    if (boundary === "compile") {
      const started = performance.now();
      const artifact = await compiler.compile(path);
      return await artifactResult(
        "full-rust-wasm",
        boundary,
        performance.now() - started,
        artifact,
        instantiationMilliseconds,
      );
    }
    await compiler.compile(path);
    const measurements: number[] = [];
    let artifact: Awaited<ReturnType<typeof compiler.compile>> | undefined;
    for (let sample = 0; sample < residentSamples; sample += 1) {
      const started = performance.now();
      artifact = await compiler.compile(path);
      measurements.push(performance.now() - started);
    }
    if (artifact === undefined) {
      throw new Error("resident Rust benchmark emitted nothing");
    }
    return await artifactResult(
      "full-rust-wasm",
      boundary,
      medianValue(measurements),
      artifact,
      instantiationMilliseconds,
    );
  } finally {
    compiler.destroy();
  }
}

async function compileTypescript(path: string) {
  await refreshLoadedModules();
  const hir = validateBlotRuntimeModule(await prepareGpupaperHir(path));
  const artifact = (await compileBlotRuntimeModulesOnRustWasm([hir]))
    .artifacts[0];
  if (artifact === undefined) {
    throw new Error("gpupaper omitted the TypeScript compiler artifact");
  }
  return artifact;
}

async function artifactResult(
  backend: Backend,
  boundary: Boundary,
  milliseconds: number,
  artifact: {
    readonly wasm: Uint8Array;
    readonly manifestBytes: Uint8Array;
  },
  instantiationMilliseconds?: number,
): Promise<WorkerResult> {
  const manifest = JSON.parse(
    new TextDecoder().decode(artifact.manifestBytes),
  ) as Record<string, unknown>;
  manifest.source = "<benchmark-entry>";
  const module = await WebAssembly.compile(
    Uint8Array.from(artifact.wasm).buffer,
  );
  const instance = await WebAssembly.instantiate(module);
  const byAccessor = instance.exports["blot:by_accessor"];
  if (!(byAccessor instanceof Function)) {
    throw new Error(`${backend} omitted blot:by_accessor`);
  }
  return {
    backend,
    boundary,
    milliseconds,
    instantiationMilliseconds,
    abiSha256: await sha256(
      new TextEncoder().encode(JSON.stringify(manifest)),
    ),
    wasmSha256: await sha256(artifact.wasm),
    wasmBytes: artifact.wasm.byteLength,
    observation: String(byAccessor()),
  };
}

function packageStorage(loaded: Loaded): "source" | "capsule" {
  const dependency = loaded.dependencies.get("@benchmark/prelude");
  if (dependency === undefined) {
    throw new Error(`${loaded.path} omitted @benchmark/prelude`);
  }
  return dependency.storage.tag;
}

function summarize(
  measurements: Record<Scenario, WorkerResult[]>,
): Record<string, unknown> {
  const source = measurements.source.map((result) => result.milliseconds);
  const capsule = measurements.capsule.map((result) => result.milliseconds);
  const sourceMedian = medianValue(source);
  const capsuleMedian = medianValue(capsule);
  const summary: Record<string, unknown> = {
    source_median_ms: sourceMedian,
    capsule_median_ms: capsuleMedian,
    capsule_minus_source_ms: capsuleMedian - sourceMedian,
    capsule_over_source: capsuleMedian / sourceMedian,
    source_range_ms: [Math.min(...source), Math.max(...source)],
    capsule_range_ms: [Math.min(...capsule), Math.max(...capsule)],
  };
  const sourceInstantiation = measurements.source.flatMap((result) => {
    if (result.instantiationMilliseconds === undefined) return [];
    return [result.instantiationMilliseconds];
  });
  const capsuleInstantiation = measurements.capsule.flatMap((result) => {
    if (result.instantiationMilliseconds === undefined) return [];
    return [result.instantiationMilliseconds];
  });
  if (sourceInstantiation.length > 0 && capsuleInstantiation.length > 0) {
    summary.source_instantiation_median_ms = medianValue(sourceInstantiation);
    summary.capsule_instantiation_median_ms = medianValue(capsuleInstantiation);
  }
  return summary;
}

function requireScenarioParity(
  measurements: Readonly<Record<Scenario, readonly WorkerResult[]>>,
): void {
  const source = measurements.source[0];
  const capsule = measurements.capsule[0];
  if (source === undefined || capsule === undefined) {
    throw new Error("package benchmark omitted a scenario observation");
  }
  assertEquals(capsule.type, source.type);
  assertEquals(capsule.effects, source.effects);
  assertEquals(capsule.abiSha256, source.abiSha256);
  assertEquals(capsule.observation, source.observation);
  if (source.boundary === "load") {
    assertEquals(source.selectedStorage, "source");
    assertEquals(capsule.selectedStorage, "capsule");
  }
}

function requireCompilerParity(
  observations: ReadonlyMap<Backend, WorkerResult>,
): void {
  const typescript = observations.get("typescript-gpupaper");
  const rust = observations.get("full-rust-wasm");
  if (typescript === undefined || rust === undefined) {
    throw new Error("benchmark omitted compiler artifact observations");
  }
  assertEquals(typescript.abiSha256, rust.abiSha256);
  assertEquals(typescript.observation, rust.observation);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function medianValue(measurements: number[]): number {
  measurements.sort((left, right) => left - right);
  const result = measurements[Math.floor(measurements.length / 2)];
  if (result === undefined) throw new Error("benchmark produced no samples");
  return result;
}

function backendArgument(value: string | undefined): Backend {
  if (value === "typescript-gpupaper" || value === "full-rust-wasm") {
    return value;
  }
  throw new Error(`unknown package benchmark backend ${String(value)}`);
}

function boundaryArgument(value: string | undefined): Boundary {
  if (
    value === "load" || value === "check" || value === "compile" ||
    value === "resident-compile"
  ) return value;
  throw new Error(`unknown package benchmark boundary ${String(value)}`);
}

function requiredArgument(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}
